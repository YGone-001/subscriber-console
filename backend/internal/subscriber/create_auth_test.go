package subscriber

import (
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	testK   = "00112233445566778899AABBCCDDEEFF"
	testOP  = "FFEEDDCCBBAA99887766554433221100"
	testOPc = "AABBCCDDEEFF00112233445566778899"
	testAMF = "8000"
)

// validOPcAuth returns a fresh map so a test cannot mutate another test's input.
func validOPcAuth() map[string]any {
	return map[string]any{"k": testK, "opc": testOPc, "amf": testAMF, "sqn": 0}
}

func validOPAuth() map[string]any {
	return map[string]any{"k": testK, "op": testOP, "amf": testAMF, "sqn": 0}
}

// TestParseCreateAuthenticationMaterial_AbsentPreservesLegacyDefaults is the backward
// compatibility guarantee: a client that sends only imsi/planId/msisdn keeps the server's
// existing default security block.
func TestParseCreateAuthenticationMaterial_AbsentPreservesLegacyDefaults(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(nil)
	if err != nil {
		t.Fatalf("absent auth4G must not error, got %v", err)
	}
	if auth != nil {
		t.Fatalf("absent auth4G must yield nil material, got %+v", auth)
	}

	// A nil material must leave the default document's security block untouched.
	doc := buildDefaultSubscriber("310260123456789", nil)
	auth.ApplyTo(doc)

	security, _ := doc["security"].(bson.M)
	if security["k"] != "000102030405060708090A0B0C0D0E0F" {
		t.Errorf("default K changed: %v", security["k"])
	}
	if security["op"] != nil {
		t.Errorf("default op should stay null, got %v", security["op"])
	}
	if security["opc"] != "00000000000000000000000000000000" {
		t.Errorf("default opc changed: %v", security["opc"])
	}
	if security["amf"] != "8000" {
		t.Errorf("default amf changed: %v", security["amf"])
	}
	if security["sqn"] != int64(1719756) {
		t.Errorf("default sqn changed: %v", security["sqn"])
	}
}

func TestParseCreateAuthenticationMaterial_ValidOPcMode(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(validOPcAuth())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if auth.K != testK {
		t.Errorf("K = %s, want %s", auth.K, testK)
	}
	if auth.OP != nil {
		t.Errorf("OP must be nil in OPc mode, got %v", *auth.OP)
	}
	if auth.OPc == nil || *auth.OPc != testOPc {
		t.Errorf("OPc mismatch: %v", auth.OPc)
	}
	if auth.AMF != testAMF {
		t.Errorf("AMF = %s, want %s", auth.AMF, testAMF)
	}
	if auth.SQN != 0 {
		t.Errorf("SQN = %d, want 0", auth.SQN)
	}
	if auth.AuthenticationMode() != "opc" {
		t.Errorf("AuthenticationMode = %s, want opc", auth.AuthenticationMode())
	}
}

func TestParseCreateAuthenticationMaterial_ValidOPMode(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(validOPAuth())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if auth.OP == nil || *auth.OP != testOP {
		t.Errorf("OP mismatch: %v", auth.OP)
	}
	if auth.OPc != nil {
		t.Errorf("OPc must be nil in OP mode, got %v", *auth.OPc)
	}
	if auth.AuthenticationMode() != "op" {
		t.Errorf("AuthenticationMode = %s, want op", auth.AuthenticationMode())
	}
}

