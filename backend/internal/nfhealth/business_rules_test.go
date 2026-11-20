package nfhealth

import (
	"testing"
	"time"
)

func businessPairFixture(request, completion float64) (*HealthTarget, ServiceWindow) {
	target, samples, now := windowFixture()
	for i := range samples {
		samples[i].Metrics[0].Value = float64(i) * request / 5
		samples[i].Metrics[1].Value = float64(i) * completion / 5
	}
	return target, EvaluateServiceWindows(target, samples, now, true).Windows[0]
}

func TestBusinessRuleDescriptivePairStatesNeverPromoteHealth(t *testing.T) {
	cases := []struct {
		request, completion float64
		state, reason       string
	}{
		{0, 0, "no_traffic", "no_requests_observed"},
		{5, 4, "low_volume", "below_volume_floor"},
		{100, 99, "completion_gap", "gap_not_failure_count"},
		{100, 100, "aligned_counts", "aligned_not_service_health"},
		{0, 2, "boundary_mismatch", "completions_exceed_requests"},
		{100, 101, "boundary_mismatch", "completions_exceed_requests"},
		{100, 0, "completion_gap", "gap_not_failure_count"},
	}
	for _, tc := range cases {
		t.Run(tc.state, func(t *testing.T) {
			_, window := businessPairFixture(tc.request, tc.completion)
			rule := window.BusinessRules[0]
			if rule.Status != tc.state || rule.Reason != tc.reason {
				t.Fatalf("unexpected interpretation: %+v", rule)
			}
			if rule.DecisionEligible || rule.HealthEffect != "none" {
				t.Fatal("observation became health")
			}
			if tc.request == 0 || tc.completion > tc.request {
				if rule.CompletionRatio != nil {
					t.Fatal("manufactured ratio")
				}
			}
			if rule.BinaryAttestation != "not_attested" {
				t.Fatal("source review became build provenance")
			}
		})
	}
}

func TestBusinessRuleScopeQualityAndRequiredMetrics(t *testing.T) {
	target, window := businessPairFixture(100, 100)
	window.Rows[1].Scope = `{"instance":"another"}`
	rules := EvaluateBusinessRules(target, window)
	if len(rules) != 2 || rules[0].Status != "unavailable" || len(rules[0].MissingMetrics) != 1 {
		t.Fatal("joined unrelated scopes")
	}
	for _, quality := range []string{"stale", "unavailable", "insufficient"} {
		target, window = businessPairFixture(100, 100)
		window.Rows[0].Quality = quality
		window.Rows[0].Reason = "scope_unverified"
		got := EvaluateBusinessRules(target, window)[0]
		if got.Status != quality || got.CompletionRatio != nil {
			t.Fatalf("quality bypass: %+v", got)
		}
	}
	target, window = businessPairFixture(100, 100)
	window.Rows[1].Evidence = append([]WindowInterval(nil), window.Rows[1].Evidence...)
	window.Rows[1].Evidence[0].ToSampleID = "other"
	if EvaluateBusinessRules(target, window)[0].Reason != "pair_intervals_differ" {
		t.Fatal("different intervals paired")
	}
	window.Rows = nil
	got := EvaluateBusinessRules(target, window)[0]
	if got.Status != "unavailable" || got.RequestDelta != nil || len(got.MissingMetrics) != 2 {
		t.Fatal("absent values became zeros")
	}
}

func reconciliationFixture(runs, anomalies, errors, critical float64) (*HealthTarget, ServiceWindow) {
	target := &HealthTarget{NFType: "OCS", Domain: "charging"}
	window := ServiceWindow{}
	defs := BusinessRuleDefinitions()
	def := defs[len(defs)-1]
	for i, value := range []float64{runs, anomalies, errors, critical} {
		v := value
		window.Rows = append(window.Rows, ServiceWindowRow{Metric: def.Metrics[i], Scope: "null", Type: "counter", Quality: "ready", Points: 6, Intervals: 5, CoveragePercent: 100, Delta: &v,
			Evidence: []WindowInterval{{FromSampleID: "a", ToSampleID: "b", Delta: &v}}})
	}
	return target, window
}

func TestBusinessRuleReconciliationRequiresExecutionAndRetainsEventCounts(t *testing.T) {
	for _, tc := range []struct {
		runs, anomalies, errors, critical float64
		want                              string
	}{{0, 0, 0, 0, "no_execution"}, {1, 0, 0, 0, "no_anomaly_observed"}, {0, 1, 0, 0, "anomaly_observed"}, {2, 5, 2, 1, "anomaly_observed"}} {
		target, window := reconciliationFixture(tc.runs, tc.anomalies, tc.errors, tc.critical)
		rules := EvaluateBusinessRules(target, window)
		rule := rules[len(rules)-1]
		if rule.Status != tc.want || rule.DecisionEligible {
			t.Fatalf("unsupported verdict: %+v", rule)
		}
		if *rule.Observed[1].Delta != tc.anomalies {
			t.Fatal("overlapping events were summed")
		}
	}
}

func TestBusinessRuleRegistryOwnershipAndResourceOnlyPCF(t *testing.T) {
	ids := map[string]bool{}
	for _, def := range BusinessRuleDefinitions() {
		if ids[def.ID] {
			t.Fatal("duplicate rule")
		}
		ids[def.ID] = true
		for _, metric := range def.Metrics {
			registered, ok := LookupMetricForTarget(metric, def.Domain, def.NFType)
			if !ok || registered.Category != CategoryService {
				t.Fatalf("foreign metric in %s: %s", def.ID, metric)
			}
		}
	}
	target, _, now := windowFixture()
	target.NFType = "PCF"
	sample := HealthSample{TargetID: target.TargetID, ResourceID: target.ResourceID, CollectedAt: now.Format(time.RFC3339Nano), WindowBinding: windowBinding(target), WindowIdentity: "pcf",
		Metrics: []MetricSample{{Key: "process_cpu_seconds_total", Type: "counter", Value: 1, Category: CategoryResource, ScopeVerified: true}}}
	report := EvaluateServiceWindows(target, []HealthSample{sample}, now, true)
	if len(report.Windows[0].BusinessRules) != 2 {
		t.Fatal("resource-only PCF hid missing business capabilities")
	}
	for _, rule := range report.Windows[0].BusinessRules {
		if rule.Status != "unavailable" || len(rule.MissingMetrics) != 2 {
			t.Fatal("resource metrics became business health")
		}
	}
	target.Domain = "epc"
	if len(EvaluateBusinessRules(target, ServiceWindow{})) != 0 {
		t.Fatal("cross-domain rules")
	}
}

func TestBusinessRuleFreshnessReadProjectionDoesNotMutateEvidence(t *testing.T) {
	target, samples, now := windowFixture()
	latest := samples[len(samples)-1]
	latest.ServiceWindows = EvaluateServiceWindows(target, samples, now, true)
	prior := latest.ServiceWindows.Windows[0].BusinessRules[0].Status
	projected := ProjectServiceWindows(target, &latest, now.Add(181*time.Second))
	if projected.Windows[0].BusinessRules[0].Status != "stale" || projected.Windows[0].BusinessRules[0].CompletionRatio == nil {
		t.Fatal("historical observation not aged or lost")
	}
	if latest.ServiceWindows.Windows[0].BusinessRules[0].Status != prior {
		t.Fatal("read mutated sample")
	}
}
