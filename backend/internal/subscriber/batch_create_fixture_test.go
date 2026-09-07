package subscriber

import (
	"encoding/json"
	"os"
	"testing"
)

// Cross-language fixture test.
// Node production generates authoritative fixtures.
// Go reads expected values only.

// FixtureExpected holds expected values from Node fixture generation.
type FixtureExpected struct {
	NoProfileFingerprint      string `json:"noProfileFingerprint"`
	ProfilePresentFingerprint string `json:"profilePresentFingerprint"`
	ProfileHash               string `json:"profileHash"`
	ProfileHashWithMetadata   string `json:"profileHashWithMetadata"`
}

func loadFixtures(t *testing.T) *FixtureExpected {
	t.Helper()

	// Required cross-language fixture — absence is a test failure
	fixturePath := "../../../src/server/__tests__/batch-create-fixtures.json"
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("required fixture file not found: %v", err)
		return nil
	}

	var fixtures FixtureExpected
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("failed to parse fixture file: %v", err)
	}
	return &fixtures
}

// TestCrossLanguageFingerprint verifies that Go produces the same fingerprint as Node.
func TestCrossLanguageFingerprint(t *testing.T) {
	fixtures := loadFixtures(t)
	if fixtures == nil {
		return
	}

	// No-profile fingerprint
	targets := []string{"001010000000001", "001010000000002", "001010000000003"}
	ocs := EffectiveOcsConfig{
		PlanId:         "plan_default_5gb",
		TrafficTotal:   5368709120,
		TrafficBalance: 5368709120,
		SmsTotal:       100,
		SmsBalance:     100,
	}
	profile := ProfileState{
		RequestedName:    "",
		State:            "absent",
		PreconditionHash: "",
	}

	actual := ComputeBatchCreateFingerprint(targets, ocs, profile)
	if actual != fixtures.NoProfileFingerprint {
		t.Errorf("no-profile fingerprint mismatch:\n  actual:   %s\n  expected: %s", actual, fixtures.NoProfileFingerprint)
	}
}

// TestCrossLanguageProfileHash verifies that Go produces the same profile hash as Node.
func TestCrossLanguageProfileHash(t *testing.T) {
	fixtures := loadFixtures(t)
	if fixtures == nil {
		return
	}

	// Profile hash for PROFILE_AUTH_AMBR_SLICE equivalent
	profileData := map[string]any{
		"auth": map[string]any{
			"k":   "00000000000000000000000000000000",
			"opc": "00000000000000000000000000000000",
			"sqn": int64(1),
			"amf": "8000",
		},
		"ambr": map[string]any{
			"downlink": map[string]any{"value": int64(1), "unit": int64(3)},
			"uplink":   map[string]any{"value": int64(1), "unit": int64(3)},
		},
		"sliceList": []any{
			map[string]any{"sst": int64(1), "sd": "000001"},
		},
		"ocsDefaults": map[string]any{
			"trafficTotal": int64(5368709120),
			"smsTotal":     int64(100),
		},
	}

	actual := ComputeProfilePreconditionHash(profileData)
	if actual != fixtures.ProfileHash {
		t.Errorf("profile hash mismatch:\n  actual:   %s\n  expected: %s", actual, fixtures.ProfileHash)
	}
}

// TestCrossLanguageProfileHashKeyOrder verifies that profile hash is key-order independent.
func TestCrossLanguageProfileHashKeyOrder(t *testing.T) {
	fixtures := loadFixtures(t)
	if fixtures == nil {
		return
	}

	// Same data, different key order
	profileData := map[string]any{
		"ocsDefaults": map[string]any{
			"smsTotal":     int64(100),
			"trafficTotal": int64(5368709120),
		},
		"sliceList": []any{
			map[string]any{"sd": "000001", "sst": int64(1)},
		},
		"ambr": map[string]any{
			"uplink":   map[string]any{"unit": int64(3), "value": int64(1)},
			"downlink": map[string]any{"unit": int64(3), "value": int64(1)},
		},
		"auth": map[string]any{
			"amf": "8000",
			"sqn": int64(1),
			"opc": "00000000000000000000000000000000",
			"k":   "00000000000000000000000000000000",
		},
	}

	actual := ComputeProfilePreconditionHash(profileData)
	if actual != fixtures.ProfileHash {
		t.Errorf("profile hash key-order mismatch:\n  actual:   %s\n  expected: %s", actual, fixtures.ProfileHash)
	}
}
