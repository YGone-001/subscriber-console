package nfhealth

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Collector orchestrates one bounded, read-only collection for a target.
type Collector struct {
	prober    *HTTPProber
	inspector *UnitInspector
	dest      *DestinationAllowlist
	units     *ServiceUnitAllowlist
	gate      *CollectionGate
	clock     Clock

	mu        sync.Mutex
	active    map[string]struct{}
	lastRunAt map[string]time.Time
}

// NewCollector constructs the collection orchestrator.
//
// The gate is shared with the scheduler and the manual collection endpoint so
// MaxGlobalConcurrent applies to manual and scheduled collections combined.
func NewCollector(prober *HTTPProber, inspector *UnitInspector, dest *DestinationAllowlist, units *ServiceUnitAllowlist) *Collector {
	return &Collector{
		prober:    prober,
		inspector: inspector,
		dest:      dest,
		units:     units,
		gate:      NewCollectionGate(),
		clock:     SystemClock{},
		active:    map[string]struct{}{},
		lastRunAt: map[string]time.Time{},
	}
}

// NewCollectorWithGate constructs a collector with an explicit shared gate and
// clock. Used by the scheduler wiring and by tests.
func NewCollectorWithGate(prober *HTTPProber, inspector *UnitInspector, dest *DestinationAllowlist, units *ServiceUnitAllowlist, gate *CollectionGate, clock Clock) *Collector {
	c := NewCollector(prober, inspector, dest, units)
	if gate != nil {
		c.gate = gate
	}
	if clock != nil {
		c.clock = clock
	}
	return c
}

// Gate exposes the shared admission gate for scheduling tests.
func (c *Collector) Gate() *CollectionGate { return c.gate }

// SetClock replaces the collector clock. Intended for tests.
func (c *Collector) SetClock(clock Clock) {
	if clock != nil {
		c.clock = clock
	}
}

// CollectionResult is the outcome of one bounded collection execution.
type CollectionResult struct {
	Run    HealthRun
	Sample *HealthSample
}

