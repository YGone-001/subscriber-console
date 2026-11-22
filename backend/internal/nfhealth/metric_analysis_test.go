package nfhealth

import (
	"testing"
	"time"
)

const analysisMiB = 1 << 20

// analysisBaseline builds `count` hourly buckets ending at end, all with the
// same identity, so the analyzer sees a controlled training set.
func analysisBaseline(end time.Time, count int, epoch string, mean func(index int) float64) []MetricAggregateBucket {
	out := make([]MetricAggregateBucket, 0, count)
	for i := 0; i < count; i++ {
		start := end.Add(-time.Duration(count-i) * time.Hour)
		out = append(out, aggregateHourBucket(start, epoch, []float64{mean(i)}, true))
	}
	return out
}

func TestMetricAnalysisFlagsOutlierAgainstItsOwnBaseline(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	baseline := analysisBaseline(start, MetricAnalysisBaselineHours, "epoch-a", func(i int) float64 {
		return float64(100*analysisMiB + (i%2)*2*analysisMiB)
	})
	current := aggregateHourBucket(start, "epoch-a", []float64{140 * analysisMiB}, true)
	analysis := BuildMetricAnalysis(target, current, baseline, start.Add(2*time.Hour))
	if analysis.State != AnalysisAnomaly || analysis.Direction != "rising" {
		t.Fatalf("outlier not reported: %+v", analysis)
	}
	if analysis.Score == nil || *analysis.Score < MetricAnalysisScoreThreshold || analysis.ScoreMethod != AnalysisScoreRobustZ {
		t.Fatalf("robust score = %v (%s)", analysis.Score, analysis.ScoreMethod)
	}
	if analysis.BaselineEligible != MetricAnalysisBaselineHours || analysis.BaselineCoverage != 1 {
		t.Fatalf("baseline accounting = %+v", analysis)
	}
	if analysis.Median == nil || *analysis.Median != float64(101*analysisMiB) {
		t.Fatalf("median = %v", analysis.Median)
	}
	if analysis.Value == nil || *analysis.Value != float64(140*analysisMiB) {
		t.Fatalf("value = %v", analysis.Value)
	}
	if analysis.Unit != "bytes" || analysis.SourceRevision != current.Revision {
		t.Fatalf("unexpected identity %+v", analysis)
	}
}

func TestMetricAnalysisUsesAbsoluteFloorWhenBaselineIsFlat(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	baseline := analysisBaseline(start, MetricAnalysisBaselineHours, "epoch-a", func(int) float64 { return float64(100 * analysisMiB) })
	small := BuildMetricAnalysis(target, aggregateHourBucket(start, "epoch-a", []float64{101 * analysisMiB}, true), baseline, start.Add(2*time.Hour))
	if small.State != AnalysisOK || small.Score != nil || small.ScoreMethod != AnalysisScoreAbsoluteFloor || small.Direction != "stable" {
		t.Fatalf("flat baseline divided by zero or flagged a tiny wobble: %+v", small)
	}
	if small.MAD == nil || *small.MAD != 0 {
		t.Fatalf("mad = %v", small.MAD)
	}
	large := BuildMetricAnalysis(target, aggregateHourBucket(start, "epoch-a", []float64{130 * analysisMiB}, true), baseline, start.Add(2*time.Hour))
	if large.State != AnalysisAnomaly || large.Score != nil || large.ScoreMethod != AnalysisScoreAbsoluteFloor {
		t.Fatalf("absolute floor did not decide a flat baseline: %+v", large)
	}
}

func TestMetricAnalysisExplainsInsufficientBaselines(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	current := aggregateHourBucket(start, "epoch-a", []float64{100 * analysisMiB}, true)
	now := start.Add(2 * time.Hour)
	cold := BuildMetricAnalysis(target, current, nil, now)
	if cold.State != AnalysisInsufficientData || cold.Reason != "cold_start" || cold.BaselineEligible != 0 {
		t.Fatalf("cold start not explained: %+v", cold)
	}
	switched := analysisBaseline(start, MetricAnalysisBaselineHours, "epoch-b", func(int) float64 { return float64(100 * analysisMiB) })
	changed := BuildMetricAnalysis(target, current, switched, now)
	if changed.State != AnalysisInsufficientData || changed.Reason != "identity_changed" {
		t.Fatalf("identity switch not explained: %+v", changed)
	}
	// Exactly 80% of the window is required: 38 hours is short, 39 is enough.
	short := analysisBaseline(start, 38, "epoch-a", func(int) float64 { return float64(100 * analysisMiB) })
	if got := BuildMetricAnalysis(target, current, short, now); got.State != AnalysisInsufficientData || got.Reason != "baseline_incomplete" || got.BaselineEligible != 38 {
		t.Fatalf("short baseline accepted: %+v", got)
	}
	enough := analysisBaseline(start, 39, "epoch-a", func(int) float64 { return float64(100 * analysisMiB) })
	if got := BuildMetricAnalysis(target, current, enough, now); got.State != AnalysisOK {
		t.Fatalf("80%% baseline rejected: %+v", got)
	}
}

