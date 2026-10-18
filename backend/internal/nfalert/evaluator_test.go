package nfalert

import (
	"context"
	"testing"
	"time"

	"subscriber/internal/nfhealth"
)

// fakeClock is an injectable deterministic clock.
type fakeClock struct{ now time.Time }

func (c fakeClock) Now() time.Time { return c.now }

// alertEvent records one repository mutation for assertions.
type alertEvent struct {
	kind    string // insert | recount | resolve
	alertID string
	count   int
	evid    AlertEvidence
}

// fakeEvalRepo is an in-memory EvaluationRepository.
type fakeEvalRepo struct {
	rules   []AlertRule
	open    map[string]*Alert // key: ruleID + "|" + targetID
	events  []alertEvent
	listErr error
	failOn  string // kind that returns an error
	failErr error
}

func newFakeEvalRepo(rules ...AlertRule) *fakeEvalRepo {
	return &fakeEvalRepo{rules: rules, open: map[string]*Alert{}}
}

func (f *fakeEvalRepo) ListRulesForEvaluation(ctx context.Context) ([]AlertRule, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	enabled := make([]AlertRule, 0, len(f.rules))
	for _, r := range f.rules {
		if r.Enabled {
			enabled = append(enabled, r)
		}
	}
	return enabled, nil
}

func (f *fakeEvalRepo) FindOpenAlert(ctx context.Context, ruleID, targetID string) (*Alert, error) {
	if a, ok := f.open[ruleID+"|"+targetID]; ok {
		return a, nil
	}
	return nil, nil
}

func (f *fakeEvalRepo) InsertAlert(ctx context.Context, alert *Alert) error {
	if f.failOn == "insert" {
		return f.failErr
	}
	f.open[alert.RuleID+"|"+alert.TargetID] = alert
	f.events = append(f.events, alertEvent{kind: "insert", alertID: alert.AlertID, count: alert.TriggerCount, evid: alert.Evidence})
	return nil
}

func (f *fakeEvalRepo) RecountAlert(ctx context.Context, alertID string, triggerCount int, lastTriggeredAt string, evidence AlertEvidence) error {
	if f.failOn == "recount" {
		return f.failErr
	}
	for _, a := range f.open {
		if a.AlertID == alertID {
			a.TriggerCount = triggerCount
			a.LastTriggeredAt = lastTriggeredAt
			a.Evidence = evidence
		}
	}
	f.events = append(f.events, alertEvent{kind: "recount", alertID: alertID, count: triggerCount, evid: evidence})
	return nil
}

func (f *fakeEvalRepo) ResolveAlertByRecovery(ctx context.Context, alertID, resolvedAt string) error {
	if f.failOn == "resolve" {
		return f.failErr
	}
	for k, a := range f.open {
		if a.AlertID == alertID {
			a.State = AlertStateResolved
			a.ResolvedAt = resolvedAt
			a.ResolvedReason = ResolveReasonRecovery
			delete(f.open, k)
		}
	}
	f.events = append(f.events, alertEvent{kind: "resolve", alertID: alertID})
	return nil
}

func testTarget(targetID, resourceID string) *nfhealth.HealthTarget {
	return &nfhealth.HealthTarget{TargetID: targetID, ResourceID: resourceID, Name: "amf-1"}
}

func testResult(runStatus string, layers *nfhealth.LayerSet) *nfhealth.CollectionResult {
	res := &nfhealth.CollectionResult{Run: nfhealth.HealthRun{Status: runStatus}}
	if layers != nil {
		res.Sample = &nfhealth.HealthSample{
			SampleID:    "sample-1",
			CollectedAt: "2026-10-18T10:00:00Z",
			Layers:      *layers,
		}
	}
	return res
}

func unhealthyLayers() *nfhealth.LayerSet {
	return &nfhealth.LayerSet{
		Process:   nfhealth.LayerEvidence{State: nfhealth.StateHealthy, Measured: true},
		Interface: nfhealth.LayerEvidence{State: nfhealth.StateHealthy, Measured: true},
		Service:   nfhealth.LayerEvidence{State: nfhealth.StateUnhealthy, Measured: true},
	}
}

func healthyLayers() *nfhealth.LayerSet {
	return &nfhealth.LayerSet{
		Process:   nfhealth.LayerEvidence{State: nfhealth.StateHealthy, Measured: true},
		Interface: nfhealth.LayerEvidence{State: nfhealth.StateHealthy, Measured: true},
		Service:   nfhealth.LayerEvidence{State: nfhealth.StateHealthy, Measured: true},
	}
}

func stateRule(ruleID string, scope, state, severity string, cooldown int, targetID, resourceID string) AlertRule {
	return AlertRule{
		RuleID:          ruleID,
		Name:            "rule-" + ruleID,
		Enabled:         true,
		TargetID:        targetID,
		ResourceID:      resourceID,
		ConditionType:   ConditionTypeState,
		Condition:       RuleCondition{Scope: scope, State: state},
		Severity:        severity,
		CooldownSeconds: cooldown,
	}
}

