package nfhealth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/auth"
)

// metricAggregateIndexes mirrors the deployment migration: one unique bucket
// identity that separates hourly and daily documents, plus the retention TTL.
func metricAggregateIndexes(t *testing.T, ctx context.Context, repo *Repository) {
	t.Helper()
	_, err := repo.metricAggregates().Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "targetId", Value: 1}, {Key: "metric", Value: 1}, {Key: "series", Value: 1}, {Key: "period", Value: 1}, {Key: "algorithmVersion", Value: 1}, {Key: "bucketStart", Value: 1}}, Options: options.Index().SetUnique(true).SetName("uniq_nf_metric_bucket")},
		{Keys: bson.D{{Key: "expiresAt", Value: 1}}, Options: options.Index().SetName("ttl_nf_metric_bucket").SetExpireAfterSeconds(0)},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMetricAggregateMongoWorkerHistoryAndRawExpiry(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
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
	start := now.Add(-5 * time.Minute).Truncate(time.Hour).Add(-time.Hour)
	for i := 0; i <= 30; i++ {
		row := aggregateObservation(target, start.Add(time.Duration(i)*2*time.Minute), float64(10+i), "fixture-epoch")
		if err := repo.InsertRun(ctx, &row.Run); err != nil {
			t.Fatal(err)
		}
		if err := repo.InsertSample(ctx, row.Sample); err != nil {
			t.Fatal(err)
		}
	}
	worker := NewMetricAggregateWorker(repo, true, func(context.Context, *HealthTarget) error { return nil })
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); worker.Tick(ctx, now) }()
	}
	wg.Wait()
	bucket, err := repo.metricAggregate(ctx, aggregateBucketID(target.TargetID, start))
	if err != nil || bucket == nil || bucket.Revision != 1 || !bucket.SourceComplete || len(bucket.Segments) != 1 || bucket.Segments[0].Count != 30 {
		t.Fatalf("non-idempotent hour %+v %v; worker %+v", bucket, err, worker.Snapshot())
	}
	if bucket.Period != MetricHourPeriod || bucket.ExpiresAt.IsZero() || bucket.ExpiresAt.Sub(bucket.End) != time.Duration(DefaultMetricHourRetentionDays)*24*time.Hour {
		t.Fatalf("hourly retention not stamped: %+v", bucket)
	}
	// The exact percentile survives the round trip; 30 samples of 10..39 give
	// the 29th smallest value.
	if bucket.P95State != P95Complete || bucket.Segments[0].P95 == nil || *bucket.Segments[0].P95 != 38 {
		t.Fatalf("hourly p95 not persisted: %+v", bucket.Segments[0])
	}
	// The same tick rolls the published hour up into its UTC day. An hour whose
	// only evidence is a boundary point may also be published as an empty hour,
	// so the invariant is that every slot is either present or counted missing.
	day := metricDayStart(start)
	dayBucket, err := repo.metricAggregate(ctx, dayBucketID(target.TargetID, day))
	if err != nil || dayBucket == nil || dayBucket.Period != MetricDayPeriod || dayBucket.Hours < 1 || dayBucket.Hours+dayBucket.MissingHours != 24 {
		t.Fatalf("daily rollup missing: %+v %v", dayBucket, err)
	}
	if len(dayBucket.Segments) != 1 || dayBucket.Segments[0].Count != 30 || dayBucket.SourceComplete || dayBucket.Quality != "partial" {
		t.Fatalf("daily rollup invented completeness: %+v", dayBucket)
	}
	if dayBucket.Reason != "day_not_closed" && dayBucket.Reason != "hour_missing" {
		t.Fatalf("daily rollup hid its incompleteness: %+v", dayBucket)
	}
	if dayBucket.ExpiresAt.Sub(dayBucket.End) != time.Duration(DefaultMetricDayRetentionDays)*24*time.Hour {
		t.Fatalf("daily retention not stamped: %+v", dayBucket)
	}
	if _, err := repo.samples.DeleteMany(ctx, bson.M{}); err != nil {
		t.Fatal(err)
	}
	q := MetricHistoryQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, Series: "unlabeled", Resolution: "1h", From: start.Add(-time.Hour), To: start.Add(time.Hour), Limit: 1}
	older := BuildMetricHour(target, start.Add(-time.Hour), MetricOutcomeBatch{}, now)
	prior := int64(0)
	if existing, err := repo.metricAggregate(ctx, older.ID); err == nil && existing != nil {
		// The boundary point of the first data hour may already have published
		// this hour as empty; replace it instead of inserting a second document.
		prior = existing.Revision
	}
	if err := repo.saveMetricAggregate(ctx, &older, prior); err != nil {
		t.Fatal(err)
	}
	first, err := repo.MetricHistory(ctx, q, now)
	if err != nil || !first.Page.HasMore || first.Page.NextCursor == nil {
		t.Fatalf("missing bounded page %+v %v", first, err)
	}
	q.Cursor = *first.Page.NextCursor
	second, err := repo.MetricHistory(ctx, q, now)
	if err != nil || len(second.Buckets) != 1 || second.Buckets[0].Segments[0].Mean != 24.5 {
		t.Fatalf("raw expiry lost aggregate: %+v %v", second, err)
	}
	// Changing a later page invalidates the original manifest, even with raw TTL.
	if err := repo.saveMetricAggregate(ctx, bucket, bucket.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.MetricHistory(ctx, q, now); !errors.Is(err, ErrMetricHistoryChanged) {
		t.Fatal("mixed aggregate versions across pages")
	}
	q.Cursor = ""
	q.Limit = 200
	q.From = start.Add(-2 * time.Hour)
	view, err := repo.MetricHistory(ctx, q, now)
	if err != nil || view.MissingHours != 1 || view.MissingBuckets != 1 || view.Complete {
		t.Fatalf("missing hour became a zero/full view %+v %v", view, err)
	}
	raw, _ := json.Marshal(view)
	for _, private := range []string{"exporter.example", "fixture-epoch", "windowBinding", "windowIdentity", "probes", "metrics_endpoint"} {
		if strings.Contains(string(raw), private) {
			t.Fatalf("history leaked private proof %s", private)
		}
	}
	handler := NewHandler(repo, nil, nil, nil, nil, nil, nil)
	handler.SetMetricHistory(repo, worker)
	values := url.Values{"metric": {MetricAggregateMetric}, "series": {"unlabeled"}, "resolution": {"1h"}, "from": {q.From.Format(time.RFC3339)}, "to": {q.To.Format(time.RFC3339)}}
	request := func(query string, principal *auth.Principal) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/nf-health/targets/"+target.TargetID+"/metric-history?"+query, nil)
		req.SetPathValue("targetId", target.TargetID)
		if principal != nil {
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
		}
		rec := httptest.NewRecorder()
		handler.GetMetricHistory(rec, req)
		return rec
	}
	viewer := &auth.Principal{Username: "reader", NormalizedRole: "viewer"}
	if rec := request(values.Encode(), nil); rec.Code != 401 {
		t.Fatalf("anonymous=%d", rec.Code)
	}
	if rec := request(values.Encode(), viewer); rec.Code != 200 {
		t.Fatalf("viewer read=%d %s", rec.Code, rec.Body)
	}
	if rec := request(values.Encode()+"&limit=201", viewer); rec.Code != 400 {
		t.Fatalf("unbounded read=%d", rec.Code)
	}
	if rec := request(values.Encode()+"&series=other", viewer); rec.Code != 400 {
		t.Fatalf("duplicate scope=%d", rec.Code)
	}
	if rec := request(strings.Replace(values.Encode(), "resolution=1h", "resolution=5m", 1), viewer); rec.Code != 400 {
		t.Fatalf("unregistered resolution=%d", rec.Code)
	}
	worker.Tick(ctx, now)
	saved, _ := repo.metricAggregate(ctx, bucket.ID)
	if saved.Revision != 2 {
		t.Fatal("GET or repeated worker rewrote finalized hour")
	}
	// One counter bucket accompanies the newest hour. This fixture records no
	// counter samples, so the bucket is published as an empty, complete hour
	// instead of a fabricated rate.
	counterBucket, counterErr := repo.metricAggregate(ctx, counterBucketID(target.TargetID, start))
	if counterErr != nil || counterBucket == nil || counterBucket.Metric != MetricCounterMetric || counterBucket.MetricType != "counter" {
		t.Fatalf("counter bucket missing: %+v %v", counterBucket, counterErr)
	}
	if len(counterBucket.Segments) != 0 || counterBucket.Reason != "no_valid_observations" || !counterBucket.SourceComplete {
		t.Fatalf("counter bucket invented a rate: %+v", counterBucket)
	}
	count, _ := db.Collection("app_nf_metric_aggregates").CountDocuments(ctx, bson.M{})
	if count != 4 {
		t.Fatalf("unexpected history writes: %d", count)
	}
	// The compound index bounds the hour manifest scan.
	var explanation bson.M
	err = db.RunCommand(ctx, bson.D{{Key: "explain", Value: bson.D{{Key: "find", Value: "app_nf_metric_aggregates"}, {Key: "filter", Value: bson.M{"targetId": target.TargetID, "metric": MetricAggregateMetric, "series": "unlabeled", "algorithmVersion": MetricAggregateVersion, "period": bson.M{"$in": bson.A{MetricHourPeriod, nil}}, "bucketStart": bson.M{"$gte": q.From, "$lt": q.To}}}, {Key: "sort", Value: bson.M{"bucketStart": 1}}}}, {Key: "verbosity", Value: "executionStats"}}).Decode(&explanation)
	if err != nil {
		t.Fatal(err)
	}
	explainJSON, _ := json.Marshal(explanation)
	if !strings.Contains(string(explainJSON), "uniq_nf_metric_bucket") {
		t.Fatal("history index not used")
	}
}

