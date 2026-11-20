package nfhealth

import (
	"sort"
)

const BusinessRulesVersion = "business-observation-v1"

type RuleSourceReference struct {
	Path string `json:"path"`
	Line int    `json:"line"`
}

// Source review explains counter meaning, not provenance of the running binary.
// No observation in this registry is allowed to change authoritative health.
type BusinessRuleDefinition struct {
	ID                string                `json:"ruleId"`
	Version           string                `json:"version"`
	NFType            string                `json:"nfType"`
	Domain            string                `json:"domain"`
	Kind              string                `json:"kind"`
	Metrics           []string              `json:"metrics"`
	MinimumRequests   int                   `json:"minimumRequests,omitempty"`
	Semantics         string                `json:"semantics"`
	SourceReview      string                `json:"sourceReview"`
	BinaryAttestation string                `json:"binaryAttestation"`
	References        []RuleSourceReference `json:"references"`
	MissingSignals    []string              `json:"missingSignals"`
}

type BusinessRuleMetric struct {
	Metric      string   `json:"metric"`
	LatestValue *float64 `json:"latestValue"`
	Delta       *float64 `json:"delta"`
	Rate        *float64 `json:"rate"`
	Quality     string   `json:"quality"`
	Reason      string   `json:"reason"`
}

type BusinessRuleObservation struct {
	BusinessRuleDefinition
	Scope            string               `json:"scope"`
	Status           string               `json:"status"`
	Reason           string               `json:"reason"`
	Quality          string               `json:"quality"`
	CoveragePercent  float64              `json:"coveragePercent"`
	ValidPoints      int                  `json:"validPoints"`
	ValidIntervals   int                  `json:"validIntervals"`
	MissingMetrics   []string             `json:"missingMetrics"`
	Observed         []BusinessRuleMetric `json:"observed"`
	RequestDelta     *float64             `json:"requestDelta"`
	CompletionDelta  *float64             `json:"completionDelta"`
	Difference       *float64             `json:"difference"`
	CompletionRatio  *float64             `json:"completionRatioPercent"`
	DecisionEligible bool                 `json:"decisionEligible"`
	HealthEffect     string               `json:"healthEffect"`
}

func pairBusinessRule(id, nf, request, completion, semantics string, refs ...RuleSourceReference) BusinessRuleDefinition {
	return BusinessRuleDefinition{ID: id, Version: BusinessRulesVersion, NFType: nf, Domain: "5gc", Kind: "request_completion", Metrics: []string{request, completion},
		MinimumRequests: 100, Semantics: semantics, SourceReview: "source_reviewed", BinaryAttestation: "not_attested", References: refs,
		MissingSignals: []string{"transaction_cohort", "inflight_and_timeout", "running_build_provenance"}}
}

