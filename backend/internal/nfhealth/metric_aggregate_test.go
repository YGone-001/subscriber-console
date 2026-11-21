package nfhealth

import (
	"math"
	"testing"
	"time"
)

func aggregateTarget() *HealthTarget {
	return &HealthTarget{TargetID: "target", ResourceID: "resource", IdentityState: IdentityInventoryAuthoritative, Enabled: true, CollectorProfile: CollectorHTTPMetrics, MetricsEndpoint: "https://exporter.example/metrics", IntervalSeconds: 120, Revision: 1}
}
func aggregateObservation(target *HealthTarget, at time.Time, value float64, identity string) CollectionResult {
	code := 200
	sample := &HealthSample{SampleID: at.Format(time.RFC3339Nano), RunID: at.Format(time.RFC3339Nano), TargetID: target.TargetID, ResourceID: target.ResourceID, CollectedAt: at.Format(time.RFC3339Nano), WindowBinding: windowBinding(target), WindowIdentity: identity,
		Probes:  []ProbeEvidence{{Family: ProbeFamilyMetrics, Measured: true, State: StateHealthy, Endpoint: target.MetricsEndpoint, MeasuredAt: at.Format(time.RFC3339Nano), HTTPStatus: &code}},
		Metrics: []MetricSample{{Key: MetricAggregateMetric, Value: value, Type: "gauge", Unit: "bytes", Category: CategoryResource, Source: "metrics_endpoint", ScopeVerified: true, CollectedAt: at.Format(time.RFC3339Nano)}, {Key: "process_start_time_seconds", Value: 1000, Type: "gauge", Unit: "seconds", Category: CategoryResource, Source: "metrics_endpoint", ScopeVerified: true, CollectedAt: at.Format(time.RFC3339Nano)}}}
	return CollectionResult{Run: HealthRun{RunID: sample.RunID, SampleID: sample.SampleID, TargetID: target.TargetID, ResourceID: target.ResourceID, StartedAt: sample.CollectedAt, Status: RunStatusSuccess, MetricRecorded: true}, Sample: sample}
}

func TestMetricHourPartitionsCountsAndObservedCoverage(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	rows := []CollectionResult{}
	for i := -1; i <= 30; i++ {
		rows = append(rows, aggregateObservation(target, start.Add(time.Duration(i)*2*time.Minute), float64(i+2), "epoch-a"))
	}
	bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if !bucket.SourceComplete || len(bucket.Segments) != 1 {
		t.Fatalf("unexpected bucket %+v", bucket)
	}
	s := bucket.Segments[0]
	if s.Count != 30 || s.Min != 2 || s.Max != 31 || s.Sum != 495 || s.Mean != 16.5 || s.CoveredSeconds != 3600 {
		t.Fatalf("boundary count/coverage: %+v", s)
	}
	// A leading boundary value is never counted a second time in the next hour.
	next := BuildMetricHour(target, start.Add(time.Hour), MetricOutcomeBatch{Outcomes: []CollectionResult{rows[len(rows)-2], rows[len(rows)-1]}}, start.Add(3*time.Hour))
	if next.Segments[0].Count != 1 || next.Segments[0].Sum != 32 || next.Segments[0].CoveredSeconds != 0 {
		t.Fatalf("boundary double count %+v", next)
	}
}

func TestMetricHourDoesNotBridgeGapsOrIncarnations(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	rows := []CollectionResult{}
	for _, v := range []struct {
		minute int
		epoch  string
	}{{0, "a"}, {2, "a"}, {4, "b"}, {6, "b"}, {20, "b"}, {22, "b"}} {
		rows = append(rows, aggregateObservation(target, start.Add(time.Duration(v.minute)*time.Minute), 10, v.epoch))
	}
	missing := aggregateObservation(target, start.Add(21*time.Minute), 10, "b")
	missing.Sample = nil
	rows = append(rows, missing)
	bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 4 || bucket.Quality != "partial" {
		t.Fatalf("joined incompatible segments %+v", bucket)
	}
	covered := 0.0
	for _, s := range bucket.Segments {
		covered += s.CoveredSeconds
	}
	if covered != 240 {
		t.Fatalf("covered across missing/gap/epoch: %f", covered)
	}
	rows[0].Sample.Metrics[0].ScopeVerified = false
	bucket = BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows, More: true}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 0 || bucket.SourceComplete || bucket.Reason != "source_budget" {
		t.Fatal("truncated source presented statistics")
	}
}

func TestMetricHourRejectsAmbiguityAndInvalidValues(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	for _, mutate := range []func(*HealthSample){func(s *HealthSample) { s.WindowIdentity = "" }, func(s *HealthSample) { s.Metrics[0].ScopeVerified = false }, func(s *HealthSample) { s.Metrics[0].Value = math.NaN() }, func(s *HealthSample) { s.Metrics[0].Type = "counter" }, func(s *HealthSample) { s.WindowBinding = "old-config" }} {
		row := aggregateObservation(target, start, 10, "a")
		mutate(row.Sample)
		bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: []CollectionResult{row}}, start.Add(2*time.Hour))
		if len(bucket.Segments) != 0 {
			t.Fatal("accepted invalid historical measurement")
		}
	}
	row := aggregateObservation(target, start, 0, "a")
	bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: []CollectionResult{row, row}}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 0 || bucket.Excluded["duplicate_time"] != 2 {
		t.Fatal("equal instants were counted")
	}
	bucket = BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: []CollectionResult{row}}, start.Add(2*time.Hour))
	if bucket.Segments[0].Count != 1 || bucket.Segments[0].Mean != 0 || bucket.Segments[0].CoveredSeconds != 0 {
		t.Fatal("measured zero confused with missing coverage")
	}
}

func TestMetricHourBoundaryCoverageIsIndependentOfSampleCount(t *testing.T) {
	target := aggregateTarget()
	target.IntervalSeconds = 3600
	start := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	before := aggregateObservation(target, start.Add(-30*time.Minute), 100, "a")
	boundary := aggregateObservation(target, start.Add(time.Hour), 200, "a")
	bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: []CollectionResult{before, boundary}}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 0 || bucket.CoveredSeconds != 3600 {
		t.Fatalf("interval coverage depended on inside sample count: %+v", bucket)
	}
}

func TestMetricHourSegmentAndNumericBudgetsDiscardStatistics(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	rows := []CollectionResult{}
	for i := 0; i <= MaxAggregateSegments; i++ {
		rows = append(rows, aggregateObservation(target, start.Add(time.Duration(i)*time.Minute), 10, string(rune('a'+i))))
	}
	bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if bucket.SourceComplete || bucket.Reason != "segment_budget" || len(bucket.Segments) != 0 || bucket.CoveredSeconds != 0 {
		t.Fatal("segment overflow returned partial statistics")
	}
	rows = []CollectionResult{aggregateObservation(target, start, math.MaxFloat64, "a"), aggregateObservation(target, start.Add(time.Minute), math.MaxFloat64, "a")}
	bucket = BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if bucket.SourceComplete || bucket.Reason != "numeric_overflow" || len(bucket.Segments) != 0 {
		t.Fatal("sum overflow published an invalid mean")
	}
}
