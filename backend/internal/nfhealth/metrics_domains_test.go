package nfhealth

import "testing"

// ---------------------------------------------------------------------------
// Registry: domain and NF type attribution.
// ---------------------------------------------------------------------------

func TestRegistryRejectsForeignDomainAttribution(t *testing.T) {
	// An EPC HSS family must never be accepted on a 5GC target.
	if _, ok := LookupMetricForTarget("hss_imsi", "5gc", NFTypeAMF); ok {
		t.Fatal("an EPC family must not be attributed to a 5GC resource")
	}
	if _, ok := LookupMetricForTarget("hss_imsi", "epc", NFTypeHSS); !ok {
		t.Fatal("the EPC HSS family must be accepted for an EPC HSS resource")
	}
	// A 5GC AMF family must never be accepted on an EPC target.
	if _, ok := LookupMetricForTarget("amf_session", "epc", NFTypeMME); ok {
		t.Fatal("a 5GC family must not be attributed to an EPC resource")
	}
	// Charging families stay in the charging domain.
	if _, ok := LookupMetricForTarget("ocs_sessions_active", "5gc", NFTypeSMF); ok {
		t.Fatal("a charging family must not be attributed to a 5GC resource")
	}
	if _, ok := LookupMetricForTarget("ocs_sessions_active", "charging", NFTypeOCS); !ok {
		t.Fatal("the charging family must be accepted for an OCS resource")
	}
}

func TestRegistryRejectsForeignNFTypesWithinTheSameDomain(t *testing.T) {
	// Both are EPC families, but an MME must not adopt HSS Diameter counters.
	if _, ok := LookupMetricForTarget("s6a_rx_ulr", "epc", NFTypeMME); ok {
		t.Fatal("an HSS Diameter family must not be attributed to an MME resource")
	}
	// Both are 5GC families, but an AMF must not adopt SMF session metrics.
	if _, ok := LookupMetricForTarget("ues_active", "5gc", NFTypeAMF); ok {
		t.Fatal("an SMF family must not be attributed to an AMF resource")
	}
	// Shared families remain permitted for every declared source.
	for _, nfType := range []string{NFTypeSMF, NFTypeUPF} {
		if _, ok := LookupMetricForTarget("pfcp_sessions_active", "5gc", nfType); !ok {
			t.Fatalf("the shared PFCP family must stay permitted for %s", nfType)
		}
	}
}

func TestRegistryGenericResourceFamiliesApplyToEveryDomain(t *testing.T) {
	for _, tc := range []struct{ domain, nfType string }{
		{"5gc", NFTypeAMF}, {"epc", NFTypeMME}, {"charging", NFTypeOCS}, {"ims", NFTypePCSCF},
	} {
		def, ok := LookupMetricForTarget("process_cpu_seconds_total", tc.domain, tc.nfType)
		if !ok {
			t.Fatalf("generic resource metrics must apply to %s/%s", tc.domain, tc.nfType)
		}
		if def.Category != CategoryResource || def.HealthRule != HealthRuleNone {
			t.Fatalf("generic resource metrics must never carry a service health rule: %+v", def)
		}
	}
}

func TestRegistryLegacyTargetsKeepCompatibilityWithoutInventingAttribution(t *testing.T) {
	// A legacy target has neither an authoritative domain nor NF type.
	if _, ok := LookupMetricForTarget("s6a_rx_ulr", "", ""); !ok {
		t.Fatal("legacy targets must keep registry compatibility")
	}
	// A domain-only mismatch is still rejected: the domain is authoritative
	// whenever it is known.
	if _, ok := LookupMetricForTarget("s6a_rx_ulr", "5gc", ""); ok {
		t.Fatal("a known 5GC domain must reject an EPC family")
	}
}

