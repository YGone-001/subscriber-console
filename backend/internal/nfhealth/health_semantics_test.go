package nfhealth

import (
	"errors"
	"testing"
)

// ---------------------------------------------------------------------------
// Correction A — overall state aggregation precedence.
//
// Baseline defect: OverallState selected the first measured layer and only
// replaced it with a "worse" state under narrower conditions, so an already
// selected healthy state survived a later measured unknown layer. The aggregate
// therefore depended on layer order and could report healthy while a measured
// layer was unknown.
// ---------------------------------------------------------------------------

func measured(state string) LayerEvidence {
	return LayerEvidence{State: state, Measured: true}
}

func TestOverallStateUnknownNeverHidesBehindHealthy(t *testing.T) {
	cases := []struct {
		name  string
		procs string
		iface string
		svc   string
	}{
		{"healthy/healthy/unknown", StateHealthy, StateHealthy, StateUnknown},
		{"unknown/healthy/healthy", StateUnknown, StateHealthy, StateHealthy},
		{"healthy/unknown/healthy", StateHealthy, StateUnknown, StateHealthy},
		{"healthy/stale/healthy", StateHealthy, StateStale, StateHealthy},
		{"stale/healthy/healthy", StateStale, StateHealthy, StateHealthy},
	}
	for _, tc := range cases {
		layers := LayerSet{
			Process:   measured(tc.procs),
			Interface: measured(tc.iface),
			Service:   measured(tc.svc),
		}
		if got := OverallState(layers); got == StateHealthy {
			t.Fatalf("%s must not aggregate to healthy, got %s", tc.name, got)
		}
	}
}

func TestOverallStatePrecedence(t *testing.T) {
	cases := []struct {
		name  string
		procs string
		iface string
		svc   string
		want  string
	}{
		{"all healthy", StateHealthy, StateHealthy, StateHealthy, StateHealthy},
		{"degraded wins over healthy", StateHealthy, StateHealthy, StateDegraded, StateDegraded},
		{"unhealthy wins over degraded", StateHealthy, StateDegraded, StateUnhealthy, StateUnhealthy},
		{"stale wins over unknown", StateStale, StateUnknown, StateHealthy, StateStale},
		{"unknown wins over healthy", StateUnknown, StateHealthy, StateHealthy, StateUnknown},
		{"degraded wins over stale", StateDegraded, StateStale, StateHealthy, StateDegraded},
		{"unrecognized state is unknown", StateHealthy, "", StateHealthy, StateUnknown},
	}
	for _, tc := range cases {
		layers := LayerSet{
			Process:   measured(tc.procs),
			Interface: measured(tc.iface),
			Service:   measured(tc.svc),
		}
		if got := OverallState(layers); got != tc.want {
			t.Fatalf("%s: expected %s, got %s", tc.name, tc.want, got)
		}
	}
}

// Aggregation must be invariant under reordering of equivalent layer evidence.
func TestOverallStateIsOrderIndependent(t *testing.T) {
	states := []string{StateHealthy, StateUnknown, StateDegraded, StateStale, StateUnhealthy}
	for _, a := range states {
		for _, b := range states {
			for _, c := range states {
				want := OverallState(LayerSet{
					Process: measured(a), Interface: measured(b), Service: measured(c),
				})
				permutations := [][3]string{
					{a, c, b}, {b, a, c}, {b, c, a}, {c, a, b}, {c, b, a},
				}
				for _, p := range permutations {
					got := OverallState(LayerSet{
						Process: measured(p[0]), Interface: measured(p[1]), Service: measured(p[2]),
					})
					if got != want {
						t.Fatalf("order changed the aggregate: %v -> %s, %v -> %s", [3]string{a, b, c}, want, p, got)
					}
				}
			}
		}
	}
}

func TestOverallStateUnmeasuredLayersAreExcludedNotAssumedHealthy(t *testing.T) {
	// Only L1 was measured: the aggregate describes the measured layers only.
	layers := LayerSet{
		Process:   measured(StateHealthy),
		Interface: LayerEvidence{State: StateNotConfigured, Measured: false},
		Service:   LayerEvidence{State: StateNotConfigured, Measured: false},
	}
	if got := OverallState(layers); got != StateHealthy {
		t.Fatalf("expected the measured-layer status, got %s", got)
	}
	coverage := CoverageFromLayers(layers)
	if coverage.L2Measured || coverage.L3Measured || coverage.L3Available {
		t.Fatalf("unmeasured layers must not report coverage: %+v", coverage)
	}

	// A measured unknown layer still wins over an unmeasured layer.
	layers.Interface = measured(StateUnknown)
	if got := OverallState(layers); got != StateUnknown {
		t.Fatalf("a measured unknown layer must win, got %s", got)
	}
}

