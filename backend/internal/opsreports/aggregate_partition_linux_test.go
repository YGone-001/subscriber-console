//go:build linux

package opsreports

import (
	"context"
	"fmt"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"subscriber/internal/nfhealth"
)

func TestAggregateMetricPartitionKeepsSegmentsSeparate(t *testing.T) {
	db := reportTestDB(t)
	ctx := context.Background()
	targetID := "11111111-1111-4111-8111-111111111111"
	resourceID := "22222222-2222-4222-8222-222222222222"
	start := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	complete, budget := 38.0, 12.0
	docs := []any{
		nfhealth.MetricAggregateBucket{
			ID: "bucket-a", TargetID: targetID, ResourceID: resourceID, Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled",
			Period: nfhealth.MetricHourPeriod, Version: nfhealth.MetricAggregateVersion, P95State: nfhealth.P95Complete,
			Start: start, End: start.Add(time.Hour), SourceComplete: true, Quality: "measured", Excluded: map[string]int{},
			Segments: []nfhealth.MetricAggregateSegment{{Epoch: "epoch-a", Count: 3, Sum: 6, Min: 1, Max: 3, Mean: 2, P95: &complete, First: start, Last: start.Add(time.Minute), CoveredSeconds: 60}},
		},
		nfhealth.MetricAggregateBucket{
			ID: "bucket-b", TargetID: targetID, ResourceID: resourceID, Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled",
			Period: nfhealth.MetricHourPeriod, Version: nfhealth.MetricAggregateVersion, P95State: nfhealth.P95Budget,
			Start: start.Add(time.Hour), End: start.Add(2 * time.Hour), SourceComplete: false, Quality: "partial", Excluded: map[string]int{"collection_gap": 1},
			Segments: []nfhealth.MetricAggregateSegment{
				{Epoch: "epoch-a", Count: 2, Sum: 4, Min: 1, Max: 3, Mean: 2, First: start.Add(time.Hour), Last: start.Add(time.Hour + time.Minute), CoveredSeconds: 60},
				{Epoch: "epoch-b", Count: 1, Sum: 5, Min: 5, Max: 5, Mean: 5, P95: &budget, First: start.Add(90 * time.Minute), Last: start.Add(91 * time.Minute), CoveredSeconds: 60},
			},
		},
		nfhealth.MetricAggregateBucket{
			ID: "bucket-c", TargetID: targetID, ResourceID: resourceID, Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled",
			Period: nfhealth.MetricHourPeriod, Version: nfhealth.MetricAggregateVersion, P95State: nfhealth.P95Budget,
			Start: start.Add(5 * time.Hour), End: start.Add(6 * time.Hour), SourceComplete: true, Quality: "measured", Excluded: map[string]int{},
			Segments: []nfhealth.MetricAggregateSegment{{Epoch: "epoch-a", Count: 1, Sum: 7, Min: 7, Max: 7, Mean: 7, First: start.Add(5 * time.Hour), Last: start.Add(5*time.Hour + time.Minute), CoveredSeconds: 60}},
		},
	}
	if _, e := db.Collection("app_nf_metric_aggregates").InsertMany(ctx, docs); e != nil {
		t.Fatal(e)
	}
	r := NewRepository(db)
	section, rows, limited := r.aggregateMetrics(ctx, Query{From: start, To: start.Add(3 * time.Hour), Source: "aggregate", Resolution: nfhealth.MetricHourPeriod}, bson.M{})
	if limited || section.Scope != "retained_aggregates" || section.Completeness != "partial" {
		t.Fatalf("unexpected aggregate section %+v limited=%v", section, limited)
	}
	if section.Reason != "aggregate_source_incomplete" {
		t.Fatalf("incomplete source not reported first: %q", section.Reason)
	}
	if len(rows) != 3 {
		t.Fatalf("segment rows = %d, want 3", len(rows))
	}
	byKey := map[string]map[string]any{}
	for _, row := range rows {
		byKey[fmt.Sprint(row["bucketStart"])+"|"+fmt.Sprint(row["identityEpoch"])] = row
	}
	first := byKey[fmt.Sprint(start)+"|epoch-a"]
	second := byKey[fmt.Sprint(start.Add(time.Hour))+"|epoch-a"]
	third := byKey[fmt.Sprint(start.Add(time.Hour))+"|epoch-b"]
	if first == nil || second == nil || third == nil {
		t.Fatalf("missing segment rows: %+v", byKey)
	}
	if value, ok := first["p95"].(*float64); !ok || value == nil || *value != 38 {
		t.Fatalf("first segment p95 = %v", first["p95"])
	}
	if second["p95"] != (*float64)(nil) {
		t.Fatalf("budgeted segment invented a percentile: %v", second["p95"])
	}
	if value, ok := third["p95"].(*float64); !ok || value == nil || *value != 12 {
		t.Fatalf("third segment p95 = %v", third["p95"])
	}
	coverage := section.Data.(map[string]any)
	if coverage["segments"] != 3 || coverage["p95Available"] != 2 || coverage["p95Unavailable"] != 1 || coverage["samples"] != int64(6) {
		t.Fatalf("coverage summary = %+v", coverage)
	}
	// A complete bucket that only exceeded the percentile sort budget is
	// reported as an incomplete percentile, not as incomplete source evidence.
	onlyBudget, budgetRows, _ := r.aggregateMetrics(ctx, Query{From: start.Add(5 * time.Hour), To: start.Add(6 * time.Hour), Source: "aggregate", Resolution: nfhealth.MetricHourPeriod}, bson.M{})
	if len(budgetRows) != 1 || onlyBudget.Completeness != "partial" || onlyBudget.Reason != "p95_budget_exceeded" {
		t.Fatalf("percentile-only budget not reported: %+v rows=%d", onlyBudget, len(budgetRows))
	}
	// Daily resolution never reads hourly buckets, and scope filtering is exact.
	_, daily, _ := r.aggregateMetrics(ctx, Query{From: start, To: start.Add(3 * time.Hour), Source: "aggregate", Resolution: nfhealth.MetricDayPeriod}, bson.M{})
	if len(daily) != 0 {
		t.Fatalf("daily partition consumed hourly buckets: %d rows", len(daily))
	}
	_, scoped, _ := r.aggregateMetrics(ctx, Query{From: start, To: start.Add(3 * time.Hour), Source: "aggregate", Resolution: nfhealth.MetricHourPeriod}, bson.M{"resourceId": "33333333-3333-4333-8333-333333333333"})
	if len(scoped) != 0 {
		t.Fatalf("scope filter ignored: %d rows", len(scoped))
	}
}
