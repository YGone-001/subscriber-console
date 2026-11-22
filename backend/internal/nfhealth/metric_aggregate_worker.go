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
	// Retention and repair bounds are published so an operator can tell a
	// missing bucket from a bucket outside the policy window.
	HourRetentionDays   int `json:"hourRetentionDays"`
	DayRetentionDays    int `json:"dayRetentionDays"`
	BackfillWindowHours int `json:"backfillWindowHours"`
	// RawRetentionDays is the raw sample policy. Older hours cannot be
	// reconstructed and stay missing instead of being published as zero.
	RawRetentionDays      int   `json:"rawRetentionDays"`
	HoursPublished        int64 `json:"hoursPublished"`
	CounterHoursPublished int64 `json:"counterHoursPublished"`
	AnalysesPublished     int64 `json:"analysesPublished"`
	TrendsPublished       int64 `json:"trendsPublished"`
	DaysPublished         int64 `json:"daysPublished"`
	BackfillRepairs       int64 `json:"backfillRepairs"`
}

// One opt-in worker visits 16 targets per minute. For each target it finalizes
// the newest closed hour and then repairs a bounded number of older missing or
// incomplete hours inside a bounded window, newest first. Every published hour
// rolls up the UTC day it belongs to.
// MetricAnalysisSink receives every published analysis record. It is optional:
// without a sink the records stay evidence only and can never become alerts.
type MetricAnalysisSink interface {
	PublishMetricAnalysis(context.Context, *HealthTarget, MetricAnalysis) error
}

type MetricAggregateWorker struct {
	repo          *Repository
	analysisSink  MetricAnalysisSink
	check         func(context.Context, *HealthTarget) error
	hourRetention time.Duration
	dayRetention  time.Duration
	mu            sync.RWMutex
	tick          sync.Mutex
	status        MetricAggregateStatus
	after         string
	cancel        context.CancelFunc
	done          chan struct{}
}

func NewMetricAggregateWorker(repo *Repository, enabled bool, check func(context.Context, *HealthTarget) error) *MetricAggregateWorker {
	state := "disabled"
	if enabled {
		state = "starting"
	}
	return &MetricAggregateWorker{
		repo:          repo,
		check:         check,
		hourRetention: time.Duration(DefaultMetricHourRetentionDays) * 24 * time.Hour,
		dayRetention:  time.Duration(DefaultMetricDayRetentionDays) * 24 * time.Hour,
		status: MetricAggregateStatus{
			Enabled:             enabled,
			State:               state,
			HourRetentionDays:   DefaultMetricHourRetentionDays,
			DayRetentionDays:    DefaultMetricDayRetentionDays,
			BackfillWindowHours: MetricBackfillWindowHours,
			RawRetentionDays:    DefaultRetentionDays,
		},
	}
}

// SetAnalysisSink wires the optional alert evaluator. It is called before the
// worker starts, so no tick can observe a half-configured sink.
func (w *MetricAggregateWorker) SetAnalysisSink(sink MetricAnalysisSink) { w.analysisSink = sink }

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
	latest := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-time.Hour)
	var lastErr error
	for _, target := range targets {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		w.after = target.TargetID
		if err := w.visitTarget(ctx, &target, latest, now); err != nil {
			lastErr = err
		}
	}
	if !more {
		w.after = ""
	}
	return lastErr
}

// planMetricHours selects repair slots newest first inside the bounded window.
// The newest closed hour is always considered; older slots are revisited only
// while the per-tick budget lasts, so a long outage is repaired progressively.
// A slot whose raw samples are already past their own retention cannot be
// reconstructed and is skipped: it stays missing rather than being published
// as zero.
func planMetricHours(latest time.Time, windowHours int, published map[time.Time]MetricAggregateBucket, now time.Time, rawRetentionDays int) []time.Time {
	if windowHours < 1 {
		windowHours = 1
	}
	windowStart := latest.Add(-time.Duration(windowHours-1) * time.Hour)
	expiredBefore := time.Time{}
	if rawRetentionDays > 0 {
		expiredBefore = now.Add(-time.Duration(rawRetentionDays) * 24 * time.Hour)
	}
	slots := []time.Time{}
	for slot := latest; !slot.Before(windowStart); slot = slot.Add(-time.Hour) {
		if bucket, ok := published[slot]; ok && bucket.SourceComplete {
			continue
		}
		if !expiredBefore.IsZero() && slot.Before(expiredBefore) {
			continue
		}
		if len(slots) >= MaxMetricHoursPerTick {
			continue
		}
		slots = append(slots, slot)
	}
	return slots
}