func TestMetricDailyHistoryContract(t *testing.T) {
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
	day := metricDayStart(now.Add(-72 * time.Hour))
	first := BuildMetricDay(target, day, []MetricAggregateBucket{
		aggregateHourBucket(day, "epoch-a", []float64{10}, true),
		aggregateHourBucket(day.Add(time.Hour), "epoch-a", []float64{20}, true),
	}, now)
	if err := repo.saveMetricAggregateRetained(ctx, &first, 0, time.Duration(DefaultMetricDayRetentionDays)*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	second := BuildMetricDay(target, day.Add(24*time.Hour), nil, now)
	if err := repo.saveMetricAggregateRetained(ctx, &second, 0, time.Duration(DefaultMetricDayRetentionDays)*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	q := MetricHistoryQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, Series: "unlabeled", Resolution: MetricDayPeriod, From: day, To: day.Add(72 * time.Hour), Limit: 1}
	view, err := repo.MetricHistory(ctx, q, now)
	if err != nil || !view.Page.HasMore || view.Page.NextCursor == nil {
		t.Fatalf("missing bounded daily page %+v %v", view, err)
	}
	if view.Resolution != MetricDayPeriod || view.Period != MetricDayPeriod || view.Version != MetricDayAggregateVersion || view.RetentionDays != DefaultMetricDayRetentionDays {
		t.Fatalf("unexpected daily scope %+v", view)
	}
	if view.MissingBuckets != 1 || view.IncompleteBuckets != 2 || view.Complete || len(view.Buckets) != 1 {
		t.Fatalf("missing day became a zero/full view %+v", view)
	}
	if view.Buckets[0].Segments[0].Count != 2 || view.Buckets[0].Segments[0].Mean != 15 {
		t.Fatalf("daily page lost merged statistics %+v", view.Buckets[0])
	}
	// Recomputing a later day invalidates a cursor bound to the earlier manifest.
	recomputed := second
	if err := repo.saveMetricAggregateRetained(ctx, &recomputed, second.Revision, time.Duration(DefaultMetricDayRetentionDays)*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	q.Cursor = *view.Page.NextCursor
	if _, err := repo.MetricHistory(ctx, q, now); !errors.Is(err, ErrMetricHistoryChanged) {
		t.Fatal("daily cursor survived a recomputed day")
	}
	q.Cursor = ""
	q.Limit = 200
	view, err = repo.MetricHistory(ctx, q, now)
	if err != nil || len(view.Buckets) != 2 || view.MissingBuckets != 1 || view.IncompleteBuckets != 2 || view.Complete {
		t.Fatalf("partial day reported complete %+v %v", view, err)
	}
	// The daily window is bounded and aligned; hourly reads never see day rows.
	q.From = day.Add(-91 * 24 * time.Hour)
	if _, err := repo.MetricHistory(ctx, q, now); !errors.Is(err, ErrMetricHistoryInvalid) {
		t.Fatal("daily window beyond 90 days accepted")
	}
	q.From = day.Add(-time.Hour)
	if _, err := repo.MetricHistory(ctx, q, now); !errors.Is(err, ErrMetricHistoryInvalid) {
		t.Fatal("unaligned daily window accepted")
	}
	q = MetricHistoryQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, Series: "unlabeled", Resolution: MetricHourPeriod, From: day, To: day.Add(time.Hour), Limit: 200}
	view, err = repo.MetricHistory(ctx, q, now)
	if err != nil || len(view.Buckets) != 0 || view.MissingBuckets != 1 {
		t.Fatalf("hourly read consumed daily buckets %+v %v", view, err)
	}
}

func TestMetricHistoryReportsBucketsPastRawRetention(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	target := aggregateTarget()
	target.TargetID = newUUID()
	target.ResourceID = newUUID()
	now := time.Now().UTC()
	to := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour)
	from := to.Add(-MaxMetricHourHistoryDays * 24 * time.Hour)
	view, err := repo.MetricHistory(ctx, MetricHistoryQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, Series: "unlabeled", Resolution: MetricHourPeriod, From: from, To: to, Limit: 200}, now)
	if err != nil {
		t.Fatal(err)
	}
	rawCutoff := now.Add(-time.Duration(DefaultRetentionDays) * 24 * time.Hour)
	expectedExpired := 0
	for slot := from; slot.Before(to); slot = slot.Add(time.Hour) {
		if slot.Before(rawCutoff) {
			expectedExpired++
		}
	}
	if view.MissingBuckets != MaxMetricHourHistoryDays*24 || view.ExpiredBuckets != expectedExpired || expectedExpired == 0 {
		t.Fatalf("unreconstructable buckets not reported: missing=%d expired=%d want=%d", view.MissingBuckets, view.ExpiredBuckets, expectedExpired)
	}
	if view.Complete || len(view.Buckets) != 0 {
		t.Fatalf("empty history claimed completeness %+v", view)
	}
}

