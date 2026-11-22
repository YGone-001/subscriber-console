package nfhealth

import (
	"fmt"
	"math"
	"sort"
	"time"
)

const (
	// MetricAnalysisVersion is the analyzer algorithm. It is part of the analysis
	// identity, so an algorithm change never rewrites earlier records.
	MetricAnalysisVersion = "rss-mad-v1"
	// MetricAnalysisPolicyVersion is the frozen server-side policy: baseline
	// length, minimum coverage, score threshold and the unit-ized floor.
	MetricAnalysisPolicyVersion = "rss-mad-policy-v1"
	// MetricAnalysisBaselineHours is the comparison window. The current bucket is
	// always excluded from its own training set.
	MetricAnalysisBaselineHours = 48
	// MetricAnalysisMinBaselineRatio requires at least 80% of the window.
	MetricAnalysisMinBaselineRatio = 0.8
	// MetricAnalysisMinBucketCoverage requires each baseline bucket to be
	// observed for at least 80% of its hour.
	MetricAnalysisMinBucketCoverage = 0.8
	// MetricAnalysisScoreThreshold is the robust z threshold (|z| >= 3.5).
	MetricAnalysisScoreThreshold = 3.5
	// MetricAnalysisMinAbsoluteChange is the unit-ized floor for the approved
	// gauge: 8 MiB of resident memory. A deviation must also clear this floor, so
	// a statistically significant but operationally tiny wobble is not reported.
	MetricAnalysisMinAbsoluteChange = 8 << 20
	// MetricAnalysisRetentionDays bounds how long an analysis record is kept.
	MetricAnalysisRetentionDays = 90
)

// Analysis states. These describe a measurement comparison, never a failure
// probability and never a change to NF Health layers.
const (
	AnalysisOK               = "ok"
	AnalysisAnomaly          = "anomaly"
	AnalysisInsufficientData = "insufficient_data"
	AnalysisUnavailable      = "unavailable"
)

// Analysis score methods.
const (
	AnalysisScoreRobustZ       = "robust_z"
	AnalysisScoreAbsoluteFloor = "absolute_floor"
)

// MetricAnalysisMetricApproved reports whether a metric may be analyzed. Only
// the positively registered gauge is analyzable; counters are interval
// statistics and their baseline policy is not defined yet.
func MetricAnalysisMetricApproved(metric string) bool {
	return metric == MetricAggregateMetric
}

