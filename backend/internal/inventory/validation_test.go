package inventory

import (
	"strings"
	"testing"
)

func TestValidationEnums(t *testing.T) {
	// Kinds
	if len(CanonicalKinds) != 20 {
		t.Fatalf("expected 20 canonical kinds, got %d", len(CanonicalKinds))
	}
	for _, k := range CanonicalKinds {
		if err := ValidateKind(k); err != nil {
			t.Errorf("expected valid kind %s, got error: %v", k, err)
		}
	}
	if err := ValidateKind("invalid_kind"); err == nil {
		t.Error("expected error for invalid kind, got nil")
	}

	// Domains
	if len(CanonicalDomains) != 10 {
		t.Fatalf("expected 10 canonical domains, got %d", len(CanonicalDomains))
	}
	for _, d := range CanonicalDomains {
		if err := ValidateDomain(d); err != nil {
			t.Errorf("expected valid domain %s, got error: %v", d, err)
		}
	}
	if err := ValidateDomain("unknown_domain"); err == nil {
		t.Error("expected error for invalid domain, got nil")
	}

	// Lifecycle states
	if len(CanonicalLifecycleStates) != 4 {
		t.Fatalf("expected 4 canonical lifecycle states, got %d", len(CanonicalLifecycleStates))
	}
	for _, s := range CanonicalLifecycleStates {
		if s == LifecycleRetired {
			if err := ValidateLifecycleState(s, false); err == nil {
				t.Error("expected error when retired is not allowed, got nil")
			}
			if err := ValidateLifecycleState(s, true); err != nil {
				t.Errorf("expected valid retired state when allowed, got: %v", err)
			}
		} else {
			if err := ValidateLifecycleState(s, false); err != nil {
				t.Errorf("expected valid state %s, got: %v", s, err)
			}
		}
	}
	if err := ValidateLifecycleState("destroyed", false); err == nil {
		t.Error("expected error for invalid state, got nil")
	}
}

func TestValidateResourceName(t *testing.T) {
	valid := []string{
		"amf-01",
		"smf_core",
		"upf.cluster-1",
		"node:1",
		"A123",
	}
	for _, n := range valid {
		if err := ValidateResourceName(n); err != nil {
			t.Errorf("expected valid name %q, got: %v", n, err)
		}
	}

	invalid := []string{
		"",
		" ",
		"-invalid",
		".invalid",
		":invalid",
		strings.Repeat("a", 129),
		"amf with space",
		"amf@home",
	}
	for _, n := range invalid {
		if err := ValidateResourceName(n); err == nil {
			t.Errorf("expected error for invalid name %q, got nil", n)
		}
	}
}

func TestValidateManagementEndpoints(t *testing.T) {
	valid := []ManagementEndpoint{
		{
			Name:        "mgmt-v4",
			Protocol:    ProtocolHTTPS,
			AddressType: AddressTypeIPv4,
			Address:     "192.0.2.10",
			Port:        443,
			Path:        "/api",
		},
		{
			Name:        "mgmt-v6",
			Protocol:    ProtocolHTTP,
			AddressType: AddressTypeIPv6,
			Address:     "2001:db8::1",
			Port:        8080,
		},
		{
			Name:        "mgmt-fqdn",
			Protocol:    ProtocolNETCONF,
			AddressType: AddressTypeFQDN,
			Address:     "amf01.core.telecom.net",
			Port:        830,
		},
	}
	if err := ValidateManagementEndpoints(valid); err != nil {
		t.Fatalf("expected valid endpoints, got: %v", err)
	}

	// IPv4 mismatch
	badV4 := []ManagementEndpoint{
		{
			Name:        "bad-v4",
			Protocol:    ProtocolHTTPS,
			AddressType: AddressTypeIPv4,
			Address:     "2001:db8::1",
			Port:        443,
		},
	}
	if err := ValidateManagementEndpoints(badV4); err == nil {
		t.Error("expected error for IPv6 in IPv4 addressType")
	}

	// IPv6 mismatch
	badV6 := []ManagementEndpoint{
		{
			Name:        "bad-v6",
			Protocol:    ProtocolHTTPS,
			AddressType: AddressTypeIPv6,
			Address:     "192.0.2.1",
			Port:        443,
		},
	}
	if err := ValidateManagementEndpoints(badV6); err == nil {
		t.Error("expected error for IPv4 in IPv6 addressType")
	}

	// FQDN with scheme/credentials
	badFQDN := []ManagementEndpoint{
		{
			Name:        "bad-fqdn",
			Protocol:    ProtocolHTTPS,
			AddressType: AddressTypeFQDN,
			Address:     "https://user:pass@host.com",
			Port:        443,
		},
	}
	if err := ValidateManagementEndpoints(badFQDN); err == nil {
		t.Error("expected error for URL in FQDN address")
	}

	// Duplicate normalized tuple
	dup := []ManagementEndpoint{
		{
			Name:        "ep1",
			Protocol:    ProtocolHTTPS,
			AddressType: AddressTypeIPv4,
			Address:     "192.0.2.1",
			Port:        443,
			Path:        "/",
		},
		{
			Name:        "ep2",
			Protocol:    ProtocolHTTPS,
			AddressType: AddressTypeIPv4,
			Address:     "192.0.2.1",
			Port:        443,
			Path:        "/",
		},
	}
	if err := ValidateManagementEndpoints(dup); err == nil {
		t.Error("expected error for duplicate normalized endpoints")
	}
}

