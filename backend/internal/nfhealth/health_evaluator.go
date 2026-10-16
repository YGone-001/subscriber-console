package nfhealth

import (
	"sort"
	"strings"
)

// layerStateRank encodes the order-independent precedence of measured layer
// states. A higher rank always wins, so aggregation never depends on the order
// in which layers are inspected.
//
// unhealthy > degraded > stale > unknown > healthy
var layerStateRank = map[string]int{
	StateUnhealthy: 5,
	StateDegraded:  4,
	StateStale:     3,
	StateUnknown:   2,
	StateHealthy:   1,
}

// OverallState derives a deterministic, order-independent overall state from the
// three layers.
//
// Precedence among measured layers:
//
//	any measured unhealthy            -> unhealthy
//	else any measured degraded        -> degraded
//	else any measured stale           -> stale
//	else any measured unknown         -> unknown
//	else all measured layers healthy  -> healthy
//	else no measured layer            -> unknown
//
// A measured layer that is unknown, stale or unrecognized can therefore never
// disappear behind a healthy layer: the documented invariant is that every
// measured layer must be healthy before the aggregate may be healthy.
//
// The result describes the status of the measured layers only. It is never a
// claim of complete end-to-end service availability: layers that were not
// measured are excluded rather than assumed healthy.
func OverallState(layers LayerSet) string {
	states := []string{layers.Process.State, layers.Interface.State, layers.Service.State}
	measured := []bool{layers.Process.Measured, layers.Interface.Measured, layers.Service.Measured}

	worst := ""
	worstRank := 0
	for i, st := range states {
		if !measured[i] {
			continue
		}
		rank, known := layerStateRank[st]
		if !known {
			// An unrecognized state is treated as unknown, never as healthy.
			st, rank = StateUnknown, layerStateRank[StateUnknown]
		}
		if rank > worstRank {
			worst, worstRank = st, rank
		}
	}
	if worstRank == 0 {
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

// ruleOutcome is the reading produced by one registered health rule.
//
// The vocabulary deliberately separates what the evidence can actually support:
//
//	outcomeNone             no rule applies to the sample
//	outcomeIntervalRequired the rule needs verified interval evidence (two valid
//	                        observations of the same series) that is not
//	                        available; the raw measurement is preserved without
//	                        a health claim
//	outcomeActivityObserved service activity or state occupancy was observed, but
//	                        complete service correctness is not established
//	outcomeConfirmed        reserved for an explicitly validated rule that
//	                        establishes current service health
//	outcomeDegraded         reserved for an explicitly validated rule that
//	                        establishes current service failures
type ruleOutcome int

const (
	outcomeNone ruleOutcome = iota
	outcomeIntervalRequired
	outcomeActivityObserved
	outcomeConfirmed
	outcomeDegraded
)

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
	// Confirmed and Degraded are reserved for explicitly validated rules. No rule
	// registered today sets them: cumulative counters and activity gauges cannot
	// establish current service outcomes.
	Confirmed int
	Degraded  int
	// ActivityObserved counts samples whose rule established service activity or
	// state occupancy only.
	ActivityObserved int
	// IntervalRequired counts samples whose rule requires verified interval
	// evidence that was not available.
	IntervalRequired int
	// AmbiguousScopes counts samples whose paired rule could not be evaluated
	// because the series scope could not be verified as equivalent.
	AmbiguousScopes int
	// Undetermined counts service samples without a defensible health rule.
	Undetermined int
}

// EvaluateServiceLayer derives L3 evidence from parsed registry samples.
//
// L3 service health is never inferred from the mere existence of samples:
//
//   - Generic process/resource telemetry describes the exporter process and can
//     never establish service health.
//   - Cumulative counters are historical totals. A request/success pair, a
//     non-zero historical failure count, or a zero historical failure count
//     cannot establish the current measurement window's outcome, so the rule
//     yields an undetermined interpretation while the raw values stay visible.
//   - Activity gauges establish that service objects exist, not that every
//     required operation is functioning.
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
	switch {
	case summary.Degraded > 0:
		return LayerEvidence{
			State:        StateDegraded,
			EvidenceKind: EvidenceMetric,
			Reason:       ReasonServiceFailuresObserved,
			Measured:     true,
		}
	case summary.Confirmed > 0:
		return LayerEvidence{
			State:        StateHealthy,
			EvidenceKind: EvidenceMetric,
			Reason:       ReasonServiceHealthConfirmed,
			Measured:     true,
		}
	case summary.ActivityObserved > 0:
		// Activity is genuine service-category evidence, but it is not proof of
		// complete service correctness.
		return LayerEvidence{
			State:        StateUnknown,
			EvidenceKind: EvidenceMetric,
			Reason:       ReasonActivityObserved,
			Measured:     true,
		}
	default:
		return LayerEvidence{
			State:        StateUnknown,
			EvidenceKind: EvidenceMetric,
			Reason:       ReasonServiceHealthUndetermined,
			Measured:     true,
		}
	}
}

