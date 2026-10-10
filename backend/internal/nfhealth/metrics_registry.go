package nfhealth

import "strings"

// MetricDefinition is one server-owned supported metric family.
type MetricDefinition struct {
	Name           string   `json:"name"`
	NFTypes        []string `json:"nfTypes"`
	Type           string   `json:"type"` // counter | gauge
	Unit           string   `json:"unit"`
	Description    string   `json:"description"`
	SafeLabels     []string `json:"safeLabels"`
	Interpretation string   `json:"interpretation"`
}

// Supported metric families. The registry is deliberately conservative: only
// families verified against the deployed exporter are listed. Unlisted families
// are dropped and never zero-filled.
var supportedMetrics = []MetricDefinition{
	{
		Name: "process_resident_memory_bytes", NFTypes: []string{"*"}, Type: "gauge", Unit: "bytes",
		Description: "Resident memory size of the exporter process",
		SafeLabels:  nil, Interpretation: "resource_usage",
	},
	{
		Name: "process_cpu_seconds_total", NFTypes: []string{"*"}, Type: "counter", Unit: "seconds",
		Description: "Total user and system CPU time spent by the exporter process",
		SafeLabels:  nil, Interpretation: "resource_usage",
	},
	{
		Name: "process_start_time_seconds", NFTypes: []string{"*"}, Type: "gauge", Unit: "seconds",
		Description: "Start time of the exporter process since the Unix epoch",
		SafeLabels:  nil, Interpretation: "resource_usage",
	},
	{
		Name: "gnb", NFTypes: []string{"amf"}, Type: "gauge", Unit: "count",
		Description: "Number of connected radio access nodes observed by the access management function",
		SafeLabels:  nil, Interpretation: "access_node_connectivity",
	},
	{
		Name: "amf_session", NFTypes: []string{"amf"}, Type: "gauge", Unit: "count",
		Description: "Number of access-management sessions currently tracked",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "ran_ue", NFTypes: []string{"amf"}, Type: "gauge", Unit: "count",
		Description: "Number of radio access user equipment contexts currently tracked",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "fivegs_amffunction_rm_registeredsubnbr", NFTypes: []string{"amf"}, Type: "gauge", Unit: "count",
		Description: "Number of registered subscribers currently tracked by the access management function",
		SafeLabels:  nil, Interpretation: "registration_count",
	},
	{
		Name: "fivegs_amffunction_rm_reginitreq", NFTypes: []string{"amf"}, Type: "counter", Unit: "count",
		Description: "Initial registration requests received by the access management function",
		SafeLabels:  nil, Interpretation: "registration_counter",
	},
	{
		Name: "fivegs_amffunction_rm_reginitsucc", NFTypes: []string{"amf"}, Type: "counter", Unit: "count",
		Description: "Successful initial registrations completed by the access management function",
		SafeLabels:  nil, Interpretation: "registration_counter",
	},
	{
		Name: "fivegs_amffunction_rm_reginitfail", NFTypes: []string{"amf"}, Type: "counter", Unit: "count",
		Description: "Failed initial registration attempts recorded by the access management function",
		SafeLabels:  nil, Interpretation: "registration_counter",
	},
	{
		Name: "ues_active", NFTypes: []string{"smf"}, Type: "gauge", Unit: "count",
		Description: "Number of active user equipment contexts on the session management function",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "bearers_active", NFTypes: []string{"smf"}, Type: "gauge", Unit: "count",
		Description: "Number of active bearers tracked by the session management function",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "pfcp_sessions_active", NFTypes: []string{"smf", "upf"}, Type: "gauge", Unit: "count",
		Description: "Number of active packet forwarding control protocol sessions",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "pfcp_peers_active", NFTypes: []string{"smf", "upf"}, Type: "gauge", Unit: "count",
		Description: "Number of active packet forwarding control protocol peer associations",
		SafeLabels:  nil, Interpretation: "peer_count",
	},
	{
		Name: "gtp2_sessions_active", NFTypes: []string{"smf"}, Type: "gauge", Unit: "count",
		Description: "Number of active user-plane tunnel sessions tracked by the session management function",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "fivegs_smffunction_sm_sessionnbr", NFTypes: []string{"smf"}, Type: "gauge", Unit: "count",
		Description: "Number of sessions currently tracked by the session management function",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "fivegs_smffunction_sm_pdusessioncreationreq", NFTypes: []string{"smf"}, Type: "counter", Unit: "count",
		Description: "Packet data unit session creation requests received by the session management function",
		SafeLabels:  nil, Interpretation: "session_counter",
	},
	{
		Name: "fivegs_upffunction_upf_sessionnbr", NFTypes: []string{"upf"}, Type: "gauge", Unit: "count",
		Description: "Number of sessions currently tracked by the user plane function",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "fivegs_upffunction_upf_qosflows", NFTypes: []string{"upf"}, Type: "gauge", Unit: "count",
		Description: "Number of quality-of-service flows currently tracked by the user plane function",
		SafeLabels:  nil, Interpretation: "session_count",
	},
	{
		Name: "fivegs_ep_n3_gtp_indatapktn3upf", NFTypes: []string{"upf"}, Type: "counter", Unit: "count",
		Description: "Inbound user-plane data packets received on the user plane function access tunnel",
		SafeLabels:  nil, Interpretation: "traffic_counter",
	},
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
