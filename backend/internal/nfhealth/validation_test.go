package nfhealth

import "testing"

func TestValidateUUIDv4(t *testing.T) {
	if err := ValidateUUIDv4("123e4567-e89b-42d3-a456-426614174000"); err != nil {
		t.Fatalf("expected valid uuid, got %v", err)
	}
	if err := ValidateUUIDv4("not-a-uuid"); err == nil {
		t.Fatal("expected invalid uuid rejection")
	}
}

func TestDestinationAllowlistDefaultDeny(t *testing.T) {
	al := NewDestinationAllowlist("")
	if al.Allows("127.0.0.5:9090") {
		t.Fatal("empty allowlist must deny all")
	}
}

func TestDestinationAllowlistExactMatch(t *testing.T) {
	al := NewDestinationAllowlist("127.0.0.5:9090,127.0.0.4:9090")
	if !al.Allows("127.0.0.5:9090") {
		t.Fatal("expected allowlisted destination")
	}
	if al.Allows("127.0.0.6:9090") {
		t.Fatal("expected non-allowlisted destination to be denied")
	}
}

func TestMustAllowlistEndpointRejectsUnknownDestination(t *testing.T) {
	al := NewDestinationAllowlist("127.0.0.5:9090")
	err := MustAllowlistEndpoint("http://127.0.0.6:9090/metrics", al)
	if err == nil {
		t.Fatal("expected destination rejection")
	}
	ve, ok := err.(*ErrValidation)
	if !ok || ve.Code != "NF_HEALTH_DESTINATION_NOT_ALLOWED" {
		t.Fatalf("expected destination error code, got %v", err)
	}
}

func TestServiceUnitAllowlistDefaultDeny(t *testing.T) {
	al := NewServiceUnitAllowlist("")
	if al.Allows("some.service") {
		t.Fatal("empty allowlist must deny all")
	}
}

func TestServiceUnitAllowlistAcceptsConfiguredUnits(t *testing.T) {
	al := NewServiceUnitAllowlist("amfd,smfd.service")
	if !al.Allows("amfd") {
		t.Fatal("expected amfd to be allowed")
	}
	if !al.Allows("smfd.service") {
		t.Fatal("expected smfd.service to be allowed")
	}
	if al.Allows("otherd") {
		t.Fatal("expected otherd to be denied")
	}
}

func TestValidateIntervalSecondsBounds(t *testing.T) {
	if err := ValidateIntervalSeconds(0); err != nil {
		t.Fatalf("zero should default: %v", err)
	}
	if err := ValidateIntervalSeconds(120); err != nil {
		t.Fatalf("120 should be valid: %v", err)
	}
	if err := ValidateIntervalSeconds(30); err == nil {
		t.Fatal("30 should be rejected below minimum")
	}
	if err := ValidateIntervalSeconds(99999); err == nil {
		t.Fatal("99999 should be rejected above maximum")
	}
}

func TestValidateMetricsEndpointRejectsUserinfoAndQuery(t *testing.T) {
	if err := ValidateMetricsEndpoint("http://user:pass@host:9090/metrics"); err == nil {
		t.Fatal("userinfo must be rejected")
	}
	if err := ValidateMetricsEndpoint("http://host:9090/metrics?x=1"); err == nil {
		t.Fatal("query string must be rejected")
	}
	if err := ValidateMetricsEndpoint("ftp://host:9090/metrics"); err == nil {
		t.Fatal("unsupported scheme must be rejected")
	}
}

func TestValidateCreateTargetRequestRequiresMetricsEndpointForHTTPProfile(t *testing.T) {
	req := &CreateTargetRequest{
		CandidateID:      "123e4567-e89b-42d3-a456-426614174000",
		Name:             "AMF-01",
		CollectorProfile: CollectorHTTPMetrics,
		ServiceKind:      "none",
		CollectionMode:   CollectionManual,
	}
	err := ValidateCreateTargetRequest(req, NewDestinationAllowlist(""), NewServiceUnitAllowlist(""))
	if err == nil {
		t.Fatal("expected metricsEndpoint requirement")
	}
}

func TestValidateCreateTargetRequestRejectsUnknownProfile(t *testing.T) {
	req := &CreateTargetRequest{
		CandidateID:      "123e4567-e89b-42d3-a456-426614174000",
		Name:             "AMF-01",
		CollectorProfile: "unknown_profile",
		ServiceKind:      "none",
		CollectionMode:   CollectionManual,
	}
	if err := ValidateCreateTargetRequest(req, nil, nil); err == nil {
		t.Fatal("expected unknown collector profile rejection")
	}
}

func TestValidateLimitBounds(t *testing.T) {
	if _, err := ValidateLimit(""); err != nil {
		t.Fatalf("empty limit should default: %v", err)
	}
	if _, err := ValidateLimit("0"); err == nil {
		t.Fatal("zero limit must be rejected")
	}
	if _, err := ValidateLimit("201"); err == nil {
		t.Fatal("over-max limit must be rejected")
	}
	if _, err := ValidateLimit("50"); err != nil {
		t.Fatalf("50 should be valid: %v", err)
	}
}

func TestIsSafeLabelRejectsSubscriberIdentities(t *testing.T) {
	for _, key := range []string{"imsi", "supi", "msisdn", "imei", "auth_token", "session_id"} {
		if IsSafeLabel(key) {
			t.Fatalf("label %q must not be considered safe", key)
		}
	}
	if !IsSafeLabel("nf") {
		t.Fatal("nf label should be safe")
	}
}
