package nfalert

import (
	"context"
	"errors"
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

type failingMetricSource struct {
	source MetricOutcomeSource
	fail   bool
}

func (f *failingMetricSource) MetricOutcomes(ctx context.Context, target, resource string, from, to time.Time, limit int) (nfhealth.MetricOutcomeBatch, error) {
	if f.fail {
		return nfhealth.MetricOutcomeBatch{}, errors.New("fixture source unavailable")
	}
	return f.source.MetricOutcomes(ctx, target, resource, from, to, limit)
}

type replaySink struct {
	mu     sync.Mutex
	events []AlertEvent
}

func (s *replaySink) NotifyAlert(_ context.Context, event AlertEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
}

func TestMetricReplayMongoRecoveryAndHistoricalSilence(t *testing.T) {
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
	db := client.Database("xcloud_test_replay_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	repo := NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts"))
	health := nfhealth.NewRepository(db.Collection("app_nf_health_targets"), db.Collection("app_nf_health_runs"), db.Collection("app_nf_health_samples"))
	target := &nfhealth.HealthTarget{TargetID: newUUID(), ResourceID: newUUID(), IdentityState: nfhealth.IdentityInventoryAuthoritative, Enabled: true, Name: "exporter", CollectorProfile: nfhealth.CollectorHTTPMetrics, CollectionMode: nfhealth.CollectionManual, IntervalSeconds: 60, ServiceKind: "none", Domain: "5gc", NFType: "AMF", Revision: 1}
	var rss atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes %d\n# TYPE process_start_time_seconds gauge\nprocess_start_time_seconds 1000\n", rss.Load())
	}))
	defer server.Close()
	target.MetricsEndpoint = server.URL + "/metrics"
	if _, err := db.Collection("app_nf_health_targets").InsertOne(ctx, target); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	base := now.Add(-30 * time.Minute)
	rule, err := repo.CreateRule(ctx, &CreateRuleRequest{Name: "replay", TargetID: target.TargetID, ConditionType: ConditionTypeMetricThreshold, MetricCondition: rssCondition("gt", 100, 50), Severity: SeverityWarning}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	// Declare the policy's fixture start before historical collection evidence.
	_, err = repo.rules.UpdateOne(ctx, bson.M{"_id": rule.RuleID}, bson.M{"$set": bson.M{"updatedAt": base.Add(-time.Second).Format(time.RFC3339Nano)}})
	if err != nil {
		t.Fatal(err)
	}
	clock := &nfhealth.FixedClock{T: base}
	collector := nfhealth.NewCollector(nfhealth.NewHTTPProber(time.Second), nil, nfhealth.NewDestinationAllowlist(strings.TrimPrefix(server.URL, "http://")), nfhealth.NewServiceUnitAllowlist(""))
	collector.SetClock(clock)
	collector.SetCollectionIdentityCheck(func(context.Context, *nfhealth.HealthTarget) error { return nil })
	record := func(at time.Time, value int64) *nfhealth.CollectionResult {
		t.Helper()
		clock.T = at
		rss.Store(value)
		result, err := collector.Collect(ctx, target, "test", false)
		if err != nil {
			t.Fatal(err)
		}
		// Synthetic exporter identity is supplied only for the controller fixture.
		result.Sample.WindowIdentity = "verified-replay-fixture"
		if err := health.RecordCollection(ctx, target, result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	source := &failingMetricSource{source: health}
	production := NewMongoEvaluatorRepository(repo)
	production.SetMetricTargetReader(MetricTargetReaderFunc(func(context.Context, string) (*nfhealth.HealthTarget, error) { return target, nil }))
	production.SetMetricOutcomeSource(source)
	sink := &replaySink{}
	repo.SetAlertEventSink(sink)
	record(base, 150)
	record(base.Add(time.Minute), 40)
	evaluate := func(hint *nfhealth.CollectionResult, at time.Time) *EvaluationOutcome {
		t.Helper()
		out, err := production.EvaluateMetric(ctx, rule, target, hint, at)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	if out := evaluate(nil, now); out.Opened != 0 || out.Recovered != 0 || len(sink.events) != 0 {
		t.Fatal("historical event escaped to alert/notification")
	}
	high := record(now.Add(-2*time.Minute), 150)
	if out := evaluate(high, now); out.Opened != 1 {
		t.Fatalf("fresh missed callback not recovered %+v", out)
	}
	if out := evaluate(high, now); out.Opened != 0 {
		t.Fatal("replay duplicate opened again")
	}
	low := record(now.Add(-time.Minute), 40)
	if out := evaluate(low, now); out.Recovered != 1 {
		t.Fatalf("fresh recovery %+v", out)
	}
	source.fail = true
	if _, err := production.EvaluateMetric(ctx, rule, target, low, now); err == nil {
		t.Fatal("source failure hidden")
	}
	saved, err := repo.GetRule(ctx, rule.RuleID)
	if err != nil || saved.MetricReplay == nil || saved.MetricReplay.State != "failed" || saved.MetricReplay.Failures != 1 {
		t.Fatalf("failure diagnostics %+v %v", saved, err)
	}
	source.fail = false
	worker := NewMetricWorker(production, true)
	worker.NoteHookFailure()
	worker.Tick(ctx, now)
	if worker.Snapshot().HookFailures != 1 || worker.Snapshot().State != "running" {
		t.Fatal("worker diagnostics")
	}
	pending := nfhealth.HealthRun{RunID: newUUID(), TargetID: target.TargetID, ResourceID: target.ResourceID, StartedAt: now.Add(-10 * time.Second).Format(time.RFC3339Nano), Status: nfhealth.RunStatusFailed}
	if err := health.InsertRun(ctx, &pending); err != nil {
		t.Fatal(err)
	}
	latest := record(now, 160)
	if out := evaluate(latest, now); out.Opened != 0 {
		t.Fatal("live callback skipped unpublished older run")
	}
	saved, _ = repo.GetRule(ctx, rule.RuleID)
	if !saved.MetricReplay.More || saved.MetricReplay.Reason != "recording_pending" {
		t.Fatal("barrier not exposed")
	}
	worker.Tick(ctx, now.Add(31*time.Second))
	count, _ := repo.alerts.CountDocuments(ctx, bson.M{})
	if count != 2 {
		t.Fatalf("worker did not resume beyond incomplete gap: %d", count)
	}
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := production.EvaluateMetric(ctx, rule, target, latest, now.Add(32*time.Second)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if count, _ := repo.alerts.CountDocuments(ctx, bson.M{}); count != 2 {
		t.Fatal("concurrent worker/hook duplicated incident")
	}
	if len(sink.events) != 3 {
		t.Fatalf("notification events=%d", len(sink.events))
	}
	_, err = db.Collection("app_nf_health_samples").DeleteOne(ctx, bson.M{"_id": latest.Sample.SampleID})
	if err != nil {
		t.Fatal(err)
	}
	worker.Tick(ctx, now.Add(33*time.Second))
	saved, _ = repo.GetRule(ctx, rule.RuleID)
	if saved.MetricReplay.State != "incomplete" || saved.MetricReplay.Gaps == 0 {
		t.Fatal("expired sample was treated as complete")
	}
	open, _ := production.FindOpenAlert(ctx, rule.RuleID, target.TargetID)
	if open == nil {
		t.Fatal("missing sample recovered an open alert")
	}
	disabled := NewMetricWorker(production, false)
	disabled.Tick(ctx, now)
	if disabled.Snapshot().State != "disabled" {
		t.Fatal("disabled worker ran")
	}
	// Rebuild a positive duration across missed callbacks using real stored rows.
	duration := rssCondition("gt", 100, 50)
	duration.DurationSeconds = 120
	duration.RecoveryDurationSeconds = 120
	durationRule, err := repo.CreateRule(ctx, &CreateRuleRequest{Name: "duration replay", TargetID: target.TargetID, ConditionType: ConditionTypeMetricThreshold, MetricCondition: duration, Severity: SeverityWarning}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	_, err = repo.rules.UpdateOne(ctx, bson.M{"_id": durationRule.RuleID}, bson.M{"$set": bson.M{"updatedAt": base.Format(time.RFC3339Nano)}})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		at := now.Add(time.Duration(i) * time.Minute)
		record(at, 180)
		_, err := production.EvaluateMetric(ctx, durationRule, target, nil, at)
		if err != nil {
			t.Fatal(err)
		}
		open, _ := production.FindOpenAlert(ctx, durationRule.RuleID, target.TargetID)
		if i < 3 && open != nil {
			t.Fatal("replayed duration fired early")
		}
		if i == 3 && (open == nil || open.Evidence.Metric.ElapsedSeconds != 120 || open.Evidence.Metric.Observations != 3) {
			t.Fatalf("duration replay proof %+v", open)
		}
	}

}