func TestRegistryEveryServiceFamilyCarriesProvenanceAndRule(t *testing.T) {
	seen := map[string]bool{}
	for _, def := range SupportedMetrics() {
		if seen[def.Name] {
			t.Fatalf("duplicate registry entry: %s", def.Name)
		}
		seen[def.Name] = true
		if def.Domain == "" || len(def.NFTypes) == 0 {
			t.Fatalf("%s must declare a domain and NF types", def.Name)
		}
		if def.Source == "" || def.Evidence == "" {
			t.Fatalf("%s must declare its exporter source and evidence class", def.Name)
		}
		if def.Description == "" || def.Interpretation == "" {
			t.Fatalf("%s must declare a description and interpretation", def.Name)
		}
		switch def.Category {
		case CategoryResource:
			if def.HealthRule != HealthRuleNone {
				t.Fatalf("%s is a resource metric and must not carry a service health rule", def.Name)
			}
		case CategoryService:
			// ok
		default:
			t.Fatalf("%s declares an unknown category %q", def.Name, def.Category)
		}
		switch def.HealthRule {
		case HealthRuleNone, HealthRuleFailureCounterZero, HealthRuleActivityGauge:
			// ok
		case HealthRuleSuccessRatioPair:
			if _, ok := LookupMetric(def.HealthPair); !ok {
				t.Fatalf("%s declares an unregistered health pair %q", def.Name, def.HealthPair)
			}
		default:
			t.Fatalf("%s declares an unknown health rule %q", def.Name, def.HealthRule)
		}
		if def.Type != "counter" && def.Type != "gauge" {
			t.Fatalf("%s declares an unsupported type %q", def.Name, def.Type)
		}
	}
	// The previously certified 5GC families stay registered.
	for _, name := range []string{
		"gnb", "amf_session", "ran_ue", "fivegs_amffunction_rm_registeredsubnbr",
		"fivegs_amffunction_rm_reginitreq", "fivegs_amffunction_rm_reginitsucc",
		"fivegs_amffunction_rm_reginitfail", "ues_active", "bearers_active",
		"pfcp_sessions_active", "pfcp_peers_active", "gtp2_sessions_active",
		"fivegs_smffunction_sm_sessionnbr", "fivegs_smffunction_sm_pdusessioncreationreq",
		"fivegs_upffunction_upf_sessionnbr", "fivegs_upffunction_upf_qosflows",
		"fivegs_ep_n3_gtp_indatapktn3upf",
	} {
		if _, ok := LookupMetric(name); !ok {
			t.Fatalf("previously certified family %s must stay registered", name)
		}
	}
}

func TestRegistryCoversVerifiedDomainsOnly(t *testing.T) {
	// EPC families exist for the NF types with a verified exporter.
	epcFamilies := map[string]int{}
	for _, def := range SupportedMetrics() {
		if def.Domain == "epc" {
			for _, nfType := range def.NFTypes {
				epcFamilies[nfType]++
			}
		}
	}
	for _, nfType := range []string{NFTypeMME, NFTypeHSS, NFTypePCRF} {
		if epcFamilies[nfType] == 0 {
			t.Fatalf("verified EPC NF type %s must have registered families", nfType)
		}
	}
	// SGW-C and SGW-U export no metrics in the reference exporter: no family
	// may be invented for them.
	if epcFamilies[NFTypeSGWC] != 0 || epcFamilies[NFTypeSGWU] != 0 {
		t.Fatal("no SGW-C or SGW-U family may be registered without exporter evidence")
	}
	// IMS has no HTTP metrics exporter: no IMS family may be invented.
	for _, def := range SupportedMetrics() {
		if def.Domain == "ims" {
			t.Fatalf("no IMS family may be registered without exporter evidence: %s", def.Name)
		}
	}
	// Charging families are source-verified only.
	for _, def := range SupportedMetrics() {
		if def.Domain == "charging" && def.Evidence != EvidenceSourceVerified {
			t.Fatalf("charging family %s must stay source_verified (the reference deployment does not enable the listener)", def.Name)
		}
	}
}

func TestRegistryLabelsDropPeerAndSliceIdentifiers(t *testing.T) {
	for _, key := range []string{"addr", "plmnid", "snssai", "imsi", "supi", "msisdn", "cell", "gnb_id"} {
		if IsSafeLabel(key) {
			t.Fatalf("label %q must never be persisted", key)
		}
	}
	for _, key := range []string{"nf", "nftype", "function", "instance"} {
		if !IsSafeLabel(key) {
			t.Fatalf("label %q must stay permitted", key)
		}
	}
}