func TestMetricWorkerRepairsMissingDailyBucket(t *testing.T) {
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
	start := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-3 * time.Hour)
	hour := aggregateHourBucket(start, "epoch-a", []float64{10, 20}, true)
	hour.ID = aggregateBucketID(target.TargetID, start)
	hour.TargetID = target.TargetID
	hour.ResourceID = target.ResourceID
	if err := repo.saveMetricAggregateRetained(ctx, &hour, 0, time.Duration(DefaultMetricHourRetentionDays)*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if bucket, err := repo.metricAggregate(ctx, dayBucketID(target.TargetID, metricDayStart(start))); err != nil || bucket != nil {
		t.Fatalf("day bucket existed before repair: %+v %v", bucket, err)
	}
	worker := NewMetricAggregateWorker(repo, true, func(context.Context, *HealthTarget) error { return nil })
	worker.Tick(ctx, now)
	dayBucket, err := repo.metricAggregate(ctx, dayBucketID(target.TargetID, metricDayStart(start)))
	if err != nil || dayBucket == nil || len(dayBucket.Segments) != 1 || dayBucket.Segments[0].Count != 2 {
		t.Fatalf("missing daily bucket was not repaired: %+v %v", dayBucket, err)
	}
	// A second tick must not rewrite a repaired day that did not change.
	revision := dayBucket.Revision
	worker.Tick(ctx, now)
	again, err := repo.metricAggregate(ctx, dayBucketID(target.TargetID, metricDayStart(start)))
	if err != nil || again.Revision != revision {
		t.Fatalf("repaired day was rewritten without a change: %+v %v", again, err)
	}
}

