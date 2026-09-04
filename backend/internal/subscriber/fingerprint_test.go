package subscriber

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func loadFixture(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", path, err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("failed to parse fixture %s: %v", path, err)
	}
	return result
}

func TestFingerprintParity_Update(t *testing.T) {
	before := loadFixture(t, "testdata/fixture_update_before.json")
	after := loadFixture(t, "testdata/fixture_update_after.json")

	// Compute fingerprint using Go stable + hash
	fp := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", before, after)

	// Verify it's a valid hex string of correct length (SHA256 = 64 hex chars)
	if len(fp) != 64 {
		t.Errorf("expected fingerprint length 64, got %d", len(fp))
	}

	// Verify deterministic: running again produces same result
	fp2 := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", before, after)
	if fp != fp2 {
		t.Errorf("fingerprint not deterministic: %s != %s", fp, fp2)
	}

	// Verify stable() sorts keys correctly (check via JSON since Go maps don't preserve order)
	stableBefore := stable(before)
	stableJSON, err := json.Marshal(stableBefore)
	if err != nil {
		t.Fatalf("failed to marshal stable output: %v", err)
	}
	expectedStable := `{"accessRestrictionData":49,"ambr":{"downlink":{"unit":0,"value":100000000},"uplink":{"unit":0,"value":50000000}},"imsi":"310260123456789","msisdn":"1234567890","networkAccessMode":2,"slice":[{"defaultSessions":[{"name":"internet","pccRule":[],"type":3},{"name":"ims","pccRule":[],"type":3}],"sst":1}]}`
	if string(stableJSON) != expectedStable {
		t.Errorf("stable output mismatch:\n  got:      %s\n  expected: %s", string(stableJSON), expectedStable)
	}

	// Write expected fingerprint to file for cross-language comparison
	// (Only update if UPDATE_FIXTURES env is set)
	if os.Getenv("UPDATE_FIXTURES") == "1" {
		os.WriteFile("testdata/fixture_update_fingerprint.txt", []byte(fp), 0644)
	} else {
		expected, err := os.ReadFile("testdata/fixture_update_fingerprint.txt")
		if err == nil && string(expected) != fp {
			t.Errorf("fingerprint mismatch:\n  got:      %s\n  expected: %s", fp, string(expected))
		}
	}

	t.Logf("Update fingerprint: %s", fp)
}

func TestFingerprintParity_Delete(t *testing.T) {
	before := loadFixture(t, "testdata/fixture_delete_before.json")

	// Compute fingerprint using Go stable + hash
	fp := hashOperation("SUBSCRIBER_DELETE", "310260123456789", before, nil)

	// Verify it's a valid hex string of correct length
	if len(fp) != 64 {
		t.Errorf("expected fingerprint length 64, got %d", len(fp))
	}

	// Verify deterministic
	fp2 := hashOperation("SUBSCRIBER_DELETE", "310260123456789", before, nil)
	if fp != fp2 {
		t.Errorf("fingerprint not deterministic: %s != %s", fp, fp2)
	}

	// Verify stable() output matches expected JSON
	stableBefore := stable(before)
	stableJSON, err := json.Marshal(stableBefore)
	if err != nil {
		t.Fatalf("failed to marshal stable output: %v", err)
	}
	// The stable output should have sorted keys
	expectedStable := `{"accessRestrictionData":49,"ambr":{"downlink":{"unit":0,"value":100000000},"uplink":{"unit":0,"value":50000000}},"imsi":"310260123456789","msisdn":"1234567890","networkAccessMode":2,"slice":[{"defaultSessions":[{"name":"internet","pccRule":[],"type":3},{"name":"ims","pccRule":[],"type":3}],"sst":1}]}`
	if string(stableJSON) != expectedStable {
		t.Errorf("stable output mismatch:\n  got:      %s\n  expected: %s", string(stableJSON), expectedStable)
	}

	// Write expected fingerprint to file
	if os.Getenv("UPDATE_FIXTURES") == "1" {
		os.WriteFile("testdata/fixture_delete_fingerprint.txt", []byte(fp), 0644)
	} else {
		expected, err := os.ReadFile("testdata/fixture_delete_fingerprint.txt")
		if err == nil && string(expected) != fp {
			t.Errorf("fingerprint mismatch:\n  got:      %s\n  expected: %s", fp, string(expected))
		}
	}

	t.Logf("Delete fingerprint: %s", fp)
}

func TestStable_SortedKeys(t *testing.T) {
	// Input with unsorted keys
	input := map[string]any{
		"z_last":  1,
		"a_first": 2,
		"m_mid":   3,
	}
	result := stable(input)

	// Go maps don't preserve insertion order, so check via JSON serialization
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}
	expected := `{"a_first":2,"m_mid":3,"z_last":1}`
	if string(data) != expected {
		t.Errorf("keys not sorted in JSON output:\n  got:      %s\n  expected: %s", string(data), expected)
	}
}

