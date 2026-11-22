package nfalert

import (
	"testing"
	"time"

	"subscriber/internal/nfhealth"
)

func analysisRecord(kind, state, direction string, confirmed bool) nfhealth.MetricAnalysis {
	algorithm, policy := nfhealth.MetricAnalysisVersion, nfhealth.MetricAnalysisPolicyVersion
	if kind == "trend" {
		algorithm, policy = nfhealth.MetricTrendVersion, nfhealth.MetricTrendPolicyVersion
	}
	return nfhealth.MetricAnalysis{
		Kind: kind, Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled", State: state, Direction: direction,
		Confirmed: confirmed, AlgorithmVersion: algorithm, PolicyVersion: policy,
		BucketStart: time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC),
	}
}

func TestClassifyAnalysisHoldsUnusableEvidence(t *testing.T) {
	trend := &AnalysisCondition{Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled", Kind: AnalysisKindTrend, Direction: "rising", AlgorithmVersion: nfhealth.MetricTrendVersion, PolicyVersion: nfhealth.MetricTrendPolicyVersion}
	cases := []struct {
		name   string
		record nfhealth.MetricAnalysis
		want   string
	}{
		{"confirmed rising", analysisRecord("trend", nfhealth.TrendRising, "rising", true), "fire"},
		{"unconfirmed rising", analysisRecord("trend", nfhealth.TrendRising, "rising", false), "hold"},
		{"opposite direction", analysisRecord("trend", nfhealth.TrendFalling, "falling", true), "hold"},
		{"stable recovers", analysisRecord("trend", nfhealth.TrendStable, "stable", false), "recover"},
		{"insufficient never recovers", analysisRecord("trend", nfhealth.AnalysisInsufficientData, "", false), "hold"},
		{"unavailable never recovers", analysisRecord("trend", nfhealth.AnalysisUnavailable, "", false), "hold"},
	}
	for _, item := range cases {
		if got := ClassifyAnalysis(trend, item.record); got != item.want {
			t.Fatalf("%s: got %q want %q", item.name, got, item.want)
		}
	}
	// A baseline record can never satisfy a trend rule.
	if got := ClassifyAnalysis(trend, analysisRecord("baseline", nfhealth.AnalysisAnomaly, "rising", false)); got != "hold" {
		t.Fatalf("baseline record fired a trend rule: %q", got)
	}
	// A rule pinned to another policy version is inert instead of silently
	// re-evaluated under a newer policy.
	stale := analysisRecord("trend", nfhealth.TrendRising, "rising", true)
	stale.PolicyVersion = "older"
	if got := ClassifyAnalysis(trend, stale); got != "hold" {
		t.Fatalf("stale policy fired: %q", got)
	}
}

func TestClassifyAnalysisDeviationDirections(t *testing.T) {
	anyDirection := &AnalysisCondition{Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled", Kind: AnalysisKindDeviation, AlgorithmVersion: nfhealth.MetricAnalysisVersion, PolicyVersion: nfhealth.MetricAnalysisPolicyVersion}
	if got := ClassifyAnalysis(anyDirection, analysisRecord("baseline", nfhealth.AnalysisAnomaly, "falling", false)); got != "fire" {
		t.Fatalf("deviation without a direction must fire: %q", got)
	}
	if got := ClassifyAnalysis(anyDirection, analysisRecord("baseline", nfhealth.AnalysisOK, "stable", false)); got != "recover" {
		t.Fatalf("normal deviation must recover: %q", got)
	}
	risingOnly := *anyDirection
	risingOnly.Direction = "rising"
	if got := ClassifyAnalysis(&risingOnly, analysisRecord("baseline", nfhealth.AnalysisAnomaly, "falling", false)); got != "hold" {
		t.Fatalf("direction filter ignored: %q", got)
	}
}

func TestValidateAnalysisConditionPinsPolicyAndScope(t *testing.T) {
	valid := &AnalysisCondition{Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled", Kind: AnalysisKindTrend, Direction: "rising", AlgorithmVersion: nfhealth.MetricTrendVersion, PolicyVersion: nfhealth.MetricTrendPolicyVersion}
	if err := ValidateAnalysisCondition(ConditionTypeMetricAnalysis, "target", "", valid, true); err != nil {
		t.Fatalf("valid analysis rule rejected: %v", err)
	}
	if err := ValidateAnalysisCondition(ConditionTypeMetricAnalysis, "target", "", valid, false); err == nil {
		t.Fatal("disabled analysis alerts accepted a rule")
	}
	if err := ValidateAnalysisCondition(ConditionTypeMetricAnalysis, "", "", valid, true); err == nil {
		t.Fatal("rule without a target accepted")
	}
	if err := ValidateAnalysisCondition(ConditionTypeMetricAnalysis, "target", "resource", valid, true); err == nil {
		t.Fatal("resource-scoped analysis rule accepted")
	}
	noDirection := *valid
	noDirection.Direction = ""
	if err := ValidateAnalysisCondition(ConditionTypeMetricAnalysis, "target", "", &noDirection, true); err == nil {
		t.Fatal("trend rule without a direction accepted")
	}
	otherPolicy := *valid
	otherPolicy.PolicyVersion = "older"
	if err := ValidateAnalysisCondition(ConditionTypeMetricAnalysis, "target", "", &otherPolicy, true); err == nil {
		t.Fatal("rule pinned to another policy accepted")
	}
	deviation := &AnalysisCondition{Metric: nfhealth.MetricAggregateMetric, Series: "unlabeled", Kind: AnalysisKindDeviation, AlgorithmVersion: nfhealth.MetricAnalysisVersion, PolicyVersion: nfhealth.MetricAnalysisPolicyVersion}
	if err := ValidateAnalysisCondition(ConditionTypeMetricAnalysis, "target", "", deviation, true); err != nil {
		t.Fatalf("deviation rule rejected: %v", err)
	}
	if err := ValidateAnalysisCondition(ConditionTypeState, "target", "", deviation, true); err == nil {
		t.Fatal("analysis payload accepted on a state rule")
	}
}

func TestAnalysisAlertIDIsStablePerRuleAndHour(t *testing.T) {
	record := analysisRecord("trend", nfhealth.TrendRising, "rising", true)
	first := analysisAlertID("rule-a", record)
	if first != analysisAlertID("rule-a", record) {
		t.Fatal("alert id is not deterministic")
	}
	if first == analysisAlertID("rule-b", record) {
		t.Fatal("two rules share an alert id")
	}
	later := record
	later.BucketStart = record.BucketStart.Add(time.Hour)
	if first == analysisAlertID("rule-a", later) {
		t.Fatal("a later hour reused the alert id")
	}
}