// Collect performs one bounded collection. It never mutates the network and
// never overwrites a previous valid measurement on failure.
//
// Admission is shared across manual and scheduled collection: the per-target
// slot rejects overlapping work on the same target, and the global gate bounds
// total concurrent collections to MaxGlobalConcurrent.
func (c *Collector) Collect(ctx context.Context, target *HealthTarget, initiatedBy string, scheduled bool) (*CollectionResult, error) {
	if target == nil {
		return nil, ErrNotFound
	}

	now := c.now()

	c.mu.Lock()
	if _, busy := c.active[target.TargetID]; busy {
		c.mu.Unlock()
		return nil, ErrInProgress
	}
	if last, ok := c.lastRunAt[target.TargetID]; ok {
		elapsed := now.Sub(last)
		if elapsed < MinIntervalSeconds*time.Second {
			c.mu.Unlock()
			return nil, ErrRateLimited
		}
	}
	c.active[target.TargetID] = struct{}{}
	c.mu.Unlock()

	// Shared global admission for manual and scheduled collections combined.
	// Both paths fail fast when the global bound is saturated so a manual
	// collection can never bypass the shared limit by blocking past it.
	if !c.gate.TryAcquire() {
		c.mu.Lock()
		delete(c.active, target.TargetID)
		c.mu.Unlock()
		return nil, ErrInProgress
	}

	defer func() {
		c.gate.Release()
		c.mu.Lock()
		delete(c.active, target.TargetID)
		c.mu.Unlock()
	}()

	started := c.now().UTC()
	run := HealthRun{
		RunID:         newUUID(),
		SchemaVersion: SchemaVersion,
		TargetID:      target.TargetID,
		CandidateID:   target.CandidateID,
		StartedAt:     started.Format(time.RFC3339Nano),
		InitiatedBy:   initiatedBy,
	}
	if initiatedBy == "" {
		if scheduled {
			run.InitiatedBy = "scheduler"
		} else {
			run.InitiatedBy = "system"
		}
	}

	deadline := time.Duration(TotalDeadlineSeconds) * time.Second
	collectCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()

	layers := LayerSet{
		Process: LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
		},
		Interface: LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
		},
		Service: LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
		},
	}

	var metrics []MetricSample
	var errCode, errSummary string
	status := RunStatusSuccess

	// L1 process evidence.
	if strings.TrimSpace(target.ServiceUnit) != "" && target.ServiceKind != "none" && c.inspector != nil {
		ev := c.inspector.Inspect(collectCtx, target.ServiceUnit, target.ServiceKind)
		layers.Process = EvaluateProcessLayer(ev)
	} else {
		layers.Process = LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
			Measured:     false,
		}
	}

	// L2 interface + L3 service evidence through the bounded metrics probe.
	var probe *ProbeResult
	if strings.TrimSpace(target.MetricsEndpoint) != "" {
		p, perr := c.prober.Probe(collectCtx, target.MetricsEndpoint, c.dest)
		if perr != nil {
			layers.Interface = LayerEvidence{
				State:        StateNotConfigured,
				EvidenceKind: EvidenceNone,
				Reason:       "invalid_endpoint",
				Measured:     false,
			}
			status = RunStatusFailed
			errCode = "NF_HEALTH_COLLECTOR_UNAVAILABLE"
			errSummary = "metrics endpoint rejected"
		} else {
			probe = p
			var parseErr error
			parsedCount := 0
			if probe.Outcome == InterfaceValid {
				outcome, perr2 := ParsePrometheusText(probe.Body, started.Format(time.RFC3339Nano), nil)
				if perr2 != nil {
					parseErr = perr2
					layers.Interface = EvaluateInterfaceLayer(probe, parseErr, 0)
					layers.Service = EvaluateServiceLayer(nil, parseErr)
					status = RunStatusPartial
					errCode = "NF_HEALTH_METRICS_INVALID"
					errSummary = "metrics response could not be parsed"
				} else {
					metrics = outcome.Samples
					parsedCount = len(outcome.Samples)
					layers.Interface = EvaluateInterfaceLayer(probe, nil, parsedCount)
					layers.Service = EvaluateServiceLayer(outcome.Samples, nil)
					if parsedCount == 0 && status == RunStatusSuccess {
						status = RunStatusPartial
						errCode = "NF_HEALTH_METRICS_INVALID"
						errSummary = "no supported metric families were exported"
					}
				}
			} else {
				layers.Interface = EvaluateInterfaceLayer(probe, nil, 0)
				layers.Service = EvaluateServiceLayer(nil, fmt.Errorf("interface not valid"))
				if status == RunStatusSuccess {
					status = RunStatusPartial
					errCode = "NF_HEALTH_METRICS_INVALID"
					errSummary = probe.ErrorMessage
				}
			}
			if collectCtx.Err() != nil && status == RunStatusSuccess {
				status = RunStatusFailed
				errCode = "NF_HEALTH_COLLECTION_TIMEOUT"
				errSummary = "collection deadline exceeded"
			}
		}
	} else {
		layers.Interface = LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
			Measured:     false,
		}
		layers.Service = LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
			Measured:     false,
		}
	}

	measured := 0
	for _, m := range []bool{layers.Process.Measured, layers.Interface.Measured, layers.Service.Measured} {
		if m {
			measured++
		}
	}

	completed := c.now().UTC()
	run.CompletedAt = completed.Format(time.RFC3339Nano)
	run.Status = status
	run.LayersMeasured = measured
	run.ErrorCode = errCode
	run.ErrorSummary = errSummary

	// A fully failed collection still records the run, but a sample is only
	// persisted when at least one layer produced real evidence. The sample
	// expiration is a BSON Date so the MongoDB TTL index can consume it.
	var sample *HealthSample
	if measured > 0 {
		sample = &HealthSample{
			SampleID:      newUUID(),
			SchemaVersion: SchemaVersion,
			TargetID:      target.TargetID,
			RunID:         run.RunID,
			CandidateID:   target.CandidateID,
			CollectedAt:   started.Format(time.RFC3339Nano),
			ExpiresAt:     NewBSONTime(started.AddDate(0, 0, DefaultRetentionDays)),
			Layers:        layers,
			Metrics:       metrics,
		}
		if sample.Metrics == nil {
			sample.Metrics = []MetricSample{}
		}
		run.SampleID = sample.SampleID
	}

	c.mu.Lock()
	c.lastRunAt[target.TargetID] = c.now()
	c.mu.Unlock()

	return &CollectionResult{Run: run, Sample: sample}, nil
}

// InProgress reports whether a collection is currently running for the target.
func (c *Collector) InProgress(targetID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.active[targetID]
	return ok
}

func (c *Collector) now() time.Time {
	if c.clock == nil {
		return time.Now().UTC()
	}
	return c.clock.Now().UTC()
}
