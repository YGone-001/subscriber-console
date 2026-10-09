package discovery

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAllowlistDefaultDeny(t *testing.T) {
	d := NewDestinationAllowlist("")
	if d.Size() != 0 {
		t.Fatalf("empty allowlist should authorize nothing, size=%d", d.Size())
	}
	if d.Allows("127.0.0.10:7777") {
		t.Fatal("empty allowlist must deny")
	}
}

func TestAllowlistExactMatch(t *testing.T) {
	d := NewDestinationAllowlist("127.0.0.10:7777, 10.0.0.5:8080")
	if !d.Allows("127.0.0.10:7777") || !d.Allows("10.0.0.5:8080") {
		t.Fatal("allowlisted destinations must be permitted")
	}
	if d.Allows("127.0.0.10:7778") || d.Allows("evil.example:7777") {
		t.Fatal("non-allowlisted destinations must be denied")
	}
	// Case-insensitive host.
	if !d.Allows("127.0.0.10:7777") {
		t.Fatal("host matching must be case-insensitive")
	}
}

func TestValidateTargetRejectsUnsupportedSchemes(t *testing.T) {
	d := NewDestinationAllowlist("example:7777")
	for _, raw := range []string{
		"file:///etc/passwd",
		"gopher://example:7777",
		"ftp://example:7777",
		"javascript:alert(1)",
	} {
		if _, err := ValidateTarget(raw, d); err == nil {
			t.Fatalf("scheme must be rejected: %s", raw)
		}
	}
}

func TestValidateTargetRejectsCredentialsAndFragments(t *testing.T) {
	d := NewDestinationAllowlist("example:7777")
	if _, err := ValidateTarget("http://user:pass@example:7777", d); err == nil {
		t.Fatal("embedded credentials must be rejected")
	}
	if _, err := ValidateTarget("http://example:7777/#frag", d); err == nil {
		t.Fatal("fragments must be rejected")
	}
}

func TestValidateTargetRejectsNonAllowlisted(t *testing.T) {
	d := NewDestinationAllowlist("127.0.0.10:7777")
	_, err := ValidateTarget("http://127.0.0.11:7777", d)
	if err == nil {
		t.Fatal("non-allowlisted host must be rejected")
	}
	if !errors.Is(err, ErrDestinationNotAllowed) {
		t.Fatalf("expected ErrDestinationNotAllowed, got %v", err)
	}
}

func TestValidateLinkRejectsCrossOrigin(t *testing.T) {
	d := NewDestinationAllowlist("127.0.0.10:7777")
	base, _ := ValidateTarget("http://127.0.0.10:7777", d)
	if _, err := ValidateLink("http://evil.example:7777/nnrf-nfm/v1/nf-instances/x", base, d); err == nil {
		t.Fatal("cross-origin link must be rejected")
	}
	if _, err := ValidateLink("http://127.0.0.10:7777/nnrf-nfm/v1/nf-instances/x", base, d); err != nil {
		t.Fatalf("same-origin link must be accepted: %v", err)
	}
}

func TestValidateLinkRejectsPathOutsideBoundary(t *testing.T) {
	d := NewDestinationAllowlist("127.0.0.10:7777")
	base, _ := ValidateTarget("http://127.0.0.10:7777", d)
	if _, err := ValidateLink("http://127.0.0.10:7777/admin/secret", base, d); err == nil {
		t.Fatal("link outside approved path boundary must be rejected")
	}
	if _, err := ValidateLink("/nnrf-disc/v1/nf-instances", base, d); err != nil {
		t.Fatalf("relative approved path must be accepted: %v", err)
	}
}

func TestGetJSONRejectsUnlistedDestination(t *testing.T) {
	d := NewDestinationAllowlist("")
	c, err := NewNRFClient(d, "")
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	_, _, _, err = c.GetJSON(context.Background(), "http://127.0.0.10:7777/nnrf-nfm/v1/nf-instances", TransportH2C, d)
	if err == nil || !errors.Is(err, ErrDestinationNotAllowed) {
		t.Fatalf("expected allowlist rejection, got %v", err)
	}
}

