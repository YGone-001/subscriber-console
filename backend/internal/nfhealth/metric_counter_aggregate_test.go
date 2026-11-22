package nfhealth

import (
	"testing"
	"time"
)

// counterObservation builds one recorded sample carrying the approved counter
// and the exporter incarnation proof.
func counterObservation(target *HealthTarget, at time.Time, value float64, identity string) CollectionResult {
	code := 200
	stamp := at.Format(time.RFC3339Nano)
	sample := &HealthSample{
		SampleID: stamp, RunID: stamp, TargetID: target.TargetID, ResourceID: target.ResourceID, CollectedAt: stamp,
		WindowBinding: windowBinding(target), WindowIdentity: identity,
		Probes: []ProbeEvidence{{Family: ProbeFamilyMetrics, Measured: true, State: StateHealthy, Endpoint: target.MetricsEndpoint, MeasuredAt: stamp, HTTPStatus: &code}},
		Metrics: []MetricSample{
			{Key: MetricCounterMetric, Value: value, Type: "counter", Unit: "seconds", Category: CategoryResource, Source: "metrics_endpoint", ScopeVerified: true, CollectedAt: stamp},
			{Key: "process_start_time_seconds", Value: 1000, Type: "gauge", Unit: "seconds", Category: CategoryResource, Source: "metrics_endpoint", ScopeVerified: true, CollectedAt: stamp},
		},
	}
	return CollectionResult{Run: HealthRun{RunID: sample.RunID, SampleID: sample.SampleID, TargetID: target.TargetID, ResourceID: target.ResourceID, StartedAt: stamp, Status: RunStatusSuccess, MetricRecorded: true}, Sample: sample}
}

func TestMetricCounterHourNeverCountsBoundaryIntervals(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	base := start.Add(-2 * time.Minute)
	rows := []CollectionResult{}
	for i := 0; i <= 32; i++ {
		rows = append(rows, counterObservation(target, base.Add(time.Duration(i)*2*time.Minute), 60*float64(i), "epoch-a"))
	}
	bucket := BuildMetricCounterHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if bucket.MetricType != "counter" || bucket.Metric != MetricCounterMetric || bucket.Version != MetricCounterAggregateVersion {
		t.Fatalf("unexpected counter identity %+v", bucket)
	}
	if len(bucket.Segments) != 1 {
		t.Fatalf("segments = %+v", bucket.Segments)
	}
	segment := bucket.Segments[0]
	// 30 observations inside the hour, so 29 inside intervals. The interval that
	// straddles 10:00 is counted in neither hour.
	if segment.Count != 30 || segment.DeltaCount != 29 || segment.DeltaSum != 1740 {
		t.Fatalf("delta accounting = %+v", segment)
	}
	if segment.CoveredSeconds != 3480 || segment.Rate == nil || *segment.Rate != 0.5 {
		t.Fatalf("rate = %v over %v seconds", segment.Rate, segment.CoveredSeconds)
	}
	// The cumulative total is never averaged into gauge statistics.
	if segment.Sum != 0 || segment.Mean != 0 || segment.Min != 0 || segment.Max != 0 {
		t.Fatalf("counter segment carried gauge statistics: %+v", segment)
	}
	if bucket.P95State != P95NotProvided {
		t.Fatalf("counter bucket published a percentile state %q", bucket.P95State)
	}
	next := BuildMetricCounterHour(target, start.Add(time.Hour), MetricOutcomeBatch{Outcomes: rows}, start.Add(3*time.Hour))
	if len(next.Segments) != 1 || next.Segments[0].DeltaCount != 1 || next.Segments[0].DeltaSum != 60 {
		t.Fatalf("straddling interval was counted twice: %+v", next.Segments)
	}
}

func TestMetricCounterHourTreatsResetAsBreakNotNegativeDelta(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	values := []float64{100, 160, 220, 10, 70}
	rows := []CollectionResult{}
	for i, value := range values {
		rows = append(rows, counterObservation(target, start.Add(time.Duration(i)*2*time.Minute), value, "epoch-a"))
	}
	bucket := BuildMetricCounterHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if bucket.Excluded["counter_reset"] != 1 || len(bucket.Segments) != 2 {
		t.Fatalf("reset was not isolated: %+v", bucket)
	}
	if bucket.Segments[0].DeltaSum != 120 || bucket.Segments[0].DeltaCount != 2 {
		t.Fatalf("pre-reset deltas = %+v", bucket.Segments[0])
	}
	if bucket.Segments[1].DeltaSum != 60 || bucket.Segments[1].DeltaCount != 1 {
		t.Fatalf("post-reset deltas = %+v", bucket.Segments[1])
	}
	for _, segment := range bucket.Segments {
		if segment.DeltaSum < 0 {
			t.Fatalf("negative increment published: %+v", segment)
		}
	}
}

