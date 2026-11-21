package nfalert

import (
	"context"
	"errors"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"testing"
	"time"
)

func TestMetricPolicyClosureResumesDisabledRuleWithoutTelemetry(t *testing.T) {
	ctx := context.Background()
	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017").SetServerSelectionTimeout(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect(ctx)
	if err := client.Ping(ctx, nil); err != nil {
		t.Skip("MongoDB unavailable")
	}
	db := client.Database("xcloud_test_policy_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	repo := NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts"))
	sink := &replaySink{}
	repo.SetAlertEventSink(sink)
	rule, err := repo.CreateRule(ctx, &CreateRuleRequest{Name: "RSS", TargetID: newUUID(), ConditionType: ConditionTypeMetricThreshold, MetricCondition: rssCondition("gt", 100, 50), Severity: SeverityWarning}, "operator")
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Format(time.RFC3339Nano)
	alert := &Alert{AlertID: newUUID(), RuleID: rule.RuleID, TargetID: rule.TargetID, RuleRevision: rule.Revision, ConditionType: ConditionTypeMetricThreshold, MetricCondition: rssCondition("gt", 100, 50), State: AlertStateAssigned, Severity: SeverityWarning, Evidence: AlertEvidence{Metric: &MetricEvidence{Metric: "process_resident_memory_bytes", Value: 150, Unit: "bytes", Subject: "exporter_process"}}}
	if _, err := repo.alerts.InsertOne(ctx, alert); err != nil {
		t.Fatal(err)
	}
	// Simulate a process death after the rule CAS, before closing the incident.
	p := &metricPolicyClosure{Revision: 2, At: at, Reason: ResolveReasonRuleDisabled}
	if _, err := repo.rules.UpdateOne(ctx, bson.M{"_id": rule.RuleID}, bson.M{"$set": bson.M{"revision": 2, "enabled": false, "metricClosure": p}}); err != nil {
		t.Fatal(err)
	}
	production := NewMongoEvaluatorRepository(repo)
	rules, _, err := production.ScanMetricRules(ctx, "")
	if err != nil || len(rules) != 1 {
		t.Fatalf("disabled closure excluded: %v %v", rules, err)
	}
	// No target/source is needed for a configuration close.
	if _, err := production.EvaluateMetric(ctx, &rules[0], nil, nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	saved, err := repo.GetAlert(ctx, alert.AlertID)
	if err != nil || saved.State != AlertStateResolved || saved.ResolvedReason != ResolveReasonRuleDisabled || saved.MetricRecovery != nil || saved.Evidence.Metric.Value != 150 {
		t.Fatalf("invalid closure: %+v %v", saved, err)
	}
	if len(sink.events) != 1 || sink.events[0].Event != AlertEventResolved || sink.events[0].ResolvedReason != ResolveReasonRuleDisabled || sink.events[0].Metric.Trigger.Value != 150 {
		t.Fatal("closure intent lost metric evidence")
	}
	// Repeat an already-closed journal: event re-emission uses the same outbox key.
	current, _ := repo.GetRule(ctx, rule.RuleID)
	current.MetricClosure = p
	if err := repo.drainMetricPolicyClosure(ctx, current); err != nil {
		t.Fatal(err)
	}
	if len(sink.events) != 2 || sink.events[1].OccurredAt != sink.events[0].OccurredAt {
		t.Fatal("closure retry changed identity")
	}
	rules, _, err = production.ScanMetricRules(ctx, "")
	if err != nil || len(rules) != 0 {
		t.Fatal("settled disabled rule kept scanning")
	}
	fields := MutableRuleFields{Name: "draft", Enabled: true, ConditionType: ConditionTypeMetricThreshold, MetricCondition: rssCondition("gt", 200, 50), Severity: SeverityWarning}
	if _, _, err := repo.UpdateRule(ctx, rule.RuleID, &UpdateRuleRequest{ExpectedRevision: 1, Rule: fields}, "operator"); !errors.Is(err, ErrRevisionConflict) {
		t.Fatal("stale edit did not conflict")
	}
	current, _ = repo.GetRule(ctx, rule.RuleID)
	if current.Enabled || *current.MetricCondition.Threshold != 100 {
		t.Fatal("conflicting edit changed policy")
	}
}