func TestAggregateSourceBudgetNeverPublishesTruncatedStatistics(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	target := aggregateTarget()
	start := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Hour)
	docs := make([]any, 10001)
	for i := range docs {
		docs[i] = bson.M{"_id": newUUID(), "targetId": target.TargetID, "resourceId": target.ResourceID, "startedAt": start.Format(time.RFC3339Nano), "metricRecorded": true, "status": RunStatusFailed}
	}
	if _, err := repo.runs.InsertMany(ctx, docs); err != nil {
		t.Fatal(err)
	}
	batch, err := repo.AggregateOutcomes(ctx, target.TargetID, target.ResourceID, start, start.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	bucket := BuildMetricHour(target, start, batch, start.Add(2*time.Hour))
	if !batch.More || bucket.SourceComplete || len(bucket.Segments) != 0 || bucket.Reason != "source_budget" {
		t.Fatal("source budget produced complete values")
	}
}

func TestMetricWorkerDisabledAndMissingSourceAreSafe(t *testing.T) {
	disabled := NewMetricAggregateWorker(nil, false, nil)
	disabled.Tick(context.Background(), time.Now())
	disabled.Start(context.Background())
	disabled.Stop()
	if disabled.Snapshot().State != "disabled" || disabled.Snapshot().Failures != 0 {
		t.Fatal("disabled aggregation performed work")
	}
	missing := NewMetricAggregateWorker(nil, true, nil)
	missing.Tick(context.Background(), time.Now())
	if missing.Snapshot().State != "degraded" || missing.Snapshot().Failures != 1 {
		t.Fatal("missing source not diagnosed")
	}
}

func TestAggregatePublicationBarrierAgesByCurrentTime(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	target := aggregateTarget()
	start := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Hour)
	run := HealthRun{RunID: newUUID(), TargetID: target.TargetID, ResourceID: target.ResourceID, StartedAt: start.Add(time.Hour - 10*time.Second).Format(time.RFC3339Nano), Status: RunStatusSuccess, SampleID: newUUID()}
	if err := repo.InsertRun(ctx, &run); err != nil {
		t.Fatal(err)
	}
	batch, err := repo.AggregateOutcomes(ctx, target.TargetID, target.ResourceID, start, start.Add(time.Hour))
	if err != nil || batch.More || batch.Gaps == 0 {
		t.Fatalf("old end-of-hour recording barrier did not age: %+v %v", batch, err)
	}
	bucket := BuildMetricHour(target, start, batch, start.Add(2*time.Hour))
	if bucket.SourceComplete || bucket.Reason != "source_gap" || len(bucket.Segments) != 0 {
		t.Fatal("incomplete publication invented a valid aggregate")
	}
}
