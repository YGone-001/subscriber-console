package nfhealth

import (
	"strings"

	"subscriber/internal/inventory"
)

// Metric categories. A resource metric describes the exporter process itself;
// a service metric is an NF-domain measurement. Only service-category evidence
// may contribute to L3 service health.
const (
	CategoryResource = "resource"
	CategoryService  = "service"
)

// Health rules. These are explicit, evidence-backed interpretation rules; a
// metric without a rule contributes measured evidence but never a health claim.
const (
	// HealthRuleNone: resource metrics and families without a defensible
	// service-health interpretation.
	HealthRuleNone = "none"
	// HealthRuleFailureCounterZero: a registered failure/error counter. Zero (or
	// absent) means no failure was observed; a positive value is observed
	// failure evidence.
	HealthRuleFailureCounterZero = "failure_counter_zero"
	// HealthRuleSuccessRatioPair: a success counter paired with its request
	// counter on the same event population. Equality with a non-zero request
	// count is positive evidence; a shortfall is degraded evidence; a zero
	// request count yields no evidence.
	HealthRuleSuccessRatioPair = "success_ratio_pair"
	// HealthRuleActivityGauge: a gauge counting currently active service
	// objects. A positive value is evidence of live service activity; zero
	// yields no evidence (it may mean idle traffic or a failure).
	HealthRuleActivityGauge = "activity_gauge"
)

// Verification classes for the capability audit.
const (
	EvidenceLiveVerified   = "live_verified"
	EvidenceSourceVerified = "source_verified"
	EvidenceFixtureTested  = "fixture_tested"
	EvidenceNotVerified    = "not_verified"
	EvidenceNotExported    = "not_exported"
)

// MetricDefinition is one server-owned supported metric family.
type MetricDefinition struct {
	Name string `json:"name"`
	// Domain is the canonical Inventory network domain the family belongs to,
	// or "*" for generic resource metrics that apply to every target.
	Domain string `json:"domain"`
	// NFTypes lists the NF types permitted to emit the family, or "*".
	NFTypes []string `json:"nfTypes"`
	// Category is resource or service.
	Category string `json:"category"`
	Type     string `json:"type"` // counter | gauge
	Unit     string `json:"unit"`
	// Description is the exporter-declared meaning of the family.
	Description string `json:"description"`
	// SafeLabels documents which labels may survive sanitization.
	SafeLabels []string `json:"safeLabels"`
	// Interpretation is the server-owned reading of the value.
	Interpretation string `json:"interpretation"`
	// Source identifies the exporter implementation that declares the family.
	Source string `json:"source"`
	// Evidence is the verification class for this family.
	Evidence string `json:"evidence"`
	// HealthRule is the explicit interpretation rule used for L3 evidence.
	HealthRule string `json:"healthRule"`
	// HealthPair names the paired request counter for success_ratio_pair.
	HealthPair string `json:"healthPair,omitempty"`
	// NonNegative marks count-like families whose values must never be
	// negative. Observed counter/gauge corruption (for example a negative
	// session count) is rejected instead of being persisted as evidence.
	NonNegative bool `json:"nonNegative"`
}

// exporterIdentity is deliberately vendor-neutral: the registry records that a
// family was verified against the deployed NF metrics exporter implementation
// without embedding a product name. The concrete exporter is identified in the
// architecture documentation, not in the server-owned contract.
const exporterIdentity = "nf_metrics_exporter"

// resourceMetric builds a generic exporter-process metric definition.
func resourceMetric(name, typ, unit, description, interpretation string, nonNegative bool) MetricDefinition {
	return MetricDefinition{
		Name: name, Domain: "*", NFTypes: []string{"*"}, Category: CategoryResource,
		Type: typ, Unit: unit, Description: description, Interpretation: interpretation,
		Source: exporterIdentity, Evidence: EvidenceLiveVerified,
		HealthRule: HealthRuleNone, NonNegative: nonNegative,
	}
}

