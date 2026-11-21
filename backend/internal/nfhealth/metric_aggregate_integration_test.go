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

func TestMetricAggregateMongoWorkerHistoryAndRawExpiry(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	// The same explicit index shape as the deployment migration, in an owned DB.
	_, err := repo.metricAggregates().Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "targetId", Value: 1}, {Key: "metric", Value: 1}, {Key: "series", Value: 1}, {Key: "algorithmVersion", Value: 1}, {Key: "bucketStart", Value: 1}}, Options: options.Index().SetUnique(true).SetName("uniq_nf_metric_hour")})
	if err != nil {
		t.Fatal(err)
	}
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
	if _, err := repo.samples.DeleteMany(ctx, bson.M{}); err != nil {
		t.Fatal(err)
	}
	q := MetricHistoryQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, Series: "unlabeled", Resolution: "1h", From: start.Add(-time.Hour), To: start.Add(time.Hour), Limit: 1}
	older := BuildMetricHour(target, start.Add(-time.Hour), MetricOutcomeBatch{}, now)
	if err := repo.saveMetricAggregate(ctx, &older, 0); err != nil {
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
	if err != nil || view.MissingHours != 1 || view.Complete {
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
	worker.Tick(ctx, now)
	saved, _ := repo.metricAggregate(ctx, bucket.ID)
	if saved.Revision != 2 {
		t.Fatal("GET or repeated worker rewrote finalized hour")
	}
	count, _ := db.Collection("app_nf_metric_aggregates").CountDocuments(ctx, bson.M{})
	if count != 2 {
		t.Fatal("unexpected history writes")
	}
	// The compound index bounds the hour manifest scan.
	var explanation bson.M
	err = db.RunCommand(ctx, bson.D{{Key: "explain", Value: bson.D{{Key: "find", Value: "app_nf_metric_aggregates"}, {Key: "filter", Value: bson.M{"targetId": target.TargetID, "metric": MetricAggregateMetric, "series": "unlabeled", "algorithmVersion": MetricAggregateVersion, "bucketStart": bson.M{"$gte": q.From, "$lt": q.To}}}, {Key: "sort", Value: bson.M{"bucketStart": 1}}}}, {Key: "verbosity", Value: "executionStats"}}).Decode(&explanation)
	if err != nil {
		t.Fatal(err)
	}
	explainJSON, _ := json.Marshal(explanation)
	if !strings.Contains(string(explainJSON), "uniq_nf_metric_hour") {
		t.Fatal("history index not used")
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
