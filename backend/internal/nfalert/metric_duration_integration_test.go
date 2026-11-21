package nfalert

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/nfhealth"
)

func TestMetricMongoDurationContinuity(t *testing.T) {
	ctx := context.Background()
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect(ctx)
	ping, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := client.Ping(ping, nil); err != nil {
		t.Skip("MongoDB unavailable")
	}
	db := client.Database("xcloud_test_duration_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	repo := NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts"))
	var rss atomic.Int64
	rss.Store(150)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes %d\n# TYPE process_start_time_seconds gauge\nprocess_start_time_seconds 1000\n", rss.Load())
	}))
	defer server.Close()
	target := &nfhealth.HealthTarget{TargetID: newUUID(), ResourceID: newUUID(), IdentityState: nfhealth.IdentityInventoryAuthoritative, Enabled: true, Name: "exporter", CollectorProfile: nfhealth.CollectorHTTPMetrics, MetricsEndpoint: server.URL + "/metrics", CollectionMode: nfhealth.CollectionManual, IntervalSeconds: 60, ServiceKind: "none", Domain: "5gc", NFType: "AMF", Revision: 1}
	condition := rssCondition("gt", 100, 50)
	condition.DurationSeconds = 120
	condition.RecoveryDurationSeconds = 120
	rule, err := repo.CreateRule(ctx, &CreateRuleRequest{Name: "duration", TargetID: target.TargetID, ConditionType: ConditionTypeMetricThreshold, MetricCondition: condition, Severity: SeverityWarning}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	clock := &nfhealth.FixedClock{T: time.Now().UTC().Add(time.Minute)}
	collector := nfhealth.NewCollector(nfhealth.NewHTTPProber(time.Second), nil, nfhealth.NewDestinationAllowlist(strings.TrimPrefix(server.URL, "http://")), nfhealth.NewServiceUnitAllowlist(""))
	collector.SetClock(clock)
	collector.SetCollectionIdentityCheck(func(context.Context, *nfhealth.HealthTarget) error { return nil })
	reader := MetricTargetReaderFunc(func(context.Context, string) (*nfhealth.HealthTarget, error) { return target, nil })
	production := NewMongoEvaluatorRepository(repo)
	production.SetMetricTargetReader(reader)
	epoch := "verified-fixture-epoch"
	collect := func() *nfhealth.CollectionResult {
		t.Helper()
		result, err := collector.Collect(ctx, target, "test", false)
		if err != nil || result.Sample == nil {
			t.Fatalf("collect %v %+v", err, result)
		}
		// Controller integration supplies an explicitly synthetic verified token.
		// nfhealth tests separately enforce actual local process/incarnation proof.
		result.Sample.WindowIdentity = epoch
		return result
	}
	evaluate := func(result *nfhealth.CollectionResult) *EvaluationOutcome {
		t.Helper()
		out, err := production.EvaluateMetric(ctx, rule, target, result, clock.Now())
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	tick := func(value int64) *EvaluationOutcome {
		clock.Advance(time.Minute)
		rss.Store(value)
		return evaluate(collect())
	}
	first := collect()
	if out := evaluate(first); out.Opened != 0 {
		t.Fatal("first sample fired")
	}
	tick(150)
	// A restarted evaluator reconstructs the first two observations from Mongo.
	repo = NewRepository(repo.rules, repo.alerts)
	production = NewMongoEvaluatorRepository(repo)
	production.SetMetricTargetReader(reader)
	if out := tick(150); out.Opened != 1 {
		t.Fatalf("persisted timer %+v", out)
	}
	open, err := production.FindOpenAlert(ctx, rule.RuleID, target.TargetID)
	if err != nil || open == nil {
		t.Fatal("no open alert", err)
	}
	if open.Evidence.Metric.ElapsedSeconds != 120 || open.Evidence.Metric.Observations != 3 || open.Evidence.Metric.FirstSampleID != first.Sample.SampleID {
		t.Fatalf("duration proof %+v", open.Evidence.Metric)
	}
	if out := evaluate(first); out.Opened != 0 || out.Recovered != 0 {
		t.Fatal("old sample changed alert")
	}
	tick(40)
	tick(80)
	tick(40)
	clock.Advance(time.Minute)
	failed := &nfhealth.CollectionResult{Run: nfhealth.HealthRun{RunID: newUUID(), TargetID: target.TargetID, ResourceID: target.ResourceID, StartedAt: clock.Now().Format(time.RFC3339Nano), Status: nfhealth.RunStatusFailed}}
	if out := evaluate(failed); out.Recovered != 0 || out.Indeterminate != 1 {
		t.Fatal("failed run recovered")
	}
	tick(40)
	// Replayed older failure cannot erase a newer recovery segment.
	evaluate(failed)
	if out := tick(40); out.Recovered != 0 {
		t.Fatal("recovered early")
	}
	if out := tick(40); out.Recovered != 1 {
		t.Fatalf("recovery %+v", out)
	}
	saved, err := repo.GetAlert(ctx, open.AlertID)
	if err != nil || saved.MetricRecovery == nil || saved.MetricRecovery.ElapsedSeconds != 120 || saved.Evidence.Metric.Value != 150 {
		t.Fatalf("lost proof %+v %v", saved, err)
	}
	tick(150)
	clock.Advance(2 * time.Minute)
	if out := tick(150); out.Opened != 0 {
		t.Fatal("gap accrued duration")
	}
	state, err := repo.loadMetricState(ctx, rule.RuleID)
	if err != nil || state.Status.ElapsedSeconds != 0 {
		t.Fatalf("gap status %+v %v", state, err)
	}
	epoch = "new-exporter"
	tick(150)
	state, _ = repo.loadMetricState(ctx, rule.RuleID)
	if state.Status.ElapsedSeconds != 0 {
		t.Fatal("new incarnation inherited time")
	}
	epoch = ""
	if out := tick(150); out.Indeterminate != 1 {
		t.Fatal("unverified incarnation accrued time")
	}
	epoch = "third-exporter"
	tick(150)
	current, err := repo.GetRule(ctx, rule.RuleID)
	if err != nil {
		t.Fatal(err)
	}
	fields := MutableRuleFields{Name: current.Name, Enabled: false, ConditionType: ConditionTypeMetricThreshold, MetricCondition: condition, Severity: SeverityWarning}
	_, disabled, err := repo.UpdateRule(ctx, rule.RuleID, &UpdateRuleRequest{ExpectedRevision: current.Revision, Rule: fields}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	fields.Enabled = true
	if _, _, err := repo.UpdateRule(ctx, rule.RuleID, &UpdateRuleRequest{ExpectedRevision: disabled.Revision, Rule: fields}, "operator"); err != nil {
		t.Fatal(err)
	}
	if out := tick(150); out.Opened != 0 {
		t.Fatal("enable inherited duration")
	}
	state, _ = repo.loadMetricState(ctx, rule.RuleID)
	if state.Status.ElapsedSeconds != 0 || state.Status.Observations != 1 {
		t.Fatalf("new timer %+v", state.Status)
	}
	// Cosmetic edits also invalidate pending version-bound progress on reads.
	current, _ = repo.GetRule(ctx, rule.RuleID)
	fields.Name = "renamed"
	if _, _, err := repo.UpdateRule(ctx, rule.RuleID, &UpdateRuleRequest{ExpectedRevision: current.Revision, Rule: fields}, "operator"); err != nil {
		t.Fatal(err)
	}
	current, _ = repo.GetRule(ctx, rule.RuleID)
	if current.MetricEvaluation == nil || current.MetricEvaluation.Reason != "rule_version_changed" {
		t.Fatal("old version displayed as current")
	}
	tick(150)
	state, _ = repo.loadMetricState(ctx, rule.RuleID)
	if state.Status.ElapsedSeconds != 0 {
		t.Fatal("edit inherited time")
	}
	if out := tick(150); out.Opened != 0 {
		t.Fatal("early after edit")
	}
	if out := tick(150); out.Opened != 1 {
		t.Fatal("duration did not complete")
	}
	// A journal prepared before an exporter restart cannot clear the incident
	// under the new epoch. It must begin a new recovery observation segment.
	active, err := production.FindOpenAlert(ctx, rule.RuleID, target.TargetID)
	if err != nil || active == nil {
		t.Fatal("expected open duration alert", err)
	}
	state, _ = repo.loadMetricState(ctx, rule.RuleID)
	state.Pending = &metricTransition{Kind: "recover", RuleRevision: current.Revision, DurationIdentity: state.Timing.Identity, Alert: &Alert{AlertID: active.AlertID}, At: clock.Now().Format(time.RFC3339Nano), ValidUntil: time.Now().Add(time.Hour), Evidence: active.Evidence.Metric}
	if err := repo.saveMetricState(ctx, state); err != nil {
		t.Fatal(err)
	}
	evaluate(failed)
	state, _ = repo.loadMetricState(ctx, rule.RuleID)
	if state.Pending == nil {
		t.Fatal("old failure cancelled a newer journal")
	}
	epoch = "fourth-exporter"
	if out := tick(40); out.Recovered != 0 {
		t.Fatal("incompatible recovery journal was published")
	}
	state, _ = repo.loadMetricState(ctx, rule.RuleID)
	if state.Status.ElapsedSeconds != 0 {
		t.Fatal("replay inherited incompatible recovery timer")
	}
	if out := tick(40); out.Recovered != 0 {
		t.Fatal("recovery after epoch change fired early")
	}
	if out := tick(40); out.Recovered != 1 {
		t.Fatal("new recovery window did not finish")
	}

	tick(150)
	production.SetMetricTargetReader(MetricTargetReaderFunc(func(context.Context, string) (*nfhealth.HealthTarget, error) {
		return nil, fmt.Errorf("identity unavailable")
	}))
	clock.Advance(time.Minute)
	rss.Store(150)
	unavailable := collect()
	if _, err := production.EvaluateMetric(ctx, rule, target, unavailable, clock.Now()); err == nil {
		t.Fatal("identity failure ignored")
	}
	production.SetMetricTargetReader(reader)
	if out := tick(150); out.Opened != 0 {
		t.Fatal("identity failure retained pending duration")
	}
	state, _ = repo.loadMetricState(ctx, rule.RuleID)
	if state.Status.ElapsedSeconds != 0 || state.Status.Observations != 1 {
		t.Fatal("identity outage did not reset timing")
	}

}
