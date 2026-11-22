package nfhealth

import (
	"testing"
	"time"
)

func TestNearestRankP95IsExact(t *testing.T) {
	cases := []struct {
		values []float64
		want   float64
	}{
		{[]float64{7}, 7},
		{[]float64{1, 2, 3, 4, 5}, 5},
		{[]float64{20, 1, 19, 2}, 20},
		{[]float64{4, 1, 3, 2, 5, 6}, 6},
	}
	for _, item := range cases {
		if got := nearestRankP95(append([]float64(nil), item.values...)); got != item.want {
			t.Fatalf("nearest rank of %v = %v, want %v", item.values, got, item.want)
		}
	}
	values := make([]float64, 100)
	for i := range values {
		values[i] = float64(i + 1)
	}
	// ceil(0.95*100)-1 = 94, the 95th smallest value.
	if got := nearestRankP95(values); got != 95 {
		t.Fatalf("p95 of 1..100 = %v", got)
	}
	twenty := make([]float64, 20)
	for i := range twenty {
		twenty[i] = float64(20 - i)
	}
	// ceil(0.95*20)-1 = 18, the 19th smallest value.
	if got := nearestRankP95(twenty); got != 19 {
		t.Fatalf("p95 of 1..20 = %v", got)
	}
}

func TestMetricHourP95StaysInsideOneSegment(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	rows := []CollectionResult{}
	for i := 0; i < 100; i++ {
		rows = append(rows, aggregateObservation(target, start.Add(time.Duration(i)*time.Second), float64(i+1), "epoch-a"))
	}
	bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if bucket.P95State != P95Complete || len(bucket.Segments) != 1 {
		t.Fatalf("unexpected percentile state %+v", bucket)
	}
	if bucket.Segments[0].P95 == nil || *bucket.Segments[0].P95 != 95 {
		t.Fatalf("segment p95 = %v, want 95", bucket.Segments[0].P95)
	}
	// Two identities in one hour keep two separate percentiles.
	rows = []CollectionResult{}
	for i := 0; i < 10; i++ {
		epoch := "epoch-a"
		if i >= 5 {
			epoch = "epoch-b"
		}
		rows = append(rows, aggregateObservation(target, start.Add(time.Duration(i)*time.Second), float64(i+1), epoch))
	}
	bucket = BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if len(bucket.Segments) != 2 || bucket.Segments[0].P95 == nil || bucket.Segments[1].P95 == nil {
		t.Fatalf("percentiles were merged across identities: %+v", bucket.Segments)
	}
	if *bucket.Segments[0].P95 != 5 || *bucket.Segments[1].P95 != 10 {
		t.Fatalf("per-segment percentiles = %v / %v", *bucket.Segments[0].P95, *bucket.Segments[1].P95)
	}
}

func TestMetricHourP95ReportsBudgetWithoutLosingStatistics(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	rows := []CollectionResult{}
	for i := 0; i <= MaxP95Samples; i++ {
		rows = append(rows, aggregateObservation(target, start.Add(time.Duration(i)*time.Second), float64(i+1), "epoch-a"))
	}
	bucket := BuildMetricHour(target, start, MetricOutcomeBatch{Outcomes: rows}, start.Add(2*time.Hour))
	if bucket.P95State != P95Budget {
		t.Fatalf("over-budget percentile reported %q", bucket.P95State)
	}
	segment := bucket.Segments[0]
	if segment.P95 != nil || segment.Count != MaxP95Samples+1 || bucket.Quality != "measured" || !bucket.SourceComplete {
		t.Fatalf("budget removed other statistics or invented a percentile: %+v", segment)
	}
}

func TestMetricDayNeverDerivesPercentile(t *testing.T) {
	target := aggregateTarget()
	day := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	hours := []MetricAggregateBucket{}
	for i := 0; i < 24; i++ {
		bucket := aggregateHourBucket(day.Add(time.Duration(i)*time.Hour), "epoch-a", []float64{float64(i), float64(i + 1)}, true)
		p95 := float64(i)
		bucket.P95State = P95Complete
		bucket.Segments[0].P95 = &p95
		hours = append(hours, bucket)
	}
	merged := BuildMetricDay(target, day, hours, day.Add(48*time.Hour))
	if merged.P95State != P95NotProvided {
		t.Fatalf("daily percentile state = %q", merged.P95State)
	}
	for _, segment := range merged.Segments {
		if segment.P95 != nil {
			t.Fatalf("daily segment derived a percentile from hourly percentiles: %+v", segment)
		}
	}
	if len(merged.Segments) != 1 || merged.Segments[0].Count != 48 || merged.Segments[0].Mean != 12 {
		t.Fatalf("daily merge changed while adding percentiles: %+v", merged.Segments)
	}
}
