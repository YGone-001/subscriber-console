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

// EvaluateServiceLayer derives L3 coverage from parsed registry samples.
//
// Unsupported KPI families stay not_available. Missing metrics are never
// zero-filled.
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
	return LayerEvidence{
		State:        StateHealthy,
		EvidenceKind: EvidenceMetric,
		Measured:     true,
	}
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
