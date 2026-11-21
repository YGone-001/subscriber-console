package nfhealth

import (
	"testing"
	"time"
)

// aggregateHourBucket builds one published hourly bucket with a single
// continuous segment so daily merging can be tested without a source read.
func aggregateHourBucket(start time.Time, epoch string, values []float64, complete bool) MetricAggregateBucket {
	bucket := MetricAggregateBucket{
		ID: aggregateBucketID("target", start), TargetID: "target", ResourceID: "resource",
		Metric: MetricAggregateMetric, Series: "unlabeled", Period: MetricHourPeriod, Version: MetricAggregateVersion,
		Start: start, End: start.Add(time.Hour), Revision: 1, SourceComplete: complete,
		Quality: "measured", Excluded: map[string]int{}, Segments: []MetricAggregateSegment{},
	}
	if len(values) == 0 {
		bucket.Quality = "unavailable"
		bucket.Reason = "no_valid_observations"
		return bucket
	}
	sum, min, max := 0.0, values[0], values[0]
	for _, value := range values {
		sum += value
		if value < min {
			min = value
		}
		if value > max {
			max = value
		}
	}
	bucket.Segments = []MetricAggregateSegment{{
		Epoch: epoch, Count: len(values), Sum: sum, Min: min, Max: max, Mean: sum / float64(len(values)),
		First: start, Last: start.Add(time.Hour - time.Second), CoveredSeconds: 3600,
	}}
	bucket.CoveredSeconds = 3600
	return bucket
}

func TestMetricDayWeightsByCountNotByHourlyMean(t *testing.T) {
	day := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	now := day.Add(48 * time.Hour)
	hours := []MetricAggregateBucket{
		aggregateHourBucket(day, "epoch-a", []float64{10, 20}, true),
		aggregateHourBucket(day.Add(time.Hour), "epoch-a", []float64{30, 40, 50}, true),
	}
	bucket := BuildMetricDay(aggregateTarget(), day, hours, now)
	if bucket.Period != MetricDayPeriod || bucket.Version != MetricDayAggregateVersion || bucket.SourceVersion != MetricAggregateVersion {
		t.Fatalf("unexpected daily identity %+v", bucket)
	}
	if bucket.Hours != 2 || bucket.MissingHours != 22 || len(bucket.Segments) != 1 {
		t.Fatalf("unexpected merge shape %+v", bucket)
	}
	segment := bucket.Segments[0]
	if segment.Count != 5 || segment.Sum != 150 || segment.Min != 10 || segment.Max != 50 {
		t.Fatalf("counts/sums not merged: %+v", segment)
	}
	// The daily mean is sum/count. Averaging the two hourly means would give
	// 27.5, which would misrepresent the five samples actually observed.
	if segment.Mean != 30 {
		t.Fatalf("daily mean %v is not sum/count", segment.Mean)
	}
	if bucket.CoveredSeconds != 7200 || segment.CoveredSeconds != 7200 {
		t.Fatalf("coverage not summed: %+v", bucket)
	}
	if bucket.SourceComplete || bucket.Reason != "hour_missing" || bucket.Quality != "partial" {
		t.Fatalf("partial day claimed completeness: %+v", bucket)
	}
}