// serviceMetric builds an NF-domain service metric definition.
func serviceMetric(name, domain string, nfTypes []string, typ, unit, description, interpretation, rule, pair string, nonNegative bool) MetricDefinition {
	return MetricDefinition{
		Name: name, Domain: domain, NFTypes: nfTypes, Category: CategoryService,
		Type: typ, Unit: unit, Description: description, Interpretation: interpretation,
		Source: exporterIdentity, Evidence: EvidenceLiveVerified,
		HealthRule: rule, HealthPair: pair, NonNegative: nonNegative,
	}
}

// supportedMetrics is the server-owned registry. The registry is deliberately
// conservative: only families verified against the deployed exporter (and, for
// charging, against the exporter implementation) are listed. Unlisted families
// are dropped and never zero-filled.
//
// Domains reuse the canonical Inventory vocabulary (epc, 5gc, ims, charging).
var supportedMetrics = buildSupportedMetrics()

func buildSupportedMetrics() []MetricDefinition {
	out := make([]MetricDefinition, 0, 160)

	// Generic exporter-process metrics: resource evidence only, never a
	// service-health claim.
	out = append(out,
		resourceMetric("process_resident_memory_bytes", "gauge", "bytes",
			"Resident memory size of the exporter process", "resource_usage", true),
		resourceMetric("process_cpu_seconds_total", "counter", "seconds",
			"Total user and system CPU time spent by the exporter process", "resource_usage", true),
		resourceMetric("process_start_time_seconds", "gauge", "seconds",
			"Start time of the exporter process since the Unix epoch", "resource_usage", true),
		resourceMetric("process_open_fds", "gauge", "count",
			"Number of open file descriptors held by the exporter process", "resource_usage", true),
		resourceMetric("process_max_fds", "gauge", "count",
			"Maximum number of open file descriptors available to the exporter process", "resource_usage", true),
		resourceMetric("process_virtual_memory_bytes", "gauge", "bytes",
			"Virtual memory size of the exporter process", "resource_usage", true),
		resourceMetric("process_virtual_memory_max_bytes", "gauge", "bytes",
			"Maximum virtual memory available to the exporter process (-1 means unlimited)", "resource_usage", false),
	)

	out = append(out, amfMetrics()...)
	out = append(out, smfMetrics()...)
	out = append(out, upfMetrics()...)
	out = append(out, pcfMetrics()...)
	out = append(out, mmeMetrics()...)
	out = append(out, hssMetrics()...)
	out = append(out, pcrfMetrics()...)
	out = append(out, ocsMetrics()...)

	return out
}

