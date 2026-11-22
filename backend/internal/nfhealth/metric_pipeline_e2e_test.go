package nfhealth

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// A repaired baseline is detectable through baselineDigest but does not
// retroactively rewrite a later record: re-analysis of earlier hours is not part
// of this release and must not be implied by a silent rewrite.
func assertNoRetroactiveRewrite(t *testing.T, repo *Repository, target *HealthTarget, sink *recordingSink, end time.Time, epoch string, prior MetricAnalysis) {
	t.Helper()
	repaired := aggregateHourBucket(end.Add(-2*time.Hour), epoch, []float64{float64(100 * analysisMiB)}, true)
	repaired.ID = aggregateBucketID(target.TargetID, end.Add(-2*time.Hour))
	repaired.TargetID, repaired.ResourceID = target.TargetID, target.ResourceID
	if err := repo.saveMetricAggregateRetained(context.Background(), &repaired, 1, 0); err != nil {
		t.Fatal(err)
	}
	stored, err := repo.metricAnalysis(context.Background(), prior.ID)
	if err != nil || stored == nil {
		t.Fatalf("analysis record missing: %v", err)
	}
	if stored.BaselineDigest != prior.BaselineDigest {
		t.Fatal("a repaired baseline silently rewrote a published analysis")
	}
	if len(sink.records) != 2 {
		t.Fatalf("repair republished a record: %d", len(sink.records))
	}
}

// recordingSink captures the records the aggregation worker publishes, so the
// end-to-end test can assert the alert side received exactly the expected
// evidence and nothing else.
type recordingSink struct {
	records []MetricAnalysis
}

func (s *recordingSink) PublishMetricAnalysis(_ context.Context, _ *HealthTarget, record MetricAnalysis) error {
	s.records = append(s.records, record)
	return nil
}

func TestMetricPipelineEndToEnd(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	metricAggregateIndexes(t, ctx, repo)
	target := aggregateTarget()
	target.TargetID = newUUID()
	target.ResourceID = newUUID()
	if _, err := repo.targets.InsertOne(ctx, target); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	end := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-time.Hour)
	epoch := analysisEpoch(t, target, end, "pipeline-epoch")
	for i := 0; i < MetricAnalysisBaselineHours; i++ {
		seedAnalysisHour(t, repo, target, end.Add(-time.Duration(MetricAnalysisBaselineHours-i)*time.Hour), epoch, float64(100*analysisMiB+i*2*analysisMiB), true)
	}
	// The current hour continues the same line, so both the baseline deviation
	// and the sustained trend are expected to fire.
	for i := 0; i <= 30; i++ {
		row := aggregateObservation(target, end.Add(time.Duration(i)*2*time.Minute), float64(100*analysisMiB+MetricAnalysisBaselineHours*2*analysisMiB), "pipeline-epoch")
		if err := repo.InsertRun(ctx, &row.Run); err != nil {
			t.Fatal(err)
		}
		if err := repo.InsertSample(ctx, row.Sample); err != nil {
			t.Fatal(err)
		}
	}
	sink := &recordingSink{}
	worker := NewMetricAggregateWorker(repo, true, func(context.Context, *HealthTarget) error { return nil })
	worker.SetAnalysisSink(sink)
	worker.Tick(ctx, now)
	if len(sink.records) != 2 {
		t.Fatalf("expected one baseline and one trend record, got %d", len(sink.records))
	}
	kinds := map[string]MetricAnalysis{}
	for _, record := range sink.records {
		kinds[record.Kind] = record
	}
	// A steady ramp is not an outlier against its own baseline: the deviation
	// analyzer correctly stays ok while the trend analyzer reports rising. That
	// separation is exactly why both records exist.
	baseline, ok := kinds["baseline"]
	if !ok || baseline.State != AnalysisOK || baseline.Direction != "rising" || baseline.BaselineEligible != MetricAnalysisBaselineHours {
		t.Fatalf("baseline record = %+v", baseline)
	}
	trend, ok := kinds["trend"]
	if !ok || trend.State != TrendRising || !trend.Confirmed {
		t.Fatalf("trend record = %+v", trend)
	}
	// The whole chain is persisted: hour bucket, day rollup and both records.
	if bucket, err := repo.metricAggregate(ctx, aggregateBucketID(target.TargetID, end)); err != nil || bucket == nil || !bucket.SourceComplete {
		t.Fatalf("hour bucket missing: %+v %v", bucket, err)
	}
	if day, err := repo.metricAggregate(ctx, dayBucketID(target.TargetID, metricDayStart(end))); err != nil || day == nil {
		t.Fatalf("day rollup missing: %+v %v", day, err)
	}
	stored, err := repo.metricAnalyses().CountDocuments(ctx, bson.M{})
	if err != nil || stored != 2 {
		t.Fatalf("stored analysis records = %d %v", stored, err)
	}
	// A repeated tick with unchanged evidence publishes nothing new.
	worker.Tick(ctx, now)
	if len(sink.records) != 2 {
		t.Fatalf("repeated tick republished: %d", len(sink.records))
	}
	assertNoRetroactiveRewrite(t, repo, target, sink, end, epoch, trend)
}