// BusinessRuleDefinitions returns a fresh server-owned registry. The 100-request
// floor only controls descriptive comparison, not a fault threshold or SLO.
func BusinessRuleDefinitions() []BusinessRuleDefinition {
	return []BusinessRuleDefinition{
		pairBusinessRule("smf_n4_report", "SMF", "fivegs_smffunction_sm_n4sessionreport", "fivegs_smffunction_sm_n4sessionreportsucc", "accept_response_sent",
			RuleSourceReference{"src/smf/n4-handler.c", 1641}, RuleSourceReference{"src/smf/n4-handler.c", 1849}),
		pairBusinessRule("upf_n4_report", "UPF", "fivegs_upffunction_sm_n4sessionreport", "fivegs_upffunction_sm_n4sessionreportsucc", "accept_response_received",
			RuleSourceReference{"src/upf/pfcp-path.c", 359}, RuleSourceReference{"src/upf/n4-handler.c", 548}),
		pairBusinessRule("amf_initial_registration", "AMF", "fivegs_amffunction_rm_reginitreq", "fivegs_amffunction_rm_reginitsucc", "registration_request_complete",
			RuleSourceReference{"src/amf/gmm-sm.c", 1685}, RuleSourceReference{"src/amf/gmm-sm.c", 3228}),
		pairBusinessRule("pcf_am_association", "PCF", "fivegs_pcffunction_pa_policyamassoreq", "fivegs_pcffunction_pa_policyamassosucc", "per_slice_association",
			RuleSourceReference{"src/pcf/npcf-handler.c", 189}, RuleSourceReference{"src/pcf/nudr-handler.c", 162}),
		pairBusinessRule("pcf_sm_association", "PCF", "fivegs_pcffunction_pa_policysmassoreq", "fivegs_pcffunction_pa_policysmassosucc", "per_slice_association",
			RuleSourceReference{"src/pcf/npcf-handler.c", 546}, RuleSourceReference{"src/pcf/sbi-path.c", 610}),
		{ID: "mme_activity", Version: BusinessRulesVersion, NFType: "MME", Domain: "epc", Kind: "activity", Metrics: []string{"enb", "enb_ue", "mme_session"},
			Semantics: "occupancy_only", SourceReview: "registry_documented", BinaryAttestation: "not_attested", References: []RuleSourceReference{}, MissingSignals: []string{"attach_outcomes", "running_build_provenance"}},
		{ID: "ocs_ccr_activity", Version: BusinessRulesVersion, NFType: "OCS", Domain: "charging", Kind: "activity", Metrics: []string{"ocs_ccr_initial_total", "ocs_ccr_update_total"},
			Semantics: "charging_activity_only", SourceReview: "registry_documented", BinaryAttestation: "not_attested", References: []RuleSourceReference{}, MissingSignals: []string{"charging_result_classification", "running_build_provenance"}},
		{ID: "ocs_reconciliation", Version: BusinessRulesVersion, NFType: "OCS", Domain: "charging", Kind: "reconciliation",
			Metrics:   []string{"ocs_reconciliation_runs_total", "ocs_reconciliation_anomalies_total", "ocs_reconciliation_error_total", "ocs_reconciliation_critical_total"},
			Semantics: "reconciliation_events", SourceReview: "registry_documented", BinaryAttestation: "not_attested", References: []RuleSourceReference{}, MissingSignals: []string{"scan_completion_and_coverage", "running_build_provenance"}},
	}
}

func EvaluateBusinessRules(target *HealthTarget, window ServiceWindow) []BusinessRuleObservation {
	out := []BusinessRuleObservation{}
	for _, def := range BusinessRuleDefinitions() {
		if def.NFType != target.NFType || def.Domain != target.Domain {
			continue
		}
		scopes := map[string]bool{}
		for _, row := range window.Rows {
			for _, metric := range def.Metrics {
				if row.Metric == metric {
					scopes[row.Scope] = true
				}
			}
		}
		if len(scopes) == 0 {
			scopes["null"] = true
		}
		ordered := make([]string, 0, len(scopes))
		for scope := range scopes {
			ordered = append(ordered, scope)
		}
		sort.Strings(ordered)
		for _, scope := range ordered {
			out = append(out, evaluateBusinessRule(def, scope, window.Rows))
		}
	}
	return out
}