func TestMetricAnalysisRequiresPerBucketCoverage(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	baseline := analysisBaseline(start, MetricAnalysisBaselineHours, "epoch-a", func(int) float64 { return float64(100 * analysisMiB) })
	baseline[0].Segments[0].CoveredSeconds = 0.79 * 3600
	current := aggregateHourBucket(start, "epoch-a", []float64{100 * analysisMiB}, true)
	analysis := BuildMetricAnalysis(target, current, baseline, start.Add(2*time.Hour))
	if analysis.BaselineEligible != MetricAnalysisBaselineHours-1 || analysis.State != AnalysisOK {
		t.Fatalf("low-coverage bucket was counted: %+v", analysis)
	}
	thin := aggregateHourBucket(start, "epoch-a", []float64{100 * analysisMiB}, true)
	thin.Segments[0].CoveredSeconds = 0.5 * 3600
	incomplete := BuildMetricAnalysis(target, thin, baseline, start.Add(2*time.Hour))
	if incomplete.State != AnalysisInsufficientData || incomplete.Reason != "current_bucket_incomplete" {
		t.Fatalf("thin current bucket accepted: %+v", incomplete)
	}
}

func TestMetricAnalysisRefusesAmbiguousOrUnsupportedInputs(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	baseline := analysisBaseline(start, MetricAnalysisBaselineHours, "epoch-a", func(int) float64 { return float64(100 * analysisMiB) })
	now := start.Add(2 * time.Hour)
	ambiguous := aggregateHourBucket(start, "epoch-a", []float64{100 * analysisMiB}, true)
	ambiguous.Segments = append(ambiguous.Segments, MetricAggregateSegment{Epoch: "epoch-b", Count: 1, Sum: 1, Min: 1, Max: 1, Mean: 1})
	if got := BuildMetricAnalysis(target, ambiguous, baseline, now); got.State != AnalysisInsufficientData || got.Reason != "identity_ambiguous" {
		t.Fatalf("ambiguous current hour accepted: %+v", got)
	}
	// An hour with no usable observation is incomplete evidence, never an
	// ambiguous identity and never a silent recovery.
	empty := aggregateHourBucket(start, "epoch-a", nil, true)
	if got := BuildMetricAnalysis(target, empty, baseline, now); got.State != AnalysisInsufficientData || got.Reason != "current_bucket_incomplete" {
		t.Fatalf("empty hour misreported: %+v", got)
	}
	counter := BuildMetricCounterHour(target, start, MetricOutcomeBatch{}, now)
	if got := BuildMetricAnalysis(target, counter, baseline, now); got.State != AnalysisUnavailable || got.Reason != "metric_not_analyzable" {
		t.Fatalf("counter analyzed: %+v", got)
	}
	open := aggregateHourBucket(start, "epoch-a", []float64{100 * analysisMiB}, true)
	if got := BuildMetricAnalysis(target, open, baseline, start.Add(10*time.Minute)); got.State != AnalysisUnavailable || got.Reason != "bucket_not_closed" {
		t.Fatalf("open hour analyzed: %+v", got)
	}
}

func TestMetricAnalysisIsDeterministicAndTracksBaselineRevisions(t *testing.T) {
	target := aggregateTarget()
	start := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	now := start.Add(2 * time.Hour)
	baseline := analysisBaseline(start, MetricAnalysisBaselineHours, "epoch-a", func(i int) float64 {
		return float64(100*analysisMiB + (i%2)*analysisMiB)
	})
	current := aggregateHourBucket(start, "epoch-a", []float64{100 * analysisMiB}, true)
	first := BuildMetricAnalysis(target, current, baseline, now)
	again := BuildMetricAnalysis(target, current, baseline, now)
	if first.ID != again.ID || first.BaselineDigest != again.BaselineDigest || first.State != again.State {
		t.Fatalf("analysis is not deterministic: %+v / %+v", first, again)
	}
	baseline[0].Revision = 9
	repaired := BuildMetricAnalysis(target, current, baseline, now)
	if repaired.BaselineDigest == first.BaselineDigest {
		t.Fatal("baseline repair was not detected")
	}
	if repaired.ID != first.ID {
		t.Fatal("analysis identity must not depend on the baseline revisions")
	}
}
