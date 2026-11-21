package nfalert

import (
	"context"
	"math"
	"net/http"
	"testing"

	"subscriber/internal/nfhealth"
	"subscriber/internal/user"
)

func metricNumber(n float64) *float64 { return &n }
func rssCondition(op string, trigger, recover float64) *MetricCondition {
	return &MetricCondition{Metric: "process_resident_memory_bytes", Series: "unlabeled", Operator: op, Threshold: metricNumber(trigger), RecoveryThreshold: metricNumber(recover)}
}

func TestMetricConditionValidation(t *testing.T) {
	for _, op := range []string{"gt", "gte", "lt", "lte"} {
		if err := ValidateMetricCondition(ConditionTypeMetricThreshold, "target", "", rssCondition(op, 100, 100)); err != nil {
			t.Fatal(err)
		}
	}
	cases := []*MetricCondition{nil, rssCondition("eq", 100, 50), rssCondition("gt", 100, 110), rssCondition("lt", 100, 50), rssCondition("gt", math.NaN(), 0), rssCondition("gt", math.Inf(1), 0), rssCondition("gt", -1, 0)}
	for _, c := range cases {
		if ValidateMetricCondition(ConditionTypeMetricThreshold, "target", "", c) == nil {
			t.Fatalf("accepted invalid condition %+v", c)
		}
	}
	c := rssCondition("gt", 100, 50)
	c.Threshold = nil
	if ValidateMetricCondition(ConditionTypeMetricThreshold, "target", "", c) == nil {
		t.Fatal("omitted threshold accepted as zero")
	}
	for _, scope := range [][2]string{{"", ""}, {"", "resource"}, {"target", "resource"}} {
		if ValidateMetricCondition(ConditionTypeMetricThreshold, scope[0], scope[1], rssCondition("gt", 100, 50)) == nil {
			t.Fatal("broad scope accepted")
		}
	}
	c = rssCondition("gt", 100, 50)
	c.Metric = "process_cpu_seconds_total"
	if ValidateMetricCondition(ConditionTypeMetricThreshold, "target", "", c) == nil {
		t.Fatal("counter accepted")
	}
	if ValidateMetricCondition(ConditionTypeState, "target", "", rssCondition("gt", 100, 50)) == nil {
		t.Fatal("cross-type payload accepted")
	}
}

func TestMetricHysteresisAndEquality(t *testing.T) {
	for _, tc := range []struct {
		op                      string
		trigger, recover, value float64
		want                    string
	}{
		{"gt", 100, 80, 101, "trigger"}, {"gt", 100, 80, 100, "hold"}, {"gt", 100, 80, 80, "recover"},
		{"gte", 100, 80, 100, "trigger"}, {"gte", 100, 80, 80, "hold"}, {"gte", 100, 80, 79, "recover"},
		{"lt", 80, 100, 79, "trigger"}, {"lt", 80, 100, 80, "hold"}, {"lt", 80, 100, 100, "recover"},
		{"lte", 80, 100, 80, "trigger"}, {"lte", 80, 100, 100, "hold"}, {"lte", 80, 100, 101, "recover"},
		{"gt", 100, 100, 100, "recover"}, {"gte", 100, 100, 100, "trigger"}, {"lt", 100, 100, 100, "recover"}, {"lte", 100, 100, 100, "trigger"},
	} {
		if got := classifyMetric(rssCondition(tc.op, tc.trigger, tc.recover), tc.value); got != tc.want {
			t.Fatalf("%+v got=%s", tc, got)
		}
	}
}

type metricActor struct{ enabled bool }