// ---------------------------------------------------------------------------
// Parser: category attribution, domain filtering and value bounds.
// ---------------------------------------------------------------------------

func TestParserAttributesCategoryAndDomain(t *testing.T) {
	body := []byte(
		"# TYPE mme_session gauge\nmme_session 7\n" +
			"# TYPE process_cpu_seconds_total counter\nprocess_cpu_seconds_total 12\n",
	)
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "epc", NFTypeMME)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	categories := map[string]string{}
	for _, sample := range out.Samples {
		categories[sample.Key] = sample.Category
	}
	if categories["mme_session"] != CategoryService {
		t.Fatalf("service family must be attributed as service evidence: %+v", categories)
	}
	if categories["process_cpu_seconds_total"] != CategoryResource {
		t.Fatalf("generic process metric must stay resource evidence: %+v", categories)
	}
}

func TestParserRejectsForeignDomainFamilies(t *testing.T) {
	// An HSS Diameter family served by a 5GC AMF target is dropped.
	body := []byte("# TYPE s6a_rx_ulr counter\ns6a_rx_ulr 4\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "5gc", NFTypeAMF)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 0 {
		t.Fatalf("a foreign-domain family must be dropped: %+v", out.Samples)
	}
	if out.Dropped != 1 {
		t.Fatalf("the dropped family must be counted: %+v", out)
	}
}

func TestParserRejectsNegativeCountLikeValues(t *testing.T) {
	// A negative session count is corrupted evidence, not a measurement.
	body := []byte("# TYPE fivegs_smffunction_sm_sessionnbr gauge\nfivegs_smffunction_sm_sessionnbr -445\n")
	out, err := ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "5gc", NFTypeSMF)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 0 {
		t.Fatalf("a negative count-like value must be rejected: %+v", out.Samples)
	}
	// A legitimately negative gauge (unlimited virtual memory) stays accepted.
	body = []byte("# TYPE process_virtual_memory_max_bytes gauge\nprocess_virtual_memory_max_bytes -1\n")
	out, err = ParsePrometheusText(body, "2026-01-01T00:00:00Z", nil, "5gc", NFTypeSMF)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Samples) != 1 || out.Samples[0].Value != -1 {
		t.Fatalf("a legitimately negative gauge must be preserved: %+v", out.Samples)
	}
}

// ---------------------------------------------------------------------------
// Service semantics: explicit rules only.
// ---------------------------------------------------------------------------

func sampleOf(key string, value float64) MetricSample {
	def, _ := LookupMetric(key)
	return MetricSample{Key: key, Value: value, Category: def.Category}
}

func TestServiceSemanticsProcessMetricsNeverClaimServiceHealth(t *testing.T) {
	samples := []MetricSample{
		sampleOf("process_cpu_seconds_total", 100),
		sampleOf("process_resident_memory_bytes", 2048),
	}
	got := EvaluateServiceLayer(samples, nil)
	if got.State == StateHealthy {
		t.Fatal("process telemetry must never establish L3 service health")
	}
	if got.State != StateUnknown || got.Reason != ReasonResourceMetricsOnly || !got.Measured {
		t.Fatalf("expected measured unknown resource_metrics_only, got %+v", got)
	}
}

func TestServiceSemanticsRequestCounterAloneIsNotHealthy(t *testing.T) {
	// A bare request counter says nothing about service health on its own.
	got := EvaluateServiceLayer([]MetricSample{sampleOf("fivegs_amffunction_rm_reginitreq", 42)}, nil)
	if got.State != StateUnknown {
		t.Fatalf("a request counter alone must not claim health, got %+v", got)
	}
	if got.Reason != ReasonServiceHealthUndetermined || !got.Measured {
		t.Fatalf("expected measured undetermined evidence, got %+v", got)
	}
}