// SummarizeServiceEvidence applies the registered health rules to one set of
// samples.
//
// Cumulative counters (request/success pairs and failure counters) require
// verified interval evidence: two valid observations of the same series with a
// consistent exporter identity, increasing timestamps, no unsupported counter
// reset and compatible numerator/denominator semantics. That interval evaluator
// is not implemented, so those rules report outcomeIntervalRequired instead of
// manufacturing a current outcome from historical totals.
func SummarizeServiceEvidence(samples []MetricSample) ServiceEvidenceSummary {
	summary := ServiceEvidenceSummary{}
	scopes := map[string]map[string]seriesObservation{}

	for _, sample := range samples {
		if sample.Category == CategoryService {
			summary.ServiceSamples++
		} else {
			summary.ResourceSamples++
		}
		familyScopes := scopes[sample.Key]
		if familyScopes == nil {
			familyScopes = map[string]seriesObservation{}
			scopes[sample.Key] = familyScopes
		}
		scope := seriesScope(sample)
		observation := familyScopes[scope]
		observation.Count++
		if observation.Count == 1 {
			observation.Value = sample.Value
		}
		familyScopes[scope] = observation
	}

	for _, sample := range samples {
		def, ok := LookupMetric(sample.Key)
		if !ok || def.Category != CategoryService {
			continue
		}
		outcome := evaluateHealthRule(def, sample, scopes)
		if outcome == outcomeNone && def.HealthRule == HealthRuleSuccessRatioPair {
			// The pair could not be verified as scope-equivalent.
			summary.AmbiguousScopes++
		}
		switch outcome {
		case outcomeConfirmed:
			summary.Confirmed++
		case outcomeDegraded:
			summary.Degraded++
		case outcomeActivityObserved:
			summary.ActivityObserved++
		case outcomeIntervalRequired:
			summary.IntervalRequired++
		default:
			summary.Undetermined++
		}
	}
	return summary
}

// seriesObservation records one sanitized series scope: its first value and how
// many samples collapsed into that scope.
//
// A count greater than one means the stored (sanitized) labels cannot
// distinguish the underlying series, so the scope is not a verified identity and
// must never be used for pairing.
type seriesObservation struct {
	Value float64
	Count int
}

// evaluateHealthRule applies one registered rule to one sample.
//
// Series scope discipline: a rule that compares two families is only evaluated
// when both families expose exactly one verified series (one sanitized scope
// carrying exactly one sample) and both carry the same scope signature.
// Otherwise the comparison is skipped instead of pairing values from different
// scopes.
func evaluateHealthRule(def MetricDefinition, sample MetricSample, scopes map[string]map[string]seriesObservation) ruleOutcome {
	switch def.HealthRule {
	case HealthRuleSuccessRatioPair:
		if !seriesScopesEquivalent(scopes, def.HealthPair, sample.Key) {
			return outcomeNone
		}
		// Both series are comparable, but cumulative totals still cannot
		// establish the current window's outcome.
		return outcomeIntervalRequired
	case HealthRuleFailureCounterZero:
		// A historical failure total (zero or not) is not a current-window
		// observation.
		return outcomeIntervalRequired
	case HealthRuleActivityGauge:
		if sample.Value > 0 {
			return outcomeActivityObserved
		}
		return outcomeNone
	default:
		return outcomeNone
	}
}

// seriesScopesEquivalent reports whether two families expose exactly one
// verified series each and those series share the same sanitized scope
// signature.
//
// Removing sensitive labels from stored evidence must never cause unrelated
// measurements to be combined: when the scope cannot be verified as equivalent
// (multiple scopes, or several samples collapsed into one sanitized scope), the
// paired interpretation is disabled and the raw measurements are retained.
func seriesScopesEquivalent(scopes map[string]map[string]seriesObservation, leftFamily, rightFamily string) bool {
	left, ok := scopes[leftFamily]
	if !ok || len(left) != 1 {
		return false
	}
	right, ok := scopes[rightFamily]
	if !ok || len(right) != 1 {
		return false
	}
	for leftScope, leftObs := range left {
		if leftObs.Count != 1 {
			return false
		}
		for rightScope, rightObs := range right {
			if rightObs.Count != 1 {
				return false
			}
			return leftScope == rightScope
		}
	}
	return false
}

// seriesScope returns a deterministic, order-independent, privacy-safe
// signature of a series' sanitized labels. Only labels that survived
// sanitization are considered; sensitive labels are never persisted or matched.
func seriesScope(sample MetricSample) string {
	if len(sample.Labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(sample.Labels))
	for key := range sample.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(sample.Labels[key])
		b.WriteByte(';')
	}
	return b.String()
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
