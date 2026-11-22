package nfhealth

import (
	"testing"
	"time"
)

// trendWindow builds `count` consecutive hourly buckets ending at `end`
// (inclusive), oldest first.
func trendWindow(end time.Time, count int, value func(index int) float64) []MetricAggregateBucket {
	out := make([]MetricAggregateBucket, 0, count)
	for i := 0; i < count; i++ {
		start := end.Add(-time.Duration(count-1-i) * time.Hour)
		out = append(out, aggregateHourBucket(start, "trend-epoch", []float64{value(i)}, true))
	}
	return out
}

func TestMetricTrendReportsRisingAndFallingWithConfirmation(t *testing.T) {
	target := aggregateTarget()
	end := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	now := end.Add(2 * time.Hour)
	rising := BuildMetricTrend(target, trendWindow(end, MetricTrendWindowHours, func(i int) float64 {
		return float64(100*analysisMiB + i*2*analysisMiB)
	}), end, now)
	if rising.State != TrendRising || !rising.Confirmed {
		t.Fatalf("rising trend not confirmed: %+v", rising)
	}
	if rising.Slope == nil || *rising.Slope != float64(2*analysisMiB) || rising.TrendChange == nil || *rising.TrendChange != float64(14*analysisMiB) {
		t.Fatalf("slope/change = %v / %v", rising.Slope, rising.TrendChange)
	}
	if rising.Fit == nil || *rising.Fit < 0.99 || rising.EligibleBuckets != MetricTrendWindowHours || !rising.LastTwoConsecutive {
		t.Fatalf("fit/window = %+v", rising)
	}
	if rising.Kind != "trend" || rising.WindowHours != MetricTrendWindowHours || rising.MinTrendChange != MetricTrendMinChange || rising.MinFit != MetricTrendMinFit {
		t.Fatalf("trend policy not published: %+v", rising)
	}
	if !rising.ConfirmedFrom.Equal(end.Add(-time.Hour)) {
		t.Fatalf("confirmation must reference the previous hour: %v", rising.ConfirmedFrom)
	}
	falling := BuildMetricTrend(target, trendWindow(end, MetricTrendWindowHours, func(i int) float64 {
		return float64(200*analysisMiB - i*3*analysisMiB)
	}), end, now)
	if falling.State != TrendFalling || !falling.Confirmed || falling.Direction != "falling" {
		t.Fatalf("falling trend not confirmed: %+v", falling)
	}
}

func TestMetricTrendNeedsTwoConsecutiveEvaluations(t *testing.T) {
	target := aggregateTarget()
	end := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	now := end.Add(2 * time.Hour)
	// Seven buckets leave the preceding evaluation one short of its minimum, so
	// the trend is reported but cannot yet be an event.
	short := BuildMetricTrend(target, trendWindow(end, MetricTrendMinEligible, func(i int) float64 {
		return float64(100*analysisMiB + i*3*analysisMiB)
	}), end, now)
	if short.State != TrendRising || short.Confirmed {
		t.Fatalf("single evaluation produced an event: %+v", short)
	}
	if !short.ConfirmedFrom.IsZero() {
		t.Fatalf("unconfirmed trend carried a confirmation time: %v", short.ConfirmedFrom)
	}
}

func TestMetricTrendRejectsSpikesAndWeakFits(t *testing.T) {
	target := aggregateTarget()
	end := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	now := end.Add(2 * time.Hour)
	spike := BuildMetricTrend(target, trendWindow(end, MetricTrendWindowHours, func(i int) float64 {
		if i == MetricTrendWindowHours-1 {
			return float64(140 * analysisMiB)
		}
		return float64(100 * analysisMiB)
	}), end, now)
	if spike.State != TrendStable || spike.Reason != "weak_fit" {
		t.Fatalf("single spike became a trend: %+v", spike)
	}
	if spike.Fit == nil || *spike.Fit >= MetricTrendMinFit {
		t.Fatalf("fit quality = %v", spike.Fit)
	}
	slow := BuildMetricTrend(target, trendWindow(end, MetricTrendWindowHours, func(i int) float64 {
		return float64(100*analysisMiB + i*analysisMiB/2)
	}), end, now)
	if slow.State != TrendStable || slow.Reason != "change_below_floor" {
		t.Fatalf("sub-floor change became a trend: %+v", slow)
	}
}

func TestMetricTrendExplainsIncompleteWindows(t *testing.T) {
	target := aggregateTarget()
	end := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	now := end.Add(2 * time.Hour)
	cold := BuildMetricTrend(target, nil, end, now)
	if cold.State != AnalysisInsufficientData || cold.Reason != "cold_start" {
		t.Fatalf("cold start not explained: %+v", cold)
	}
	sparse := trendWindow(end, MetricTrendWindowHours, func(i int) float64 { return float64(100 * analysisMiB) })
	for i := 0; i < 3; i++ {
		sparse[i].Segments[0].CoveredSeconds = 600
	}
	if got := BuildMetricTrend(target, sparse, end, now); got.State != AnalysisInsufficientData || got.Reason != "trend_window_incomplete" || got.EligibleBuckets != 5 {
		t.Fatalf("low coverage accepted: %+v", got)
	}
	// The previous hour is missing, so the window does not end on a continuous pair.
	broken := trendWindow(end, MetricTrendWindowHours, func(i int) float64 { return float64(100 * analysisMiB) })
	broken = append(broken[:MetricTrendWindowHours-2], broken[MetricTrendWindowHours-1:]...)
	if got := BuildMetricTrend(target, broken, end, now); got.State != AnalysisInsufficientData || got.Reason != "last_buckets_not_consecutive" {
		t.Fatalf("window without its newest pair accepted: %+v", got)
	}
	ambiguous := trendWindow(end, MetricTrendWindowHours, func(i int) float64 { return float64(100 * analysisMiB) })
	ambiguous[MetricTrendWindowHours-1].Segments = append(ambiguous[MetricTrendWindowHours-1].Segments, MetricAggregateSegment{Epoch: "other", Count: 1, Sum: 1, Min: 1, Max: 1, Mean: 1})
	if got := BuildMetricTrend(target, ambiguous, end, now); got.State != AnalysisInsufficientData || got.Reason != "current_bucket_incomplete" {
		t.Fatalf("ambiguous newest bucket accepted: %+v", got)
	}
}

func TestMetricTrendTracksWindowRevisions(t *testing.T) {
	target := aggregateTarget()
	end := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	now := end.Add(2 * time.Hour)
	buckets := trendWindow(end, MetricTrendWindowHours, func(i int) float64 {
		return float64(100*analysisMiB + i*2*analysisMiB)
	})
	first := BuildMetricTrend(target, buckets, end, now)
	again := BuildMetricTrend(target, buckets, end, now)
	if first.ID != again.ID || first.BaselineDigest != again.BaselineDigest || first.State != again.State {
		t.Fatalf("trend is not deterministic: %+v / %+v", first, again)
	}
	buckets[2].Revision = 7
	repaired := BuildMetricTrend(target, buckets, end, now)
	if repaired.BaselineDigest == first.BaselineDigest || repaired.ID != first.ID {
		t.Fatal("window repair was not detected without changing the trend identity")
	}
	if first.Kind == "baseline" || first.Kind != "trend" {
		t.Fatalf("trend kind = %q", first.Kind)
	}
}
