package nfhealth

// OverallState derives a deterministic overall state from the three layers.
//
// Aggregation rules are deliberately conservative:
//
//   - Any measured layer that is unhealthy forces unhealthy.
//   - Any measured layer that is degraded forces degraded unless an unhealthy
//     layer is present.
//   - If every measured layer is healthy and at least one layer is measured,
//     the overall state is healthy.
//   - If no layer is measured, the overall state is unknown.
//   - Unsupported layers never contribute a healthy claim.
func OverallState(layers LayerSet) string {
	states := []string{layers.Process.State, layers.Interface.State, layers.Service.State}
	measured := []bool{layers.Process.Measured, layers.Interface.Measured, layers.Service.Measured}

	anyMeasured := false
	for _, m := range measured {
		if m {
			anyMeasured = true
			break
		}
	}
	if !anyMeasured {
		return StateUnknown
	}

	worst := ""
	for i, st := range states {
		if !measured[i] {
			continue
		}
		switch st {
		case StateUnhealthy:
			return StateUnhealthy
		case StateDegraded:
			if worst != StateUnhealthy {
				worst = StateDegraded
			}
		case StateUnknown, StateStale:
			if worst == "" {
				worst = StateUnknown
			}
		case StateHealthy:
			if worst == "" {
				worst = StateHealthy
			}
		}
	}
	if worst == "" {
		return StateUnknown
	}
	return worst
}

// EvaluateProcessLayer converts process evidence into layer evidence.
func EvaluateProcessLayer(ev ProcessEvidence) LayerEvidence {
	if ev.Outcome == ProcessNotConfigured {
		return LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
			Measured:     false,
		}
	}
	out := LayerEvidence{
		State:          MapProcessEvidenceToState(ev),
		EvidenceKind:   ev.EvidenceKind,
		ProcessOutcome: ev.Outcome,
		Measured:       true,
	}
	if ev.MainPID > 0 {
		out.MainPID = ev.MainPID
	}
	if ev.ErrorMessage != "" {
		out.Reason = ev.ErrorMessage
	}
	return out
}

// EvaluateInterfaceLayer converts probe evidence into layer evidence.
//
// An HTTP 200 alone is never interpreted as a healthy protocol stack. It
// proves only that the probed endpoint answered.
func EvaluateInterfaceLayer(probe *ProbeResult, parseErr error, parsed int) LayerEvidence {
	if probe == nil {
		return LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
			Measured:     false,
		}
	}
	out := LayerEvidence{
		EvidenceKind: EvidenceHTTP,
		ResponseMs:   &probe.ResponseMs,
		Measured:     true,
	}
	status := probe.HTTPStatus
	if status > 0 {
		out.HTTPStatus = &status
	}

	switch probe.Outcome {
	case InterfaceValid:
		// A valid HTTP response is not automatically valid metrics data.
		if parseErr != nil {
			out.State = StateUnhealthy
			out.Reason = ReasonMetricInvalid
			return out
		}
		if parsed == 0 {
			out.State = StateDegraded
			out.Reason = ReasonMetricMissing
			return out
		}
		out.State = StateHealthy
	case InterfaceRefused:
		out.State = StateUnhealthy
		out.Reason = "connection_refused"
	case InterfaceTimeout:
		out.State = StateUnhealthy
		out.Reason = "timeout"
	case InterfaceHTTP4xx:
		out.State = StateUnhealthy
		out.Reason = "http_4xx"
	case InterfaceHTTP5xx:
		out.State = StateUnhealthy
		out.Reason = "http_5xx"
	case InterfaceInvalid:
		out.State = StateUnhealthy
		out.Reason = "invalid_response"
	case InterfaceNotConfig:
		out.State = StateNotConfigured
		out.Reason = ReasonNotConfigured
		out.Measured = false
	default:
		out.State = StateUnknown
		out.Reason = "collection_error"
	}
	return out
}

// ServiceEvidenceSummary is the rule-based reading of one measurement set.
//
// It is reported for diagnostics and is never persisted as a health claim on
// its own.
type ServiceEvidenceSummary struct {
	// ServiceSamples counts accepted service-category samples.
	ServiceSamples int
	// ResourceSamples counts accepted resource-category samples (exporter
	// process telemetry).
	ResourceSamples int
	// Positive counts rule evaluations that produced positive evidence.
	Positive int
	// Degraded counts rule evaluations that observed failures.
	Degraded int
	// Undetermined counts service samples without a defensible health rule.
	Undetermined int
}