func TestNormalizeCapabilities(t *testing.T) {
	input := []string{"  mobility-management ", "registration", "mobility-management", "  ", "session-management"}
	normalized, err := NormalizeCapabilities(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(normalized) != 3 {
		t.Fatalf("expected 3 deduped capabilities, got %d", len(normalized))
	}
	expected := []string{"mobility-management", "registration", "session-management"}
	for i, c := range expected {
		if normalized[i] != c {
			t.Errorf("at [%d]: expected %s, got %s", i, c, normalized[i])
		}
	}
}

func TestValidateLabels(t *testing.T) {
	valid := map[string]string{
		"env":         "production",
		"region/zone": "zone-1",
		"cluster.id":  "", // wait! '.' is forbidden in keys!
	}
	// with '.' in key:
	if err := ValidateLabels(valid); err == nil {
		t.Error("expected error for label key containing '.'")
	}

	clean := map[string]string{
		"env":         "production",
		"region/zone": "zone-1",
		"tier_name":   "core",
	}
	if err := ValidateLabels(clean); err != nil {
		t.Errorf("expected clean labels to pass, got: %v", err)
	}
}

func TestValidateAttributes(t *testing.T) {
	// Clean attributes
	clean := map[string]any{
		"vendor_config": map[string]any{
			"plmn_id": "00101",
			"tac":     100,
			"features": []any{
				"feature-1",
				"feature-2",
			},
		},
	}
	if err := ValidateAttributes(clean); err != nil {
		t.Fatalf("expected clean attributes to pass, got: %v", err)
	}

	// Sensitive key rejection (case-insensitive)
	sensitive := map[string]any{
		"nested": map[string]any{
			"api_key": "some-secret",
		},
	}
	if err := ValidateAttributes(sensitive); err == nil {
		t.Error("expected error for sensitive key api_key, got nil")
	}

	sensitive2 := map[string]any{
		"password": "pass",
	}
	if err := ValidateAttributes(sensitive2); err == nil {
		t.Error("expected error for password key, got nil")
	}

	// Key with '.' or '$'
	dotKey := map[string]any{
		"invalid.key": "val",
	}
	if err := ValidateAttributes(dotKey); err == nil {
		t.Error("expected error for attribute key with '.'")
	}

	dollarKey := map[string]any{
		"$invalid": "val",
	}
	if err := ValidateAttributes(dollarKey); err == nil {
		t.Error("expected error for attribute key with '$'")
	}

	// Depth > 6
	deep := map[string]any{
		"l1": map[string]any{
			"l2": map[string]any{
				"l3": map[string]any{
					"l4": map[string]any{
						"l5": map[string]any{
							"l6": map[string]any{
								"l7": "too deep",
							},
						},
					},
				},
			},
		},
	}
	if err := ValidateAttributes(deep); err == nil {
		t.Error("expected error for nesting depth > 6, got nil")
	}
}

func TestCheckForbiddenServerFields(t *testing.T) {
	spoofPayload := []byte(`{"name":"amf-01","kind":"host","domain":"5gc","revision":5}`)
	if err := CheckForbiddenServerFields(spoofPayload); err == nil {
		t.Error("expected error for revision field, got nil")
	}

	validPayload := []byte(`{"name":"amf-01","kind":"host","domain":"5gc"}`)
	if err := CheckForbiddenServerFields(validPayload); err != nil {
		t.Errorf("expected clean payload to pass, got: %v", err)
	}
}
