package profile

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ─── Stable JSON for cross-runtime fingerprint ───

func stableJson(v any) string {
	switch val := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		result := "{"
		for i, k := range keys {
			if i > 0 {
				result += ","
			}
			keyBytes, _ := json.Marshal(k)
			result += string(keyBytes) + ":" + stableJson(val[k])
		}
		return result + "}"
	case bson.M:
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		result := "{"
		for i, k := range keys {
			if i > 0 {
				result += ","
			}
			keyBytes, _ := json.Marshal(k)
			result += string(keyBytes) + ":" + stableJson(val[k])
		}
		return result + "}"
	case []any:
		result := "["
		for i, item := range val {
			if i > 0 {
				result += ","
			}
			result += stableJson(item)
		}
		return result + "]"
	case bson.A:
		result := "["
		for i, item := range val {
			if i > 0 {
				result += ","
			}
			result += stableJson(item)
		}
		return result + "]"
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func fingerprint(v any) string {
	h := sha256.Sum256([]byte(stableJson(v)))
	return hex.EncodeToString(h[:])
}

// ─── Fixture 1: POST create ───

var PostBody = map[string]any{
	"title":       "Test Profile",
	"description": "A test profile",
}

var PostExpectedFields = map[string]any{
	"name":        "fixture_post_profile",
	"title":       "Test Profile",
	"description": "A test profile",
}

func validatePostResponse(t *testing.T, resp bson.M, user string) {
	t.Helper()
	if resp["name"] != "fixture_post_profile" {
		t.Errorf("name: expected fixture_post_profile, got %v", resp["name"])
	}
	if resp["title"] != "Test Profile" {
		t.Errorf("title: expected Test Profile, got %v", resp["title"])
	}
	if resp["description"] != "A test profile" {
		t.Errorf("description: expected A test profile, got %v", resp["description"])
	}
	if resp["createdAt"] == nil {
		t.Error("createdAt missing")
	}
	if resp["createdBy"] != user {
		t.Errorf("createdBy: expected %s, got %v", user, resp["createdBy"])
	}
	if resp["updatedAt"] == nil {
		t.Error("updatedAt missing")
	}
	if resp["updatedBy"] != user {
		t.Errorf("updatedBy: expected %s, got %v", user, resp["updatedBy"])
	}
}

// ─── Fixture 2: PUT existing (preserves untouched fields) ───

var PutExistingInitial = bson.M{
	"name":        "fixture_put_existing",
	"title":       "Original Title",
	"description": "Original description",
	"auth": bson.M{
		"k":   "00000000000000000000000000000000",
		"opc": "00000000000000000000000000000000",
		"amf": "8000",
	},
	"ambr": bson.M{
		"downlink": bson.M{"unit": 2, "value": 10},
		"uplink":   bson.M{"unit": 2, "value": 10},
	},
	"sliceList": bson.A{
		bson.M{
			"default_indicator": true,
			"sd":                "000001",
			"sst":               1,
			"session_list":      bson.A{},
		},
	},
	"ocsDefaults": bson.M{
		"planId": "custom_plan",
	},
	"createdAt": "2024-01-01T00:00:00.000Z",
	"createdBy": "original_user",
	"updatedAt": "2024-01-01T00:00:00.000Z",
	"updatedBy": "original_user",
}

var PutExistingBody = map[string]any{
	"title": "Changed Title",
}

func validatePutExistingResponse(t *testing.T, resp bson.M, user string) {
	t.Helper()

	// Title should be changed
	if resp["title"] != "Changed Title" {
		t.Errorf("title: expected Changed Title, got %v", resp["title"])
	}

	// Untouched fields should be preserved
	if resp["description"] != "Original description" {
		t.Errorf("description should be preserved, got %v", resp["description"])
	}

	auth, _ := resp["auth"].(bson.M)
	if auth == nil || auth["k"] != "00000000000000000000000000000000" {
		t.Error("auth.k should be preserved")
	}
	if auth == nil || auth["opc"] != "00000000000000000000000000000000" {
		t.Error("auth.opc should be preserved")
	}
	if auth == nil || auth["amf"] != "8000" {
		t.Error("auth.amf should be preserved")
	}

	ambr, _ := resp["ambr"].(bson.M)
	downlink, _ := ambr["downlink"].(bson.M)
	if downlink == nil || downlink["unit"] != 2 || downlink["value"] != 10 {
		t.Error("ambr.downlink should be preserved")
	}

	sl, _ := resp["sliceList"].(bson.A)
	if sl == nil || len(sl) != 1 {
		t.Error("sliceList should be preserved")
	}

	ocs, _ := resp["ocsDefaults"].(bson.M)
	if ocs == nil || ocs["planId"] != "custom_plan" {
		t.Error("ocsDefaults should be preserved")
	}

	// Immutable fields
	if resp["createdAt"] != "2024-01-01T00:00:00.000Z" {
		t.Error("createdAt should be preserved")
	}
	if resp["createdBy"] != "original_user" {
		t.Error("createdBy should be preserved")
	}

	// System fields should be updated
	if resp["updatedBy"] != user {
		t.Errorf("updatedBy: expected %s, got %v", user, resp["updatedBy"])
	}
}

// ─── Fixture 3: PUT missing (sparse insert) ───

var PutMissingBody = map[string]any{
	"title": "New Profile Title",
}

func validatePutMissingResponse(t *testing.T, resp bson.M, user string) {
	t.Helper()

	if resp["name"] != "fixture_put_missing" {
		t.Errorf("name: expected fixture_put_missing, got %v", resp["name"])
	}
	if resp["title"] != "New Profile Title" {
		t.Errorf("title: expected New Profile Title, got %v", resp["title"])
	}
	if resp["createdAt"] == nil {
		t.Error("createdAt missing")
	}
	if resp["createdBy"] != user {
		t.Errorf("createdBy: expected %s, got %v", user, resp["createdBy"])
	}
	if resp["updatedAt"] == nil {
		t.Error("updatedAt missing")
	}
	if resp["updatedBy"] != user {
		t.Errorf("updatedBy: expected %s, got %v", user, resp["updatedBy"])
	}

	// Should NOT have default auth/ambr/sliceList/ocsDefaults
	if _, ok := resp["auth"]; ok {
		t.Error("auth should not be present for sparse insert")
	}
	if _, ok := resp["ambr"]; ok {
		t.Error("ambr should not be present for sparse insert")
	}
	if _, ok := resp["sliceList"]; ok {
		t.Error("sliceList should not be present for sparse insert")
	}
	if _, ok := resp["ocsDefaults"]; ok {
		t.Error("ocsDefaults should not be present for sparse insert")
	}
}

// ─── Fixture 4: PUT with unknown field (should fail) ───

var PutUnknownFieldBody = map[string]any{
	"title":       "Valid Title",
	"unknown_xyz": "should_be_rejected",
}

func validateUnknownFieldError(t *testing.T, resp bson.M) {
	t.Helper()
	if resp["code"] != "INVALID_PROFILE_UPDATE" {
		t.Errorf("code: expected INVALID_PROFILE_UPDATE, got %v", resp["code"])
	}
}

// ─── Cross-runtime fingerprint test ───

func TestCrossRuntimeFingerprint(t *testing.T) {
	// This test validates that Go and Node produce identical fingerprints
	// for the same fixture data. Run both runtimes and compare.

	// POST body fingerprint
	postFp := fingerprint(PostBody)
	t.Logf("POST body fingerprint: %s", postFp)

	// PUT existing initial fingerprint
	putExistingFp := fingerprint(PutExistingInitial)
	t.Logf("PUT existing initial fingerprint: %s", putExistingFp)

	// PUT existing body fingerprint
	putBodyFp := fingerprint(PutExistingBody)
	t.Logf("PUT existing body fingerprint: %s", putBodyFp)

	// PUT missing body fingerprint
	putMissingFp := fingerprint(PutMissingBody)
	t.Logf("PUT missing body fingerprint: %s", putMissingFp)

	// PUT unknown field body fingerprint
	putUnknownFp := fingerprint(PutUnknownFieldBody)
	t.Logf("PUT unknown field body fingerprint: %s", putUnknownFp)

	// These fingerprints should match between Node and Go
	// to ensure contract parity
}