// amfMetrics covers the 5GC access and mobility management function.
func amfMetrics() []MetricDefinition {
	amf := []string{NFTypeAMF}
	return []MetricDefinition{
		serviceMetric("gnb", inventory.Domain5GC, amf, "gauge", "count",
			"gNodeBs", "access_node_connectivity", HealthRuleActivityGauge, "", true),
		serviceMetric("amf_session", inventory.Domain5GC, amf, "gauge", "count",
			"AMF Sessions", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("ran_ue", inventory.Domain5GC, amf, "gauge", "count",
			"RAN UEs", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("fivegs_amffunction_rm_registeredsubnbr", inventory.Domain5GC, amf, "gauge", "count",
			"Number of registered subscribers currently tracked by the access management function",
			"registration_count", HealthRuleActivityGauge, "", true),
		serviceMetric("fivegs_amffunction_rm_reginitreq", inventory.Domain5GC, amf, "counter", "count",
			"Number of initial registration requests received by the AMF",
			"registration_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_amffunction_rm_reginitsucc", inventory.Domain5GC, amf, "counter", "count",
			"Number of successful initial registrations at the AMF",
			"registration_counter", HealthRuleSuccessRatioPair, "fivegs_amffunction_rm_reginitreq", true),
		serviceMetric("fivegs_amffunction_rm_reginitfail", inventory.Domain5GC, amf, "counter", "count",
			"Number of failed initial registrations at the AMF",
			"registration_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_amffunction_rm_regmobreq", inventory.Domain5GC, amf, "counter", "count",
			"Number of mobility registration update requests received by the AMF",
			"registration_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_amffunction_rm_regmobsucc", inventory.Domain5GC, amf, "counter", "count",
			"Number of successful mobility registration updates at the AMF",
			"registration_counter", HealthRuleSuccessRatioPair, "fivegs_amffunction_rm_regmobreq", true),
		serviceMetric("fivegs_amffunction_rm_regmobfail", inventory.Domain5GC, amf, "counter", "count",
			"Number of failed mobility registration updates at the AMF",
			"registration_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_amffunction_rm_regperiodreq", inventory.Domain5GC, amf, "counter", "count",
			"Number of periodic registration update requests received by the AMF",
			"registration_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_amffunction_rm_regperiodsucc", inventory.Domain5GC, amf, "counter", "count",
			"Number of successful periodic registration updates at the AMF",
			"registration_counter", HealthRuleSuccessRatioPair, "fivegs_amffunction_rm_regperiodreq", true),
		serviceMetric("fivegs_amffunction_rm_regperiodfail", inventory.Domain5GC, amf, "counter", "count",
			"Number of failed periodic registration updates at the AMF",
			"registration_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_amffunction_rm_regemergreq", inventory.Domain5GC, amf, "counter", "count",
			"Number of emergency registration requests received by the AMF",
			"registration_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_amffunction_rm_regemergsucc", inventory.Domain5GC, amf, "counter", "count",
			"Number of successful emergency registrations at the AMF",
			"registration_counter", HealthRuleSuccessRatioPair, "fivegs_amffunction_rm_regemergreq", true),
		serviceMetric("fivegs_amffunction_rm_regemergfail", inventory.Domain5GC, amf, "counter", "count",
			"Number of failed emergency registrations at the AMF",
			"registration_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_amffunction_amf_authreq", inventory.Domain5GC, amf, "counter", "count",
			"Number of authentication requests sent by the AMF",
			"authentication_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_amffunction_amf_authreject", inventory.Domain5GC, amf, "counter", "count",
			"Number of authentication rejections sent by the AMF",
			"authentication_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_amffunction_amf_authfail", inventory.Domain5GC, amf, "counter", "count",
			"Number of authentication failures observed by the AMF",
			"authentication_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_amffunction_mm_paging5greq", inventory.Domain5GC, amf, "counter", "count",
			"Number of 5G paging procedures initiated at the AMF",
			"paging_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_amffunction_mm_paging5gsucc", inventory.Domain5GC, amf, "counter", "count",
			"Number of successful 5G paging procedures initiated at the AMF",
			"paging_counter", HealthRuleSuccessRatioPair, "fivegs_amffunction_mm_paging5greq", true),
		serviceMetric("fivegs_amffunction_mm_confupdate", inventory.Domain5GC, amf, "counter", "count",
			"Number of UE Configuration Update commands requested by the AMF",
			"configuration_update_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_amffunction_mm_confupdatesucc", inventory.Domain5GC, amf, "counter", "count",
			"Number of UE Configuration Update complete messages received by the AMF",
			"configuration_update_counter", HealthRuleSuccessRatioPair, "fivegs_amffunction_mm_confupdate", true),
	}
}

// smfMetrics covers the 5GC session management function.
func smfMetrics() []MetricDefinition {
	smf := []string{NFTypeSMF}
	return []MetricDefinition{
		serviceMetric("ues_active", inventory.Domain5GC, smf, "gauge", "count",
			"Active User Equipments", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("bearers_active", inventory.Domain5GC, smf, "gauge", "count",
			"Active Bearers", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("pfcp_sessions_active", inventory.Domain5GC, []string{NFTypeSMF, NFTypeUPF}, "gauge", "count",
			"Active PFCP Sessions", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("pfcp_peers_active", inventory.Domain5GC, []string{NFTypeSMF, NFTypeUPF}, "gauge", "count",
			"Active PFCP peers", "peer_count", HealthRuleActivityGauge, "", true),
		serviceMetric("gtp2_sessions_active", inventory.Domain5GC, smf, "gauge", "count",
			"Active GTPv2 Sessions (PGW)", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("fivegs_smffunction_sm_sessionnbr", inventory.Domain5GC, smf, "gauge", "count",
			"Number of sessions currently tracked by the session management function",
			"session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("fivegs_smffunction_sm_pdusessioncreationreq", inventory.Domain5GC, smf, "counter", "count",
			"Packet data unit session creation requests received by the session management function",
			"session_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_smffunction_sm_pdusessioncreationsucc", inventory.Domain5GC, smf, "counter", "count",
			"Successful packet data unit session creations at the session management function",
			"session_counter", HealthRuleSuccessRatioPair, "fivegs_smffunction_sm_pdusessioncreationreq", true),
		serviceMetric("fivegs_smffunction_sm_pdusessioncreationfail", inventory.Domain5GC, smf, "counter", "count",
			"Failed packet data unit session creations at the session management function",
			"session_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_smffunction_sm_n4sessionestabreq", inventory.Domain5GC, smf, "counter", "count",
			"Number of requested N4 session establishments evidented by SMF",
			"session_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_smffunction_sm_n4sessionestabfail", inventory.Domain5GC, smf, "counter", "count",
			"Number of failed N4 session establishments evidented by SMF",
			"session_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_smffunction_sm_n4sessionreport", inventory.Domain5GC, smf, "counter", "count",
			"Number of requested N4 session reports evidented by SMF",
			"session_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_smffunction_sm_n4sessionreportsucc", inventory.Domain5GC, smf, "counter", "count",
			"Number of successful N4 session reports evidented by SMF",
			"session_counter", HealthRuleSuccessRatioPair, "fivegs_smffunction_sm_n4sessionreport", true),
	}
}

// upfMetrics covers the 5GC user plane function.
func upfMetrics() []MetricDefinition {
	upf := []string{NFTypeUPF}
	return []MetricDefinition{
		serviceMetric("fivegs_upffunction_upf_sessionnbr", inventory.Domain5GC, upf, "gauge", "count",
			"Active Sessions", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("fivegs_upffunction_upf_qosflows", inventory.Domain5GC, upf, "gauge", "count",
			"Number of quality-of-service flows currently tracked by the user plane function",
			"session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("fivegs_ep_n3_gtp_indatapktn3upf", inventory.Domain5GC, upf, "counter", "count",
			"Number of incoming GTP data packets on the N3 interface",
			"traffic_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_ep_n3_gtp_outdatapktn3upf", inventory.Domain5GC, upf, "counter", "count",
			"Number of outgoing GTP data packets on the N3 interface",
			"traffic_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_upffunction_sm_n4sessionestabreq", inventory.Domain5GC, upf, "counter", "count",
			"Number of requested N4 session establishments",
			"session_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_upffunction_sm_n4sessionestabfail", inventory.Domain5GC, upf, "counter", "count",
			"Number of failed N4 session establishments",
			"session_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("fivegs_upffunction_sm_n4sessionreport", inventory.Domain5GC, upf, "counter", "count",
			"Number of requested N4 session reports",
			"session_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_upffunction_sm_n4sessionreportsucc", inventory.Domain5GC, upf, "counter", "count",
			"Number of successful N4 session reports",
			"session_counter", HealthRuleSuccessRatioPair, "fivegs_upffunction_sm_n4sessionreport", true),
	}
}

// pcfMetrics covers the 5GC policy control function. The deployed exporter
// registers these families with metadata but no sample values until policy
// associations exist; an absent value stays unmeasured.
func pcfMetrics() []MetricDefinition {
	pcf := []string{NFTypePCF}
	return []MetricDefinition{
		serviceMetric("fivegs_pcffunction_pa_policyamassoreq", inventory.Domain5GC, pcf, "counter", "count",
			"Number of AM policy association requests", "policy_association_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_pcffunction_pa_policyamassosucc", inventory.Domain5GC, pcf, "counter", "count",
			"Number of successful AM policy associations", "policy_association_counter",
			HealthRuleSuccessRatioPair, "fivegs_pcffunction_pa_policyamassoreq", true),
		serviceMetric("fivegs_pcffunction_pa_policysmassoreq", inventory.Domain5GC, pcf, "counter", "count",
			"Number of SM policy association requests", "policy_association_counter", HealthRuleNone, "", true),
		serviceMetric("fivegs_pcffunction_pa_policysmassosucc", inventory.Domain5GC, pcf, "counter", "count",
			"Number of successful SM policy associations", "policy_association_counter",
			HealthRuleSuccessRatioPair, "fivegs_pcffunction_pa_policysmassoreq", true),
		serviceMetric("fivegs_pcffunction_pa_sessionnbr", inventory.Domain5GC, pcf, "gauge", "count",
			"Active Sessions", "session_count", HealthRuleActivityGauge, "", true),
	}
}

// mmeMetrics covers the EPC mobility management entity.
func mmeMetrics() []MetricDefinition {
	mme := []string{NFTypeMME}
	return []MetricDefinition{
		serviceMetric("mme_session", inventory.DomainEPC, mme, "gauge", "count",
			"MME Sessions", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("enb_ue", inventory.DomainEPC, mme, "gauge", "count",
			"Number of UEs connected to eNodeBs", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("enb", inventory.DomainEPC, mme, "gauge", "count",
			"eNodeBs", "access_node_connectivity", HealthRuleActivityGauge, "", true),
	}
}

// hssMetrics covers the EPC home subscriber server. Diameter counters are
// grouped by interface; every entry is live-verified against the deployed HSS
// exporter and source-verified against src/hss/metrics.c.
func hssMetrics() []MetricDefinition {
	hss := []string{NFTypeHSS}
	out := []MetricDefinition{
		serviceMetric("hss_imsi", inventory.DomainEPC, hss, "gauge", "count",
			"Number of IMSIs attached to HSS", "subscriber_aggregate_count", HealthRuleActivityGauge, "", true),
		serviceMetric("hss_impi", inventory.DomainEPC, hss, "gauge", "count",
			"Number of IMPIs attached to HSS", "subscriber_aggregate_count", HealthRuleActivityGauge, "", true),
		serviceMetric("hss_impu", inventory.DomainEPC, hss, "gauge", "count",
			"Number of IMPUs attached to HSS", "subscriber_aggregate_count", HealthRuleActivityGauge, "", true),
	}

	// Diameter request counters: request/response pairs plus explicit failures.
	type diameterCounter struct {
		name    string
		iface   string
		meaning string
		failure bool
	}
	counters := []diameterCounter{
		// S6a — EPC subscriber authentication and mobility management.
		{"s6a_rx_ulr", "S6a", "Update-Location requests received", false},
		{"s6a_rx_ulr_error", "S6a", "Update-Location requests failed", true},
		{"s6a_tx_ula", "S6a", "Update-Location answers transmitted", false},
		{"s6a_rx_air", "S6a", "Authentication-Information requests received", false},
		{"s6a_rx_air_error", "S6a", "Authentication-Information requests failed", true},
		{"s6a_tx_aia", "S6a", "Authentication-Information answers transmitted", false},
		{"s6a_rx_cla", "S6a", "Cancel-Location requests received", false},
		{"s6a_rx_cla_error", "S6a", "Cancel-Location requests failed", true},
		{"s6a_tx_clr", "S6a", "Cancel-Location answers transmitted", false},
		{"s6a_rx_idr", "S6a", "Insert-Subscriber-Data requests received", false},
		{"s6a_rx_ida", "S6a", "Insert-Subscriber-Data answers received", false},
		{"s6a_rx_ida_error", "S6a", "Insert-Subscriber-Data answers failed", true},
		{"s6a_tx_idr", "S6a", "Insert-Subscriber-Data requests transmitted", false},
		{"s6a_rx_pur", "S6a", "Purge-UE requests received", false},
		{"s6a_rx_pur_error", "S6a", "Purge-UE requests failed", true},
		{"s6a_tx_pua", "S6a", "Purge-UE answers transmitted", false},
		{"s6a_rx_unknown", "S6a", "Unknown S6a messages received", true},
		// Cx — IMS subscriber registration and authentication.
		{"cx_rx_mar", "Cx", "Multimedia-Authentication requests received", false},
		{"cx_rx_mar_error", "Cx", "Multimedia-Authentication requests failed", true},
		{"cx_tx_maa", "Cx", "Multimedia-Authentication answers transmitted", false},
		{"cx_rx_sar", "Cx", "Server-Assignment requests received", false},
		{"cx_rx_sar_error", "Cx", "Server-Assignment requests failed", true},
		{"cx_tx_saa", "Cx", "Server-Assignment answers transmitted", false},
		{"cx_rx_uar", "Cx", "User-Authorization requests received", false},
		{"cx_rx_uar_error", "Cx", "User-Authorization requests failed", true},
		{"cx_tx_uaa", "Cx", "User-Authorization answers transmitted", false},
		{"cx_rx_lir", "Cx", "Location-Info requests received", false},
		{"cx_rx_lir_error", "Cx", "Location-Info requests failed", true},
		{"cx_tx_lia", "Cx", "Location-Info answers transmitted", false},
		{"cx_rx_unknown", "Cx", "Unknown Cx messages received", true},
		// SWx — non-3GPP authentication.
		{"swx_rx_mar", "SWx", "Multimedia-Authentication requests received", false},
		{"swx_rx_mar_error", "SWx", "Multimedia-Authentication requests failed", true},
		{"swx_tx_maa", "SWx", "Multimedia-Authentication answers transmitted", false},
		{"swx_rx_sar", "SWx", "Server-Assignment requests received", false},
		{"swx_rx_sar_error", "SWx", "Server-Assignment requests failed", true},
		{"swx_tx_saa", "SWx", "Server-Assignment answers transmitted", false},
		{"swx_rx_unknown", "SWx", "Unknown SWx messages received", true},
	}

	for _, counter := range counters {
		rule, interp := HealthRuleNone, "diameter_request_counter"
		if counter.failure {
			rule, interp = HealthRuleFailureCounterZero, "diameter_failure_counter"
		}
		out = append(out, serviceMetric(counter.name, inventory.DomainEPC, hss, "counter", "count",
			counter.iface+" Diameter: "+counter.meaning, interp, rule, "", true))
	}
	return out
}

// pcrfMetrics covers the EPC policy and charging rules function.
func pcrfMetrics() []MetricDefinition {
	pcrf := []string{NFTypePCRF}
	return []MetricDefinition{
		serviceMetric("gx_rx_ccr", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Gx CCR messages", "policy_request_counter", HealthRuleNone, "", true),
		serviceMetric("gx_rx_ccr_error", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Gx CCR messages failed", "policy_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("gx_tx_cca", inventory.DomainEPC, pcrf, "counter", "count",
			"Transmitted Gx CCA messages", "policy_response_counter", HealthRuleNone, "", true),
		serviceMetric("gx_rx_raa", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Gx RAA messages", "policy_response_counter", HealthRuleNone, "", true),
		serviceMetric("gx_tx_rar", inventory.DomainEPC, pcrf, "counter", "count",
			"Transmitted Gx RAR messages", "policy_request_counter", HealthRuleNone, "", true),
		serviceMetric("gx_tx_rar_error", inventory.DomainEPC, pcrf, "counter", "count",
			"Failed to transmit Gx RAR messages", "policy_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("gx_rx_unknown", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Gx unknown messages", "policy_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("rx_rx_aar", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Rx AAR messages", "policy_request_counter", HealthRuleNone, "", true),
		serviceMetric("rx_rx_aar_error", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Rx AAR messages failed", "policy_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("rx_tx_aaa", inventory.DomainEPC, pcrf, "counter", "count",
			"Transmitted Rx AAA messages", "policy_response_counter", HealthRuleNone, "", true),
		serviceMetric("rx_rx_asa", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Rx ASA messages", "policy_response_counter", HealthRuleNone, "", true),
		serviceMetric("rx_rx_asa_error", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Rx ASA messages failed", "policy_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("rx_tx_sar", inventory.DomainEPC, pcrf, "counter", "count",
			"Transmitted Rx SAR messages", "policy_request_counter", HealthRuleNone, "", true),
		serviceMetric("rx_tx_sta", inventory.DomainEPC, pcrf, "counter", "count",
			"Transmitted Rx STA messages", "policy_request_counter", HealthRuleNone, "", true),
		serviceMetric("rx_rx_str_error", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Rx STR messages failed", "policy_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("rx_rx_unknown", inventory.DomainEPC, pcrf, "counter", "count",
			"Received Rx unknown messages", "policy_failure_counter", HealthRuleFailureCounterZero, "", true),
	}
}

// ocsMetrics covers the shared charging domain online charging system.
//
// Evidence: the OCS exporter implementation declares these families
// (source_verified). The reference deployment does not enable the OCS metrics
// listener, so no family is live-verified and none is claimed as delivered
// service KPI monitoring.
func ocsMetrics() []MetricDefinition {
	ocs := []string{NFTypeOCS}
	defs := []MetricDefinition{
		serviceMetric("ocs_sessions_active", inventory.DomainCharging, ocs, "gauge", "count",
			"Number of active OCS sessions", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("ocs_reservations_active", inventory.DomainCharging, ocs, "gauge", "count",
			"Number of active OCS quota reservations", "reservation_count", HealthRuleActivityGauge, "", true),
		serviceMetric("ocs_subscribers_active", inventory.DomainCharging, ocs, "gauge", "count",
			"Number of active OCS subscribers", "subscriber_aggregate_count", HealthRuleActivityGauge, "", true),
		serviceMetric("ocs_ro_sessions_active", inventory.DomainCharging, ocs, "gauge", "count",
			"Number of active Ro sessions", "session_count", HealthRuleActivityGauge, "", true),
		serviceMetric("ocs_ro_reservations_active", inventory.DomainCharging, ocs, "gauge", "count",
			"Number of active Ro reservations", "reservation_count", HealthRuleActivityGauge, "", true),
		serviceMetric("ocs_ccr_initial_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total CCR-Initial requests received", "charging_request_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_ccr_update_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total CCR-Update requests received", "charging_request_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_ccr_terminate_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total CCR-Terminate requests received", "charging_request_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_ro_ccr_initial_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total Ro CCR-Initial requests received", "charging_request_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_ro_ccr_update_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total Ro CCR-Update requests received", "charging_request_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_ro_ccr_terminate_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total Ro CCR-Terminate requests received", "charging_request_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_fui_returned_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total Final-Unit-Indication returned", "charging_outcome_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_ro_fui_returned_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total Ro Final-Unit-Indication returned", "charging_outcome_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_ro_credit_limit_reached_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total Ro credit limit rejections", "charging_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("ocs_idempotent_replay_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total idempotent CCA replays", "charging_outcome_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_reconciliation_runs_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total reconciliation scans performed", "reconciliation_counter", HealthRuleNone, "", true),
		serviceMetric("ocs_reconciliation_anomalies_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total anomalies detected by reconciliation", "reconciliation_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("ocs_reconciliation_critical_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total CRITICAL anomalies detected", "reconciliation_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("ocs_reconciliation_error_total", inventory.DomainCharging, ocs, "counter", "count",
			"Total ERROR anomalies detected", "reconciliation_failure_counter", HealthRuleFailureCounterZero, "", true),
		serviceMetric("ocs_reconciliation_open_anomalies", inventory.DomainCharging, ocs, "gauge", "count",
			"Current number of open reconciliation anomalies", "reconciliation_gauge", HealthRuleNone, "", true),
		serviceMetric("ocs_reconciliation_global_scan_duration_seconds", inventory.DomainCharging, ocs, "gauge", "seconds",
			"Duration of the last global reconciliation scan in seconds", "processing_latency_gauge", HealthRuleNone, "", true),
	}
	for i := range defs {
		// Source-verified only: the reference deployment does not enable the
		// OCS metrics listener.
		defs[i].Evidence = EvidenceSourceVerified
	}
	return defs
}

// registryIndex maps metric name to definition.
var registryIndex = map[string]MetricDefinition{}

func init() {
	for _, def := range supportedMetrics {
		registryIndex[def.Name] = def
	}
}

// SupportedMetrics returns the server-owned registry contents.
func SupportedMetrics() []MetricDefinition {
	out := make([]MetricDefinition, len(supportedMetrics))
	copy(out, supportedMetrics)
	return out
}

// LookupMetric resolves a metric family name against the registry.
func LookupMetric(name string) (MetricDefinition, bool) {
	def, ok := registryIndex[name]
	return def, ok
}

// LookupMetricForNFType resolves a metric family for an identity-resolved
// target NF type.
//
// Rules:
//   - generic resource families (wildcard domain and nfTypes) remain permitted
//     for every target;
//   - an empty nfType denotes a legacy target without an authoritative NF type;
//     registry families stay permitted without inventing type-specific
//     attribution;
//   - otherwise the family must explicitly permit the normalized target NF
//     type. A foreign NF's metric is never relabelled as belonging to the
//     selected Inventory resource.
func LookupMetricForNFType(name, nfType string) (MetricDefinition, bool) {
	return LookupMetricForTarget(name, "", nfType)
}

// LookupMetricForTarget resolves a metric family for an identity-resolved
// target, enforcing both the canonical network domain and the NF type.
//
// A metric is accepted only when its registered domain is compatible with the
// monitored Inventory resource domain and its registered NF type set permits
// the resource NF type. Domain and NF type are never derived from the metric
// itself (for example from an nfType label).
func LookupMetricForTarget(name, domain, nfType string) (MetricDefinition, bool) {
	def, ok := registryIndex[name]
	if !ok {
		return MetricDefinition{}, false
	}
	generic := false
	for _, permitted := range def.NFTypes {
		if permitted == "*" {
			generic = true
			break
		}
	}
	// The domain must always be compatible, including for generic families.
	if !domainCompatible(def.Domain, domain) {
		return MetricDefinition{}, false
	}
	if generic {
		return def, true
	}
	if normalizeNFToken(nfType) == "" {
		return def, true
	}
	for _, permitted := range def.NFTypes {
		if normalizeNFToken(permitted) == normalizeNFToken(nfType) {
			return def, true
		}
	}
	return MetricDefinition{}, false
}

// domainCompatible reports whether a registry domain admits a target domain.
// An unknown target domain (legacy target) keeps registry compatibility without
// inventing domain attribution.
func domainCompatible(registered, target string) bool {
	if registered == "*" {
		return true
	}
	target = strings.TrimSpace(target)
	if target == "" {
		return true
	}
	return registered == target
}

// safeLabelNames is the server-owned allowlist of label keys that may survive
// parsing. Identity and session-specific labels are dropped.
var safeLabelNames = map[string]struct{}{
	"nf":       {},
	"nftype":   {},
	"nf_type":  {},
	"function": {},
	"instance": {},
}

// sensitiveLabelFragments identifies label keys that must never be stored.
var sensitiveLabelFragments = []string{
	"imsi", "supi", "msisdn", "imei", "impu", "impi", "su",
	"auth", "token", "secret", "password", "key",
	"session", "sess", "ue", "peer_addr", "addr", "ip",
	"plmn", "snssai", "tac", "cell", "enodeb", "gnb_id",
}

// IsSafeLabel reports whether a label key may be persisted and exposed.
func IsSafeLabel(key string) bool {
	k := strings.ToLower(strings.TrimSpace(key))
	if k == "" {
		return false
	}
	if _, ok := safeLabelNames[k]; ok {
		return true
	}
	for _, frag := range sensitiveLabelFragments {
		if strings.Contains(k, frag) {
			return false
		}
	}
	return false
}

// SanitizeLabels keeps only safe labels with bounded cardinality.
func SanitizeLabels(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := map[string]string{}
	for k, v := range in {
		if !IsSafeLabel(k) {
			continue
		}
		if len(k) > MaxLabelNameLen || len(v) > MaxLabelValueLen {
			continue
		}
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