func runFailedRule(ruleID string, cooldown int) AlertRule {
	return AlertRule{
		RuleID:          ruleID,
		Name:            "rule-" + ruleID,
		Enabled:         true,
		ConditionType:   ConditionTypeRunFailed,
		Severity:        SeverityCritical,
		CooldownSeconds: cooldown,
	}
}

func newTestEvaluator(repo EvaluationRepository, now time.Time) *Evaluator {
	e := NewEvaluator(repo)
	e.SetClock(fakeClock{now: now})
	return e
}

func TestEvaluateOpensAlertOnStateCondition(t *testing.T) {
	repo := newFakeEvalRepo(stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", ""))
	e := newTestEvaluator(repo, time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC))
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"),
		Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Opened != 1 || out.Recounted != 0 || out.Recovered != 0 {
		t.Fatalf("outcome mismatch: %+v", out)
	}
	alert, ok := repo.open["r1|t1"]
	if !ok {
		t.Fatal("expected an open alert for (r1, t1)")
	}
	if alert.State != AlertStateActive || alert.Severity != SeverityCritical || alert.TriggerCount != 1 {
		t.Fatalf("alert fields mismatch: %+v", alert)
	}
	if alert.Evidence.OverallState != nfhealth.StateUnhealthy {
		t.Fatalf("evidence overallState = %q, want unhealthy", alert.Evidence.OverallState)
	}
	if alert.Evidence.SampleID != "sample-1" {
		t.Fatalf("evidence sampleId = %q", alert.Evidence.SampleID)
	}
}

func TestEvaluateCooldownSuppressesRetrigger(t *testing.T) {
	repo := newFakeEvalRepo(stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", ""))
	base := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	e := newTestEvaluator(repo, base)

	// First trigger opens the alert.
	if _, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}}); err != nil {
		t.Fatalf("first evaluation failed: %v", err)
	}

	// Second trigger 100s later: inside the 300s cooldown window, so it must
	// neither open a new alert nor recount.
	e.SetClock(fakeClock{now: base.Add(100 * time.Second)})
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}})
	if err != nil {
		t.Fatalf("second evaluation failed: %v", err)
	}
	if out.Opened != 0 || out.Recounted != 0 {
		t.Fatalf("cooldown must suppress retrigger: %+v", out)
	}

	// Third trigger 300s later: outside the window, counter is refreshed.
	e.SetClock(fakeClock{now: base.Add(400 * time.Second)})
	out, err = e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}})
	if err != nil {
		t.Fatalf("third evaluation failed: %v", err)
	}
	if out.Opened != 0 || out.Recounted != 1 {
		t.Fatalf("cooldown expiry must recount: %+v", out)
	}
	if alert := repo.open["r1|t1"]; alert == nil || alert.TriggerCount != 2 {
		t.Fatalf("expected triggerCount 2, got %+v", alert)
	}
}

func TestEvaluateRecoveryResolvesOpenAlert(t *testing.T) {
	repo := newFakeEvalRepo(stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", ""))
	base := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	e := newTestEvaluator(repo, base)

	if _, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}}); err != nil {
		t.Fatalf("open evaluation failed: %v", err)
	}

	// Recovered measurement: condition no longer satisfied, the open alert
	// must be resolved with reason recovery.
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, healthyLayers()),
	}})
	if err != nil {
		t.Fatalf("recovery evaluation failed: %v", err)
	}
	if out.Recovered != 1 {
		t.Fatalf("expected recovery, got %+v", out)
	}
	if _, still := repo.open["r1|t1"]; still {
		t.Fatal("alert must not stay open after recovery")
	}

	// A healthy measurement with no open alert does nothing.
	out, err = e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, healthyLayers()),
	}})
	if err != nil {
		t.Fatalf("idle evaluation failed: %v", err)
	}
	if out.Recovered != 0 || out.Opened != 0 {
		t.Fatalf("no-op expected, got %+v", out)
	}
}

func TestEvaluateAbsenceOfSampleNeverAlarms(t *testing.T) {
	repo := newFakeEvalRepo(stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", ""))
	e := newTestEvaluator(repo, time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC))
	// Successful run but no accepted sample: absence of evidence is never
	// an alarm.
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, nil),
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Opened != 0 {
		t.Fatalf("state condition without sample must not alarm: %+v", out)
	}
}

