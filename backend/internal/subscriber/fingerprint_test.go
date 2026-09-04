package subscriber

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// loadFixtureJSON reads a JSON fixture file and returns the raw bytes.
func loadFixtureJSON(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", path, err)
	}
	return data
}

// loadFixtureField extracts a nested JSON field from a fixture file.
func loadFixtureField(t *testing.T, path string, field string) map[string]any {
	t.Helper()
	data := loadFixtureJSON(t, path)
	var wrapper map[string]any
	if err := json.Unmarshal(data, &wrapper); err != nil {
		t.Fatalf("failed to parse fixture %s: %v", path, err)
	}
	raw, ok := wrapper[field]
	if !ok {
		t.Fatalf("fixture %s missing field %q", path, field)
	}
	result, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("fixture %s field %q is not an object: %T", path, field, raw)
	}
	return result
}

// loadFixtureString reads a fixture file and returns trimmed string content.
func loadFixtureString(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", path, err)
	}
	return strings.TrimSpace(string(data))
}

// ============================================================
// SafeSnapshot shape verification
// ============================================================

func TestSafeSnapshot_Shape(t *testing.T) {
	snap := loadFixtureField(t, "testdata/fixture_safe_before.json", "snapshot")

	// Required keys
	requiredKeys := []string{"imsi", "msisdn", "accessRestrictionData", "networkAccessMode", "ambr", "slices"}
	for _, key := range requiredKeys {
		if _, ok := snap[key]; !ok {
			t.Errorf("SafeSnapshot missing required key: %s", key)
		}
	}

	// msisdn must be array
	if _, ok := snap["msisdn"].([]any); !ok {
		t.Errorf("msisdn must be array, got %T", snap["msisdn"])
	}

	// slices must be array
	if _, ok := snap["slices"].([]any); !ok {
		t.Errorf("slices must be array, got %T", snap["slices"])
	}

	// NO security fields
	for _, forbidden := range []string{"security", "k", "op", "opc", "amf", "sqn"} {
		if _, ok := snap[forbidden]; ok {
			t.Errorf("SafeSnapshot must NOT contain %q", forbidden)
		}
	}
}

// ============================================================
// Default subscriber verification
// ============================================================

func TestDefaultSubscriber_Shape(t *testing.T) {
	doc := loadFixtureField(t, "testdata/fixture_default_subscriber.json", "raw")

	// Required fields
	if doc["imsi"] != "310260123456789" {
		t.Errorf("expected imsi=310260123456789, got %v", doc["imsi"])
	}

	// Security
	sec, ok := doc["security"].(map[string]any)
	if !ok {
		t.Fatal("security must be an object")
	}
	if sec["k"] != "000102030405060708090A0B0C0D0E0F" {
		t.Errorf("expected k=000102030405060708090A0B0C0D0E0F, got %v", sec["k"])
	}
	if sec["op"] != nil {
		t.Errorf("expected op=nil, got %v", sec["op"])
	}
	if sec["opc"] != "00000000000000000000000000000000" {
		t.Errorf("expected opc=00000000000000000000000000000000, got %v", sec["opc"])
	}
	if sec["amf"] != "8000" {
		t.Errorf("expected amf=8000, got %v", sec["amf"])
	}

	// EPC realm
	mmeHost, ok := doc["mme_host"].(string)
	if !ok {
		t.Fatal("mme_host must be a string")
	}
	if !strings.Contains(mmeHost, "mme.epc.mnc") {
		t.Errorf("mme_host must contain 'mme.epc.mnc', got %s", mmeHost)
	}

	// AMBR defaults
	ambr, ok := doc["ambr"].(map[string]any)
	if !ok {
		t.Fatal("ambr must be an object")
	}
	dl, ok := ambr["downlink"].(map[string]any)
	if !ok {
		t.Fatal("ambr.downlink must be an object")
	}
	if dl["unit"] != float64(3) {
		t.Errorf("expected ambr.downlink.unit=3, got %v", dl["unit"])
	}
	if dl["value"] != float64(1) {
		t.Errorf("expected ambr.downlink.value=1, got %v", dl["value"])
	}

	// Slice
	slice, ok := doc["slice"].([]any)
	if !ok {
		t.Fatal("slice must be an array")
	}
	if len(slice) < 1 {
		t.Fatal("must have at least 1 slice")
	}
}

// ============================================================
// Default slice ARP verification
// ============================================================

