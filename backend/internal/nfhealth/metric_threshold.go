package nfhealth

import (
	"math"
	"strconv"
	"time"
)

// ThresholdCapability describes a measurement policy, never service health.
type ThresholdCapability struct {
	Metric   string `json:"metric"`
	Type     string `json:"type"`
	Unit     string `json:"unit"`
	Subject  string `json:"subject"`
	Series   string `json:"series"`
	Eligible bool   `json:"eligible"`
	Reason   string `json:"reason"`
}

// ThresholdCapabilities is deliberately allowlisted. Gauge type alone does not
// establish operational meaning, and the exporter is not necessarily the NF.
func ThresholdCapabilities() []ThresholdCapability {
	out := make([]ThresholdCapability, 0, len(supportedMetrics))
	for _, def := range SupportedMetrics() {
		cap := ThresholdCapability{Metric: def.Name, Type: def.Type, Unit: def.Unit,
			Subject: "measurement", Series: "unlabeled", Reason: "metric_not_approved"}
		if def.Category == CategoryResource {
			cap.Subject = "exporter_process"
		}
		if def.Type == "counter" {
			cap.Reason = "counter_requires_interval"
		}
		if def.Name == "process_resident_memory_bytes" {
			cap.Eligible = true
			cap.Reason = "exporter_memory_only"
		}
		out = append(out, cap)
	}
	return out
}

func ThresholdMetricApproved(metric string) bool {
	return metric == "process_resident_memory_bytes"
}

// ThresholdValue validates the accepted evidence against the CURRENT target
// configuration. Private binding material never leaves this package.
func ThresholdValue(target *HealthTarget, sample *HealthSample, metric string, now time.Time) (*float64, string) {
	if target == nil || !target.Enabled || target.CollectorProfile != CollectorHTTPMetrics ||
		target.ResourceID == "" || target.IdentityState != IdentityInventoryAuthoritative {
		return nil, "target_not_eligible"
	}
	if !ThresholdMetricApproved(metric) {
		return nil, "metric_not_approved"
	}
	if sample == nil {
		return nil, "measurement_missing"
	}
	if sample.TargetID != target.TargetID || sample.ResourceID != target.ResourceID ||
		sample.WindowBinding == "" || sample.WindowBinding != windowBinding(target) {
		return nil, "measurement_identity_changed"
	}
	at, err := time.Parse(time.RFC3339Nano, sample.CollectedAt)
	if err != nil || at.After(now) || now.Sub(at) > time.Duration(FreshnessPolicySeconds(target))*time.Second {
		return nil, "measurement_not_fresh"
	}
	var metricsProof *ProbeEvidence
	for i := range sample.Probes {
		probe := &sample.Probes[i]
		if probe.Family != ProbeFamilyMetrics {
			continue
		}
		if metricsProof != nil {
			return nil, "metrics_collection_unavailable"
		}
		metricsProof = probe
	}
	if metricsProof == nil || !metricsProof.Measured || metricsProof.State != StateHealthy ||
		metricsProof.Endpoint != target.MetricsEndpoint || metricsProof.MeasuredAt != sample.CollectedAt ||
		metricsProof.HTTPStatus == nil || *metricsProof.HTTPStatus != 200 {
		return nil, "metrics_collection_unavailable"
	}
	var selected *MetricSample
	for i := range sample.Metrics {
		m := &sample.Metrics[i]
		if m.Key != metric {
			continue
		}
		if selected != nil {
			return nil, "series_ambiguous"
		}
		selected = m
	}
	if selected == nil {
		return nil, "metric_missing"
	}
	m := selected
	if !m.ScopeVerified || len(m.Labels) != 0 {
		return nil, "series_not_verified"
	}
	if m.Type != "gauge" || m.Unit != "bytes" || m.Category != CategoryResource ||
		m.Source != "metrics_endpoint" || m.CollectedAt != sample.CollectedAt ||
		math.IsNaN(m.Value) || math.IsInf(m.Value, 0) || m.Value < 0 {
		return nil, "metric_invalid"
	}
	value := m.Value
	return &value, "measured"
}

// ThresholdPreview is a read-only projection, not an evaluation or a collection.
type ThresholdPreview struct {
	DurationEligible bool     `json:"durationEligible"`
	DurationReason   string   `json:"durationReason"`
	MaxGapSeconds    int      `json:"maxGapSeconds"`
	Value            *float64 `json:"value"`
	Reason           string   `json:"reason"`
}

// ThresholdContinuity uses the same verified exporter incarnation as interval
// observations. No private binding, process token or endpoint enters the API.
func ThresholdContinuity(target *HealthTarget, sample *HealthSample) (string, int) {
	gap := ThresholdMaxGapSeconds(target)
	if target == nil || sample == nil || sample.WindowBinding != windowBinding(target) || sample.WindowIdentity == "" {
		return "", gap
	}
	count := 0
	for _, metric := range sample.Metrics {
		if metric.Key != "process_start_time_seconds" {
			continue
		}
		count++
		if !metric.ScopeVerified || len(metric.Labels) != 0 || metric.Type != "gauge" || metric.Unit != "seconds" ||
			metric.Category != CategoryResource || metric.Source != "metrics_endpoint" || metric.CollectedAt != sample.CollectedAt ||
			math.IsNaN(metric.Value) || math.IsInf(metric.Value, 0) || metric.Value <= 0 {
			return "", gap
		}
	}
	if count != 1 {
		return "", gap
	}
	return windowHash(sample.WindowBinding, sample.WindowIdentity, strconv.FormatInt(target.Revision, 10)), gap
}
func ThresholdMaxGapSeconds(target *HealthTarget) int {
	if target == nil {
		return DefaultIntervalSeconds * 3 / 2
	}
	gap, _ := windowLimits(target)
	return gap
}