func TestEvaluateRunFailedSemantics(t *testing.T) {
	repo := newFakeEvalRepo(runFailedRule("r1", 300))
	base := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	e := newTestEvaluator(repo, base)

	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusFailed, nil),
	}})
	if err != nil {
		t.Fatalf("failed-run evaluation error: %v", err)
	}
	if out.Opened != 1 {
		t.Fatalf("failed run must open an alert: %+v", out)
	}

	// A partial run still produced evidence and is not a failure.
	e.SetClock(fakeClock{now: base})
	out, err = e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t2", "res-2"), Result: testResult(nfhealth.RunStatusPartial, healthyLayers()),
	}})
	if err != nil {
		t.Fatalf("partial-run evaluation error: %v", err)
	}
	if out.Opened != 0 {
		t.Fatalf("partial run must not open a new alert: %+v", out)
	}
	if _, ok := repo.open["r1|t2"]; ok {
		t.Fatal("partial run must not alarm")
	}
}

func TestEvaluateTargetScoping(t *testing.T) {
	repo := newFakeEvalRepo(
		stateRule("by-target", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "t1", ""),
		stateRule("by-resource", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", "res-9"),
		stateRule("global", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", ""),
	)
	e := newTestEvaluator(repo, time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC))
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// by-target matches t1; by-resource requires res-9 and must not match;
	// global matches everything.
	if out.Opened != 2 {
		t.Fatalf("expected 2 opened alerts (by-target + global), got %+v", out)
	}
	if _, ok := repo.open["by-resource|t1"]; ok {
		t.Fatal("resource-scoped rule must not match a different resource")
	}
}

func TestEvaluateProcessScopeUsesLayerState(t *testing.T) {
	layers := &nfhealth.LayerSet{
		Process:   nfhealth.LayerEvidence{State: nfhealth.StateDegraded, Measured: true},
		Interface: nfhealth.LayerEvidence{State: nfhealth.StateHealthy, Measured: true},
		Service:   nfhealth.LayerEvidence{State: nfhealth.StateHealthy, Measured: true},
	}
	repo := newFakeEvalRepo(stateRule("r1", ScopeProcess, nfhealth.StateDegraded, SeverityWarning, 300, "", ""))
	e := newTestEvaluator(repo, time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC))
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, layers),
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Opened != 1 {
		t.Fatalf("process-scoped condition must match its layer: %+v", out)
	}
}

func TestEvaluateUnparseableTimestampRecountsDeterministically(t *testing.T) {
	repo := newFakeEvalRepo(stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", ""))
	base := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	e := newTestEvaluator(repo, base)
	if _, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}}); err != nil {
		t.Fatalf("open evaluation failed: %v", err)
	}
	// Corrupt the stored timestamp: the engine must still refresh the
	// bookkeeping deterministically rather than silently skipping.
	alert := repo.open["r1|t1"]
	alert.LastTriggeredAt = "not-a-timestamp"
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Recounted != 1 {
		t.Fatalf("unparseable timestamp must be treated as outside the window: %+v", out)
	}
}

func TestEvaluateDisabledRulesAreNotEvaluated(t *testing.T) {
	disabled := stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", "")
	disabled.Enabled = false
	repo := newFakeEvalRepo(disabled)
	e := newTestEvaluator(repo, time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC))
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.RulesEvaluated != 0 || out.Opened != 0 {
		t.Fatalf("disabled rules must not be evaluated: %+v", out)
	}
}

func TestEvaluateEmptyInputsAndRuleSet(t *testing.T) {
	e := newTestEvaluator(newFakeEvalRepo(), time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC))
	out, err := e.EvaluateTargets(context.Background(), nil)
	if err != nil || out.Opened != 0 {
		t.Fatalf("empty inputs must be a no-op: %+v, %v", out, err)
	}
	out, err = e.EvaluateTargets(context.Background(), []EvaluationInput{{
		Target: testTarget("t1", "res-1"), Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers()),
	}})
	if err != nil || out.RulesEvaluated != 0 {
		t.Fatalf("empty rule set must be a no-op: %+v, %v", out, err)
	}
}

func TestEvaluateSkipsNilInputs(t *testing.T) {
	repo := newFakeEvalRepo(stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 300, "", ""))
	e := newTestEvaluator(repo, time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC))
	out, err := e.EvaluateTargets(context.Background(), []EvaluationInput{
		{Target: nil, Result: testResult(nfhealth.RunStatusSuccess, unhealthyLayers())},
		{Target: testTarget("t1", "res-1"), Result: nil},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Opened != 0 {
		t.Fatalf("nil inputs must be skipped: %+v", out)
	}
}

func TestOpenCooldownClampsInvalidValues(t *testing.T) {
	rule := stateRule("r1", ScopeOverall, nfhealth.StateUnhealthy, SeverityCritical, 0, "", "")
	if got := openCooldown(&rule); got != DefaultCooldownSeconds {
		t.Fatalf("zero cooldown must clamp to default, got %d", got)
	}
	rule.CooldownSeconds = 5
	if got := openCooldown(&rule); got != DefaultCooldownSeconds {
		t.Fatalf("out-of-bounds cooldown must clamp to default, got %d", got)
	}
	rule.CooldownSeconds = 60
	if got := openCooldown(&rule); got != 60 {
		t.Fatalf("valid cooldown must be honored, got %d", got)
	}
}
