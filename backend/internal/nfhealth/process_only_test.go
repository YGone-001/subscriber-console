package nfhealth

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func processOnlyTarget(targetID, resourceID, unit string) *HealthTarget {
	return &HealthTarget{
		TargetID:         targetID,
		SchemaVersion:    SchemaVersion,
		ResourceID:       resourceID,
		Name:             "IMS P-CSCF local process",
		CollectorProfile: CollectorProcessOnly,
		ServiceUnit:      unit,
		ServiceKind:      "process",
		CollectionMode:   CollectionManual,
		IntervalSeconds:  DefaultIntervalSeconds,
		Enabled:          true,
		Domain:           "ims",
		NFType:           NFTypePCSCF,
		IdentityState:    IdentityInventoryAuthoritative,
	}
}

// Group D: process_only collector behavior.
func TestProcessOnlyCollectorPerformsNoHTTPRequest(t *testing.T) {
	root := t.TempDir()
	pidDir := filepath.Join(root, "801")
	if err := os.MkdirAll(pidDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pidDir, "comm"), []byte("pcscfd\n"), 0o644); err != nil {
		t.Fatalf("write comm: %v", err)
	}
	if err := os.Symlink("/usr/bin/pcscfd", filepath.Join(pidDir, "exe")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	inspector := NewUnitInspector(NewServiceUnitAllowlist("pcscfd"), "")
	inspector.procRoot = root
	// A nil prober fails the test if any HTTP request is attempted.
	collector := NewCollector(nil, inspector, NewDestinationAllowlist(""), NewServiceUnitAllowlist("pcscfd"))

	target := processOnlyTarget("80111111-1111-4111-8111-111111111111", testResourceIMS, "pcscfd")
	result, err := collector.Collect(context.Background(), target, "operator1", false)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if result.Run.Status != RunStatusSuccess {
		t.Fatalf("expected success run, got %s (%s)", result.Run.Status, result.Run.ErrorSummary)
	}
	if result.Run.LayersMeasured != 1 {
		t.Fatalf("expected exactly one measured layer, got %d", result.Run.LayersMeasured)
	}
	if result.Sample == nil {
		t.Fatal("L1 evidence must be recorded as a sample")
	}
	sample := result.Sample
	if sample.Layers.Process.State != StateHealthy || !sample.Layers.Process.Measured {
		t.Fatalf("expected measured healthy L1, got %+v", sample.Layers.Process)
	}
	if sample.Layers.Interface.State != StateNotConfigured || sample.Layers.Interface.Measured {
		t.Fatalf("L2 must stay not_configured and unmeasured, got %+v", sample.Layers.Interface)
	}
	if sample.Layers.Service.State != StateNotConfigured || sample.Layers.Service.Measured {
		t.Fatalf("L3 must stay not_configured and unmeasured, got %+v", sample.Layers.Service)
	}
	if sample.ResourceID != testResourceIMS {
		t.Fatalf("sample must retain the canonical resource association, got %q", sample.ResourceID)
	}
	if len(sample.Metrics) != 0 {
		t.Fatal("process_only must not synthesize metrics")
	}
	// L1-only health must not be presented as full service health.
	coverage := CoverageFromLayers(sample.Layers)
	if !coverage.L1Measured || coverage.L2Measured || coverage.L3Measured {
		t.Fatalf("coverage must report L1 only, got %+v", coverage)
	}
	if overall := OverallState(sample.Layers); overall != StateHealthy {
		t.Fatalf("expected healthy overall for the measured layer, got %s", overall)
	}
}

func TestProcessOnlyCollectorWithoutProcessIsNotHealthy(t *testing.T) {
	root := t.TempDir()
	inspector := NewUnitInspector(NewServiceUnitAllowlist("pcscfd"), "")
	inspector.procRoot = root
	collector := NewCollector(nil, inspector, NewDestinationAllowlist(""), NewServiceUnitAllowlist("pcscfd"))

	target := processOnlyTarget("80222222-2222-4222-8222-222222222222", testResourceIMS, "pcscfd")
	result, err := collector.Collect(context.Background(), target, "operator1", false)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if result.Sample == nil {
		t.Fatal("not-running is still measured L1 evidence")
	}
	if result.Sample.Layers.Process.State != StateUnhealthy {
		t.Fatalf("expected unhealthy L1, got %+v", result.Sample.Layers.Process)
	}
	if result.Run.Status != RunStatusSuccess {
		t.Fatalf("expected success run with measured evidence, got %s", result.Run.Status)
	}
}