func (a metricActor) FindByUsernameIdentity(context.Context, string) (*user.UserIdentity, error) {
	status := "disabled"
	if a.enabled {
		status = "active"
	}
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: "operator", Role: "operator", Status: status}}, nil
}
func TestMetricHTTPGates(t *testing.T) {
	targetID := "0192f0c0-a000-7000-8000-000000000001"
	repo := newStubRepo()
	h := newTestServer(repo)
	reader := MetricTargetReaderFunc(func(context.Context, string) (*nfhealth.HealthTarget, error) {
		return &nfhealth.HealthTarget{TargetID: targetID, ResourceID: "resource", Enabled: true, IdentityState: nfhealth.IdentityInventoryAuthoritative, CollectorProfile: nfhealth.CollectorHTTPMetrics}, nil
	})
	payload := map[string]any{"name": "RSS", "conditionType": ConditionTypeMetricThreshold, "targetId": targetID, "metricCondition": rssCondition("gt", 100, 80), "severity": "warning"}
	if rec := doRouted(h, "POST", "/api/nf-alerts/rules", "viewer", payload); rec.Code != http.StatusForbidden {
		t.Fatalf("viewer=%d", rec.Code)
	}
	h.ConfigureMetricRules(false, reader, metricActor{true})
	if rec := doRouted(h, "POST", "/api/nf-alerts/rules", "operator", payload); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("feature off=%d %s", rec.Code, rec.Body)
	}
	h.ConfigureMetricRules(true, reader, metricActor{false})
	if rec := doRouted(h, "POST", "/api/nf-alerts/rules", "operator", payload); rec.Code != http.StatusForbidden {
		t.Fatalf("disabled actor=%d %s", rec.Code, rec.Body)
	}
	h.ConfigureMetricRules(true, reader, metricActor{true})
	if rec := doRouted(h, "POST", "/api/nf-alerts/rules", "operator", payload); rec.Code != http.StatusCreated {
		t.Fatalf("valid=%d %s", rec.Code, rec.Body)
	}
	payload["metricCondition"] = map[string]any{"metric": "process_resident_memory_bytes", "series": "unlabeled", "operator": "gt", "recoveryThreshold": 0}
	if rec := doRouted(h, "POST", "/api/nf-alerts/rules", "operator", payload); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing threshold=%d", rec.Code)
	}
}

func TestUnknownAndDisabledMetricTypesHoldOpenAlerts(t *testing.T) {
	for _, kind := range []string{"future_condition", ConditionTypeMetricThreshold} {
		rule := AlertRule{RuleID: "rule", TargetID: "target", Enabled: true, ConditionType: kind}
		repo := newFakeEvalRepo(rule)
		repo.open["rule|target"] = &Alert{AlertID: "open", RuleID: "rule", TargetID: "target", State: AlertStateActive}
		evaluator := NewEvaluator(repo)
		out, err := evaluator.EvaluateTargets(context.Background(), []EvaluationInput{{Target: testTarget("target", "resource"), Result: testResult(nfhealth.RunStatusFailed, nil)}})
		if err != nil || out.Recovered != 0 || len(repo.events) != 0 {
			t.Fatalf("kind=%s changed an open alert: %+v %v", kind, out, err)
		}
	}
}

func TestMetricHTTPRejectsInvalidDurations(t *testing.T) {
	h := newTestServer(newStubRepo())
	for _, duration := range []any{1.5, 3601, -1, "120"} {
		rec := doRouted(h, "POST", "/api/nf-alerts/rules", "operator", map[string]any{"name": "RSS", "conditionType": ConditionTypeMetricThreshold, "targetId": "0192f0c0-a000-7000-8000-000000000001", "severity": "warning", "metricCondition": map[string]any{"metric": "process_resident_memory_bytes", "series": "unlabeled", "operator": "gt", "threshold": 100, "recoveryThreshold": 50, "durationSeconds": duration}})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid duration %v returned %d", duration, rec.Code)
		}
	}
}

func TestMetricUpdateAndDisableRequireFreshActor(t *testing.T) {
	repo := newStubRepo()
	id := "0192f0c0-a000-7000-8000-000000000001"
	repo.rules[id] = &AlertRule{RuleID: id, TargetID: id, ConditionType: ConditionTypeMetricThreshold, MetricCondition: rssCondition("gt", 100, 50), Revision: 1}
	h := newTestServer(repo)
	h.ConfigureMetricRules(true, nil, metricActor{true})
	payload := map[string]any{"expectedRevision": 1, "rule": map[string]any{"name": "RSS disabled", "enabled": false, "conditionType": ConditionTypeMetricThreshold, "metricCondition": rssCondition("gt", 200, 50), "severity": "warning"}}
	if rec := doRouted(h, "PUT", "/api/nf-alerts/rules/"+id, "viewer", payload); rec.Code != http.StatusForbidden {
		t.Fatalf("viewer disable=%d", rec.Code)
	}
	h.ConfigureMetricRules(true, nil, metricActor{false})
	if rec := doRouted(h, "PUT", "/api/nf-alerts/rules/"+id, "operator", payload); rec.Code != http.StatusForbidden {
		t.Fatalf("revoked actor disable=%d %s", rec.Code, rec.Body)
	}
	h.ConfigureMetricRules(true, nil, metricActor{true})
	if rec := doRouted(h, "PUT", "/api/nf-alerts/rules/"+id, "operator", payload); rec.Code != http.StatusOK {
		t.Fatalf("eligible disable=%d %s", rec.Code, rec.Body)
	}
	if rec := doRouted(h, "PUT", "/api/nf-alerts/rules/"+id, "operator", payload); rec.Code != http.StatusConflict {
		t.Fatalf("stale edit=%d", rec.Code)
	}
}