type MetricAnalysis struct {
	ID         string `json:"-" bson:"_id"`
	TargetID   string `json:"targetId" bson:"targetId"`
	ResourceID string `json:"resourceId" bson:"resourceId"`
	Metric     string `json:"metric" bson:"metric"`
	Series     string `json:"series" bson:"series"`
	// Kind is "baseline" for a deviation record and "trend" for a fitted trend.
	Kind string `json:"kind" bson:"kind,omitempty"`
	// BucketStart is the analyzed UTC hour. The comparison window ends here.
	BucketStart      time.Time `json:"bucketStart" bson:"bucketStart"`
	AlgorithmVersion string    `json:"algorithmVersion" bson:"algorithmVersion"`
	PolicyVersion    string    `json:"policyVersion" bson:"policyVersion"`
	State            string    `json:"state" bson:"state"`
	Reason           string    `json:"reason,omitempty" bson:"reason,omitempty"`
	Direction        string    `json:"direction,omitempty" bson:"direction,omitempty"`
	ScoreMethod      string    `json:"scoreMethod,omitempty" bson:"scoreMethod,omitempty"`
	IdentityEpoch    string    `json:"identityEpoch,omitempty" bson:"identityEpoch,omitempty"`
	Unit             string    `json:"unit" bson:"unit"`
	// SourceRevision is the hourly bucket revision that was analyzed.
	SourceRevision int64 `json:"sourceRevision" bson:"sourceRevision"`
	// BaselineDigest binds the exact baseline bucket revisions used, so a later
	// repair is detectable instead of silently changing the explanation.
	BaselineDigest string   `json:"baselineDigest,omitempty" bson:"baselineDigest,omitempty"`
	Value          *float64 `json:"value,omitempty" bson:"value,omitempty"`
	Median         *float64 `json:"median,omitempty" bson:"median,omitempty"`
	MAD            *float64 `json:"mad,omitempty" bson:"mad,omitempty"`
	// Score is absent when MAD is zero; the decision then used the absolute
	// floor and ScoreMethod says so.
	Score             *float64  `json:"score,omitempty" bson:"score,omitempty"`
	AbsoluteChange    *float64  `json:"absoluteChange,omitempty" bson:"absoluteChange,omitempty"`
	BaselineExpected  int       `json:"baselineExpected" bson:"baselineExpected"`
	BaselineEligible  int       `json:"baselineEligible" bson:"baselineEligible"`
	BaselinePresent   int       `json:"baselinePresent" bson:"baselinePresent"`
	BaselineCoverage  float64   `json:"baselineCoverage" bson:"baselineCoverage"`
	BaselineFrom      time.Time `json:"baselineFrom,omitempty" bson:"baselineFrom,omitempty"`
	BaselineTo        time.Time `json:"baselineTo,omitempty" bson:"baselineTo,omitempty"`
	ScoreThreshold    float64   `json:"scoreThreshold,omitempty" bson:"scoreThreshold,omitempty"`
	MinAbsoluteChange float64   `json:"minAbsoluteChange,omitempty" bson:"minAbsoluteChange,omitempty"`
	// Trend-only fields. A trend record never carries a baseline median, MAD or
	// robust score, and a baseline record never carries a slope or a fit.
	WindowHours        int       `json:"windowHours,omitempty" bson:"windowHours,omitempty"`
	EligibleBuckets    int       `json:"eligibleBuckets,omitempty" bson:"eligibleBuckets,omitempty"`
	LastTwoConsecutive bool      `json:"lastTwoConsecutive,omitempty" bson:"lastTwoConsecutive,omitempty"`
	Slope              *float64  `json:"slope,omitempty" bson:"slope,omitempty"`
	Fit                *float64  `json:"fit,omitempty" bson:"fit,omitempty"`
	TrendChange        *float64  `json:"trendChange,omitempty" bson:"trendChange,omitempty"`
	Confirmed          bool      `json:"confirmed,omitempty" bson:"confirmed,omitempty"`
	ConfirmedFrom      time.Time `json:"confirmedFrom,omitempty" bson:"confirmedFrom,omitempty"`
	MinTrendChange     float64   `json:"minTrendChange,omitempty" bson:"minTrendChange,omitempty"`
	MinFit             float64   `json:"minFit,omitempty" bson:"minFit,omitempty"`
	Revision           int64     `json:"revision" bson:"revision"`
	ComputedAt         time.Time `json:"computedAt" bson:"computedAt"`
	ExpiresAt          time.Time `json:"expiresAt,omitempty" bson:"expiresAt,omitempty"`
	// EvidenceExpired is computed on read: the hourly buckets behind this record
	// are past their own retention, so the numbers can no longer be re-verified.
	EvidenceExpired bool `json:"evidenceExpired" bson:"-"`
}

func analysisID(targetID, metric string, bucketStart time.Time) string {
	return windowHash(MetricAnalysisVersion, MetricAnalysisPolicyVersion, targetID, metric, "unlabeled", bucketStart.UTC().Format(time.RFC3339))
}

func medianOf(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	return (sorted[middle-1] + sorted[middle]) / 2
}