func (w *MetricAggregateWorker) visitTarget(ctx context.Context, target *HealthTarget, latest, now time.Time) error {
	windowStart := latest.Add(-time.Duration(MetricBackfillWindowHours-1) * time.Hour)
	existing, err := w.repo.metricAggregateHours(ctx, target.TargetID, windowStart, latest.Add(time.Hour))
	if err != nil {
		return err
	}
	published := make(map[time.Time]MetricAggregateBucket, len(existing))
	for _, bucket := range existing {
		published[bucket.Start.UTC()] = bucket
	}
	var lastErr error
	// Repair days that have published hours but no daily bucket. This covers a
	// rollup that failed after a successful hour write, and hours published
	// before daily rollups existed.
	days := make(map[time.Time]bool, 3)
	for start := range published {
		days[metricDayStart(start)] = true
	}
	for dayStart := range days {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		prior, err := w.repo.metricAggregate(ctx, dayBucketID(target.TargetID, dayStart))
		if err != nil {
			lastErr = err
			continue
		}
		if prior != nil {
			continue
		}
		if err := w.rebuildDay(ctx, target, dayStart, now); err != nil {
			lastErr = err
		}
	}
	for _, slot := range planMetricHours(latest, MetricBackfillWindowHours, published, now, DefaultRetentionDays) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		gaugeWritten, counterWritten, backfill, err := w.buildHour(ctx, target, slot, latest, now)
		if err != nil {
			lastErr = err
			continue
		}
		if gaugeWritten || counterWritten {
			w.mu.Lock()
			if gaugeWritten {
				w.status.HoursPublished++
			}
			if counterWritten {
				w.status.CounterHoursPublished++
			}
			if backfill {
				w.status.BackfillRepairs++
			}
			w.mu.Unlock()
		}
		if !gaugeWritten {
			continue
		}
		// The changed hour is also compared with its own recent baseline. The
		// analysis is a stored explanation, never an alert or a health change.
		if err := w.analyzeHour(ctx, target, slot, now); err != nil {
			lastErr = err
		}
		if err := w.analyzeTrendHour(ctx, target, slot, now); err != nil {
			lastErr = err
		}
		// A changed hour invalidates the day it belongs to. The daily bucket is
		// recomputed from its published hours and keeps a digest of the exact
		// revisions it consumed, so a later analysis can detect staleness.
		if err := w.rebuildDay(ctx, target, metricDayStart(slot), now); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

func (w *MetricAggregateWorker) buildHour(ctx context.Context, target *HealthTarget, start, latest, now time.Time) (gaugeWritten, counterWritten, backfill bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	priorGauge, err := w.repo.metricAggregate(ctx, aggregateBucketID(target.TargetID, start))
	if err != nil {
		return false, false, false, err
	}
	priorCounter, err := w.repo.metricAggregate(ctx, counterBucketID(target.TargetID, start))
	if err != nil {
		return false, false, false, err
	}
	gaugeFinal := priorGauge != nil && priorGauge.SourceComplete
	counterFinal := priorCounter != nil && priorCounter.SourceComplete
	if gaugeFinal && counterFinal {
		return false, false, false, nil
	}
	// Fail closed if current Inventory identity cannot be checked. This never
	// derives ownership from endpoint/name or changes the target configuration.
	if w.check == nil {
		return false, false, false, validationError("NF_METRIC_IDENTITY_UNAVAILABLE", "Inventory identity reader required")
	}
	if err := w.check(ctx, target); err != nil {
		return false, false, false, err
	}
	// One bounded source read serves both derived series of the same hour.
	batch, err := w.repo.AggregateOutcomes(ctx, target.TargetID, target.ResourceID, start.Add(-time.Duration(ThresholdMaxGapSeconds(target))*time.Second), start.Add(time.Hour))
	if err != nil {
		return false, false, false, err
	}
	current, err := w.repo.GetTarget(ctx, target.TargetID)
	if err != nil {
		return false, false, false, err
	}
	if current.Revision != target.Revision || !current.Enabled {
		return false, false, false, ErrRevisionConflict
	}
	if err := w.check(ctx, current); err != nil {
		return false, false, false, err
	}
	// A repair slot with no recorded evidence at all is not published, even when
	// one of the two derived series already exists. An empty document would claim
	// a read that never happened and would inflate the day rollup; the read
	// contract reports the hour as missing instead.
	if start.Before(latest) && len(batch.Outcomes) == 0 && batch.Gaps == 0 {
		return false, false, false, nil
	}
	save := func(bucket MetricAggregateBucket, prior *MetricAggregateBucket) (bool, error) {
		revision := int64(0)
		if prior != nil {
			if metricAggregateUnchanged(*prior, bucket) {
				return false, nil
			}
			revision = prior.Revision
		}
		if err := w.repo.saveMetricAggregateRetained(ctx, &bucket, revision, w.hourRetention); err != nil {
			return false, err
		}
		return true, nil
	}
	if !gaugeFinal {
		gaugeWritten, err = save(BuildMetricHour(target, start, batch, now), priorGauge)
		if err != nil {
			return gaugeWritten, false, false, err
		}
	}
	if !counterFinal {
		counterBucket := BuildMetricCounterHour(target, start, batch, now)
		// A repair slot never publishes an empty counter document: the gauge
		// bucket already records that hour, and an empty counter row would only
		// restate the absence of inside observations.
		if len(counterBucket.Segments) > 0 || !start.Before(latest) {
			counterWritten, err = save(counterBucket, priorCounter)
			if err != nil {
				return gaugeWritten, counterWritten, false, err
			}
		}
	}
	return gaugeWritten, counterWritten, start.Before(latest), nil
}

func (w *MetricAggregateWorker) analyzeHour(ctx context.Context, target *HealthTarget, start, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	current, err := w.repo.metricAggregate(ctx, aggregateBucketID(target.TargetID, start))
	if err != nil || current == nil {
		return err
	}
	baseline, err := w.repo.metricAggregateHours(ctx, target.TargetID, start.Add(-time.Duration(MetricAnalysisBaselineHours)*time.Hour), start)
	if err != nil {
		return err
	}
	analysis := BuildMetricAnalysis(target, *current, baseline, now)
	prior, err := w.repo.metricAnalysis(ctx, analysis.ID)
	if err != nil {
		return err
	}
	// The record is rewritten only when the analyzed revision, the consumed
	// baseline revisions or the frozen policy changed.
	if prior != nil && prior.SourceRevision == analysis.SourceRevision && prior.BaselineDigest == analysis.BaselineDigest &&
		prior.PolicyVersion == analysis.PolicyVersion && prior.AlgorithmVersion == analysis.AlgorithmVersion {
		return nil
	}
	if err := w.repo.saveMetricAnalysis(ctx, &analysis, prior); err != nil {
		return err
	}
	w.mu.Lock()
	w.status.AnalysesPublished++
	w.mu.Unlock()
	// Alert evaluation is best-effort: the evidence is already stored, so a sink
	// failure must not fail the aggregation tick.
	if w.analysisSink != nil {
		_ = w.analysisSink.PublishMetricAnalysis(ctx, target, analysis)
	}
	return nil
}

// analyzeTrendHour fits the last eight hours for one evaluated hour. It reuses
// the same idempotency rule as the baseline analysis: the record is rewritten
// only when the newest bucket revision or the consumed window revisions change.
func (w *MetricAggregateWorker) analyzeTrendHour(ctx context.Context, target *HealthTarget, start, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	current, err := w.repo.metricAggregate(ctx, aggregateBucketID(target.TargetID, start))
	if err != nil || current == nil || !current.SourceComplete {
		return err
	}
	// One extra hour before the window lets the preceding evaluation run with a
	// complete window, which is what confirmation compares against.
	buckets, err := w.repo.metricAggregateHours(ctx, target.TargetID, start.Add(-time.Duration(MetricTrendWindowHours+1)*time.Hour), start.Add(time.Hour))
	if err != nil {
		return err
	}
	trend := BuildMetricTrend(target, buckets, start, now)
	prior, err := w.repo.metricAnalysis(ctx, trend.ID)
	if err != nil {
		return err
	}
	if prior != nil && prior.SourceRevision == trend.SourceRevision && prior.BaselineDigest == trend.BaselineDigest &&
		prior.PolicyVersion == trend.PolicyVersion && prior.AlgorithmVersion == trend.AlgorithmVersion {
		return nil
	}
	if err := w.repo.saveMetricAnalysis(ctx, &trend, prior); err != nil {
		return err
	}
	w.mu.Lock()
	w.status.TrendsPublished++
	w.mu.Unlock()
	if w.analysisSink != nil {
		_ = w.analysisSink.PublishMetricAnalysis(ctx, target, trend)
	}
	return nil
}

// rebuildDay recomputes one UTC day from its published hours. It writes only

// when the merged statistics or the consumed revision digest changed.
func (w *MetricAggregateWorker) rebuildDay(ctx context.Context, target *HealthTarget, dayStart, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	prior, err := w.repo.metricAggregate(ctx, dayBucketID(target.TargetID, dayStart))
	if err != nil {
		return err
	}
	hours, err := w.repo.metricAggregateHours(ctx, target.TargetID, dayStart, dayStart.Add(24*time.Hour))
	if err != nil {
		return err
	}
	bucket := BuildMetricDay(target, dayStart, hours, now)
	revision := int64(0)
	if prior != nil {
		if metricAggregateUnchanged(*prior, bucket) {
			return nil
		}
		revision = prior.Revision
	}
	if err := w.repo.saveMetricAggregateRetained(ctx, &bucket, revision, w.dayRetention); err != nil {
		return err
	}
	w.mu.Lock()
	w.status.DaysPublished++
	w.mu.Unlock()
	return nil
}
