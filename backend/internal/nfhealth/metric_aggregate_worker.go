package nfhealth

import (
	"context"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MetricAggregateStatus struct {
	Enabled       bool   `json:"enabled"`
	State         string `json:"state"`
	LastAttemptAt string `json:"lastAttemptAt,omitempty"`
	LastSuccessAt string `json:"lastSuccessAt,omitempty"`
	Failures      int    `json:"failures"`
}

// One opt-in worker visits 16 targets per minute, one closed hour per target.
// Older absent hours and late recomputation belong to the later backfill task.
type MetricAggregateWorker struct {
	repo   *Repository
	check  func(context.Context, *HealthTarget) error
	mu     sync.RWMutex
	tick   sync.Mutex
	status MetricAggregateStatus
	after  string
	cancel context.CancelFunc
	done   chan struct{}
}

func NewMetricAggregateWorker(repo *Repository, enabled bool, check func(context.Context, *HealthTarget) error) *MetricAggregateWorker {
	state := "disabled"
	if enabled {
		state = "starting"
	}
	return &MetricAggregateWorker{repo: repo, check: check, status: MetricAggregateStatus{Enabled: enabled, State: state}}
}
func (w *MetricAggregateWorker) Snapshot() MetricAggregateStatus {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.status
}
func (w *MetricAggregateWorker) Start(parent context.Context) {
	if !w.Snapshot().Enabled {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	w.cancel = cancel
	w.done = make(chan struct{})
	go func() {
		defer close(w.done)
		w.Tick(ctx, time.Now().UTC())
		ticker := time.NewTicker(time.Minute)
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
func (w *MetricAggregateWorker) Stop() {
	if w.cancel != nil {
		w.cancel()
		<-w.done
	}
}
func (w *MetricAggregateWorker) Tick(ctx context.Context, now time.Time) {
	if !w.Snapshot().Enabled {
		return
	}
	w.tick.Lock()
	defer w.tick.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	w.mu.Lock()
	w.status.LastAttemptAt = now.UTC().Format(time.RFC3339Nano)
	w.mu.Unlock()
	err := w.visit(ctx, now)
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
func (w *MetricAggregateWorker) visit(ctx context.Context, now time.Time) error {
	if w.repo == nil {
		return validationError("NF_METRIC_SOURCE_UNAVAILABLE", "aggregation repository required")
	}
	scan, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	filter := bson.M{"enabled": true, "collectorProfile": CollectorHTTPMetrics, "identityState": IdentityInventoryAuthoritative}
	if w.after != "" {
		filter["_id"] = bson.M{"$gt": w.after}
	}
	cursor, err := w.repo.targets.Find(scan, filter, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(17))
	if err != nil {
		return err
	}
	defer cursor.Close(scan)
	var targets []HealthTarget
	if err := cursor.All(scan, &targets); err != nil {
		return err
	}
	more := len(targets) > 16
	if more {
		targets = targets[:16]
	}
	start := now.Add(-5 * time.Minute).UTC().Truncate(time.Hour).Add(-time.Hour)
	var lastErr error
	for _, target := range targets {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		w.after = target.TargetID
		if err := w.buildHour(ctx, &target, start, now); err != nil {
			lastErr = err
		}
	}
	if !more {
		w.after = ""
	}
	return lastErr
}
func (w *MetricAggregateWorker) buildHour(ctx context.Context, target *HealthTarget, start, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	prior, err := w.repo.metricAggregate(ctx, aggregateBucketID(target.TargetID, start))
	if err != nil {
		return err
	}
	if prior != nil && prior.SourceComplete {
		return nil
	}
	// Fail closed if current Inventory identity cannot be checked. This never
	// derives ownership from endpoint/name or changes the target configuration.
	if w.check == nil {
		return validationError("NF_METRIC_IDENTITY_UNAVAILABLE", "Inventory identity reader required")
	}
	if err := w.check(ctx, target); err != nil {
		return err
	}
	batch, err := w.repo.AggregateOutcomes(ctx, target.TargetID, target.ResourceID, start.Add(-time.Duration(ThresholdMaxGapSeconds(target))*time.Second), start.Add(time.Hour))
	if err != nil {
		return err
	}
	current, err := w.repo.GetTarget(ctx, target.TargetID)
	if err != nil {
		return err
	}
	if current.Revision != target.Revision || !current.Enabled {
		return ErrRevisionConflict
	}
	if err := w.check(ctx, current); err != nil {
		return err
	}
	bucket := BuildMetricHour(target, start, batch, now)
	revision := int64(0)
	if prior != nil {
		revision = prior.Revision
	}
	return w.repo.saveMetricAggregate(ctx, &bucket, revision)
}
