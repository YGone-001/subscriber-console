package nfhealth

import "testing"

func TestOverallStateUnmeasuredIsUnknown(t *testing.T) {
	layers := LayerSet{}
	if got := OverallState(layers); got != StateUnknown {
		t.Fatalf("expected unknown, got %s", got)
	}
}

func TestOverallStateHealthyRequiresMeasuredLayers(t *testing.T) {
	layers := LayerSet{
		Process:   LayerEvidence{State: StateHealthy, Measured: true},
		Interface: LayerEvidence{State: StateHealthy, Measured: true},
		Service:   LayerEvidence{State: StateNotConfigured, Measured: false},
	}
	if got := OverallState(layers); got != StateHealthy {
		t.Fatalf("expected healthy, got %s", got)
	}
}

func TestOverallStateUnhealthyWinsOverHealthy(t *testing.T) {
	layers := LayerSet{
		Process:   LayerEvidence{State: StateHealthy, Measured: true},
		Interface: LayerEvidence{State: StateUnhealthy, Measured: true},
		Service:   LayerEvidence{State: StateHealthy, Measured: true},
	}
	if got := OverallState(layers); got != StateUnhealthy {
		t.Fatalf("expected unhealthy, got %s", got)
	}
}

func TestOverallStateDegradedWinsOverHealthy(t *testing.T) {
	layers := LayerSet{
		Process:   LayerEvidence{State: StateHealthy, Measured: true},
		Interface: LayerEvidence{State: StateHealthy, Measured: true},
		Service:   LayerEvidence{State: StateDegraded, Measured: true},
	}
	if got := OverallState(layers); got != StateDegraded {
		t.Fatalf("expected degraded, got %s", got)
	}
}

func TestUnsupportedLayerNeverBecomesHealthy(t *testing.T) {
	layers := LayerSet{
		Process:   LayerEvidence{State: StateNotConfigured, Measured: false},
		Interface: LayerEvidence{State: StateHealthy, Measured: true},
		Service:   LayerEvidence{State: StateNotConfigured, Measured: false},
	}
	got := OverallState(layers)
	if got != StateHealthy {
		t.Fatalf("expected healthy from the single measured layer, got %s", got)
	}
	cov := CoverageFromLayers(layers)
	if cov.L1Measured || cov.L3Measured {
		t.Fatalf("unsupported layers must not report coverage: %+v", cov)
	}
}

func TestEvaluateProcessLayerActiveIsHealthy(t *testing.T) {
	got := EvaluateProcessLayer(ProcessEvidence{
		Outcome:      ProcessActive,
		EvidenceKind: EvidenceSystemd,
		MainPID:      1234,
	})
	if got.State != StateHealthy || !got.Measured {
		t.Fatalf("expected healthy measured layer, got %+v", got)
	}
}

func TestEvaluateProcessLayerNotConfiguredStaysNotConfigured(t *testing.T) {
	got := EvaluateProcessLayer(ProcessEvidence{Outcome: ProcessNotConfigured})
	if got.State != StateNotConfigured || got.Measured {
		t.Fatalf("expected not_configured unmeasured layer, got %+v", got)
	}
}

func TestEvaluateProcessLayerPermissionIsUnknown(t *testing.T) {
	got := EvaluateProcessLayer(ProcessEvidence{
		Outcome:      ProcessPermission,
		EvidenceKind: EvidenceSystemd,
	})
	if got.State != StateUnknown {
		t.Fatalf("expected unknown on permission denial, got %+v", got)
	}
}

func TestEvaluateInterfaceLayerValidHTTPIsHealthyOnlyForEndpoint(t *testing.T) {
	status := 200
	probe := &ProbeResult{HTTPStatus: status, Outcome: InterfaceValid, ResponseMs: 5}
	got := EvaluateInterfaceLayer(probe, nil, 3)
	if got.State != StateHealthy {
		t.Fatalf("expected healthy interface layer, got %+v", got)
	}
	if got.HTTPStatus == nil || *got.HTTPStatus != 200 {
		t.Fatalf("expected http status provenance, got %+v", got)
	}
}

