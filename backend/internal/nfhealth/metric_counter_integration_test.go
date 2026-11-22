package nfhealth

import (
	"context"
	"testing"
	"time"
)

func TestMetricCounterHourRoundTripsAndReadsAsRate(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	target := aggregateTarget()
	target.TargetID = newUUID()
	target.ResourceID = newUUID()
	if _, err := repo.targets.InsertOne(ctx, target); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	start := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-time.Hour)
	for i := 0; i < 10; i++ {
		row := counterObservation(target, start.Add(time.Duration(i)*2*time.Minute), 60*float64(i), "counter-epoch")
		if err := repo.InsertRun(ctx, &row.Run); err != nil {
			t.Fatal(err)
		}
		if err := repo.InsertSample(ctx, row.Sample); err != nil {
			t.Fatal(err)
		}
	}
	worker := NewMetricAggregateWorker(repo, true, func(context.Context, *HealthTarget) error { return nil })
	worker.Tick(ctx, now)
	bucket, err := repo.metricAggregate(ctx, counterBucketID(target.TargetID, start))
	if err != nil || bucket == nil {
		t.Fatalf("counter bucket missing: %v", err)
	}
	if bucket.MetricType != "counter" || bucket.Version != MetricCounterAggregateVersion || len(bucket.Segments) != 1 {
		t.Fatalf("unexpected counter bucket %+v", bucket)
	}
	segment := bucket.Segments[0]
	if segment.DeltaCount != 9 || segment.DeltaSum != 540 || segment.CoveredSeconds != 1080 || segment.Rate == nil || *segment.Rate != 0.5 {
		t.Fatalf("counter delta accounting = %+v", segment)
	}
	view, err := repo.MetricHistory(ctx, MetricHistoryQuery{TargetID: target.TargetID, Metric: MetricCounterMetric, Series: "unlabeled", Resolution: MetricHourPeriod, From: start, To: start.Add(time.Hour), Limit: 200}, now)
	if err != nil {
		t.Fatal(err)
	}
	if view.MetricType != "counter" || view.Unit != MetricCounterRateUnit || view.Version != MetricCounterAggregateVersion {
		t.Fatalf("counter read scope = %+v", view)
	}
	if len(view.Buckets) != 1 || view.Buckets[0].Metric != MetricCounterMetric || len(view.Buckets[0].Segments) != 1 {
		t.Fatalf("counter read rows = %+v", view.Buckets)
	}
	if rate := view.Buckets[0].Segments[0].Rate; rate == nil || *rate != 0.5 {
		t.Fatalf("counter read rate = %v", rate)
	}
	// The gauge partition of the same hour is a different document and version.
	gauge, err := repo.MetricHistory(ctx, MetricHistoryQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, Series: "unlabeled", Resolution: MetricHourPeriod, From: start, To: start.Add(time.Hour), Limit: 200}, now)
	if err != nil {
		t.Fatal(err)
	}
	if gauge.MetricType != "gauge" || gauge.Unit != "bytes" || gauge.Version != MetricAggregateVersion {
		t.Fatalf("gauge partition changed: %+v", gauge)
	}
	for _, item := range gauge.Buckets {
		if item.Metric != MetricAggregateMetric {
			t.Fatalf("gauge read consumed a counter document: %+v", item)
		}
	}
}
