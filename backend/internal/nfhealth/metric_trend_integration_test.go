package nfhealth

import (
	"context"
	"errors"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"subscriber/internal/auth"
)

func TestMetricTrendWorkerPublishesConfirmedEvent(t *testing.T) {
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
	end := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-time.Hour)
	epoch := analysisEpoch(t, target, end, "trend-epoch")
	// Eight published hours plus one hour of samples continue the same line.
	for i := 0; i < MetricTrendWindowHours; i++ {
		value := float64(100*analysisMiB + i*2*analysisMiB)
		seedAnalysisHour(t, repo, target, end.Add(-time.Duration(MetricTrendWindowHours-i)*time.Hour), epoch, value, true)
	}
	for i := 0; i <= 30; i++ {
		row := aggregateObservation(target, end.Add(time.Duration(i)*2*time.Minute), float64(100*analysisMiB+MetricTrendWindowHours*2*analysisMiB), "trend-epoch")
		if err := repo.InsertRun(ctx, &row.Run); err != nil {
			t.Fatal(err)
		}
		if err := repo.InsertSample(ctx, row.Sample); err != nil {
			t.Fatal(err)
		}
	}
	worker := NewMetricAggregateWorker(repo, true, func(context.Context, *HealthTarget) error { return nil })
	worker.Tick(ctx, now)
	trend, err := repo.metricAnalysis(ctx, trendID(target.TargetID, MetricAggregateMetric, end))
	if err != nil || trend == nil {
		t.Fatalf("trend record missing: %v", err)
	}
	if trend.Kind != "trend" || trend.State != TrendRising || !trend.Confirmed {
		t.Fatalf("trend not confirmed: %+v", trend)
	}
	if trend.Slope == nil || *trend.Slope <= 0 || trend.EligibleBuckets < MetricTrendMinEligible {
		t.Fatalf("trend statistics = %+v", trend)
	}
	if trend.PolicyVersion != MetricTrendPolicyVersion || trend.AlgorithmVersion != MetricTrendVersion {
		t.Fatalf("trend policy = %+v", trend)
	}
	// A repeated tick with unchanged inputs must not rewrite the event.
	revision := trend.Revision
	worker.Tick(ctx, now)
	again, err := repo.metricAnalysis(ctx, trend.ID)
	if err != nil || again.Revision != revision {
		t.Fatalf("trend rewritten without a change: %+v %v", again, err)
	}
	// Baseline and trend records share a collection but never a read partition.
	window := MetricAnalysisQuery{TargetID: target.TargetID, Metric: MetricAggregateMetric, From: end, To: end.Add(time.Hour), Limit: 200}
	window.Kind = "trend"
	trends, err := repo.MetricAnalyses(ctx, window, now)
	if err != nil || len(trends.Items) != 1 || trends.Items[0].Kind != "trend" || trends.Kind != "trend" {
		t.Fatalf("trend partition = %+v %v", trends, err)
	}
	if trends.WindowHours != MetricTrendWindowHours || trends.MinFit != MetricTrendMinFit || trends.MinTrendChange != MetricTrendMinChange {
		t.Fatalf("trend policy not published: %+v", trends)
	}
	window.Kind = "baseline"
	baselines, err := repo.MetricAnalyses(ctx, window, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range baselines.Items {
		if item.Kind == "trend" {
			t.Fatalf("baseline partition returned a trend record: %+v", item)
		}
	}
	if baselines.Kind != "baseline" || baselines.BaselineHours != MetricAnalysisBaselineHours {
		t.Fatalf("baseline policy lost: %+v", baselines)
	}
	window.Kind = "history"
	if _, err := repo.MetricAnalyses(ctx, window, now); !errors.Is(err, ErrMetricAnalysisInvalid) {
		t.Fatalf("unknown kind accepted: %v", err)
	}
	handler := NewHandler(repo, nil, nil, nil, nil, nil, nil)
	handler.SetMetricAnalysis(repo)
	values := url.Values{"metric": {MetricAggregateMetric}, "kind": {"trend"}, "from": {end.Format(time.RFC3339)}, "to": {end.Add(time.Hour).Format(time.RFC3339)}}
	request := func(query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/nf-health/targets/"+target.TargetID+"/metric-analysis?"+query, nil)
		req.SetPathValue("targetId", target.TargetID)
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{Username: "reader", NormalizedRole: "viewer"}))
		rec := httptest.NewRecorder()
		handler.GetMetricAnalysis(rec, req)
		return rec
	}
	if rec := request(values.Encode()); rec.Code != 200 {
		t.Fatalf("trend read=%d %s", rec.Code, rec.Body)
	}
	if rec := request(values.Encode() + "&kind=history"); rec.Code != 400 {
		t.Fatalf("unknown kind read=%d", rec.Code)
	}
}