// TestParseCreateAuthenticationMaterial_HexUppercaseNormalization covers case-insensitive input
// with canonical uppercase persistence.
func TestParseCreateAuthenticationMaterial_HexUppercaseNormalization(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(map[string]any{
		"k":   "00112233445566778899aabbccddeeff",
		"opc": "aabbccddeeff00112233445566778899",
		"amf": "8a0b",
		"sqn": 5,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if auth.K != "00112233445566778899AABBCCDDEEFF" {
		t.Errorf("K not canonicalized: %s", auth.K)
	}
	if auth.OPc == nil || *auth.OPc != "AABBCCDDEEFF00112233445566778899" {
		t.Errorf("OPc not canonicalized: %v", auth.OPc)
	}
	if auth.AMF != "8A0B" {
		t.Errorf("AMF not canonicalized: %s", auth.AMF)
	}
}

func TestParseCreateAuthenticationMaterial_Rejections(t *testing.T) {
	cases := []struct {
		name string
		auth map[string]any
	}{
		{"k wrong length", map[string]any{"k": "0011", "opc": testOPc, "amf": testAMF, "sqn": 0}},
		{"k non-hex", map[string]any{"k": strings.Repeat("z", 32), "opc": testOPc, "amf": testAMF, "sqn": 0}},
		{"k blank", map[string]any{"k": "   ", "opc": testOPc, "amf": testAMF, "sqn": 0}},
		{"k missing", map[string]any{"opc": testOPc, "amf": testAMF, "sqn": 0}},
		{"op wrong length", map[string]any{"k": testK, "op": "FFEE", "amf": testAMF, "sqn": 0}},
		{"op non-hex", map[string]any{"k": testK, "op": strings.Repeat("g", 32), "amf": testAMF, "sqn": 0}},
		{"opc wrong length", map[string]any{"k": testK, "opc": "AABB", "amf": testAMF, "sqn": 0}},
		{"opc non-hex", map[string]any{"k": testK, "opc": strings.Repeat("h", 32), "amf": testAMF, "sqn": 0}},
		{"amf wrong length", map[string]any{"k": testK, "opc": testOPc, "amf": "800", "sqn": 0}},
		{"amf non-hex", map[string]any{"k": testK, "opc": testOPc, "amf": "zzzz", "sqn": 0}},
		{"amf missing", map[string]any{"k": testK, "opc": testOPc, "sqn": 0}},
		{"sqn missing", map[string]any{"k": testK, "opc": testOPc, "amf": testAMF}},
		{"sqn negative", map[string]any{"k": testK, "opc": testOPc, "amf": testAMF, "sqn": -1}},
		{"sqn too large", map[string]any{"k": testK, "opc": testOPc, "amf": testAMF, "sqn": float64(9007199254740992)}},
		{"sqn non-integer", map[string]any{"k": testK, "opc": testOPc, "amf": testAMF, "sqn": 1.5}},
		{"sqn wrong type", map[string]any{"k": testK, "opc": testOPc, "amf": testAMF, "sqn": "0"}},
		{"both op and opc", map[string]any{"k": testK, "op": testOP, "opc": testOPc, "amf": testAMF, "sqn": 0}},
		{"neither op nor opc", map[string]any{"k": testK, "amf": testAMF, "sqn": 0}},
		{"unknown field", map[string]any{"k": testK, "opc": testOPc, "amf": testAMF, "sqn": 0, "password": "x"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			auth, err := ParseCreateAuthenticationMaterial(tc.auth)
			if err == nil {
				t.Fatalf("expected rejection, got material %+v", auth)
			}
		})
	}
}

// TestParseCreateAuthenticationMaterial_SQNZeroAccepted guards against treating zero as absent.
func TestParseCreateAuthenticationMaterial_SQNZeroAccepted(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(map[string]any{
		"k": testK, "opc": testOPc, "amf": testAMF, "sqn": 0,
	})
	if err != nil {
		t.Fatalf("SQN 0 must be accepted: %v", err)
	}
	if auth.SQN != 0 {
		t.Errorf("SQN = %d, want 0", auth.SQN)
	}
}

// TestParseCreateAuthenticationMaterial_MaxSQNAccepted checks the documented upper bound.
func TestParseCreateAuthenticationMaterial_MaxSQNAccepted(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(map[string]any{
		"k": testK, "opc": testOPc, "amf": testAMF, "sqn": float64(9007199254740991),
	})
	if err != nil {
		t.Fatalf("max SQN must be accepted: %v", err)
	}
	if auth.SQN != 9007199254740991 {
		t.Errorf("SQN = %d", auth.SQN)
	}
}

// TestCreateAuthenticationMaterial_ErrorOmitsSuppliedValue is the non-leakage guarantee for
// validation errors: the message names the field but never echoes the value.
func TestCreateAuthenticationMaterial_ErrorOmitsSuppliedValue(t *testing.T) {
	const sentinel = "DEADBEEFDEADBEEFDEADBEEFDEADBEEF"
	_, err := ParseCreateAuthenticationMaterial(map[string]any{
		"k": sentinel, "opc": "SHORT", "amf": testAMF, "sqn": 0,
	})
	if err == nil {
		t.Fatal("expected rejection")
	}
	if strings.Contains(err.Error(), sentinel) {
		t.Errorf("error leaks the supplied K: %v", err)
	}
	if strings.Contains(err.Error(), "SHORT") {
		t.Errorf("error leaks the supplied OPc: %v", err)
	}
}

// TestCreateAuthenticationMaterial_ApplyToWritesExactlyTheSecurityAuthFields proves the mapping
// and that no other default is disturbed.
func TestCreateAuthenticationMaterial_ApplyToWritesExactlyTheSecurityAuthFields(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(validOPcAuth())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	doc := buildDefaultSubscriber("310260123456789", []any{"963932000001"})
	amfBefore := doc["access_restriction_data"]
	sliceBefore := doc["slice"]

	auth.ApplyTo(doc)

	security, _ := doc["security"].(bson.M)
	if security["k"] != testK {
		t.Errorf("k = %v", security["k"])
	}
	if security["op"] != nil {
		t.Errorf("op must be null in OPc mode, got %v", security["op"])
	}
	if security["opc"] != testOPc {
		t.Errorf("opc = %v", security["opc"])
	}
	if security["amf"] != testAMF {
		t.Errorf("amf = %v", security["amf"])
	}
	if security["sqn"] != int64(0) {
		t.Errorf("sqn = %v", security["sqn"])
	}

	// Untouched defaults.
	if doc["access_restriction_data"] != amfBefore {
		t.Error("access_restriction_data must not change")
	}
	if len(doc["slice"].([]any)) != len(sliceBefore.([]any)) {
		t.Error("slice defaults must not change")
	}
	if doc["imsi"] != "310260123456789" {
		t.Error("imsi must not change")
	}
}

// TestCreateAuthenticationMaterial_ApplyToOPModeNullsOPc covers the mirror mapping.
func TestCreateAuthenticationMaterial_ApplyToOPModeNullsOPc(t *testing.T) {
	auth, err := ParseCreateAuthenticationMaterial(validOPAuth())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	doc := buildDefaultSubscriber("310260123456789", nil)
	auth.ApplyTo(doc)

	security, _ := doc["security"].(bson.M)
	if security["op"] != testOP {
		t.Errorf("op = %v", security["op"])
	}
	if security["opc"] != nil {
		t.Errorf("opc must be null in OP mode, got %v", security["opc"])
	}
}