func evaluateBusinessRule(def BusinessRuleDefinition, scope string, rows []ServiceWindowRow) BusinessRuleObservation {
	result := BusinessRuleObservation{BusinessRuleDefinition: def, Scope: scope, Status: "unavailable", Reason: "metric_missing", Quality: "unavailable",
		MissingMetrics: []string{}, Observed: []BusinessRuleMetric{}, HealthEffect: "none"}
	selected := []ServiceWindowRow{}
	for _, metric := range def.Metrics {
		found := false
		for _, row := range rows {
			if row.Metric != metric || row.Scope != scope {
				continue
			}
			found = true
			selected = append(selected, row)
			result.Observed = append(result.Observed, BusinessRuleMetric{Metric: metric, LatestValue: row.LatestValue, Delta: row.Delta, Rate: row.Rate, Quality: row.Quality, Reason: row.Reason})
			break
		}
		if !found {
			result.MissingMetrics = append(result.MissingMetrics, metric)
		}
	}
	if len(result.MissingMetrics) > 0 {
		return result
	}
	result.CoveragePercent = 100
	result.ValidPoints = maxWindowHistory
	result.ValidIntervals = maxWindowHistory
	for _, row := range selected {
		if row.CoveragePercent < result.CoveragePercent {
			result.CoveragePercent = row.CoveragePercent
		}
		if row.Points < result.ValidPoints {
			result.ValidPoints = row.Points
		}
		if row.Intervals < result.ValidIntervals {
			result.ValidIntervals = row.Intervals
		}
	}
	// Choose quality independently of family ordering; all required families
	// must be valid before a descriptive business comparison is permitted.
	for _, quality := range []string{"stale", "unavailable", "insufficient"} {
		for _, row := range selected {
			if row.Quality == quality {
				result.Quality = quality
				result.Reason = row.Reason
				result.Status = quality
				return result
			}
		}
	}
	for _, row := range selected {
		if row.Quality != "ready" {
			result.Reason = "invalid_rule_evidence"
			return result
		}
	}
	result.Quality = "ready"
	if def.Kind == "request_completion" {
		return evaluateBusinessPair(result, selected[0], selected[1])
	}
	if def.Kind == "reconciliation" {
		return evaluateReconciliation(result, selected)
	}
	result.Status = "no_activity"
	result.Reason = "no_activity_observed"
	for _, row := range selected {
		value := row.Delta
		if row.Type == "gauge" {
			value = row.LatestValue
		}
		if value == nil {
			result.Status = "unavailable"
			result.Reason = "invalid_rule_evidence"
			result.Quality = "unavailable"
			return result
		}
		if *value > 0 {
			result.Status = "activity_observed"
			result.Reason = "activity_not_outcome"
		}
	}
	return result
}

func businessIntervalsAligned(left, right ServiceWindowRow) bool {
	if len(left.Evidence) != len(right.Evidence) || len(left.Evidence) == 0 {
		return false
	}
	for i, a := range left.Evidence {
		b := right.Evidence[i]
		if a.FromSampleID != b.FromSampleID || a.ToSampleID != b.ToSampleID || a.Reason != b.Reason {
			return false
		}
	}
	return true
}

func evaluateBusinessPair(result BusinessRuleObservation, request, completion ServiceWindowRow) BusinessRuleObservation {
	if !businessIntervalsAligned(request, completion) || request.Delta == nil || completion.Delta == nil {
		result.Status = "unavailable"
		result.Reason = "pair_intervals_differ"
		result.Quality = "unavailable"
		return result
	}
	result.RequestDelta = request.Delta
	result.CompletionDelta = completion.Delta
	difference := *request.Delta - *completion.Delta
	result.Difference = &difference
	switch {
	case *completion.Delta > *request.Delta:
		result.Status = "boundary_mismatch"
		result.Reason = "completions_exceed_requests"
	case *request.Delta == 0:
		result.Status = "no_traffic"
		result.Reason = "no_requests_observed"
	default:
		ratio := *completion.Delta / *request.Delta * 100
		result.CompletionRatio = &ratio
		switch {
		case *request.Delta < float64(result.MinimumRequests):
			result.Status = "low_volume"
			result.Reason = "below_volume_floor"
		case difference > 0:
			result.Status = "completion_gap"
			result.Reason = "gap_not_failure_count"
		default:
			result.Status = "aligned_counts"
			result.Reason = "aligned_not_service_health"
		}
	}
	return result
}

func evaluateReconciliation(result BusinessRuleObservation, rows []ServiceWindowRow) BusinessRuleObservation {
	for _, row := range rows {
		if row.Delta == nil || !businessIntervalsAligned(rows[0], row) {
			result.Status = "unavailable"
			result.Reason = "pair_intervals_differ"
			result.Quality = "unavailable"
			return result
		}
	}
	hasAnomaly := false
	for _, row := range rows[1:] {
		if *row.Delta > 0 {
			hasAnomaly = true
		}
	}
	switch {
	case hasAnomaly:
		result.Status = "anomaly_observed"
		result.Reason = "anomaly_events_not_health"
	case *rows[0].Delta == 0:
		result.Status = "no_execution"
		result.Reason = "no_scan_observed"
	default:
		result.Status = "no_anomaly_observed"
		result.Reason = "no_new_anomalies_not_scan_success"
	}
	return result
}