func TestProjectOverallStateFreshnessNeverBecomesHealthy(t *testing.T) {
	healthyLayers := &LayerSet{
		Process: measured(StateHealthy), Interface: measured(StateHealthy), Service: measured(StateHealthy),
	}
	cases := []struct {
		freshness string
		want      string
	}{
		{FreshnessStale, StateStale},
		{FreshnessUnknown, StateUnknown},
		{FreshnessNotMonitored, StateNotConfigured},
		{FreshnessFresh, StateHealthy},
	}
	for _, tc := range cases {
		got := ProjectOverallState(FreshnessProjection{State: tc.freshness}, healthyLayers)
		if got != tc.want {
			t.Fatalf("freshness %s: expected %s, got %s", tc.freshness, tc.want, got)
		}
		if tc.freshness != FreshnessFresh && got == StateHealthy {
			t.Fatalf("freshness %s must never project healthy", tc.freshness)
		}
	}
}

// ---------------------------------------------------------------------------
// Correction B — cumulative counters cannot establish current outcomes.
// ---------------------------------------------------------------------------

func serviceSample(key string, value float64) MetricSample {
	def, _ := LookupMetric(key)
	return MetricSample{Key: key, Value: value, Category: def.Category}
}

func TestCumulativePairWithoutIntervalIsUndetermined(t *testing.T) {
	// Mandatory scenario: request_total = 10000, success_total = 9990, no
	// previous measurement. The shortfall is historical, not a current failure.
	samples := []MetricSample{
		serviceSample("fivegs_amffunction_rm_reginitreq", 10000),
		serviceSample("fivegs_amffunction_rm_reginitsucc", 9990),
	}
	got := EvaluateServiceLayer(samples, nil)
	if got.State != StateUnknown {
		t.Fatalf("cumulative totals must not produce a health claim, got %+v", got)
	}
	if got.Reason != ReasonServiceHealthUndetermined || !got.Measured {
		t.Fatalf("expected measured undetermined, got %+v", got)
	}
	summary := SummarizeServiceEvidence(samples)
	if summary.IntervalRequired != 1 {
		t.Fatalf("the paired rule must report missing interval evidence: %+v", summary)
	}
	if summary.Degraded != 0 || summary.Confirmed != 0 {
		t.Fatalf("no rule may confirm or degrade from cumulative totals: %+v", summary)
	}
}

func TestCumulativeEqualPairIsNotConfirmedHealthy(t *testing.T) {
	// Mandatory scenario: request_total = success_total = 100, both cumulative,
	// no verified interval.
	samples := []MetricSample{
		serviceSample("fivegs_amffunction_rm_reginitreq", 100),
		serviceSample("fivegs_amffunction_rm_reginitsucc", 100),
	}
	got := EvaluateServiceLayer(samples, nil)
	if got.State == StateHealthy || got.Reason == ReasonServiceHealthConfirmed {
		t.Fatalf("cumulative equality must not confirm current health, got %+v", got)
	}
}

func TestHistoricalFailureCounterDoesNotDegradeForever(t *testing.T) {
	// Mandatory scenario: failure_total = 3. The failures happened before the
	// present observation window, so no new current failure may be inferred.
	samples := []MetricSample{
		serviceSample("s6a_rx_air", 500),
		serviceSample("s6a_rx_air_error", 3),
	}
	got := EvaluateServiceLayer(samples, nil)
	if got.State == StateDegraded || got.Reason == ReasonServiceFailuresObserved {
		t.Fatalf("a historical failure total must not degrade the service forever, got %+v", got)
	}
	if got.State != StateUnknown {
		t.Fatalf("expected undetermined, got %+v", got)
	}
}

func TestZeroHistoricalFailureCounterDoesNotProveSuccess(t *testing.T) {
	samples := []MetricSample{
		serviceSample("s6a_rx_ulr", 25),
		serviceSample("s6a_rx_ulr_error", 0),
	}
	got := EvaluateServiceLayer(samples, nil)
	if got.State == StateHealthy {
		t.Fatalf("a zero historical failure counter must not prove current success, got %+v", got)
	}
	if got.Reason != ReasonServiceHealthUndetermined {
		t.Fatalf("expected service_health_undetermined, got %+v", got)
	}
}