// EvaluateServiceLayer derives L3 evidence from parsed registry samples.
//
// Corrected semantics: L3 service health is never inferred from the mere
// existence of samples.
//
//   - Generic process/resource telemetry (process_cpu_seconds_total,
//     process_resident_memory_bytes, ...) describes the exporter process and can
//     never establish service health.
//   - A measured service counter does not prove the service is healthy: a
//     recognized counter may simply report how many failures occurred.
//   - Only explicit, evidence-backed rules (registered per metric family)
//     produce a positive or degraded reading.
//   - When service evidence exists but no rule applies, the layer is reported as
//     unknown while the measurement coverage is preserved.
//   - Unsupported KPI families stay not_configured, and missing metrics are
//     never zero-filled.
func EvaluateServiceLayer(samples []MetricSample, parseErr error) LayerEvidence {
	if parseErr != nil && len(samples) == 0 {
		return LayerEvidence{
			State:        StateUnknown,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonMetricMissing,
			Measured:     false,
		}
	}
	if len(samples) == 0 {
		return LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNoSupportedKPI,
			Measured:     false,
		}
	}

	summary := SummarizeServiceEvidence(samples)
	if summary.ServiceSamples == 0 {
		// Only exporter-process telemetry was observed: real evidence, but no
		// service-health claim may be derived from it.
		return LayerEvidence{
			State:        StateUnknown,
			EvidenceKind: EvidenceMetric,
			Reason:       ReasonResourceMetricsOnly,
			Measured:     true,
		}
	}
	if summary.Degraded > 0 {
		return LayerEvidence{
			State:        StateDegraded,
			EvidenceKind: EvidenceMetric,
			Reason:       ReasonServiceFailuresObserved,
			Measured:     true,
		}
	}
	if summary.Positive > 0 {
		return LayerEvidence{
			State:        StateHealthy,
			EvidenceKind: EvidenceMetric,
			Reason:       ReasonServiceHealthConfirmed,
			Measured:     true,
		}
	}
	return LayerEvidence{
		State:        StateUnknown,
		EvidenceKind: EvidenceMetric,
		Reason:       ReasonServiceHealthUndetermined,
		Measured:     true,
	}
}

// SummarizeServiceEvidence applies the registered health rules to one set of
// samples.
//
// Failure counters are only credited as positive "no failure observed" evidence
// when at least one request or activity signal is present in the same set: a
// zero failure counter with no traffic proves nothing.
func SummarizeServiceEvidence(samples []MetricSample) ServiceEvidenceSummary {
	summary := ServiceEvidenceSummary{}
	values := make(map[string]float64, len(samples))
	for _, sample := range samples {
		if sample.Category == CategoryService {
			summary.ServiceSamples++
		} else {
			summary.ResourceSamples++
		}
		// First occurrence wins so duplicate series cannot inflate evidence.
		if _, seen := values[sample.Key]; !seen {
			values[sample.Key] = sample.Value
		}
	}

	trafficObserved := false
	for _, sample := range samples {
		def, ok := LookupMetric(sample.Key)
		if !ok || def.Category != CategoryService {
			continue
		}
		switch def.HealthRule {
		case HealthRuleSuccessRatioPair:
			request, seen := values[def.HealthPair]
			if !seen || request <= 0 {
				summary.Undetermined++
				continue
			}
			trafficObserved = true
			if sample.Value >= request {
				summary.Positive++
			} else {
				summary.Degraded++
			}
		case HealthRuleActivityGauge:
			if sample.Value > 0 {
				trafficObserved = true
				summary.Positive++
			} else {
				summary.Undetermined++
			}
		case HealthRuleNone:
			// Request counters are traffic evidence even though they carry no
			// health rule of their own.
			if sample.Value > 0 {
				trafficObserved = true
			}
			summary.Undetermined++
		}
	}

	// Failure counters are evaluated after traffic is known so that an idle
	// exporter cannot be reported as healthy.
	for _, sample := range samples {
		def, ok := LookupMetric(sample.Key)
		if !ok || def.HealthRule != HealthRuleFailureCounterZero {
			continue
		}
		if sample.Value > 0 {
			summary.Degraded++
			continue
		}
		if trafficObserved {
			summary.Positive++
		} else {
			summary.Undetermined++
		}
	}
	return summary
}

// CoverageFromLayers summarises which layers were actually measured.
func CoverageFromLayers(layers LayerSet) CoverageSummary {
	return CoverageSummary{
		L1Measured:  layers.Process.Measured,
		L2Measured:  layers.Interface.Measured,
		L3Measured:  layers.Service.Measured,
		L3Available: layers.Service.Measured && layers.Service.State != StateNotConfigured,
	}
}
