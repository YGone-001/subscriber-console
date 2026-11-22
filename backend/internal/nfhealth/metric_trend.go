package nfhealth

import (
	"fmt"
	"math"
	"time"
)

const (
	// MetricTrendVersion is the trend algorithm. It is part of the trend identity.
	MetricTrendVersion = "rss-trend-v1"
	// MetricTrendPolicyVersion is the frozen trend policy: window length, minimum
	// eligible buckets, the unit-ized floor and the fit-quality gate.
	MetricTrendPolicyVersion = "rss-trend-policy-v1"
	// MetricTrendWindowHours is the fitted window, including the evaluated hour.
	MetricTrendWindowHours = 8
	// MetricTrendMinEligible requires at least seven usable buckets in the window.
	MetricTrendMinEligible = 7
	// MetricTrendMinBucketCoverage requires each used bucket to be observed for at
	// least 80% of its hour.
	MetricTrendMinBucketCoverage = 0.8
	// MetricTrendMinChange is the fitted change across the window, in bytes.
	MetricTrendMinChange = 8 << 20
	// MetricTrendMinFit is the fit-quality gate. R-squared decides whether a
	// monotone trend may be claimed at all; it is never a confidence value.
	MetricTrendMinFit = 0.7
)

// Trend states. A trend becomes an event only when two consecutive evaluations
// agree on the direction.
const (
	TrendRising  = "rising"
	TrendFalling = "falling"
	TrendStable  = "stable"
)

func trendID(targetID, metric string, bucketStart time.Time) string {
	return windowHash(MetricTrendVersion, MetricTrendPolicyVersion, "trend", targetID, metric, "unlabeled", bucketStart.UTC().Format(time.RFC3339))
}

// BuildMetricTrend fits a line over the last eight hourly buckets and reports a
// direction only when the fitted change clears the unit-ized floor and the fit
// is strong enough. The record becomes a confirmed event only when the
// immediately preceding hour's evaluation reports the same direction, so a
// single hour cannot create one.
func BuildMetricTrend(target *HealthTarget, buckets []MetricAggregateBucket, asOf, now time.Time) MetricAnalysis {
	out := trendAt(target, buckets, asOf, now)
	if out.State != TrendRising && out.State != TrendFalling {
		return out
	}
	previous := trendAt(target, buckets, asOf.Add(-time.Hour), now)
	if previous.State == out.State {
		out.Confirmed = true
		out.ConfirmedFrom = previous.BucketStart
	}
	return out
}