func TestMetricDaySplitsSegmentsAcrossGapsAndIdentities(t *testing.T) {
	day := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	now := day.Add(48 * time.Hour)
	adjacent := []MetricAggregateBucket{
		aggregateHourBucket(day, "epoch-a", []float64{10}, true),
		aggregateHourBucket(day.Add(time.Hour), "epoch-a", []float64{20}, true),
	}
	if bucket := BuildMetricDay(aggregateTarget(), day, adjacent, now); len(bucket.Segments) != 1 {
		t.Fatalf("adjacent continuous hours did not merge: %+v", bucket.Segments)
	}
	gapped := []MetricAggregateBucket{
		aggregateHourBucket(day, "epoch-a", []float64{10}, true),
		aggregateHourBucket(day.Add(2*time.Hour), "epoch-a", []float64{20}, true),
	}
	if bucket := BuildMetricDay(aggregateTarget(), day, gapped, now); len(bucket.Segments) != 2 {
		t.Fatalf("missing hour joined one population: %+v", bucket.Segments)
	}
	restarted := []MetricAggregateBucket{
		aggregateHourBucket(day, "epoch-a", []float64{10}, true),
		aggregateHourBucket(day.Add(time.Hour), "epoch-b", []float64{20}, true),
	}
	bucket := BuildMetricDay(aggregateTarget(), day, restarted, now)
	if len(bucket.Segments) != 2 || bucket.Segments[0].Epoch != "epoch-a" || bucket.Segments[1].Epoch != "epoch-b" {
		t.Fatalf("incarnation change joined into one mean: %+v", bucket.Segments)
	}
}

func TestMetricDayReportsOpenIncompleteAndEmptyDays(t *testing.T) {
	day := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	hours := []MetricAggregateBucket{aggregateHourBucket(day, "epoch-a", []float64{10}, true)}
	open := BuildMetricDay(aggregateTarget(), day, hours, day.Add(12*time.Hour))
	if open.SourceComplete || open.Reason != "day_not_closed" {
		t.Fatalf("open day claimed closure: %+v", open)
	}
	incomplete := []MetricAggregateBucket{}
	for i := 0; i < 24; i++ {
		complete := i != 7
		incomplete = append(incomplete, aggregateHourBucket(day.Add(time.Duration(i)*time.Hour), "epoch-a", []float64{float64(i)}, complete))
	}
	bucket := BuildMetricDay(aggregateTarget(), day, incomplete, day.Add(48*time.Hour))
	if bucket.Hours != 24 || bucket.MissingHours != 0 || bucket.SourceComplete || bucket.Reason != "hour_incomplete" || bucket.Quality != "partial" {
		t.Fatalf("incomplete hour not reported: %+v", bucket)
	}
	empty := []MetricAggregateBucket{}
	for i := 0; i < 24; i++ {
		empty = append(empty, aggregateHourBucket(day.Add(time.Duration(i)*time.Hour), "epoch-a", nil, true))
	}
	bucket = BuildMetricDay(aggregateTarget(), day, empty, day.Add(48*time.Hour))
	if len(bucket.Segments) != 0 || bucket.Quality != "unavailable" || bucket.Reason != "no_valid_observations" || !bucket.SourceComplete {
		t.Fatalf("empty day invented statistics: %+v", bucket)
	}
}

func TestMetricDaySegmentBudgetDiscardsStatistics(t *testing.T) {
	day := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	hours := []MetricAggregateBucket{}
	for i := 0; i < 17; i++ {
		start := day.Add(time.Duration(i) * time.Hour)
		bucket := aggregateHourBucket(start, "epoch-a", []float64{1}, true)
		bucket.Segments = append(bucket.Segments, MetricAggregateSegment{
			Epoch: "epoch-b", Count: 1, Sum: 2, Min: 2, Max: 2, Mean: 2,
			First: start.Add(30 * time.Minute), Last: start.Add(40 * time.Minute), CoveredSeconds: 600,
		})
		hours = append(hours, bucket)
	}
	bucket := BuildMetricDay(aggregateTarget(), day, hours, day.Add(48*time.Hour))
	if bucket.SourceComplete || bucket.Reason != "segment_budget" || len(bucket.Segments) != 0 || bucket.CoveredSeconds != 0 {
		t.Fatalf("segment overflow published truncated statistics: %+v", bucket)
	}
}

