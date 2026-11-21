package nfhealth

import (
	"math"
	"testing"
	"time"
)

func TestThresholdCapabilityBoundaries(t *testing.T) {
	approved := 0
	for _, cap := range ThresholdCapabilities() {
		if cap.Eligible {
			approved++
			if cap.Metric != "process_resident_memory_bytes" || cap.Subject != "exporter_process" || cap.Unit != "bytes" {
				t.Fatalf("false capability: %+v", cap)
			}
		}
		if cap.Type == "counter" && cap.Eligible {
			t.Fatal("cumulative counter approved")
		}
	}
	if approved != 1 {
		t.Fatalf("approved=%d", approved)
	}
}

func TestThresholdValueEvidence(t *testing.T) {
	now := time.Date(2026, 11, 21, 1, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		mutate func(*HealthTarget, *HealthSample)
		reason string
	}{
		{"valid", func(*HealthTarget, *HealthSample) {}, "measured"},
		{"unrelated_interface_failure", func(t *HealthTarget, s *HealthSample) { s.Layers.Interface.State = StateUnhealthy }, "measured"},
		{"disabled", func(t *HealthTarget, s *HealthSample) { t.Enabled = false }, "target_not_eligible"},
		{"process_only", func(t *HealthTarget, s *HealthSample) { t.CollectorProfile = CollectorProcessOnly }, "target_not_eligible"},
		{"legacy", func(t *HealthTarget, s *HealthSample) { t.IdentityState = IdentityLegacyUnbound }, "target_not_eligible"},
		{"different_resource", func(t *HealthTarget, s *HealthSample) { s.ResourceID = "other" }, "measurement_identity_changed"},
		{"old_binding", func(t *HealthTarget, s *HealthSample) { t.MetricsEndpoint = "http://127.0.0.1:9999/metrics" }, "measurement_identity_changed"},
		{"legacy_binding", func(t *HealthTarget, s *HealthSample) { s.WindowBinding = "" }, "measurement_identity_changed"},
		{"stale", func(t *HealthTarget, s *HealthSample) {
			s.CollectedAt = now.Add(-24 * time.Hour).Format(time.RFC3339Nano)
		}, "measurement_not_fresh"},
		{"future", func(t *HealthTarget, s *HealthSample) { s.CollectedAt = now.Add(time.Second).Format(time.RFC3339Nano) }, "measurement_not_fresh"},
		{"failed_interface", func(t *HealthTarget, s *HealthSample) { s.Probes[0].State = StateUnhealthy }, "metrics_collection_unavailable"},
		{"unmeasured_interface", func(t *HealthTarget, s *HealthSample) { s.Probes[0].Measured = false }, "metrics_collection_unavailable"},
		{"absent", func(t *HealthTarget, s *HealthSample) { s.Metrics = nil }, "metric_missing"},
		{"duplicate", func(t *HealthTarget, s *HealthSample) { s.Metrics = append(s.Metrics, s.Metrics[0]) }, "series_ambiguous"},
		{"privacy_collapsed", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].ScopeVerified = false }, "series_not_verified"},
		{"labeled", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].Labels = map[string]string{"nf": "AMF"} }, "series_not_verified"},
		{"counter", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].Type = "counter" }, "metric_invalid"},
		{"wrong_unit", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].Unit = "percent" }, "metric_invalid"},
		{"wrong_origin", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].Source = "process" }, "metric_invalid"},
		{"negative", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].Value = -1 }, "metric_invalid"},
		{"nan", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].Value = math.NaN() }, "metric_invalid"},
		{"infinite", func(t *HealthTarget, s *HealthSample) { s.Metrics[0].Value = math.Inf(1) }, "metric_invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target := &HealthTarget{TargetID: "target", ResourceID: "resource", IdentityState: IdentityInventoryAuthoritative, Enabled: true, CollectorProfile: CollectorHTTPMetrics, MetricsEndpoint: "http://127.0.0.1:9090/metrics", CollectionMode: CollectionManual}
			httpOK := 200
			sample := &HealthSample{
				Probes: []ProbeEvidence{{Family: ProbeFamilyMetrics, Endpoint: target.MetricsEndpoint, State: StateHealthy, Measured: true, HTTPStatus: &httpOK, MeasuredAt: now.Format(time.RFC3339Nano)}}, TargetID: target.TargetID, ResourceID: target.ResourceID, CollectedAt: now.Format(time.RFC3339Nano), WindowBinding: windowBinding(target), Layers: LayerSet{Interface: LayerEvidence{State: StateHealthy, Measured: true}},
				Metrics: []MetricSample{{Key: "process_resident_memory_bytes", Type: "gauge", Unit: "bytes", Source: "metrics_endpoint", Category: CategoryResource, ScopeVerified: true, CollectedAt: now.Format(time.RFC3339Nano), Value: 123}}}
			tc.mutate(target, sample)
			value, reason := ThresholdValue(target, sample, "process_resident_memory_bytes", now)
			if reason != tc.reason {
				t.Fatalf("reason=%s want=%s", reason, tc.reason)
			}
			if (value != nil) != (reason == "measured") {
				t.Fatal("invalid evidence returned a value")
			}
		})
	}
}
