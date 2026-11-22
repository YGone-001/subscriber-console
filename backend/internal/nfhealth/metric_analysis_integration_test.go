package nfhealth

import (
	"context"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"subscriber/internal/auth"
)

// analysisEpoch derives the opaque epoch the hourly builder assigns to a sample
// with this identity, so seeded baselines share the analyzed population.
func analysisEpoch(t *testing.T, target *HealthTarget, at time.Time, identity string) string {
	t.Helper()
	row := aggregateObservation(target, at, 1, identity)
	epoch, _ := ThresholdContinuity(target, row.Sample)
	if epoch == "" {
		t.Fatal("continuity proof unavailable")
	}
	return windowHash(MetricAggregateVersion, epoch)
}

func seedAnalysisHour(t *testing.T, repo *Repository, target *HealthTarget, start time.Time, epoch string, value float64, complete bool) {
	t.Helper()
	bucket := aggregateHourBucket(start, epoch, []float64{value}, complete)
	bucket.ID = aggregateBucketID(target.TargetID, start)
	bucket.TargetID = target.TargetID
	bucket.ResourceID = target.ResourceID
	if err := repo.saveMetricAggregateRetained(context.Background(), &bucket, 0, 0); err != nil {
		t.Fatal(err)
	}
}

func TestMetricAnalysisWorkerPublishesAndReadsRecords(t *testing.T) {
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
	current := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-time.Hour)
	epoch := analysisEpoch(t, target, current, "analysis-epoch")
	for i := 0; i < MetricAnalysisBaselineHours; i++ {
		value := float64(100*analysisMiB + (i%2)*2*analysisMiB)
		seedAnalysisHour(t, repo, target, current.Add(-time.Duration(MetricAnalysisBaselineHours-i)*time.Hour), epoch, value, true)
	}
	for i := 0; i <= 30; i++ {
		row := aggregateObservation(target, current.Add(time.Duration(i)*2*time.Minute), float64(140*analysisMiB+i), "analysis-epoch")
		if err := repo.InsertRun(ctx, &row.Run); err != nil {
			t.Fatal(err)
		}
		if err := repo.InsertSample(ctx, row.Sample); err != nil {
			t.Fatal(err)
		}
	}
	worker := NewMetricAggregateWorker(repo, true, func(context.Context, *HealthTarget) error { return nil })
	worker.Tick(ctx, now)
	record, err := repo.metricAnalysis(ctx, analysisID(target.TargetID, MetricAggregateMetric, current))
	if err != nil || record == nil {
		t.Fatalf("analysis record missing: %v", err)
	}
	if record.State != AnalysisAnomaly || record.Direction != "rising" || record.BaselineEligible != MetricAnalysisBaselineHours {
		t.Fatalf("unexpected analysis %+v", record)
	}
	if record.AlgorithmVersion != MetricAnalysisVersion || record.PolicyVersion != MetricAnalysisPolicyVersion || record.SourceRevision == 0 {
		t.Fatalf("analysis identity %+v", record)
	}
	view, err := repo.MetricAnalyses(ctx, MetricAnalysisQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, From: current, To: current.Add(time.Hour), Limit: 200}, now)
	if err != nil || len(view.Items) != 1 || view.Items[0].ID != record.ID {
		t.Fatalf("analysis read %+v %v", view, err)
	}
	if view.BaselineHours != MetricAnalysisBaselineHours || view.ScoreThreshold != MetricAnalysisScoreThreshold || view.PolicyVersion != MetricAnalysisPolicyVersion {
		t.Fatalf("analysis policy not published: %+v", view)
	}
	// A repeated tick with unchanged inputs must not rewrite the record.
	revision := record.Revision
	worker.Tick(ctx, now)
	again, err := repo.metricAnalysis(ctx, record.ID)
	if err != nil || again.Revision != revision {
		t.Fatalf("analysis rewritten without a change: %+v %v", again, err)
	}
}

