package nfhealth

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// dayBucketID is deterministic per target/day/algorithm. Hourly identifiers are
// left untouched so already published hourly evidence keeps its identity.
func dayBucketID(targetID string, start time.Time) string {
	return windowHash(MetricDayAggregateVersion, targetID, MetricAggregateMetric, "unlabeled", start.UTC().Format(time.RFC3339))
}

// metricDayStart returns the UTC day containing at.
func metricDayStart(at time.Time) time.Time {
	return at.UTC().Truncate(24 * time.Hour)
}

// BuildMetricDay merges published hourly buckets into one UTC day. Only
// mergeable statistics are combined: counts and sums add, minima and maxima
// extend, and the mean is recomputed from sum/count. Hourly means are never
// averaged and no percentile is derived from hourly percentiles.
//
// The hourly segmentation rule still applies: a different identity, an hour
// that failed, or a gap longer than the collection-derived allowance starts a
// new segment instead of joining separate populations into one daily value.
// Coverage is the sum of the clipped hourly coverage, which is already disjoint
// because hours are half-open and never bridge across a boundary.
func BuildMetricDay(target *HealthTarget, dayStart time.Time, hours []MetricAggregateBucket, now time.Time) MetricAggregateBucket {
	dayStart = dayStart.UTC()
	out := MetricAggregateBucket{
		ID: dayBucketID(target.TargetID, dayStart), TargetID: target.TargetID, ResourceID: target.ResourceID,
		Metric: MetricAggregateMetric, MetricType: "gauge", Series: "unlabeled", Period: MetricDayPeriod, Version: MetricDayAggregateVersion,
		SourceVersion: MetricAggregateVersion, P95State: P95NotProvided, Start: dayStart, End: dayStart.Add(24 * time.Hour), GeneratedAt: now.UTC(),
		Quality: "unavailable", Excluded: map[string]int{}, Segments: []MetricAggregateSegment{},
	}
	if !dayStart.Equal(dayStart.Truncate(24 * time.Hour)) {
		out.Reason = "day_not_aligned"
		out.SourceComplete = false
		return out
	}
	closed := !out.End.After(now.UTC().Add(-MetricAggregateGrace))
	slots := make(map[time.Time]MetricAggregateBucket, len(hours))
	for _, hour := range hours {
		if hour.Version != MetricAggregateVersion || (hour.Period != "" && hour.Period != MetricHourPeriod) {
			continue
		}
		start := hour.Start.UTC()
		if !start.Equal(start.Truncate(time.Hour)) || start.Before(out.Start) || !start.Before(out.End) {
			continue
		}
		// A stored hour that never closed cannot contribute to a day.
		if hour.Reason == "hour_not_closed" {
			continue
		}
		slots[start] = hour
	}
	complete := closed
	gap := time.Duration(ThresholdMaxGapSeconds(target)) * time.Second
	digest := make([]string, 0, 24)
	for slot := out.Start; slot.Before(out.End); slot = slot.Add(time.Hour) {
		hour, ok := slots[slot]
		if !ok {
			out.MissingHours++
			complete = false
			continue
		}
		digest = append(digest, fmt.Sprintf("%s:%d", hour.ID, hour.Revision))
		if !hour.SourceComplete {
			complete = false
		}
		for reason, count := range hour.Excluded {
			out.Excluded[reason] += count
		}
		// Hourly percentiles are never merged into a daily percentile. The merged
		// segments are rebuilt from counts and extremes only, so P95 stays absent.
		segments := append([]MetricAggregateSegment(nil), hour.Segments...)
		sort.Slice(segments, func(i, j int) bool { return segments[i].First.Before(segments[j].First) })
		for _, segment := range segments {
			if segment.Count <= 0 {
				continue
			}
			merge := -1
			if len(out.Segments) > 0 {
				last := out.Segments[len(out.Segments)-1]
				if last.Epoch == segment.Epoch && segment.First.After(last.Last) && segment.First.Sub(last.Last) <= gap {
					merge = len(out.Segments) - 1
				}
			}
			if merge < 0 {
				if len(out.Segments) >= MaxAggregateSegments {
					out.Segments = []MetricAggregateSegment{}
					out.CoveredSeconds = 0
					out.Excluded = map[string]int{}
					out.Reason = "segment_budget"
					out.SourceComplete = false
					return out
				}
				out.Segments = append(out.Segments, MetricAggregateSegment{Epoch: segment.Epoch, Min: segment.Min, Max: segment.Max, First: segment.First, Last: segment.Last})
				merge = len(out.Segments) - 1
			}
			merged := &out.Segments[merge]
			merged.Count += segment.Count
			merged.Sum += segment.Sum
			merged.Min = math.Min(merged.Min, segment.Min)
			merged.Max = math.Max(merged.Max, segment.Max)
			if segment.First.Before(merged.First) {
				merged.First = segment.First
			}
			if segment.Last.After(merged.Last) {
				merged.Last = segment.Last
			}
			merged.CoveredSeconds += segment.CoveredSeconds
			merged.Mean = merged.Sum / float64(merged.Count)
			if math.IsInf(merged.Sum, 0) || math.IsNaN(merged.Sum) || math.IsInf(merged.Mean, 0) || math.IsNaN(merged.Mean) {
				out.Segments = []MetricAggregateSegment{}
				out.CoveredSeconds = 0
				out.Excluded = map[string]int{}
				out.Reason = "numeric_overflow"
				out.SourceComplete = false
				return out
			}
		}
		out.CoveredSeconds += hour.CoveredSeconds
	}
	out.Hours = 24 - out.MissingHours
	out.SourceDigest = windowHash(append(digest, fmt.Sprint(out.MissingHours))...)
	out.SourceComplete = complete
	switch {
	case !closed:
		out.Reason = "day_not_closed"
	case out.MissingHours > 0:
		out.Reason = "hour_missing"
	case !complete:
		out.Reason = "hour_incomplete"
	case len(out.Segments) == 0:
		out.Reason = "no_valid_observations"
	}
	if len(out.Segments) > 0 {
		out.Quality = "measured"
		if len(out.Excluded) > 0 || !complete {
			out.Quality = "partial"
		}
	}
	return out
}

