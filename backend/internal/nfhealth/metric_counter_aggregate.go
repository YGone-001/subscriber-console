package nfhealth

import (
	"math"
	"sort"
	"time"
)

const (
	// MetricCounterMetric is the only approved counter family. Its cumulative
	// total is never averaged; only deltas and their rate are published.
	MetricCounterMetric           = "process_cpu_seconds_total"
	MetricCounterAggregateVersion = "rss-counter-hour-v1"
	// MetricCounterRateUnit is the unit of the published rate: CPU seconds
	// consumed per wall-clock second by the exporter process. It is not a
	// percentage of capacity and may exceed 1 on a multi-core host.
	MetricCounterRateUnit = "seconds_per_second"
)

// AggregateMetricApproved reports whether the aggregation worker may publish a
// derived series. It deliberately does not widen ThresholdMetricApproved, so a
// counter never becomes a threshold candidate by being aggregated.
func AggregateMetricApproved(metric string) bool {
	return metric == MetricAggregateMetric || metric == MetricCounterMetric
}

func counterBucketID(targetID string, start time.Time) string {
	return windowHash(MetricCounterAggregateVersion, targetID, MetricCounterMetric, "unlabeled", start.UTC().Format(time.RFC3339))
}

// BuildMetricCounterHour publishes per-segment counter deltas and rates for
// [start,end). A delta is counted only when both endpoints fall inside the hour,
// so an interval crossing the boundary belongs to neither hour and is never
// counted twice. A negative delta is a counter reset: it is excluded and opens a
// new segment instead of producing a negative increment. A zero delta is a
// measured zero and stays distinct from a missing measurement.
//
// The cumulative total is never averaged, no percentile is derived, and the
// rate is the sum of valid deltas divided by the covered seconds rather than an
// average of per-interval rates.
func BuildMetricCounterHour(target *HealthTarget, start time.Time, batch MetricOutcomeBatch, now time.Time) MetricAggregateBucket {
	start = start.UTC()
	out := MetricAggregateBucket{
		ID: counterBucketID(target.TargetID, start), TargetID: target.TargetID, ResourceID: target.ResourceID,
		Metric: MetricCounterMetric, MetricType: "counter", Series: "unlabeled", Period: MetricHourPeriod,
		Version: MetricCounterAggregateVersion, P95State: P95NotProvided,
		Start: start, End: start.Add(time.Hour), GeneratedAt: now.UTC(),
		SourceComplete: !batch.More && batch.Gaps == 0, Quality: "unavailable",
		Excluded: map[string]int{}, Segments: []MetricAggregateSegment{},
	}
	if !start.Equal(start.Truncate(time.Hour)) || out.End.After(now.Add(-MetricAggregateGrace)) {
		out.Reason = "hour_not_closed"
		out.SourceComplete = false
		return out
	}
	if batch.More {
		out.Reason = "source_budget"
		out.SourceComplete = false
		return out
	}
	rows := append([]CollectionResult(nil), batch.Outcomes...)
	sort.Slice(rows, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339Nano, rows[i].Run.StartedAt)
		b, _ := time.Parse(time.RFC3339Nano, rows[j].Run.StartedAt)
		return a.Before(b)
	})
	var previous time.Time
	previousEpoch := ""
	segment := -1
	var segmentValue float64
	var segmentAt time.Time
	gap := time.Duration(ThresholdMaxGapSeconds(target)) * time.Second
	excluded := func(reason string) {
		out.Excluded[reason]++
		previous = time.Time{}
		previousEpoch = ""
		segment = -1
	}
	// open starts a new segment at an observation. The first observation of a
	// segment only establishes the previous total; it contributes no delta.
	open := func(at time.Time, value float64, identity string) bool {
		if len(out.Segments) >= MaxAggregateSegments {
			return false
		}
		out.Segments = append(out.Segments, MetricAggregateSegment{Epoch: identity, Count: 1, First: at, Last: at})
		segment = len(out.Segments) - 1
		segmentValue, segmentAt = value, at
		return true
	}
	budget := func(reason string) MetricAggregateBucket {
		out.Segments = []MetricAggregateSegment{}
		out.CoveredSeconds = 0
		out.Reason = reason
		out.SourceComplete = false
		return out
	}
	for i, row := range rows {
		at, err := time.Parse(time.RFC3339Nano, row.Run.StartedAt)
		if err != nil || at.After(out.End) || at.Before(start.Add(-gap)) {
			excluded("invalid_time")
			continue
		}
		duplicate := i > 0 && row.Run.StartedAt == rows[i-1].Run.StartedAt || i+1 < len(rows) && row.Run.StartedAt == rows[i+1].Run.StartedAt
		if duplicate {
			excluded("duplicate_time")
			continue
		}
		if row.Run.Status == RunStatusFailed || row.Run.TargetID != target.TargetID || row.Run.ResourceID != target.ResourceID || row.Sample == nil || row.Sample.RunID != row.Run.RunID || row.Sample.CollectedAt != row.Run.StartedAt {
			excluded("collection_gap")
			continue
		}
		value, reason := AggregateSeriesValue(target, row.Sample, MetricCounterMetric, at)
		if value == nil {
			excluded(reason)
			continue
		}
		identity, _ := ThresholdContinuity(target, row.Sample)
		if identity == "" {
			excluded("continuity_unverified")
			continue
		}
		identity = windowHash(MetricCounterAggregateVersion, identity)
		continuous := !previous.IsZero() && previousEpoch == identity && at.After(previous) && at.Sub(previous) <= gap
		if !continuous {
			segment = -1
		}
		inside := !at.Before(start) && at.Before(out.End)
		if inside {
			switch {
			case segment < 0:
				if !open(at, *value, identity) {
					return budget("segment_budget")
				}
			case *value < segmentValue:
				// The cumulative total moved backwards: this is a restart or a
				// reset, so the previous total cannot be subtracted.
				out.Excluded["counter_reset"]++
				if !open(at, *value, identity) {
					return budget("segment_budget")
				}
			default:
				delta := *value - segmentValue
				interval := at.Sub(segmentAt)
				s := &out.Segments[segment]
				s.DeltaSum += delta
				s.DeltaCount++
				if interval > 0 {
					s.CoveredSeconds += interval.Seconds()
					out.CoveredSeconds += interval.Seconds()
				}
				s.Count++
				s.Last = at
				segmentValue, segmentAt = *value, at
				if math.IsInf(s.DeltaSum, 0) || math.IsNaN(s.DeltaSum) {
					return budget("numeric_overflow")
				}
			}
		}
		previous, previousEpoch = at, identity
	}
	hasRate := false
	for i := range out.Segments {
		s := &out.Segments[i]
		if s.DeltaCount > 0 && s.CoveredSeconds > 0 {
			rate := s.DeltaSum / s.CoveredSeconds
			if math.IsInf(rate, 0) || math.IsNaN(rate) {
				return budget("numeric_overflow")
			}
			s.Rate = &rate
			hasRate = true
		}
	}
	if len(out.Segments) > 0 {
		out.Quality = "measured"
	} else {
		out.Reason = "no_valid_observations"
	}
	if batch.Gaps > 0 {
		out.Excluded["source_gap"] += batch.Gaps
		out.Reason = "source_gap"
	}
	// Observations without a single valid interval (for example one sample in
	// the hour) prove activity but cannot produce a rate. That is reported, not
	// published as zero traffic.
	if len(out.Segments) > 0 && !hasRate && out.Reason == "" {
		out.Reason = "no_valid_intervals"
		out.Quality = "partial"
	}
	if len(out.Excluded) > 0 && len(out.Segments) > 0 && out.Quality == "measured" {
		out.Quality = "partial"
	}
	return out
}