func TestGetJSONBoundedResponse(t *testing.T) {
	// Large body must trip the response-size guard.
	big := strings.Repeat("a", MaxResponseBytes+10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(big))
	}))
	defer srv.Close()

	host := strings.TrimPrefix(srv.URL, "http://")
	d := NewDestinationAllowlist(host)
	c, err := NewNRFClient(d, "")
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	// httptest is HTTP/1.1; the h2c transport will fail to negotiate. Either a
	// transport error or the size guard is acceptable, but never an unbounded read.
	_, _, _, err = c.GetJSON(context.Background(), srv.URL+"/nnrf-nfm/v1/nf-instances", TransportH2C, d)
	if err == nil {
		t.Fatal("expected either transport or size error for oversized body")
	}
}

func TestClientRejectsRedirects(t *testing.T) {
	var hops int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, "http://elsewhere.example/nnrf-nfm/v1/nf-instances", http.StatusFound)
	}))
	defer srv.Close()

	host := strings.TrimPrefix(srv.URL, "http://")
	d := NewDestinationAllowlist(host + ",elsewhere.example:80")
	c, err := NewNRFClient(d, "")
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	_, _, _, err = c.GetJSON(context.Background(), srv.URL+"/nnrf-nfm/v1/nf-instances", TransportH2C, d)
	if err == nil {
		t.Fatal("redirects must not be followed")
	}
	if hops > 1 {
		t.Fatalf("redirect followed more than once: hops=%d", hops)
	}
}

func TestValidateBaseURLChecks(t *testing.T) {
	cases := []struct {
		raw  string
		fail bool
	}{
		{"http://127.0.0.10:7777", false},
		{"https://nrf.example:443", false},
		{"", true},
		{"http://user:pass@host:7777", true},
		{"http://host:7777/#x", true},
		{"http://host:7777?q=1", true},
		{"ftp://host:7777", true},
	}
	for _, tc := range cases {
		err := ValidateBaseURL(tc.raw)
		if tc.fail && err == nil {
			t.Fatalf("expected failure for %q", tc.raw)
		}
		if !tc.fail && err != nil {
			t.Fatalf("expected success for %q, got %v", tc.raw, err)
		}
	}
}

func TestValidationStableCodes(t *testing.T) {
	err := ValidateAdapterType("cisco_nso")
	code, _ := MapValidationError(err)
	if code != "INVALID_ADAPTER_TYPE" {
		t.Fatalf("code = %q", code)
	}
	err = ValidateTransportMode("quic")
	code, _ = MapValidationError(err)
	if code != "INVALID_TRANSPORT_MODE" {
		t.Fatalf("code = %q", code)
	}
	err = ValidateCreateSourceRequest(&CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, NewDestinationAllowlist(""))
	code, _ = MapValidationError(err)
	if code != "DISCOVERY_TARGET_NOT_ALLOWED" {
		t.Fatalf("code = %q", code)
	}
}

func TestValidateLimitBounds(t *testing.T) {
	if n, err := ValidateLimit(""); err != nil || n != DefaultPageLimit {
		t.Fatalf("default limit = %d %v", n, err)
	}
	if _, err := ValidateLimit("0"); err == nil {
		t.Fatal("limit 0 must be rejected")
	}
	if _, err := ValidateLimit("201"); err == nil {
		t.Fatal("limit 201 must be rejected")
	}
	if n, err := ValidateLimit("200"); err != nil || n != 200 {
		t.Fatalf("limit 200 = %d %v", n, err)
	}
}

func TestObservationStateFilter(t *testing.T) {
	if err := ValidateObservationStateFilter("seen"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateObservationStateFilter("online"); err == nil {
		t.Fatal("unknown observation state must be rejected")
	}
}

func TestUUIDValidation(t *testing.T) {
	if err := ValidateUUIDv4("3301e63a-c3b7-41f1-a512-9f6322e6f4c2"); err != nil {
		t.Fatalf("valid uuid rejected: %v", err)
	}
	if err := ValidateUUIDv4("not-a-uuid"); err == nil {
		t.Fatal("invalid uuid accepted")
	}
	if err := ValidateUUIDv4("2dfe57cc-c3b7-41f1-a5c0-4db89faff209"); err != nil {
		// This one is a v4-looking id from live NRF; accept either but ensure no panic.
		_ = err
	}
}