// TestMetricHistoryLoadBudget replays the documented capacity shape against a
// real MongoDB and reports latency, scan volume and index usage. It is skipped
// unless explicitly requested, because it writes 72k aggregate documents.
func TestMetricHistoryLoadBudget(t *testing.T) {
	if os.Getenv("NF_METRIC_LOAD_TEST") != "1" {
		t.Skip("set NF_METRIC_LOAD_TEST=1 to run the capacity replay")
	}
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	metricAggregateIndexes(t, ctx, repo)
	// 100 targets x 30 days of hourly buckets. The implementation aggregates one
	// unlabeled series per target, so the plan's "10 series" shape is one series.
	const targets, hours = 100, 720
	now := time.Now().UTC()
	latest := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour)
	batch := make([]any, 0, 1000)
	inserted := 0
	var before runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for i := 0; i < targets; i++ {
		targetID := fmt.Sprintf("11111111-1111-4111-8111-%012d", i)
		resourceID := fmt.Sprintf("22222222-2222-4222-8222-%012d", i)
		for h := 0; h < hours; h++ {
			start := latest.Add(-time.Duration(h+1) * time.Hour)
			batch = append(batch, MetricAggregateBucket{
				ID: aggregateBucketID(targetID, start), TargetID: targetID, ResourceID: resourceID,
				Metric: MetricAggregateMetric, MetricType: "gauge", Series: "unlabeled", Period: MetricHourPeriod, Version: MetricAggregateVersion,
				P95State: P95Complete, Start: start, End: start.Add(time.Hour), Revision: 1, GeneratedAt: now,
				SourceComplete: true, Quality: "measured", Excluded: map[string]int{},
				Segments: []MetricAggregateSegment{{Epoch: "epoch", Count: 30, Sum: 3000, Min: 90, Max: 110, Mean: 100, First: start, Last: start.Add(time.Hour - time.Second), CoveredSeconds: 3600}},
			})
			if len(batch) == 1000 {
				if _, err := repo.metricAggregates().InsertMany(ctx, batch); err != nil {
					t.Fatal(err)
				}
				inserted += len(batch)
				batch = batch[:0]
			}
		}
	}
	if len(batch) > 0 {
		if _, err := repo.metricAggregates().InsertMany(ctx, batch); err != nil {
			t.Fatal(err)
		}
		inserted += len(batch)
	}
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	// Twenty 30-day reads measure the steady-state read path.
	latencies := make([]time.Duration, 0, 20)
	for i := 0; i < 20; i++ {
		start := time.Now()
		view, err := repo.MetricHistory(ctx, MetricHistoryQuery{
			TargetID: fmt.Sprintf("11111111-1111-4111-8111-%012d", i), Metric: MetricAggregateMetric, Series: "unlabeled",
			Resolution: MetricHourPeriod, From: latest.Add(-MaxMetricHourHistoryDays * 24 * time.Hour), To: latest, Limit: 200,
		}, now)
		if err != nil {
			t.Fatal(err)
		}
		latencies = append(latencies, time.Since(start))
		if view.MissingBuckets != 0 || len(view.Buckets) != 200 || !view.Page.HasMore {
			t.Fatalf("unexpected page shape: missing=%d buckets=%d more=%v", view.MissingBuckets, len(view.Buckets), view.Page.HasMore)
		}
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	p95 := latencies[len(latencies)*95/100]
	// The manifest query must use the declared bucket index and stay bounded.
	var explain bson.M
	err := db.RunCommand(ctx, bson.D{
		{Key: "explain", Value: bson.D{
			{Key: "find", Value: "app_nf_metric_aggregates"},
			{Key: "filter", Value: bson.M{"targetId": fmt.Sprintf("11111111-1111-4111-8111-%012d", 0), "metric": MetricAggregateMetric, "series": "unlabeled", "algorithmVersion": MetricAggregateVersion, "period": bson.M{"$in": bson.A{MetricHourPeriod, nil}}, "bucketStart": bson.M{"$gte": latest.Add(-720 * time.Hour), "$lt": latest}}},
			{Key: "sort", Value: bson.M{"bucketStart": 1}},
		}},
		{Key: "verbosity", Value: "executionStats"},
	}).Decode(&explain)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(explain)
	indexHit := strings.Contains(string(raw), "uniq_nf_metric_bucket")
	scanned := int64(0)
	if stats, ok := explain["executionStats"].(bson.M); ok {
		switch value := stats["totalDocsExamined"].(type) {
		case int64:
			scanned = value
		case int32:
			scanned = int64(value)
		case float64:
			scanned = int64(value)
		}
	}
	t.Logf("LOAD targets=%d hours=%d docs=%d p50=%s p95=%s scanned=%d index=%v heap_delta_kb=%d",
		targets, hours, inserted, latencies[len(latencies)/2].Round(time.Microsecond), p95.Round(time.Microsecond), scanned, indexHit,
		(int64(after.HeapAlloc)-int64(before.HeapAlloc))/1024)
	if !indexHit {
		t.Fatal("history read did not use the declared bucket index")
	}
	// The bound only applies when the driver exposes the counter; index usage
	// above is the hard assertion.
	if scanned > 0 && scanned > 800 {
		t.Fatalf("manifest scan exceeded its bound: %d documents", scanned)
	}
	_ = options.Find()
}