func TestProcessOnlyWithEndpointConfiguredNeverProbes(t *testing.T) {
	root := t.TempDir()
	pidDir := filepath.Join(root, "803")
	if err := os.MkdirAll(pidDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pidDir, "comm"), []byte("pcscfd\n"), 0o644); err != nil {
		t.Fatalf("write comm: %v", err)
	}
	if err := os.Symlink("/usr/bin/pcscfd", filepath.Join(pidDir, "exe")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	inspector := NewUnitInspector(NewServiceUnitAllowlist("pcscfd"), "")
	inspector.procRoot = root
	collector := NewCollector(nil, inspector, NewDestinationAllowlist(""), NewServiceUnitAllowlist("pcscfd"))

	// Validation rejects this combination at the API boundary; the collector
	// must still never open an HTTP connection if it somehow reaches here.
	target := processOnlyTarget("80333333-3333-4333-8333-333333333333", testResourceIMS, "pcscfd")
	target.MetricsEndpoint = "http://127.0.0.1:1/metrics"
	result, err := collector.Collect(context.Background(), target, "operator1", false)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if result.Sample.Layers.Interface.Measured || result.Sample.Layers.Interface.State != StateNotConfigured {
		t.Fatalf("L2 must remain not_configured, got %+v", result.Sample.Layers.Interface)
	}
}

func TestCollectorBlocksRetiredResource(t *testing.T) {
	root := t.TempDir()
	inspector := NewUnitInspector(NewServiceUnitAllowlist("pcscfd"), "")
	inspector.procRoot = root
	collector := NewCollector(nil, inspector, NewDestinationAllowlist(""), NewServiceUnitAllowlist("pcscfd"))
	retired := testResourceIMS
	collector.SetRetiredResourceCheck(func(_ context.Context, resourceID string) (bool, error) {
		return resourceID == retired, nil
	})

	target := processOnlyTarget("80444444-4444-4444-8444-444444444444", testResourceIMS, "pcscfd")
	if _, err := collector.Collect(context.Background(), target, "operator1", false); err != ErrResourceRetired {
		t.Fatalf("expected ErrResourceRetired, got %v", err)
	}
}

func TestProcessOnlyValidationRules(t *testing.T) {
	base := func() *CreateTargetRequest {
		return &CreateTargetRequest{
			ResourceID:  testResourceIMS,
			Name:        "P-CSCF local",
			ServiceKind: "process",
			ServiceUnit: "pcscfd",
		}
	}
	units := NewServiceUnitAllowlist("pcscfd")
	bindings := NewProcessBindingRegistry(testResourceIMS + "=pcscfd")
	dest := NewDestinationAllowlist("127.0.0.1:9090")

	req := base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	if err := ValidateCreateTargetRequest(req, dest, units, bindings); err != nil {
		t.Fatalf("valid process_only request rejected: %v", err)
	}

	req = base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	req.MetricsEndpoint = "http://127.0.0.1:9090/metrics"
	assertCode(t, ValidateCreateTargetRequest(req, dest, units, bindings), "INVALID_TARGET")

	req = base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	req.ServiceKind = "none"
	assertCode(t, ValidateCreateTargetRequest(req, nil, units, bindings), "INVALID_SERVICE_KIND")

	req = base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	req.ServiceUnit = ""
	assertCode(t, ValidateCreateTargetRequest(req, nil, units, bindings), "INVALID_TARGET")

	// Missing server-authorized binding fails closed.
	req = base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	assertCode(t, ValidateCreateTargetRequest(req, nil, units, NewProcessBindingRegistry("")), "NF_HEALTH_PROCESS_BINDING_MISSING")

	// Mismatched binding fails closed.
	req = base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	assertCode(t, ValidateCreateTargetRequest(req, nil, units, NewProcessBindingRegistry(testResourceIMS+"=otherd")), "NF_HEALTH_PROCESS_BINDING_MISMATCH")

	// process_only without an Inventory resource is rejected. A candidate-only
	// process_only request fails with the specific resource requirement.
	req = base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	req.ResourceID = ""
	req.CandidateID = "55555555-5555-4555-8555-555555555555"
	assertCode(t, ValidateCreateTargetRequest(req, dest, units, bindings), "NF_HEALTH_RESOURCE_REQUIRED")

	// No identity at all is a generic invalid target.
	req = base()
	req.CollectorProfile = CollectorProcessOnly
	req.CollectionMode = CollectionManual
	req.ResourceID = ""
	req.CandidateID = ""
	assertCode(t, ValidateCreateTargetRequest(req, dest, units, bindings), "INVALID_TARGET")

	// Legacy candidate-only http_metrics creation remains compatible.
	legacy := &CreateTargetRequest{
		CandidateID:      "55555555-5555-4555-8555-555555555555",
		Name:             "AMF metrics",
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  "http://127.0.0.1:9090/metrics",
		ServiceKind:      "none",
		CollectionMode:   CollectionManual,
	}
	if err := ValidateCreateTargetRequest(legacy, NewDestinationAllowlist("127.0.0.1:9090"), nil, nil); err != nil {
		t.Fatalf("legacy candidate-only http_metrics request must stay valid: %v", err)
	}
}
