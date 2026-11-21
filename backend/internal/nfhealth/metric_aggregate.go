package nfhealth

import (
	"math"
	"sort"
	"time"
)

const MetricAggregateVersion = "rss-hour-v1"
const MetricAggregateMetric = "process_resident_memory_bytes"
const MaxAggregateSegments = 32

// Segments never join across failed observations, gaps or exporter incarnations.
// Epoch is an opaque digest; no private process/endpoint proof is exposed.
type MetricAggregateSegment struct {
	Epoch          string    `json:"identityEpoch" bson:"identityEpoch"`
	Count          int       `json:"count" bson:"count"`
	Sum            float64   `json:"sum" bson:"sum"`
	Min            float64   `json:"min" bson:"min"`
	Max            float64   `json:"max" bson:"max"`
	Mean           float64   `json:"mean" bson:"mean"`
	First          time.Time `json:"firstObservedAt" bson:"firstObservedAt"`
	Last           time.Time `json:"lastObservedAt" bson:"lastObservedAt"`
	CoveredSeconds float64   `json:"coveredSeconds" bson:"coveredSeconds"`
}

type MetricAggregateBucket struct {
	CoveredSeconds float64                  `json:"coveredSeconds" bson:"coveredSeconds"`
	ID             string                   `json:"-" bson:"_id"`
	TargetID       string                   `json:"targetId" bson:"targetId"`
	ResourceID     string                   `json:"resourceId" bson:"resourceId"`
	Metric         string                   `json:"metric" bson:"metric"`
	Series         string                   `json:"series" bson:"series"`
	Version        string                   `json:"algorithmVersion" bson:"algorithmVersion"`
	Start          time.Time                `json:"from" bson:"bucketStart"`
	End            time.Time                `json:"to" bson:"bucketEnd"`
	Revision       int64                    `json:"revision" bson:"revision"`
	GeneratedAt    time.Time                `json:"generatedAt" bson:"generatedAt"`
	SourceComplete bool                     `json:"sourceComplete" bson:"sourceComplete"`
	Quality        string                   `json:"quality" bson:"quality"`
	Reason         string                   `json:"reason,omitempty" bson:"reason,omitempty"`
	Excluded       map[string]int           `json:"excluded" bson:"excluded"`
	Segments       []MetricAggregateSegment `json:"segments" bson:"segments"`
}

func aggregateBucketID(targetID string, start time.Time) string {
	return windowHash(MetricAggregateVersion, targetID, MetricAggregateMetric, "unlabeled", start.UTC().Format(time.RFC3339))
}

// BuildMetricHour counts observations only in [start,end). A leading point or
// a point exactly at end supplies continuity only. Covered intervals are disjoint,
// clipped adjacent pairs; no forward extrapolation or sample-count coverage.
func BuildMetricHour(target *HealthTarget, start time.Time, batch MetricOutcomeBatch, now time.Time) MetricAggregateBucket {
	start = start.UTC()
	out := MetricAggregateBucket{ID: aggregateBucketID(target.TargetID, start), TargetID: target.TargetID, ResourceID: target.ResourceID, Metric: MetricAggregateMetric, Series: "unlabeled", Version: MetricAggregateVersion, Start: start, End: start.Add(time.Hour), GeneratedAt: now.UTC(), SourceComplete: !batch.More && batch.Gaps == 0, Quality: "unavailable", Excluded: map[string]int{}, Segments: []MetricAggregateSegment{}}
	if !start.Equal(start.Truncate(time.Hour)) || out.End.After(now.Add(-5*time.Minute)) {
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
	gap := time.Duration(ThresholdMaxGapSeconds(target)) * time.Second
	excluded := func(reason string) { out.Excluded[reason]++; previous = time.Time{}; previousEpoch = ""; segment = -1 }
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
		// Historical admissibility is checked at the observation instant, never by
		// treating a retained old gauge as a fresh current measurement.
		value, reason := ThresholdValue(target, row.Sample, MetricAggregateMetric, at)
		if value == nil {
			excluded(reason)
			continue
		}
		identity, _ := ThresholdContinuity(target, row.Sample)
		if identity == "" {
			excluded("continuity_unverified")
			continue
		}
		identity = windowHash(MetricAggregateVersion, identity)
		continuous := !previous.IsZero() && previousEpoch == identity && at.After(previous) && at.Sub(previous) <= gap
		if !continuous {
			segment = -1
		}
		inside := !at.Before(start) && at.Before(out.End)
		if inside {
			if segment < 0 {
				if len(out.Segments) >= MaxAggregateSegments {
					out.Segments = []MetricAggregateSegment{}
					out.CoveredSeconds = 0
					out.Reason = "segment_budget"
					out.SourceComplete = false
					return out
				}
				out.Segments = append(out.Segments, MetricAggregateSegment{Epoch: identity, Min: *value, Max: *value, First: at})
				segment = len(out.Segments) - 1
			}
			s := &out.Segments[segment]
			s.Count++
			s.Sum += *value
			s.Min = math.Min(s.Min, *value)
			s.Max = math.Max(s.Max, *value)
			s.Last = at
			s.Mean = s.Sum / float64(s.Count)
			if math.IsInf(s.Sum, 0) || math.IsNaN(s.Sum) {
				out.Segments = []MetricAggregateSegment{}
				out.CoveredSeconds = 0
				out.Reason = "numeric_overflow"
				out.SourceComplete = false
				return out
			}
		}
		if continuous {
			lo := previous
			if lo.Before(start) {
				lo = start
			}
			hi := at
			if hi.After(out.End) {
				hi = out.End
			}
			if hi.After(lo) {
				out.CoveredSeconds += hi.Sub(lo).Seconds()
				if segment >= 0 {
					out.Segments[segment].CoveredSeconds += hi.Sub(lo).Seconds()
				}
			}
		}
		previous, previousEpoch = at, identity
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
	if len(out.Excluded) > 0 && len(out.Segments) > 0 {
		out.Quality = "partial"
	}
	return out
}