func TestDefaultSlice_ARP(t *testing.T) {
	doc := loadFixtureField(t, "testdata/fixture_default_subscriber.json", "raw")
	slice := doc["slice"].([]any)
	first := slice[0].(map[string]any)
	sessions := first["session"].([]any)

	// Find internet, mobile, ims sessions
	var internet, mobile, ims map[string]any
	for _, s := range sessions {
		sess := s.(map[string]any)
		switch sess["name"] {
		case "internet":
			internet = sess
		case "mobile":
			mobile = sess
		case "ims":
			ims = sess
		}
	}

	if internet == nil {
		t.Fatal("must have internet session")
	}
	internetQos := internet["qos"].(map[string]any)
	internetArp := internetQos["arp"].(map[string]any)
	if internetArp["priority_level"] != float64(9) {
		t.Errorf("internet ARP priority_level expected 9, got %v", internetArp["priority_level"])
	}

	if mobile == nil {
		t.Fatal("must have mobile session")
	}
	mobileQos := mobile["qos"].(map[string]any)
	mobileArp := mobileQos["arp"].(map[string]any)
	if mobileArp["priority_level"] != float64(9) {
		t.Errorf("mobile ARP priority_level expected 9, got %v", mobileArp["priority_level"])
	}

	if ims == nil {
		t.Fatal("must have ims session")
	}
	imsQos := ims["qos"].(map[string]any)
	imsArp := imsQos["arp"].(map[string]any)
	if imsArp["priority_level"] != float64(1) {
		t.Errorf("ims ARP priority_level expected 1, got %v", imsArp["priority_level"])
	}
}

// ============================================================
// IMS PCC rule verification
// ============================================================

func TestDefaultSlice_IMS_PCC(t *testing.T) {
	doc := loadFixtureField(t, "testdata/fixture_default_subscriber.json", "raw")
	slice := doc["slice"].([]any)
	first := slice[0].(map[string]any)
	sessions := first["session"].([]any)

	var ims map[string]any
	for _, s := range sessions {
		sess := s.(map[string]any)
		if sess["name"] == "ims" {
			ims = sess
			break
		}
	}
	if ims == nil {
		t.Fatal("must have ims session")
	}

	pccRule, ok := ims["pcc_rule"].([]any)
	if !ok {
		t.Fatal("ims pcc_rule must be an array")
	}
	if len(pccRule) < 1 {
		t.Fatal("ims must have at least 1 PCC rule")
	}

	rule := pccRule[0].(map[string]any)
	qos := rule["qos"].(map[string]any)

	// GBR
	gbr := qos["gbr"].(map[string]any)
	gbrDl := gbr["downlink"].(map[string]any)
	if gbrDl["value"] != float64(128) {
		t.Errorf("GBR downlink value expected 128, got %v", gbrDl["value"])
	}
	if gbrDl["unit"] != float64(1) {
		t.Errorf("GBR downlink unit expected 1, got %v", gbrDl["unit"])
	}

	// MBR
	mbr := qos["mbr"].(map[string]any)
	mbrDl := mbr["downlink"].(map[string]any)
	if mbrDl["value"] != float64(128) {
		t.Errorf("MBR downlink value expected 128, got %v", mbrDl["value"])
	}
	if mbrDl["unit"] != float64(1) {
		t.Errorf("MBR downlink unit expected 1, got %v", mbrDl["unit"])
	}

	// ARP
	arp := qos["arp"].(map[string]any)
	if arp["priority_level"] != float64(2) {
		t.Errorf("PCC ARP priority_level expected 2, got %v", arp["priority_level"])
	}
}

// ============================================================
// IMS session AMBR verification
// ============================================================

func TestDefaultSlice_IMS_AMBR(t *testing.T) {
	doc := loadFixtureField(t, "testdata/fixture_default_subscriber.json", "raw")
	slice := doc["slice"].([]any)
	first := slice[0].(map[string]any)
	sessions := first["session"].([]any)

	var ims map[string]any
	for _, s := range sessions {
		sess := s.(map[string]any)
		if sess["name"] == "ims" {
			ims = sess
			break
		}
	}
	if ims == nil {
		t.Fatal("must have ims session")
	}

	ambr := ims["ambr"].(map[string]any)
	dl := ambr["downlink"].(map[string]any)
	// IMS_SESSION_AMBR: { value: 1, unit: 3 }
	if dl["value"] != float64(1) {
		t.Errorf("IMS AMBR downlink value expected 1, got %v", dl["value"])
	}
	if dl["unit"] != float64(3) {
		t.Errorf("IMS AMBR downlink unit expected 3, got %v", dl["unit"])
	}
}

// ============================================================
// Canonical string parity
// ============================================================