func TestMetricAnalysisReadContractAndHandler(t *testing.T) {
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
	latest := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-time.Hour)
	older := latest.Add(-40 * 24 * time.Hour)
	for _, start := range []time.Time{older, latest} {
		value := float64(100 * analysisMiB)
		record := MetricAnalysis{
			ID: analysisID(target.TargetID, MetricAggregateMetric, start), TargetID: target.TargetID, ResourceID: target.ResourceID,
			Metric: MetricAggregateMetric, Series: "unlabeled", BucketStart: start,
			Kind: "baseline", AlgorithmVersion: MetricAnalysisVersion, PolicyVersion: MetricAnalysisPolicyVersion,
			State: AnalysisOK, Unit: "bytes", Value: &value, BaselineExpected: MetricAnalysisBaselineHours,
			BaselineEligible: MetricAnalysisBaselineHours, BaselineCoverage: 1, ComputedAt: now,
		}
		if err := repo.saveMetricAnalysis(ctx, &record, nil); err != nil {
			t.Fatal(err)
		}
	}
	query := MetricAnalysisQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, From: older, To: latest.Add(time.Hour), Limit: 1}
	page, err := repo.MetricAnalyses(ctx, query, now)
	if err != nil || !page.Page.HasMore || page.Page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatalf("bounded page %+v %v", page, err)
	}
	if page.Items[0].BucketStart.Equal(older) {
		t.Fatal("analysis page is not newest first")
	}
	if page.Items[0].EvidenceExpired {
		t.Fatal("a recent analysis was reported as expired")
	}
	query.Cursor = *page.Page.NextCursor
	second, err := repo.MetricAnalyses(ctx, query, now)
	if err != nil || len(second.Items) != 1 || !second.Items[0].BucketStart.Equal(older) {
		t.Fatalf("second page %+v %v", second, err)
	}
	if !second.Items[0].EvidenceExpired {
		t.Fatal("an analysis older than hourly retention was not marked expired")
	}
	// A changed record invalidates the cursor bound to the earlier manifest.
	changed, err := repo.metricAnalysis(ctx, analysisID(target.TargetID, MetricAggregateMetric, latest))
	if err != nil || changed == nil {
		t.Fatal(err)
	}
	if err := repo.saveMetricAnalysis(ctx, changed, changed); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.MetricAnalyses(ctx, query, now); err != ErrMetricAnalysisChanged {
		t.Fatalf("stale cursor accepted: %v", err)
	}
	handler := NewHandler(repo, nil, nil, nil, nil, nil, nil)
	handler.SetMetricAnalysis(repo)
	values := url.Values{"metric": {MetricAggregateMetric}, "from": {older.Format(time.RFC3339)}, "to": {latest.Add(time.Hour).Format(time.RFC3339)}}
	request := func(query string, principal *auth.Principal) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/nf-health/targets/"+target.TargetID+"/metric-analysis?"+query, nil)
		req.SetPathValue("targetId", target.TargetID)
		if principal != nil {
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
		}
		rec := httptest.NewRecorder()
		handler.GetMetricAnalysis(rec, req)
		return rec
	}
	viewer := &auth.Principal{Username: "reader", NormalizedRole: "viewer"}
	if rec := request(values.Encode(), nil); rec.Code != 401 {
		t.Fatalf("anonymous=%d", rec.Code)
	}
	if rec := request(values.Encode(), viewer); rec.Code != 200 {
		t.Fatalf("viewer read=%d %s", rec.Code, rec.Body)
	}
	if rec := request(values.Encode()+"&metric=process_cpu_seconds_total", viewer); rec.Code != 400 {
		t.Fatalf("counter analysis accepted=%d", rec.Code)
	}
	if rec := request(values.Encode()+"&limit=201", viewer); rec.Code != 400 {
		t.Fatalf("unbounded analysis read=%d", rec.Code)
	}
	missing := NewHandler(repo, nil, nil, nil, nil, nil, nil)
	req := httptest.NewRequest("GET", "/api/nf-health/targets/"+target.TargetID+"/metric-analysis", nil)
	req.SetPathValue("targetId", target.TargetID)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), viewer))
	rec := httptest.NewRecorder()
	missing.GetMetricAnalysis(rec, req)
	if rec.Code != 503 {
		t.Fatalf("unconfigured reader=%d", rec.Code)
	}
}
