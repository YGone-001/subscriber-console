package nfhealth

import (
	"testing"
)

// Group E: metric attribution by resolved NF type.
const nfTypeMetricsBody = `# HELP amf_session Access-management sessions currently tracked
# TYPE amf_session gauge
amf_session 12
# HELP pfcp_sessions_active Active PFCP sessions
# TYPE pfcp_sessions_active gauge
pfcp_sessions_active 8
# HELP process_cpu_seconds_total Cumulative process CPU seconds
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total 128.5
# HELP unknown_family_not_registered Unregistered family
# TYPE unknown_family_not_registered gauge
unknown_family_not_registered 42
`

func TestLookupMetricForNFTypeFiltersByPermittedType(t *testing.T) {
	if _, ok := LookupMetricForNFType("amf_session", "AMF"); !ok {
		t.Fatal("amf_session must be permitted for an AMF target")
	}
	if _, ok := LookupMetricForNFType("pfcp_sessions_active", "AMF"); ok {
		t.Fatal("pfcp_sessions_active must not be permitted for an AMF target")
	}
	if _, ok := LookupMetricForNFType("pfcp_sessions_active", "smf"); !ok {
		t.Fatal("pfcp_sessions_active must be permitted for an SMF target")
	}
	if _, ok := LookupMetricForNFType("process_cpu_seconds_total", "P-CSCF"); !ok {
		t.Fatal("generic wildcard families stay permitted for every NF type")
	}
	if _, ok := LookupMetricForNFType("amf_session", ""); !ok {
		t.Fatal("legacy targets without authoritative NF type keep registry compatibility")
	}
	if _, ok := LookupMetricForNFType("amf_session", "SMF"); ok {
		t.Fatal("a foreign NF type must not adopt another NF's metric family")
	}
	if _, ok := LookupMetricForNFType("unknown_family_not_registered", "AMF"); ok {
		t.Fatal("unregistered families are always dropped")
	}
}

func TestParsePrometheusTextFiltersForeignNFFamilies(t *testing.T) {
	out, err := ParsePrometheusText([]byte(nfTypeMetricsBody), "2026-01-01T00:00:00Z", nil, "AMF")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	keys := map[string]bool{}
	for _, sample := range out.Samples {
		keys[sample.Key] = true
	}
	if !keys["amf_session"] {
		t.Fatal("permitted AMF family must be kept")
	}
	if !keys["process_cpu_seconds_total"] {
		t.Fatal("generic wildcard family must be kept")
	}
	if keys["pfcp_sessions_active"] {
		t.Fatal("SMF family must be dropped for an AMF target")
	}
	if keys["unknown_family_not_registered"] {
		t.Fatal("unregistered family must be dropped")
	}
	if out.Dropped == 0 {
		t.Fatal("dropped families must be counted")
	}
}

func TestParsePrometheusTextLegacyTargetKeepsRegistryCompatibility(t *testing.T) {
	out, err := ParsePrometheusText([]byte(nfTypeMetricsBody), "2026-01-01T00:00:00Z", nil, "")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	keys := map[string]bool{}
	for _, sample := range out.Samples {
		keys[sample.Key] = true
	}
	if !keys["amf_session"] || !keys["pfcp_sessions_active"] {
		t.Fatal("legacy targets keep the previous registry behavior")
	}
	if keys["unknown_family_not_registered"] {
		t.Fatal("unregistered family must still be dropped")
	}
}

func TestParsePrometheusTextNeverZeroFillsDroppedFamilies(t *testing.T) {
	out, err := ParsePrometheusText([]byte(nfTypeMetricsBody), "2026-01-01T00:00:00Z", nil, "AMF")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	for _, sample := range out.Samples {
		if sample.Key == "pfcp_sessions_active" {
			t.Fatal("dropped family must never appear, with or without a zero value")
		}
	}
}

func TestParsePrometheusTextKeepsSafeLabelsForResolvedNFType(t *testing.T) {
	body := []byte(`# HELP amf_session gauge
# TYPE amf_session gauge
amf_session{imsi="001010000000001",nf="amf-01"} 7
`)
	out, err := ParsePrometheusText([]byte(body), "2026-01-01T00:00:00Z", nil, "AMF")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 1 {
		t.Fatalf("expected one sample, got %d", len(out.Samples))
	}
	labels := out.Samples[0].Labels
	if labels == nil {
		t.Fatal("safe label must survive")
	}
	if _, bad := labels["imsi"]; bad {
		t.Fatal("sensitive label must be dropped")
	}
	if labels["nf"] != "amf-01" {
		t.Fatalf("safe label value must be preserved, got %v", labels)
	}
}