func TestCounterResetInvalidatesIntervalEvidence(t *testing.T) {
	body := []byte(
		"# TYPE fivegs_amffunction_rm_reginitreq counter\nfivegs_amffunction_rm_reginitreq 5\n",
	)
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", map[string]float64{
		"fivegs_amffunction_rm_reginitreq": 900,
	}, "5gc", NFTypeAMF)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.CounterResets) != 1 {
		t.Fatalf("the reset must be detected: %+v", out)
	}
	// A reset series cannot support an interval outcome.
	if got := EvaluateServiceLayer(out.Samples, nil); got.State == StateHealthy || got.State == StateDegraded {
		t.Fatalf("a reset counter must not produce a health claim, got %+v", got)
	}
}

func TestMissingPairMemberIsUndetermined(t *testing.T) {
	for _, samples := range [][]MetricSample{
		{serviceSample("fivegs_amffunction_rm_reginitsucc", 5)},
		{serviceSample("fivegs_amffunction_rm_reginitreq", 5)},
	} {
		got := EvaluateServiceLayer(samples, nil)
		if got.State != StateUnknown {
			t.Fatalf("an incomplete pair must stay undetermined, got %+v", got)
		}
	}
}

func TestRawCumulativeCountersRemainAvailable(t *testing.T) {
	samples := []MetricSample{
		serviceSample("fivegs_amffunction_rm_reginitreq", 10000),
		serviceSample("fivegs_amffunction_rm_reginitsucc", 9990),
		serviceSample("fivegs_amffunction_rm_reginitfail", 10),
	}
	_ = EvaluateServiceLayer(samples, nil)
	if len(samples) != 3 {
		t.Fatal("the raw measurements must be preserved")
	}
	summary := SummarizeServiceEvidence(samples)
	if summary.ServiceSamples != 3 {
		t.Fatalf("coverage must be preserved: %+v", summary)
	}
}

// ---------------------------------------------------------------------------
// Correction C — activity gauges establish activity, not complete health.
// ---------------------------------------------------------------------------

func TestActivityGaugeIsRecordedButNotHealthConfirmed(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{serviceSample("mme_session", 3)}, nil)
	if got.State == StateHealthy {
		t.Fatalf("activity must not independently establish service health, got %+v", got)
	}
	if got.State != StateUnknown || got.Reason != ReasonActivityObserved || !got.Measured {
		t.Fatalf("expected measured unknown activity_observed, got %+v", got)
	}
	summary := SummarizeServiceEvidence([]MetricSample{serviceSample("mme_session", 3)})
	if summary.ActivityObserved != 1 || summary.Confirmed != 0 {
		t.Fatalf("activity must be reported separately from confirmation: %+v", summary)
	}
}

func TestZeroActivityGaugeIsNotFailure(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{serviceSample("mme_session", 0)}, nil)
	if got.State == StateHealthy || got.State == StateDegraded || got.State == StateUnhealthy {
		t.Fatalf("a zero activity gauge must not assert any outcome, got %+v", got)
	}
	if got.State != StateUnknown || !got.Measured {
		t.Fatalf("expected measured unknown, got %+v", got)
	}
}

func TestActivityGaugeRemainsServiceCategoryEvidence(t *testing.T) {
	def, ok := LookupMetric("mme_session")
	if !ok || def.Category != CategoryService {
		t.Fatalf("activity gauges must stay service-category measurements: %+v", def)
	}
}

// ---------------------------------------------------------------------------
// Correction D — series scope integrity.
// ---------------------------------------------------------------------------

func TestPairedRuleRefusesCrossScopePairing(t *testing.T) {
	// Two request series in different scopes with a single success series: the
	// success value cannot be paired with either request series.
	samples := []MetricSample{
		{Key: "fivegs_amffunction_rm_reginitreq", Value: 10, Category: CategoryService,
			Labels: map[string]string{"nf": "amf-a"}},
		{Key: "fivegs_amffunction_rm_reginitreq", Value: 20, Category: CategoryService,
			Labels: map[string]string{"nf": "amf-b"}},
		{Key: "fivegs_amffunction_rm_reginitsucc", Value: 10, Category: CategoryService,
			Labels: map[string]string{"nf": "amf-a"}},
	}
	summary := SummarizeServiceEvidence(samples)
	if summary.Confirmed != 0 || summary.Degraded != 0 {
		t.Fatalf("cross-scope pairing must never confirm or degrade: %+v", summary)
	}
	if summary.AmbiguousScopes == 0 {
		t.Fatalf("the ambiguous scope must be reported: %+v", summary)
	}
	if got := EvaluateServiceLayer(samples, nil); got.State == StateHealthy {
		t.Fatalf("cross-scope pairing must not claim health, got %+v", got)
	}
}