// BuildMetricAnalysis compares one closed hourly bucket with the same identity's
// preceding hours. It is a pure function of its inputs: no clock, no collection
// and no raw sample access. Every outcome states why it is what it is, and an
// anomaly means "this hour deviates from its own recent baseline", never a
// failure probability.
func BuildMetricAnalysis(target *HealthTarget, current MetricAggregateBucket, baseline []MetricAggregateBucket, now time.Time) MetricAnalysis {
	out := MetricAnalysis{
		Kind: "baseline", TargetID: target.TargetID, ResourceID: target.ResourceID, Metric: current.Metric, Series: "unlabeled",
		BucketStart: current.Start.UTC(), AlgorithmVersion: MetricAnalysisVersion, PolicyVersion: MetricAnalysisPolicyVersion,
		Unit: "bytes", SourceRevision: current.Revision, Revision: 1, ComputedAt: now.UTC(),
		BaselineExpected: MetricAnalysisBaselineHours, ScoreThreshold: MetricAnalysisScoreThreshold, MinAbsoluteChange: MetricAnalysisMinAbsoluteChange,
	}
	out.ID = analysisID(target.TargetID, current.Metric, current.Start)
	out.ExpiresAt = out.BucketStart.AddDate(0, 0, MetricAnalysisRetentionDays)
	fail := func(state, reason string) MetricAnalysis {
		out.State, out.Reason = state, reason
		return out
	}
	if !MetricAnalysisMetricApproved(current.Metric) {
		return fail(AnalysisUnavailable, "metric_not_analyzable")
	}
	if current.Version != MetricAggregateVersion || current.Period != MetricHourPeriod {
		return fail(AnalysisUnavailable, "bucket_not_hourly_gauge")
	}
	if !current.Start.UTC().Equal(current.Start.UTC().Truncate(time.Hour)) || current.End.After(now.UTC().Add(-MetricAggregateGrace)) {
		return fail(AnalysisUnavailable, "bucket_not_closed")
	}
	if len(current.Segments) != 1 {
		return fail(AnalysisInsufficientData, "identity_ambiguous")
	}
	subject := current.Segments[0]
	if !current.SourceComplete || subject.CoveredSeconds < MetricAnalysisMinBucketCoverage*3600 {
		return fail(AnalysisInsufficientData, "current_bucket_incomplete")
	}
	out.IdentityEpoch = subject.Epoch
	value := subject.Mean
	out.Value = &value
	windowStart := current.Start.UTC().Add(-time.Duration(MetricAnalysisBaselineHours) * time.Hour)
	out.BaselineFrom, out.BaselineTo = windowStart, current.Start.UTC()
	byStart := make(map[time.Time]MetricAggregateBucket, len(baseline))
	for _, bucket := range baseline {
		start := bucket.Start.UTC()
		if start.Before(windowStart) || !start.Before(current.Start.UTC()) {
			continue
		}
		byStart[start] = bucket
	}
	values := make([]float64, 0, MetricAnalysisBaselineHours)
	digest := make([]string, 0, MetricAnalysisBaselineHours)
	mismatched, ambiguous := 0, 0
	for slot := windowStart; slot.Before(current.Start.UTC()); slot = slot.Add(time.Hour) {
		bucket, ok := byStart[slot]
		if !ok {
			continue
		}
		out.BaselinePresent++
		digest = append(digest, fmt.Sprintf("%s:%d", bucket.ID, bucket.Revision))
		if bucket.Version != MetricAggregateVersion || bucket.Period != MetricHourPeriod {
			ambiguous++
			continue
		}
		if len(bucket.Segments) != 1 {
			ambiguous++
			continue
		}
		segment := bucket.Segments[0]
		if segment.Epoch != subject.Epoch {
			mismatched++
			continue
		}
		if segment.CoveredSeconds < MetricAnalysisMinBucketCoverage*3600 {
			continue
		}
		values = append(values, segment.Mean)
	}
	out.BaselineEligible = len(values)
	out.BaselineCoverage = float64(len(values)) / float64(MetricAnalysisBaselineHours)
	out.BaselineDigest = windowHash(digest...)
	if float64(len(values)) < MetricAnalysisMinBaselineRatio*MetricAnalysisBaselineHours {
		switch {
		case out.BaselinePresent == 0:
			return fail(AnalysisInsufficientData, "cold_start")
		case len(values) == 0 && mismatched > 0 && ambiguous == 0:
			return fail(AnalysisInsufficientData, "identity_changed")
		case len(values) == 0 && ambiguous > 0:
			return fail(AnalysisInsufficientData, "baseline_identity_ambiguous")
		}
		return fail(AnalysisInsufficientData, "baseline_incomplete")
	}
	median := medianOf(values)
	deviations := make([]float64, len(values))
	for i, v := range values {
		deviations[i] = math.Abs(v - median)
	}
	mad := medianOf(deviations)
	change := value - median
	out.Median, out.MAD, out.AbsoluteChange = &median, &mad, &change
	switch {
	case change >= MetricAnalysisMinAbsoluteChange:
		out.Direction = "rising"
	case change <= -MetricAnalysisMinAbsoluteChange:
		out.Direction = "falling"
	default:
		out.Direction = "stable"
	}
	anomalous := false
	if mad > 0 {
		score := 0.6745 * change / mad
		out.Score, out.ScoreMethod = &score, AnalysisScoreRobustZ
		anomalous = math.Abs(score) >= MetricAnalysisScoreThreshold && math.Abs(change) >= MetricAnalysisMinAbsoluteChange
	} else {
		// A perfectly flat baseline has no dispersion to divide by. The
		// unit-ized floor alone decides, and no infinite score is invented.
		out.ScoreMethod = AnalysisScoreAbsoluteFloor
		anomalous = math.Abs(change) >= MetricAnalysisMinAbsoluteChange
	}
	if anomalous {
		out.State = AnalysisAnomaly
		return out
	}
	out.State = AnalysisOK
	return out
}
