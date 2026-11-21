package nfalert

import (
	"context"
	"sync"
	"time"
)

type MetricWorkerStatus struct {
	State         string `json:"state"`
	LastAttemptAt string `json:"lastAttemptAt,omitempty"`
	LastSuccessAt string `json:"lastSuccessAt,omitempty"`
	Failures      int    `json:"failures"`
	HookFailures  int    `json:"hookFailures"`
}

// One worker owns a fair bounded page per tick. It never collects telemetry or
// writes Inventory/Topology/NF Health and shares the metric serialization gate.
type MetricWorker struct {
	repo    *MongoEvaluatorRepository
	enabled bool
	tickMu  sync.Mutex
	mu      sync.RWMutex
	status  MetricWorkerStatus
	cursor  string
	cancel  context.CancelFunc
	done    chan struct{}
}

func NewMetricWorker(repo *MongoEvaluatorRepository, enabled bool) *MetricWorker {
	state := "disabled"
	if enabled {
		state = "starting"
	}
	return &MetricWorker{repo: repo, enabled: enabled, status: MetricWorkerStatus{State: state}}
}
func (w *MetricWorker) Snapshot() MetricWorkerStatus {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.status
}
func (w *MetricWorker) NoteHookFailure() { w.mu.Lock(); w.status.HookFailures++; w.mu.Unlock() }
func (w *MetricWorker) Start(parent context.Context) {
	if !w.enabled {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	w.cancel = cancel
	w.done = make(chan struct{})
	go func() {
		defer close(w.done)
		w.Tick(ctx, time.Now().UTC())
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				w.Tick(ctx, now.UTC())
			}
		}
	}()
}
func (w *MetricWorker) Stop() {
	if w.cancel != nil {
		w.cancel()
		<-w.done
	}
}
func (w *MetricWorker) Tick(ctx context.Context, now time.Time) {
	if !w.enabled {
		return
	}
	w.tickMu.Lock()
	defer w.tickMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	w.mu.Lock()
	w.status.LastAttemptAt = now.Format(time.RFC3339Nano)
	w.status.State = "running"
	w.mu.Unlock()
	if w.repo == nil || w.repo.metricSource == nil {
		w.mu.Lock()
		w.status.State = "degraded"
		w.status.Failures++
		w.mu.Unlock()
		return
	}
	rules, more, err := w.repo.ScanMetricRules(ctx, w.cursor)
	if err == nil {
		for _, rule := range rules {
			if ctx.Err() != nil {
				err = ctx.Err()
				break
			}
			w.cursor = rule.RuleID
			if _, evaluationErr := w.repo.EvaluateMetric(ctx, &rule, nil, nil, now); evaluationErr != nil {
				err = evaluationErr
			}
		}
		if ctx.Err() == nil && !more {
			w.cursor = ""
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err != nil {
		w.status.State = "degraded"
		w.status.Failures++

	} else {
		w.status.State = "running"
		w.status.LastSuccessAt = w.status.LastAttemptAt
	}
}