// sameOptionalFloat compares optional statistics without treating absent as zero.
func sameOptionalFloat(a, b *float64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// metricAggregateUnchanged reports whether a rebuild would publish identical
// statistics. Unchanged rebuilds are not rewritten, so revisions (and therefore
// read watermarks) do not churn while an incomplete bucket is being retried.
func metricAggregateUnchanged(prior, next MetricAggregateBucket) bool {
	if prior.SourceComplete != next.SourceComplete || prior.Quality != next.Quality || prior.Reason != next.Reason ||
		prior.CoveredSeconds != next.CoveredSeconds || prior.Hours != next.Hours || prior.MissingHours != next.MissingHours ||
		prior.P95State != next.P95State ||
		prior.SourceDigest != next.SourceDigest || len(prior.Segments) != len(next.Segments) || len(prior.Excluded) != len(next.Excluded) {
		return false
	}
	for i := range prior.Segments {
		a, b := prior.Segments[i], next.Segments[i]
		if a.Epoch != b.Epoch || a.Count != b.Count || a.Sum != b.Sum || a.Min != b.Min || a.Max != b.Max || a.Mean != b.Mean || a.CoveredSeconds != b.CoveredSeconds || a.DeltaSum != b.DeltaSum || a.DeltaCount != b.DeltaCount || !a.First.Equal(b.First) || !a.Last.Equal(b.Last) || !sameOptionalFloat(a.P95, b.P95) || !sameOptionalFloat(a.Rate, b.Rate) {
			return false
		}
	}
	for reason, count := range prior.Excluded {
		if next.Excluded[reason] != count {
			return false
		}
	}
	return true
}