func TestEvaluateInterfaceLayerHTTP200WithInvalidMetricsIsUnhealthy(t *testing.T) {
	probe := &ProbeResult{HTTPStatus: 200, Outcome: InterfaceValid}
	got := EvaluateInterfaceLayer(probe, errParse, 0)
	if got.State != StateUnhealthy {
		t.Fatalf("expected unhealthy on invalid metrics, got %+v", got)
	}
	if got.Reason != ReasonMetricInvalid {
		t.Fatalf("expected metric_invalid reason, got %+v", got)
	}
}

func TestEvaluateServiceLayerMissingStaysNotAvailable(t *testing.T) {
	got := EvaluateServiceLayer(nil, nil)
	if got.State != StateNotConfigured {
		t.Fatalf("expected not_configured for missing KPIs, got %+v", got)
	}
	if got.Reason != ReasonNoSupportedKPI {
		t.Fatalf("expected no_supported_service_kpi, got %+v", got)
	}
}

// A registered activity rule reports observed activity, never confirmed health.
// Regression: this sample previously produced a healthy L3 layer purely because
// a positive activity gauge was treated as service-health confirmation.
func TestEvaluateServiceLayerActivitySampleIsNotHealthy(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{{Key: "gnb", Value: 1, Category: CategoryService}}, nil)
	if got.State == StateHealthy {
		t.Fatalf("activity alone must not establish service health, got %+v", got)
	}
	if !got.Measured || got.State != StateUnknown {
		t.Fatalf("expected measured unknown service layer, got %+v", got)
	}
	if got.Reason != ReasonActivityObserved {
		t.Fatalf("expected activity_observed, got %+v", got)
	}
}

// Process/resource telemetry is genuine measured evidence but can never
// establish L3 service health.
func TestEvaluateServiceLayerResourceOnlySamplesAreUnknown(t *testing.T) {
	samples := []MetricSample{
		{Key: "process_cpu_seconds_total", Value: 128.5, Category: CategoryResource},
		{Key: "process_resident_memory_bytes", Value: 4096, Category: CategoryResource},
	}
	got := EvaluateServiceLayer(samples, nil)
	if got.State != StateUnknown {
		t.Fatalf("resource-only telemetry must not claim service health, got %+v", got)
	}
	if !got.Measured {
		t.Fatal("observed evidence must still be reported as measured")
	}
	if got.Reason != ReasonResourceMetricsOnly {
		t.Fatalf("expected resource_metrics_only, got %+v", got)
	}
}

// A sample with no category (legacy or unattributed) is read conservatively as
// resource evidence rather than as a service-health claim.
func TestEvaluateServiceLayerUncategorizedSampleIsNotHealthy(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{{Key: "gnb", Value: 1}}, nil)
	if got.State == StateHealthy {
		t.Fatalf("an unattributed sample must not claim service health, got %+v", got)
	}
	if !got.Measured {
		t.Fatal("observed evidence must still be reported as measured")
	}
}

func TestMissingMetricsAreNeverZeroFilled(t *testing.T) {
	// A missing family must not materialise as a zero-valued sample.
	samples := []MetricSample{}
	got := EvaluateServiceLayer(samples, nil)
	if len(samples) != 0 {
		t.Fatalf("missing metrics must not invent samples")
	}
	if got.State == StateHealthy {
		t.Fatalf("empty sample set must not be healthy")
	}
}

func TestFailedCollectionDoesNotClaimHealthy(t *testing.T) {
	layers := LayerSet{
		Process:   LayerEvidence{State: StateUnknown, Measured: true},
		Interface: LayerEvidence{State: StateUnhealthy, Measured: true, Reason: "connection_refused"},
		Service:   LayerEvidence{State: StateUnknown, Measured: false},
	}
	if got := OverallState(layers); got != StateUnhealthy {
		t.Fatalf("expected unhealthy, got %s", got)
	}
}