func TestMetricCounterHourKeepsZeroTrafficApartFromMissingMeasurement(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	rows := []CollectionResult{}
	for i := 0; i < 3; i++ {
		rows = append(rows, counterObservation(target, start.Add(time.Duration(i)*2*time.Minute), 500, "epoch-a"))
	}
	bucket := BuildMetricCounterHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 1 || bucket.Segments[0].Rate == nil || *bucket.Segments[0].Rate != 0 {
		t.Fatalf("measured zero traffic was not published as zero: %+v", bucket.Segments)
	}
	if bucket.Segments[0].DeltaCount != 2 || bucket.Segments[0].CoveredSeconds != 240 {
		t.Fatalf("zero-delta intervals = %+v", bucket.Segments[0])
	}
	empty := BuildMetricCounterHour(target, start, MetricOutcomeBatch{}, start.Add(2*time.Hour))
	if len(empty.Segments) != 0 || empty.Reason != "no_valid_observations" || empty.Quality != "unavailable" {
		t.Fatalf("missing measurement invented traffic: %+v", empty)
	}
	single := BuildMetricCounterHour(target, start, MetricOutcomeBatch{Outcomes: rows[:1]}, start.Add(2*time.Hour))
	if len(single.Segments) != 1 || single.Segments[0].Rate != nil || single.Reason != "no_valid_intervals" || single.Quality != "partial" {
		t.Fatalf("single observation produced a rate: %+v", single)
	}
}

func TestMetricCounterHourSplitsOnGapsAndRejectsDuplicates(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	rows := []CollectionResult{
		counterObservation(target, start, 100, "epoch-a"),
		counterObservation(target, start.Add(2*time.Minute), 160, "epoch-a"),
		counterObservation(target, start.Add(30*time.Minute), 200, "epoch-a"),
	}
	bucket := BuildMetricCounterHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 2 || bucket.Segments[1].DeltaCount != 0 || bucket.Segments[1].Rate != nil {
		t.Fatalf("gap was bridged: %+v", bucket.Segments)
	}
	duplicated := []CollectionResult{rows[0], rows[0]}
	bucket = BuildMetricCounterHour(target, start, MetricOutcomeBatch{Outcomes: duplicated}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 0 || bucket.Excluded["duplicate_time"] != 2 {
		t.Fatalf("duplicate instants were counted: %+v", bucket)
	}
}

func TestMetricCounterNeverBecomesThresholdOrDailyInput(t *testing.T) {
	if ThresholdMetricApproved(MetricCounterMetric) || !AggregateMetricApproved(MetricCounterMetric) {
		t.Fatal("aggregation widened threshold eligibility")
	}
	for _, capability := range ThresholdCapabilities() {
		if capability.Metric == MetricCounterMetric && capability.Eligible {
			t.Fatal("counter became a threshold candidate")
		}
	}
	day := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	hour := BuildMetricCounterHour(aggregateTarget(), day, MetricOutcomeBatch{Outcomes: []CollectionResult{
		counterObservation(aggregateTarget(), day, 100, "epoch-a"),
		counterObservation(aggregateTarget(), day.Add(2*time.Minute), 160, "epoch-a"),
	}}, day.Add(48*time.Hour))
	merged := BuildMetricDay(aggregateTarget(), day, []MetricAggregateBucket{hour}, day.Add(48*time.Hour))
	if merged.Hours != 0 || merged.MissingHours != 24 || len(merged.Segments) != 0 {
		t.Fatalf("counter bucket entered the daily gauge rollup: %+v", merged)
	}
}

func TestMetricHistoryAcceptsCountersHourlyOnly(t *testing.T) {
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	start := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	query := MetricHistoryQuery{TargetID: "target", Metric: MetricCounterMetric, Series: "unlabeled", Resolution: MetricHourPeriod, From: start, To: start.Add(time.Hour), Limit: 200}
	if err := validateMetricHistory(query, now); err != nil {
		t.Fatalf("hourly counter read rejected: %v", err)
	}
	query.Resolution = MetricDayPeriod
	query.From = metricDayStart(start)
	query.To = query.From.Add(24 * time.Hour)
	if err := validateMetricHistory(query, now); err == nil {
		t.Fatal("daily counter read accepted")
	}
	query = MetricHistoryQuery{TargetID: "target", Metric: "process_open_fds", Series: "unlabeled", Resolution: MetricHourPeriod, From: start, To: start.Add(time.Hour), Limit: 200}
	if err := validateMetricHistory(query, now); err == nil {
		t.Fatal("unapproved metric accepted")
	}
}