func TestStable_NestedMaps(t *testing.T) {
	input := map[string]any{
		"outer": map[string]any{
			"z": 1,
			"a": 2,
		},
	}
	result := stable(input)

	// Check via JSON serialization since Go maps don't preserve insertion order
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}
	expected := `{"outer":{"a":2,"z":1}}`
	if string(data) != expected {
		t.Errorf("nested keys not sorted:\n  got:      %s\n  expected: %s", string(data), expected)
	}
}

func TestStable_ArraysPreserved(t *testing.T) {
	input := map[string]any{
		"items": []any{"c", "a", "b"},
	}
	result := stable(input)
	m := result.(map[string]any)
	items := m["items"].([]any)

	// Arrays should preserve order (not sorted)
	if items[0] != "c" || items[1] != "a" || items[2] != "b" {
		t.Errorf("array order not preserved: %v", items)
	}
}

func TestHashOperation_Deterministic(t *testing.T) {
	before := map[string]any{"imsi": "310260123456789"}
	after := map[string]any{"imsi": "310260123456789", "msisdn": "123"}

	h1 := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", before, after)
	h2 := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", before, after)
	if h1 != h2 {
		t.Errorf("hash not deterministic: %s != %s", h1, h2)
	}

	// Verify it's a valid SHA256 hex
	expectedLen := sha256.Size * 2 // 64 hex chars
	if len(h1) != expectedLen {
		t.Errorf("expected hash length %d, got %d", expectedLen, len(h1))
	}

	// Different operation should produce different hash
	h3 := hashOperation("SUBSCRIBER_DELETE", "310260123456789", before, nil)
	if h1 == h3 {
		t.Error("different operations should produce different hashes")
	}
}

func TestStable_StructHandling(t *testing.T) {
	type Inner struct {
		Z int    `json:"z"`
		A string `json:"a"`
	}
	type Outer struct {
		Name  string `json:"name"`
		Inner Inner  `json:"inner"`
	}

	input := Outer{
		Name:  "test",
		Inner: Inner{Z: 1, A: "hello"},
	}

	result := stable(input)
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any from struct, got %T", result)
	}

	// Keys should be sorted
	if m["name"] != "test" {
		t.Errorf("expected name=test, got %v", m["name"])
	}
	inner, ok := m["inner"].(map[string]any)
	if !ok {
		t.Fatalf("expected inner to be map[string]any, got %T", m["inner"])
	}
	if inner["a"] != "hello" || inner["z"] != 1 {
		t.Errorf("inner values wrong: %v", inner)
	}

	// Verify sorted order in JSON
	data, _ := json.Marshal(result)
	expected := `{"inner":{"a":"hello","z":1},"name":"test"}`
	if string(data) != expected {
		t.Errorf("struct stable output mismatch:\n  got:      %s\n  expected: %s", string(data), expected)
	}
}

func TestGenerateFixtures(t *testing.T) {
	if os.Getenv("GENERATE_FIXTURES") != "1" {
		t.Skip("set GENERATE_FIXTURES=1 to regenerate fixture files")
	}

	// Update fingerprint
	before := loadFixture(t, "testdata/fixture_update_before.json")
	after := loadFixture(t, "testdata/fixture_update_after.json")
	updateFP := hashOperation("SUBSCRIBER_UPDATE", "310260123456789", before, after)
	os.WriteFile("testdata/fixture_update_fingerprint.txt", []byte(updateFP), 0644)
	t.Logf("Update fingerprint: %s", updateFP)

	// Delete fingerprint
	deleteBefore := loadFixture(t, "testdata/fixture_delete_before.json")
	deleteFP := hashOperation("SUBSCRIBER_DELETE", "310260123456789", deleteBefore, nil)
	os.WriteFile("testdata/fixture_delete_fingerprint.txt", []byte(deleteFP), 0644)
	t.Logf("Delete fingerprint: %s", deleteFP)

	// Also output the stable JSON for Node comparison
	stableBefore := stable(before)
	sb, _ := json.Marshal(stableBefore)
	fmt.Printf("Stable before (update): %s\n", string(sb))

	stableAfter := stable(after)
	sa, _ := json.Marshal(stableAfter)
	fmt.Printf("Stable after (update): %s\n", string(sa))

	stableDeleteBefore := stable(deleteBefore)
	sdb, _ := json.Marshal(stableDeleteBefore)
	fmt.Printf("Stable before (delete): %s\n", string(sdb))
}