func TestPairedRuleRefusesCollapsedSeriesAfterSanitization(t *testing.T) {
	// Two series that differ only by a sensitive label collapse to one sanitized
	// scope. The stored evidence cannot distinguish them, so pairing is disabled
	// rather than combining unrelated measurements.
	sanitizedA := SanitizeLabels(map[string]string{"addr": "127.0.0.3"})
	sanitizedB := SanitizeLabels(map[string]string{"addr": "127.0.0.4"})
	if sanitizedA != nil || sanitizedB != nil {
		t.Fatalf("sensitive labels must be dropped: %v %v", sanitizedA, sanitizedB)
	}
	samples := []MetricSample{
		{Key: "fivegs_amffunction_rm_reginitreq", Value: 10, Category: CategoryService, Labels: sanitizedA},
		{Key: "fivegs_amffunction_rm_reginitreq", Value: 20, Category: CategoryService, Labels: sanitizedB},
		{Key: "fivegs_amffunction_rm_reginitsucc", Value: 10, Category: CategoryService, Labels: nil},
	}
	summary := SummarizeServiceEvidence(samples)
	if summary.Confirmed != 0 || summary.Degraded != 0 {
		t.Fatalf("collapsed series must not be paired: %+v", summary)
	}
}

func TestSeriesScopeIsLabelOrderIndependent(t *testing.T) {
	left := seriesScope(MetricSample{Labels: map[string]string{"nf": "amf", "instance": "1"}})
	right := seriesScope(MetricSample{Labels: map[string]string{"instance": "1", "nf": "amf"}})
	if left != right {
		t.Fatalf("label order must not change the scope signature: %q != %q", left, right)
	}
	if left == seriesScope(MetricSample{Labels: map[string]string{"nf": "amf", "instance": "2"}}) {
		t.Fatal("different scopes must produce different signatures")
	}
}

func TestPairedRuleAcceptsSingleVerifiedScope(t *testing.T) {
	samples := []MetricSample{
		{Key: "fivegs_amffunction_rm_reginitreq", Value: 10, Category: CategoryService,
			Labels: map[string]string{"nf": "amf"}},
		{Key: "fivegs_amffunction_rm_reginitsucc", Value: 10, Category: CategoryService,
			Labels: map[string]string{"nf": "amf"}},
	}
	summary := SummarizeServiceEvidence(samples)
	if summary.AmbiguousScopes != 0 {
		t.Fatalf("a single verified scope must be comparable: %+v", summary)
	}
	if summary.IntervalRequired != 1 {
		t.Fatalf("the comparable pair still requires interval evidence: %+v", summary)
	}
}

func TestSeparateTargetsAreNeverCombined(t *testing.T) {
	// Evidence sets are evaluated independently; no state leaks between calls.
	first := SummarizeServiceEvidence([]MetricSample{serviceSample("mme_session", 5)})
	second := SummarizeServiceEvidence([]MetricSample{serviceSample("mme_session", 0)})
	if first.ActivityObserved != 1 || second.ActivityObserved != 0 {
		t.Fatalf("target evidence must not be combined: %+v %+v", first, second)
	}
}

// ---------------------------------------------------------------------------
// Correction E — Prometheus type integrity.
// ---------------------------------------------------------------------------

func TestParserRejectsTypeDeclarationContradictingRegistry(t *testing.T) {
	// Baseline defect: a TYPE declaration overrode the registered type, so a
	// gauge could be persisted as a counter.
	body := []byte("# TYPE mme_session counter\nmme_session 3\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "epc", NFTypeMME)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 0 {
		t.Fatalf("a contradictory declaration must drop the sample: %+v", out.Samples)
	}
	if out.TypeMismatches != 1 {
		t.Fatalf("the mismatch must be reported: %+v", out)
	}

	// Reverse mismatch: a registered counter declared as a gauge.
	body = []byte("# TYPE s6a_rx_ulr gauge\ns6a_rx_ulr 7\n")
	out, err = ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "epc", NFTypeHSS)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 0 || out.TypeMismatches != 1 {
		t.Fatalf("the reverse mismatch must be dropped and reported: %+v", out)
	}
}