func TestMetricDayDigestTracksConsumedRevisions(t *testing.T) {
	day := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	now := day.Add(48 * time.Hour)
	hours := []MetricAggregateBucket{
		aggregateHourBucket(day, "epoch-a", []float64{10}, true),
		aggregateHourBucket(day.Add(time.Hour), "epoch-a", []float64{20}, true),
	}
	first := BuildMetricDay(aggregateTarget(), day, hours, now)
	again := BuildMetricDay(aggregateTarget(), day, hours, now)
	if first.SourceDigest == "" || first.SourceDigest != again.SourceDigest {
		t.Fatalf("digest is not deterministic: %q %q", first.SourceDigest, again.SourceDigest)
	}
	if !metricAggregateUnchanged(first, again) {
		t.Fatal("identical rebuilds would rewrite a published day")
	}
	hours[1].Revision = 2
	recomputed := BuildMetricDay(aggregateTarget(), day, hours, now)
	if recomputed.SourceDigest == first.SourceDigest {
		t.Fatal("digest did not change after an hourly recomputation")
	}
	if metricAggregateUnchanged(first, recomputed) {
		t.Fatal("changed revisions were treated as unchanged")
	}
	hours[1].Segments[0].Sum = 999
	changed := BuildMetricDay(aggregateTarget(), day, hours, now)
	if metricAggregateUnchanged(recomputed, changed) {
		t.Fatal("changed statistics were treated as unchanged")
	}
}

func TestPlanMetricHoursRepairsNewestGapsWithinBudget(t *testing.T) {
	latest := time.Date(2026, 11, 22, 5, 0, 0, 0, time.UTC)
	now := latest.Add(2 * time.Hour)
	published := map[time.Time]MetricAggregateBucket{
		latest.Add(-time.Hour): {SourceComplete: true},
	}
	for i := 2; i <= 5; i++ {
		published[latest.Add(-time.Duration(i)*time.Hour)] = MetricAggregateBucket{SourceComplete: false}
	}
	slots := planMetricHours(latest, MetricBackfillWindowHours, published, now, DefaultRetentionDays)
	if len(slots) != MaxMetricHoursPerTick {
		t.Fatalf("unbounded repair plan: %v", slots)
	}
	if !slots[0].Equal(latest) {
		t.Fatalf("newest closed hour was not first: %v", slots)
	}
	if !slots[1].Equal(latest.Add(-2*time.Hour)) || !slots[2].Equal(latest.Add(-3*time.Hour)) {
		t.Fatalf("repair did not follow the newest gaps: %v", slots)
	}
	complete := map[time.Time]MetricAggregateBucket{}
	for i := 0; i < MetricBackfillWindowHours; i++ {
		complete[latest.Add(-time.Duration(i)*time.Hour)] = MetricAggregateBucket{SourceComplete: true}
	}
	if planned := planMetricHours(latest, MetricBackfillWindowHours, complete, now, DefaultRetentionDays); len(planned) != 0 {
		t.Fatalf("finalized hour was rebuilt: %v", planned)
	}
}

func TestPlanMetricHoursSkipsHoursPastRawRetention(t *testing.T) {
	latest := time.Date(2026, 11, 22, 5, 0, 0, 0, time.UTC)
	now := latest.Add(2 * time.Hour)
	published := map[time.Time]MetricAggregateBucket{}
	for i := 0; i <= 22; i++ {
		published[latest.Add(-time.Duration(i)*time.Hour)] = MetricAggregateBucket{SourceComplete: true}
	}
	oldest := latest.Add(-23 * time.Hour)
	published[oldest] = MetricAggregateBucket{SourceComplete: false}
	// With a one-day raw retention the oldest slot is past its own evidence.
	if slots := planMetricHours(latest, 24, published, now, 1); len(slots) != 0 {
		t.Fatalf("expired slot was scheduled: %v", slots)
	}
	// The same slot is still repairable while raw samples exist.
	slots := planMetricHours(latest, 24, published, now, DefaultRetentionDays)
	if len(slots) != 1 || !slots[0].Equal(oldest) {
		t.Fatalf("repairable gap was skipped: %v", slots)
	}
}
