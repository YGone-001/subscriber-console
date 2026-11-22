package nfalert

import (
	"context"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/nfhealth"
)

type pipelineEventSink struct{ events []AlertEvent }

func (s *pipelineEventSink) NotifyAlert(_ context.Context, event AlertEvent) {
	s.events = append(s.events, event)
}

func pipelineAlertRepo(t *testing.T) (*Repository, *mongo.Database, func()) {
	t.Helper()
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		t.Skipf("mongo unavailable: %v", err)
	}
	db := client.Database("xcloud_test_nfalert_pipeline_" + bson.NewObjectID().Hex())
	repo := NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts"))
	return repo, db, func() {
		_ = db.Drop(context.Background())
		_ = client.Disconnect(context.Background())
	}
}

func trendRecord(bucket time.Time, state, direction string, confirmed bool) nfhealth.MetricAnalysis {
	return nfhealth.MetricAnalysis{
		Kind: "trend", TargetID: "target", ResourceID: "resource", Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled",
		State: state, Direction: direction, Confirmed: confirmed, BucketStart: bucket.UTC(),
		AlgorithmVersion: nfhealth.MetricTrendVersion, PolicyVersion: nfhealth.MetricTrendPolicyVersion,
	}
}

// TestAnalysisRuleFiresHoldsAndRecovers drives the alert side of the analysis
// pipeline: one event opens an alert, a replay does not duplicate it, unusable
// evidence holds, and two consecutive normal records are required to close it.
func TestAnalysisRuleFiresHoldsAndRecovers(t *testing.T) {
	repo, db, cleanup := pipelineAlertRepo(t)
	defer cleanup()
	ctx := context.Background()
	sink := &pipelineEventSink{}
	repo.SetAlertEventSink(sink)
	target := &nfhealth.HealthTarget{TargetID: "33333333-3333-4333-8333-333333333333", ResourceID: "44444444-4444-4444-8444-444444444444", Name: "pipeline"}
	rule, err := repo.CreateRule(ctx, &CreateRuleRequest{
		Name: "analysis pipeline", TargetID: target.TargetID, ConditionType: ConditionTypeMetricAnalysis, Severity: SeverityWarning,
		AnalysisCondition: &AnalysisCondition{
			Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled", Kind: AnalysisKindTrend, Direction: "rising",
			AlgorithmVersion: nfhealth.MetricTrendVersion, PolicyVersion: nfhealth.MetricTrendPolicyVersion,
		},
	}, "tester")
	if err != nil {
		t.Fatal(err)
	}
	evaluator := NewMongoEvaluatorRepository(repo)
	now := time.Now().UTC()
	bucket := now.Add(-10 * time.Minute).Truncate(time.Hour)
	countAlerts := func() int64 {
		value, err := db.Collection("app_nf_alerts").CountDocuments(ctx, bson.M{"ruleId": rule.RuleID})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	if err := evaluator.PublishMetricAnalysis(ctx, target, trendRecord(bucket, nfhealth.TrendRising, "rising", true)); err != nil {
		t.Fatal(err)
	}
	if countAlerts() != 1 || len(sink.events) != 1 || sink.events[0].Event != AlertEventOpened {
		t.Fatalf("first event did not open exactly one alert: alerts=%d events=%d", countAlerts(), len(sink.events))
	}
	// Replaying the same hour is idempotent and silent.
	if err := evaluator.PublishMetricAnalysis(ctx, target, trendRecord(bucket, nfhealth.TrendRising, "rising", true)); err != nil {
		t.Fatal(err)
	}
	if countAlerts() != 1 || len(sink.events) != 1 {
		t.Fatalf("replay duplicated the alert: alerts=%d events=%d", countAlerts(), len(sink.events))
	}
	// Unusable evidence holds: it must not close the open alert.
	if err := evaluator.PublishMetricAnalysis(ctx, target, trendRecord(bucket.Add(time.Hour), nfhealth.AnalysisInsufficientData, "", false)); err != nil {
		t.Fatal(err)
	}
	// One normal record is not enough to close it.
	if err := evaluator.PublishMetricAnalysis(ctx, target, trendRecord(bucket.Add(2*time.Hour), nfhealth.TrendStable, "stable", false)); err != nil {
		t.Fatal(err)
	}
	if open, err := evaluator.FindOpenAlert(ctx, rule.RuleID, target.TargetID); err != nil || open == nil {
		t.Fatalf("alert closed after a single normal record: %+v %v", open, err)
	}
	// The second consecutive normal record closes it and emits a resolution.
	if err := evaluator.PublishMetricAnalysis(ctx, target, trendRecord(bucket.Add(3*time.Hour), nfhealth.TrendStable, "stable", false)); err != nil {
		t.Fatal(err)
	}
	if open, err := evaluator.FindOpenAlert(ctx, rule.RuleID, target.TargetID); err != nil || open != nil {
		t.Fatalf("alert still open after two normal records: %+v %v", open, err)
	}
	if len(sink.events) != 2 || sink.events[1].Event != AlertEventResolved {
		t.Fatalf("resolution was not notified: %+v", sink.events)
	}
	// A stale event still becomes evidence but never pages an operator.
	stale := trendRecord(now.Add(-3*time.Hour).Truncate(time.Hour), nfhealth.TrendRising, "rising", true)
	if err := evaluator.PublishMetricAnalysis(ctx, target, stale); err != nil {
		t.Fatal(err)
	}
	if countAlerts() != 2 {
		t.Fatalf("stale event did not become evidence: %d", countAlerts())
	}
	if len(sink.events) != 2 {
		t.Fatalf("stale event notified: %+v", sink.events)
	}
	// A rule for another target never sees this record.
	other := &nfhealth.HealthTarget{TargetID: "55555555-5555-4555-8555-555555555555", Name: "other"}
	before := countAlerts()
	if err := evaluator.PublishMetricAnalysis(ctx, other, trendRecord(bucket.Add(4*time.Hour), nfhealth.TrendRising, "rising", true)); err != nil {
		t.Fatal(err)
	}
	if countAlerts() != before {
		t.Fatal("a rule evaluated a record from another target")
	}
}