// trendAt evaluates one window ending at asOf. It is a pure function of the
// supplied buckets: no clock, no collection and no raw sample access.
func trendAt(target *HealthTarget, buckets []MetricAggregateBucket, asOf, now time.Time) MetricAnalysis {
	asOf = asOf.UTC()
	out := MetricAnalysis{
		Kind: "trend", TargetID: target.TargetID, ResourceID: target.ResourceID, Metric: MetricAggregateMetric, Series: "unlabeled",
		BucketStart: asOf, AlgorithmVersion: MetricTrendVersion, PolicyVersion: MetricTrendPolicyVersion,
		Unit: "bytes", Revision: 1, ComputedAt: now.UTC(),
		WindowHours: MetricTrendWindowHours, BaselineExpected: MetricTrendWindowHours,
		MinTrendChange: MetricTrendMinChange, MinFit: MetricTrendMinFit,
	}
	out.ID = trendID(target.TargetID, MetricAggregateMetric, asOf)
	out.ExpiresAt = asOf.AddDate(0, 0, MetricAnalysisRetentionDays)
	fail := func(state, reason string) MetricAnalysis {
		out.State, out.Reason = state, reason
		return out
	}
	if !asOf.Equal(asOf.Truncate(time.Hour)) || asOf.Add(time.Hour).After(now.UTC().Add(-MetricAggregateGrace)) {
		return fail(AnalysisUnavailable, "bucket_not_closed")
	}
	byStart := make(map[time.Time]MetricAggregateBucket, len(buckets))
	for _, bucket := range buckets {
		if bucket.Version != MetricAggregateVersion || bucket.Period != MetricHourPeriod {
			continue
		}
		byStart[bucket.Start.UTC()] = bucket
	}
	newest, ok := byStart[asOf]
	if !ok {
		return fail(AnalysisInsufficientData, "cold_start")
	}
	if len(newest.Segments) != 1 || !newest.SourceComplete || newest.Segments[0].CoveredSeconds < MetricTrendMinBucketCoverage*3600 {
		return fail(AnalysisInsufficientData, "current_bucket_incomplete")
	}
	epoch := newest.Segments[0].Epoch
	out.IdentityEpoch = epoch
	value := newest.Segments[0].Mean
	out.Value, out.SourceRevision = &value, newest.Revision
	windowStart := asOf.Add(-time.Duration(MetricTrendWindowHours-1) * time.Hour)
	out.BaselineFrom, out.BaselineTo = windowStart, asOf
	type point struct{ x, y float64 }
	points := make([]point, 0, MetricTrendWindowHours)
	digest := make([]string, 0, MetricTrendWindowHours)
	for slot := windowStart; !slot.After(asOf); slot = slot.Add(time.Hour) {
		bucket, ok := byStart[slot]
		if !ok {
			continue
		}
		digest = append(digest, fmt.Sprintf("%s:%d", bucket.ID, bucket.Revision))
		if len(bucket.Segments) != 1 {
			continue
		}
		segment := bucket.Segments[0]
		if segment.Epoch != epoch || segment.CoveredSeconds < MetricTrendMinBucketCoverage*3600 {
			continue
		}
		points = append(points, point{x: slot.Sub(windowStart).Hours(), y: segment.Mean})
	}
	out.EligibleBuckets, out.BaselineEligible = len(points), len(points)
	out.BaselineCoverage = float64(len(points)) / float64(MetricTrendWindowHours)
	out.BaselineDigest = windowHash(digest...)
	// The newest two buckets must both be usable, so a trend cannot be claimed
	// from a window whose end is a gap.
	lastTwo := false
	hasNewest, hasPrevious := false, false
	for _, item := range points {
		if item.x == float64(MetricTrendWindowHours-1) {
			hasNewest = true
		}
		if item.x == float64(MetricTrendWindowHours-2) {
			hasPrevious = true
		}
	}
	lastTwo = hasNewest && hasPrevious
	out.LastTwoConsecutive = lastTwo
	if len(points) < MetricTrendMinEligible {
		return fail(AnalysisInsufficientData, "trend_window_incomplete")
	}
	if !lastTwo {
		return fail(AnalysisInsufficientData, "last_buckets_not_consecutive")
	}
	count := float64(len(points))
	var sumX, sumY float64
	for _, item := range points {
		sumX += item.x
		sumY += item.y
	}
	meanX, meanY := sumX/count, sumY/count
	var sxx, sxy float64
	for _, item := range points {
		sxx += (item.x - meanX) * (item.x - meanX)
		sxy += (item.x - meanX) * (item.y - meanY)
	}
	if sxx == 0 {
		return fail(AnalysisInsufficientData, "trend_window_incomplete")
	}
	slope := sxy / sxx
	intercept := meanY - slope*meanX
	var ssRes, ssTot float64
	for _, item := range points {
		predicted := intercept + slope*item.x
		ssRes += (item.y - predicted) * (item.y - predicted)
		ssTot += (item.y - meanY) * (item.y - meanY)
	}
	// A perfectly flat window has no total variance; the line explains it fully.
	fit := 1.0
	if ssTot > 0 {
		fit = 1 - ssRes/ssTot
	}
	if fit < 0 {
		fit = 0
	}
	change := slope * float64(MetricTrendWindowHours-1)
	out.Slope, out.Fit, out.TrendChange = &slope, &fit, &change
	switch {
	case math.Abs(change) < MetricTrendMinChange:
		out.State, out.Reason = TrendStable, "change_below_floor"
	case fit < MetricTrendMinFit:
		out.State, out.Reason = TrendStable, "weak_fit"
	case change > 0:
		out.State = TrendRising
		out.Direction = "rising"
	default:
		out.State = TrendFalling
		out.Direction = "falling"
	}
	return out
}