func TestParserAcceptsCompatibleDeclarationAndRegistryFallback(t *testing.T) {
	// Compatible declaration.
	body := []byte("# TYPE mme_session gauge\nmme_session 3\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "epc", NFTypeMME)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 1 || out.Samples[0].Type != "gauge" || out.TypeMismatches != 0 {
		t.Fatalf("a compatible declaration must be accepted: %+v", out)
	}

	// No declaration: the registry definition is authoritative.
	body = []byte("mme_session 3\n")
	out, err = ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "epc", NFTypeMME)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 1 || out.Samples[0].Type != "gauge" {
		t.Fatalf("the registry type must be used when no declaration exists: %+v", out.Samples)
	}

	// An unsupported declaration kind is not a counter/gauge and must be dropped.
	body = []byte("# TYPE mme_session histogram\nmme_session 3\n")
	out, err = ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "epc", NFTypeMME)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 0 {
		t.Fatalf("an unsupported declaration kind must be dropped: %+v", out.Samples)
	}
}

func TestParserStillRejectsUnregisteredFamilies(t *testing.T) {
	body := []byte("# TYPE not_registered gauge\nnot_registered 1\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "epc", NFTypeMME)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 0 || out.Dropped != 1 {
		t.Fatalf("unregistered families must stay dropped: %+v", out)
	}
}

// ---------------------------------------------------------------------------
// Correction F — L3 evidence and coverage remain truthful.
// ---------------------------------------------------------------------------

func TestL3ReasonsRemainTruthful(t *testing.T) {
	cases := []struct {
		name     string
		samples  []MetricSample
		state    string
		reason   string
		measured bool
	}{
		{
			name:     "resource only",
			samples:  []MetricSample{{Key: "process_cpu_seconds_total", Value: 1, Category: CategoryResource}},
			state:    StateUnknown,
			reason:   ReasonResourceMetricsOnly,
			measured: true,
		},
		{
			name:     "service without rule",
			samples:  []MetricSample{serviceSample("fivegs_amffunction_rm_reginitreq", 4)},
			state:    StateUnknown,
			reason:   ReasonServiceHealthUndetermined,
			measured: true,
		},
		{
			name:     "activity only",
			samples:  []MetricSample{serviceSample("mme_session", 2)},
			state:    StateUnknown,
			reason:   ReasonActivityObserved,
			measured: true,
		},
		{
			name:     "no supported kpi",
			samples:  nil,
			state:    StateNotConfigured,
			reason:   ReasonNoSupportedKPI,
			measured: false,
		},
	}
	for _, tc := range cases {
		got := EvaluateServiceLayer(tc.samples, nil)
		if got.State != tc.state || got.Reason != tc.reason || got.Measured != tc.measured {
			t.Fatalf("%s: expected %s/%s/measured=%v, got %+v", tc.name, tc.state, tc.reason, tc.measured, got)
		}
	}
}

func TestParseFailureIsNotASuccessfulMeasurement(t *testing.T) {
	got := EvaluateServiceLayer(nil, errors.New("metrics body could not be parsed"))
	if got.State == StateHealthy {
		t.Fatalf("a parse failure must not be presented as a successful measurement: %+v", got)
	}
	if got.Measured {
		t.Fatalf("a parse failure without samples is not a measurement: %+v", got)
	}
	if got.Reason != ReasonMetricMissing {
		t.Fatalf("expected metric_not_exported, got %+v", got)
	}
}

func TestL3UnmeasuredLayersNeverClaimHealth(t *testing.T) {
	layers := LayerSet{
		Process:   measured(StateHealthy),
		Interface: measured(StateHealthy),
		Service:   EvaluateServiceLayer([]MetricSample{serviceSample("mme_session", 3)}, nil),
	}
	if got := OverallState(layers); got == StateHealthy {
		t.Fatalf("an activity-only service layer must keep the aggregate below healthy, got %s", got)
	}
	if got := OverallState(layers); got != StateUnknown {
		t.Fatalf("expected unknown aggregate, got %s", got)
	}
}