func TestCanonicalString_Update_Parity(t *testing.T) {
	nodeCanonical := loadFixtureString(t, "testdata/fixture_update_canonical_string.txt")

	// Build the same object in Go
	before := loadFixtureField(t, "testdata/fixture_safe_before.json", "snapshot")
	after := loadFixtureField(t, "testdata/fixture_safe_after.json", "snapshot")

	goCanonical := stableJSON(map[string]any{
		"operation": "SUBSCRIBER_UPDATE",
		"imsi":      "310260123456789",
		"before":    before,
		"after":     after,
	})

	if goCanonical != nodeCanonical {
		t.Errorf("canonical string mismatch:\n  Go:   %s\n  Node: %s", goCanonical[:200], nodeCanonical[:200])
	}
}

func TestCanonicalString_Delete_Parity(t *testing.T) {
	nodeCanonical := loadFixtureString(t, "testdata/fixture_delete_canonical_string.txt")

	before := loadFixtureField(t, "testdata/fixture_safe_before.json", "snapshot")

	goCanonical := stableJSON(map[string]any{
		"operation": "SUBSCRIBER_DELETE",
		"imsi":      "310260123456789",
		"before":    before,
	})

	if goCanonical != nodeCanonical {
		t.Errorf("canonical string mismatch:\n  Go:   %s\n  Node: %s", goCanonical[:200], nodeCanonical[:200])
	}
}

// ============================================================
// Fingerprint parity
// ============================================================

func TestFingerprint_Update_Parity(t *testing.T) {
	nodeFingerprint := loadFixtureString(t, "testdata/fixture_update_fingerprint.txt")

	before := loadFixtureField(t, "testdata/fixture_safe_before.json", "snapshot")
	after := loadFixtureField(t, "testdata/fixture_safe_after.json", "snapshot")

	goFingerprint := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", before, after)

	if goFingerprint != nodeFingerprint {
		t.Errorf("fingerprint mismatch:\n  Go:   %s\n  Node: %s", goFingerprint, nodeFingerprint)
	}
}

func TestFingerprint_Delete_Parity(t *testing.T) {
	nodeFingerprint := loadFixtureString(t, "testdata/fixture_delete_fingerprint.txt")

	before := loadFixtureField(t, "testdata/fixture_safe_before.json", "snapshot")

	goFingerprint := hashOperation("SUBSCRIBER_DELETE", "310260123456789", before, nil)

	if goFingerprint != nodeFingerprint {
		t.Errorf("fingerprint mismatch:\n  Go:   %s\n  Node: %s", goFingerprint, nodeFingerprint)
	}
}

// ============================================================
// stable() determinism
// ============================================================

func TestStable_Deterministic(t *testing.T) {
	input := map[string]any{
		"z": 1,
		"a": map[string]any{"z": 2, "a": 1},
		"m": []any{3, 1, 2},
	}
	s1 := stableJSON(input)
	s2 := stableJSON(input)
	if s1 != s2 {
		t.Errorf("stableJSON not deterministic:\n  %s\n  %s", s1, s2)
	}
	expected := `{"a":{"a":1,"z":2},"m":[3,1,2],"z":1}`
	if s1 != expected {
		t.Errorf("stableJSON output mismatch:\n  got:      %s\n  expected: %s", s1, expected)
	}
}

func TestHash_Deterministic(t *testing.T) {
	input := map[string]any{"operation": "SUBSCRIBER_UPDATE", "imsi": "310260123456789"}
	h1 := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", nil, nil)
	h2 := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", nil, nil)
	if h1 != h2 {
		t.Errorf("hash not deterministic: %s != %s", h1, h2)
	}
	if len(h1) != sha256.Size*2 {
		t.Errorf("expected hash length %d, got %d", sha256.Size*2, len(h1))
	}
	_ = input
}

// ============================================================
// Struct handling in stable()
// ============================================================

func TestStable_StructHandling(t *testing.T) {
	type Inner struct {
		Z int    `json:"z"`
		A string `json:"a"`
	}
	type Outer struct {
		Name  string `json:"name"`
		Inner Inner  `json:"inner"`
	}

	input := Outer{Name: "test", Inner: Inner{Z: 1, A: "hello"}}
	result := stable(input)
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any from struct, got %T", result)
	}
	if m["name"] != "test" {
		t.Errorf("expected name=test, got %v", m["name"])
	}
	inner := m["inner"].(map[string]any)
	if inner["a"] != "hello" || inner["z"] != 1 {
		t.Errorf("inner values wrong: %v", inner)
	}
}