// Regression: a cumulative request/success pair was previously treated as
// confirmed health or observed degradation. Cumulative totals cannot establish
// the current window's outcome, so the rule now reports missing interval
// evidence while the raw counters stay available.
func TestServiceSemanticsCumulativePairRequiresInterval(t *testing.T) {
	// Equal totals: not confirmed.
	summary := SummarizeServiceEvidence([]MetricSample{
		sampleOf("fivegs_amffunction_rm_reginitreq", 10),
		sampleOf("fivegs_amffunction_rm_reginitsucc", 10),
	})
	if summary.Confirmed != 0 || summary.Degraded != 0 {
		t.Fatalf("cumulative totals must not confirm or degrade: %+v", summary)
	}
	if summary.IntervalRequired != 1 {
		t.Fatalf("the pair must report missing interval evidence: %+v", summary)
	}

	// Shortfall: historical, not a current failure.
	summary = SummarizeServiceEvidence([]MetricSample{
		sampleOf("fivegs_amffunction_rm_reginitreq", 10),
		sampleOf("fivegs_amffunction_rm_reginitsucc", 8),
	})
	if summary.Degraded != 0 {
		t.Fatalf("a historical shortfall must not degrade the service: %+v", summary)
	}

	// A non-zero cumulative failure counter is historical evidence as well.
	summary = SummarizeServiceEvidence([]MetricSample{
		sampleOf("fivegs_amffunction_rm_reginitreq", 10),
		sampleOf("fivegs_amffunction_rm_reginitsucc", 10),
		sampleOf("fivegs_amffunction_rm_reginitfail", 2),
	})
	if summary.Degraded != 0 {
		t.Fatalf("a cumulative failure counter must not degrade the service: %+v", summary)
	}
	if summary.IntervalRequired != 2 {
		t.Fatalf("both interval-requiring families must be reported: %+v", summary)
	}
}

func TestServiceSemanticsIdleFailureCounterProvesNothing(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{
		sampleOf("s6a_rx_unknown", 0),
		sampleOf("cx_rx_mar_error", 0),
	}, nil)
	if got.State != StateUnknown || got.Reason != ReasonServiceHealthUndetermined {
		t.Fatalf("idle failure counters must not claim health, got %+v", got)
	}
}

func TestServiceSemanticsFailureCounterWithTrafficIsStillUndetermined(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{
		sampleOf("s6a_rx_ulr", 25),
		sampleOf("s6a_rx_ulr_error", 0),
	}, nil)
	if got.State != StateUnknown || got.Reason != ReasonServiceHealthUndetermined {
		t.Fatalf("cumulative counters must stay undetermined, got %+v", got)
	}
}

func TestServiceSemanticsZeroActivityGaugeIsNotHealthy(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{sampleOf("mme_session", 0)}, nil)
	if got.State == StateHealthy {
		t.Fatalf("a zero activity gauge must not claim health, got %+v", got)
	}
	if got.State != StateUnknown || !got.Measured {
		t.Fatalf("expected measured unknown, got %+v", got)
	}
}

func TestServiceSemanticsPositiveActivityGaugeIsActivityOnly(t *testing.T) {
	got := EvaluateServiceLayer([]MetricSample{sampleOf("mme_session", 3)}, nil)
	if got.State != StateUnknown || got.Reason != ReasonActivityObserved {
		t.Fatalf("activity is observed activity, not confirmed health: %+v", got)
	}
}

func TestServiceSemanticsMissingPairYieldsNoPercentage(t *testing.T) {
	// A success counter without its request counter must not be turned into a
	// percentage or a health claim.
	got := EvaluateServiceLayer([]MetricSample{sampleOf("fivegs_amffunction_rm_reginitsucc", 5)}, nil)
	if got.State != StateUnknown || got.Reason != ReasonServiceHealthUndetermined {
		t.Fatalf("an incomplete pair must stay undetermined, got %+v", got)
	}
}

func TestServiceSemanticsSummaryCountsCategories(t *testing.T) {
	summary := SummarizeServiceEvidence([]MetricSample{
		sampleOf("process_cpu_seconds_total", 1),
		sampleOf("mme_session", 2),
		sampleOf("enb", 0),
	})
	if summary.ResourceSamples != 1 || summary.ServiceSamples != 2 {
		t.Fatalf("category counts must be reported: %+v", summary)
	}
	if summary.ActivityObserved != 1 || summary.Undetermined != 1 {
		t.Fatalf("rule outcomes must be reported: %+v", summary)
	}
	if summary.Confirmed != 0 || summary.Degraded != 0 {
		t.Fatalf("no rule may confirm or degrade from these families: %+v", summary)
	}
}
