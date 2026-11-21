package nfalert

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/nfhealth"
)

func TestMetricMongoLifecycleAndReplay(t *testing.T) {
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect(context.Background())
	ping, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ping, nil); err != nil {
		t.Skip("MongoDB unavailable")
	}
	db := client.Database("xcloud_test_metric_" + bson.NewObjectID().Hex())
	defer db.Drop(context.Background())
	ctx := context.Background()
	repo := NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts"))
	// Same uniqueness contract as the production alert index.
	_, err = repo.alerts.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "ruleId", Value: 1}, {Key: "targetId", Value: 1}}, Options: options.Index().SetUnique(true).SetPartialFilterExpression(bson.M{"state": bson.M{"$in": AlertOpenStates}})})
	if err != nil {
		t.Fatal(err)
	}
	var rss atomic.Int64
	rss.Store(150)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes %d\n", rss.Load())
	}))
	defer server.Close()
	target := &nfhealth.HealthTarget{TargetID: "0192f0c0-a000-7000-8000-000000000002", ResourceID: "0192f0c0-a000-7000-8000-000000000003", IdentityState: nfhealth.IdentityInventoryAuthoritative, Enabled: true, Name: "exporter", CollectorProfile: nfhealth.CollectorHTTPMetrics, MetricsEndpoint: server.URL + "/metrics", CollectionMode: nfhealth.CollectionManual, ServiceKind: "none", Domain: "5gc", NFType: "AMF"}
	clock := &nfhealth.FixedClock{T: time.Now().UTC()}
	collector := nfhealth.NewCollector(nfhealth.NewHTTPProber(time.Second), nil, nfhealth.NewDestinationAllowlist(strings.TrimPrefix(server.URL, "http://")), nfhealth.NewServiceUnitAllowlist(""))
	collector.SetClock(clock)
	collector.SetCollectionIdentityCheck(func(context.Context, *nfhealth.HealthTarget) error { return nil })
	collect := func() *nfhealth.CollectionResult {
		t.Helper()
		result, err := collector.Collect(ctx, target, "test", false)
		if err != nil {
			t.Fatal(err)
		}
		if result.Sample == nil {
			t.Fatalf("no accepted sample: %+v", result.Run)
		}
		return result
	}
	rule, err := repo.CreateRule(ctx, &CreateRuleRequest{Name: "RSS", TargetID: target.TargetID, ConditionType: ConditionTypeMetricThreshold, MetricCondition: rssCondition("gt", 100, 50), Severity: SeverityWarning}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	reader := MetricTargetReaderFunc(func(context.Context, string) (*nfhealth.HealthTarget, error) { return target, nil })
	production := NewMongoEvaluatorRepository(repo)
	production.SetMetricTargetReader(reader)
	evaluate := func(result *nfhealth.CollectionResult) *EvaluationOutcome {
		t.Helper()
		out, err := production.EvaluateMetric(ctx, rule, target, result, clock.Now())
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	clock.T = time.Now().UTC()
	first := collect()
	if out := evaluate(first); out.Opened != 1 {
		t.Fatalf("first %+v", out)
	}
	if out := evaluate(first); out.Opened != 0 {
		t.Fatal("duplicate opened")
	}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := production.EvaluateMetric(ctx, rule, target, first, clock.Now()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	open, err := production.FindOpenAlert(ctx, rule.RuleID, target.TargetID)
	if err != nil || open == nil {
		t.Fatalf("open=%+v %v", open, err)
	}
	if open.Evidence.Metric == nil || open.Evidence.Metric.Value != 150 || open.RuleRevision != rule.Revision {
		t.Fatal("missing immutable metric evidence")
	}
	rss.Store(80)
	clock.Advance(2 * time.Minute)
	if out := evaluate(collect()); out.Recovered != 0 {
		t.Fatal("hysteresis recovered")
	}
	clock.Advance(2 * time.Minute)
	missing := collect()
	missing.Sample.Metrics = nil
	if out := evaluate(missing); out.Indeterminate != 1 || out.Recovered != 0 {
		t.Fatalf("missing %+v", out)
	}
	rss.Store(40)
	clock.Advance(2 * time.Minute)
	if out := evaluate(collect()); out.Recovered != 1 {
		t.Fatalf("recovery %+v", out)
	}
	saved, err := repo.GetAlert(ctx, open.AlertID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Evidence.Metric.Value != 150 || saved.MetricRecovery == nil || saved.MetricRecovery.Value != 40 || saved.MetricLatest == nil || saved.MetricLatest.Evidence.Value != 40 {
		t.Fatalf("evidence overwritten %+v", saved)
	}
	production = NewMongoEvaluatorRepository(NewRepository(repo.rules, repo.alerts))
	production.SetMetricTargetReader(reader)
	if out := evaluate(first); out.Opened != 0 {
		t.Fatal("restart replay reopened")
	}
	rss.Store(180)
	clock.Advance(2 * time.Minute)
	if out := evaluate(collect()); out.Opened != 1 {
		t.Fatalf("new incident %+v", out)
	}
	count, err := repo.alerts.CountDocuments(ctx, bson.M{})
	if err != nil || count != 2 {
		t.Fatalf("count=%d %v", count, err)
	}
	// Reconstruct an interrupted open publication: pending journal exists, alert
	// insertion has already happened, but journal completion was lost.
	current, err := production.FindOpenAlert(ctx, rule.RuleID, target.TargetID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := repo.loadMetricState(ctx, rule.RuleID)
	if err != nil {
		t.Fatal(err)
	}
	state.Pending = &metricTransition{Kind: "open", Alert: current, At: current.UpdatedAt, ValidUntil: time.Now().Add(time.Hour)}
	if err := repo.saveMetricState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if err := repo.drainMetricTransition(ctx, rule.RuleID); err != nil {
		t.Fatal(err)
	}
	if n, _ := repo.alerts.CountDocuments(ctx, bson.M{}); n != 2 {
		t.Fatal("pending publication duplicated alert")
	}
	state, err = repo.loadMetricState(ctx, rule.RuleID)
	if err != nil {
		t.Fatal(err)
	}
	stale := *current
	stale.AlertID = metricAlertID(rule.RuleID, "expired-publication")
	state.Pending = &metricTransition{Kind: "open", Alert: &stale, At: current.UpdatedAt, ValidUntil: time.Now().Add(-time.Hour)}
	if err := repo.saveMetricState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if err := repo.drainMetricTransition(ctx, rule.RuleID); err != nil {
		t.Fatal(err)
	}
	if n, _ := repo.alerts.CountDocuments(ctx, bson.M{}); n != 2 {
		t.Fatal("expired journal created an alert")
	}
	fields := MutableRuleFields{Name: "changed", Enabled: true, ConditionType: ConditionTypeMetricThreshold, MetricCondition: rssCondition("gt", 200, 50), Severity: SeverityWarning}
	if _, _, err := repo.UpdateRule(ctx, rule.RuleID, &UpdateRuleRequest{ExpectedRevision: rule.Revision, Rule: fields}, "operator"); err != nil {
		t.Fatal(err)
	}
	saved, _ = repo.GetAlert(ctx, current.AlertID)
	if saved.ResolvedReason != ResolveReasonConfigurationChanged || saved.MetricRecovery != nil || *saved.MetricCondition.Threshold != 100 {
		t.Fatal("policy edit rewrote trigger or fabricated recovery")
	}
	state, err = repo.loadMetricState(ctx, rule.RuleID)
	if err != nil {
		t.Fatal(err)
	}
	stale.AlertID = metricAlertID(rule.RuleID, "cancelled-publication")
	state.Pending = &metricTransition{Kind: "open", Alert: &stale, At: current.UpdatedAt, ValidUntil: time.Now().Add(time.Hour)}
	if err := repo.saveMetricState(ctx, state); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repo.DeleteRule(ctx, rule.RuleID, "operator"); err != nil {
		t.Fatal(err)
	}
	if err := repo.drainMetricTransition(ctx, rule.RuleID); err != nil {
		t.Fatal(err)
	}
	if n, _ := repo.alerts.CountDocuments(ctx, bson.M{}); n != 2 {
		t.Fatal("delete published an abandoned incident")
	}

}
