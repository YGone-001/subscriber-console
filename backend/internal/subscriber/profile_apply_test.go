package subscriber

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestBuildSubscriberAfterProfileApply(t *testing.T) {
	current := bson.M{
		"imsi":    "test-imsi",
		"enabled": true,
		"security": bson.M{
			"opc": "old-opc",
			"amf": "8000",
			"k":   "00112233445566778899aabbccddeeff",
			"sqn": "000000001234",
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 50, "unit": 3},
			"uplink":   bson.M{"value": 25, "unit": 3},
		},
		"slice": bson.A{
			bson.M{
				"sst": 1,
				"sd":  "000001",
				"sessionList": bson.A{
					bson.M{
						"name": "internet",
						"type": 3,
					},
				},
			},
		},
		"access_restriction_data": 4,
	}

	t.Run("applies profile auth with OPc", func(t *testing.T) {
		profile := bson.M{
			"name": "premium-5g",
			"auth": bson.M{
				"opc": "aabbccddee00112233445566778899ff",
				"amf": "8000",
				"k":   "00112233445566778899aabbccddeeff",
			},
			"ambr": bson.M{
				"downlink": bson.M{"value": 100, "unit": 3},
				"uplink":   bson.M{"value": 50, "unit": 3},
			},
			"sliceList": bson.A{
				bson.M{
					"sst": 1,
					"sd":  "000001",
					"sessionList": bson.A{
						bson.M{
							"name": "internet",
							"type": 3,
						},
					},
				},
			},
			"access_restriction_data": 32,
		}

		result := BuildSubscriberAfterProfileApply(current, profile, "premium-5g")

		// SQN preserved
		sec := toMap(result["security"])
		if sec == nil {
			t.Fatal("security is nil")
		}
		if sec["sqn"] != "000000001234" {
			t.Errorf("expected sqn=000000001234, got %v", sec["sqn"])
		}

		// OPc applied
		if sec["opc"] != "aabbccddee00112233445566778899ff" {
			t.Errorf("expected opc from profile, got %v", sec["opc"])
		}

		// OP cleared
		if sec["op"] != nil {
			t.Errorf("expected op=nil, got %v", sec["op"])
		}

		// AMF applied
		if sec["amf"] != "8000" {
			t.Errorf("expected amf=8000, got %v", sec["amf"])
		}

		// AMBR applied
		ambr := toMap(result["ambr"])
		if ambr == nil {
			t.Fatal("ambr is nil")
		}
		dl := toMap(ambr["downlink"])
		if dl == nil {
			t.Fatal("downlink is nil")
		}
		dlVal := dl["value"]
		if dlVal != 100 && dlVal != float64(100) {
			t.Errorf("expected ambr downlink value=100, got %v (type %T)", dlVal, dlVal)
		}

		// access_restriction_data applied
		ardVal := result["access_restriction_data"]
		if ardVal != 32 && ardVal != float64(32) {
			t.Errorf("expected ard=32, got %v (type %T)", ardVal, ardVal)
		}

		// profile_name set
		meta := toMap(result["webui_meta"])
		if meta == nil {
			t.Fatal("webui_meta is nil")
		}
		if meta["profile_name"] != "premium-5g" {
			t.Errorf("expected profile_name=premium-5g, got %v", meta["profile_name"])
		}
	})

	t.Run("applies profile auth with OP", func(t *testing.T) {
		profile := bson.M{
			"name": "profile-op",
			"auth": bson.M{
				"op":  "aabbccddee00112233",
				"amf": "8000",
				"k":   "00112233445566778899aabbccddeeff",
			},
		}

		result := BuildSubscriberAfterProfileApply(current, profile, "profile-op")
		sec, _ := result["security"].(map[string]interface{})

		// OP applied
		if sec["op"] != "aabbccddee00112233" {
			t.Errorf("expected op from profile, got %v", sec["op"])
		}

		// OPc cleared
		if sec["opc"] != nil {
			t.Errorf("expected opc=nil, got %v", sec["opc"])
		}

		// SQN preserved
		if sec["sqn"] != "000000001234" {
			t.Errorf("expected sqn=000000001234, got %v", sec["sqn"])
		}
	})

	t.Run("preserves SQN exactly", func(t *testing.T) {
		profile := bson.M{
			"name": "test-profile",
			"auth": bson.M{
				"opc": "new-opc-value",
				"amf": "9000",
			},
		}

		result := BuildSubscriberAfterProfileApply(current, profile, "test-profile")
		sec, _ := result["security"].(map[string]interface{})

		if sec["sqn"] != "000000001234" {
			t.Errorf("expected sqn=000000001234, got %v", sec["sqn"])
		}
	})
}

func TestComputeSubscriberPreconditionHash(t *testing.T) {
	doc := bson.M{
		"imsi":    "test-imsi",
		"enabled": true,
		"security": bson.M{
			"opc": "value",
			"sqn": "1234",
		},
	}

	hash1 := computeSubscriberPreconditionHash(doc)
	hash2 := computeSubscriberPreconditionHash(doc)

	if hash1 != hash2 {
		t.Errorf("expected deterministic hash, got %s != %s", hash1, hash2)
	}

	if hash1 == "" {
		t.Error("expected non-empty hash")
	}
}

func TestComputeProfilePreconditionHash(t *testing.T) {
	profile := bson.M{
		"auth": bson.M{
			"opc": "value",
			"amf": "8000",
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 100},
		},
		"sliceList":               bson.A{},
		"access_restriction_data": 32,
	}

	hash1 := computeProfilePreconditionHash(profile)
	hash2 := computeProfilePreconditionHash(profile)

	if hash1 != hash2 {
		t.Errorf("expected deterministic hash, got %s != %s", hash1, hash2)
	}

	// Changing irrelevant field should NOT change hash
	profile["name"] = "changed"
	hash3 := computeProfilePreconditionHash(profile)
	if hash1 != hash3 {
		t.Error("expected hash unchanged when irrelevant field changes")
	}
}

func TestSecurityMaterialChanged(t *testing.T) {
	current := bson.M{
		"security": bson.M{
			"opc": "old-opc",
			"amf": "8000",
			"sqn": "1234",
		},
	}

	t.Run("no change", func(t *testing.T) {
		effective := bson.M{
			"security": bson.M{
				"opc": "old-opc",
				"amf": "8000",
				"sqn": "5678", // SQN change should NOT trigger
			},
		}
		if securityMaterialChanged(current, effective) {
			t.Error("expected no change when only SQN differs")
		}
	})

	t.Run("OPc changed", func(t *testing.T) {
		effective := bson.M{
			"security": bson.M{
				"opc": "new-opc",
				"amf": "8000",
				"sqn": "1234",
			},
		}
		if !securityMaterialChanged(current, effective) {
			t.Error("expected change when OPc differs")
		}
	})

	t.Run("AMF changed", func(t *testing.T) {
		effective := bson.M{
			"security": bson.M{
				"opc": "old-opc",
				"amf": "9000",
				"sqn": "1234",
			},
		}
		if !securityMaterialChanged(current, effective) {
			t.Error("expected change when AMF differs")
		}
	})
}

func TestIsProfileApplyNoEffect(t *testing.T) {
	current := bson.M{
		"imsi":    "test-imsi",
		"enabled": true,
		"security": bson.M{
			"opc": "same-opc",
			"amf": "8000",
			"k":   "key",
			"sqn": "1234",
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 100, "unit": 3},
			"uplink":   bson.M{"value": 50, "unit": 3},
		},
		"slice":                   bson.A{},
		"access_restriction_data": 32,
		"webui_meta": bson.M{
			"profile_name": "same-profile",
		},
	}

	profile := bson.M{
		"name": "same-profile",
		"auth": bson.M{
			"opc": "same-opc",
			"amf": "8000",
			"k":   "key",
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 100, "unit": 3},
			"uplink":   bson.M{"value": 50, "unit": 3},
		},
		"sliceList":               bson.A{},
		"access_restriction_data": 32,
	}

	if !IsProfileApplyNoEffect(current, profile, "same-profile") {
		t.Error("expected no effect when profile already applied")
	}

	// Different profile name should NOT be no-effect
	if IsProfileApplyNoEffect(current, profile, "different-profile") {
		t.Error("expected effect when profile name differs")
	}
}

func TestGetProfileName(t *testing.T) {
	t.Run("with webui_meta", func(t *testing.T) {
		doc := bson.M{
			"webui_meta": bson.M{
				"profile_name": "test-profile",
			},
		}
		if GetProfileName(doc) != "test-profile" {
			t.Errorf("expected test-profile, got %s", GetProfileName(doc))
		}
	})

	t.Run("without webui_meta", func(t *testing.T) {
		doc := bson.M{}
		if GetProfileName(doc) != "" {
			t.Errorf("expected empty, got %s", GetProfileName(doc))
		}
	})
}

func TestToMap(t *testing.T) {
	t.Run("bson.M", func(t *testing.T) {
		m := bson.M{"key": "value"}
		result := toMap(m)
		if result["key"] != "value" {
			t.Errorf("expected value, got %v", result["key"])
		}
	})

	t.Run("map[string]interface{}", func(t *testing.T) {
		m := map[string]interface{}{"key": "value"}
		result := toMap(m)
		if result["key"] != "value" {
			t.Errorf("expected value, got %v", result["key"])
		}
	})

	t.Run("bson.D", func(t *testing.T) {
		d := bson.D{{Key: "key", Value: "value"}}
		result := toMap(d)
		if result["key"] != "value" {
			t.Errorf("expected value, got %v", result["key"])
		}
	})

	t.Run("bson.D with nested bson.D", func(t *testing.T) {
		d := bson.D{
			{Key: "security", Value: bson.D{
				{Key: "sqn", Value: "1234"},
				{Key: "opc", Value: "abcd"},
			}},
		}
		result := toMap(d)
		sec := toMap(result["security"])
		if sec == nil {
			t.Fatal("nested security is nil")
		}
		if sec["sqn"] != "1234" {
			t.Errorf("expected sqn=1234, got %v", sec["sqn"])
		}
	})

	t.Run("nil returns nil", func(t *testing.T) {
		if toMap(nil) != nil {
			t.Error("expected nil")
		}
	})

	t.Run("unsupported type returns nil", func(t *testing.T) {
		if toMap("string") != nil {
			t.Error("expected nil for string")
		}
	})
}

func TestConvertValue(t *testing.T) {
	t.Run("bson.D converts to map", func(t *testing.T) {
		d := bson.D{{Key: "a", Value: 1}}
		result := convertValue(d)
		m, ok := result.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map[string]interface{}, got %T", result)
		}
		if m["a"] != 1 {
			t.Errorf("expected 1, got %v", m["a"])
		}
	})

	t.Run("bson.A converts elements", func(t *testing.T) {
		a := bson.A{bson.D{{Key: "x", Value: "y"}}}
		result := convertValue(a)
		arr, ok := result.(bson.A)
		if !ok {
			t.Fatalf("expected bson.A, got %T", result)
		}
		m := toMap(arr[0])
		if m["x"] != "y" {
			t.Errorf("expected y, got %v", m["x"])
		}
	})

	t.Run("scalar passthrough", func(t *testing.T) {
		if convertValue("hello") != "hello" {
			t.Error("string passthrough failed")
		}
		if convertValue(42) != 42 {
			t.Error("int passthrough failed")
		}
	})
}

func TestBuildSubscriberAfterProfileApplyReappliesWithoutEffect(t *testing.T) {
	profile := bson.M{
		"name": "gold",
		"ambr": bson.M{"downlink": bson.M{"value": 100, "unit": 3}, "uplink": bson.M{"value": 50, "unit": 3}},
		"sliceList": bson.A{
			bson.M{
				"sst": int32(1), "sd": "000001", "default_indicator": true,
				"session_list": bson.A{
					bson.M{"name": "internet", "type": int32(3)},
					bson.M{"name": "ims", "type": int32(1)},
				},
			},
			bson.M{"sst": int32(2), "default_indicator": false},
		},
		"access_restriction_data": int32(32),
	}
	current := bson.M{"imsi": "460001234567890", "security": bson.M{"sqn": "000000001234"}}

	first := BuildSubscriberAfterProfileApply(current, profile, "gold")
	second := BuildSubscriberAfterProfileApply(first, profile, "gold")

	// The stored document is the identifier base, so a second apply of the same
	// profile must be a fixed point and the governed path must report no effect.
	if stableJSON(first["slice"]) != stableJSON(second["slice"]) {
		t.Errorf("re-applying a profile must not rewrite embedded identifiers:\nfirst:  %s\nsecond: %s",
			stableJSON(first["slice"]), stableJSON(second["slice"]))
	}
	if !IsProfileApplyNoEffect(second, profile, "gold") {
		t.Error("an already-applied subscriber must read as no effect")
	}
	if IsProfileApplyNoEffect(current, profile, "gold") {
		t.Error("the first apply changes content and must not read as no effect")
	}
}

func TestConvertSlicesFromReusesStoredIdentifiersOnly(t *testing.T) {
	storedSliceID := bson.NewObjectID()
	storedSessionID := bson.NewObjectID()
	// Read shape: mongo-driver decodes arrays to bson.A and documents to bson.D.
	base := bson.A{bson.D{
		{Key: "_id", Value: storedSliceID},
		{Key: "sst", Value: int32(9)},
		{Key: "sd", Value: "deadbeef"},
		{Key: "default_indicator", Value: false},
		{Key: "session", Value: bson.A{bson.D{
			{Key: "_id", Value: storedSessionID},
			{Key: "name", Value: "stale-apn"},
		}}},
	}}

	converted := convertSlicesFrom(bson.A{bson.M{
		"sst": int32(1), "default_indicator": true,
		"session_list": bson.A{bson.M{"name": "internet", "type": int32(3)}},
	}}, base)

	if len(converted) != 1 {
		t.Fatalf("expected one slice, got %d", len(converted))
	}
	sliceDoc := toMap(converted[0])
	if id, ok := sliceDoc["_id"].(bson.ObjectID); !ok || id != storedSliceID {
		t.Errorf("expected the stored slice identifier to be reused, got %v", sliceDoc["_id"])
	}
	// Only the identifier is taken from the base; content comes from the profile.
	if sliceDoc["sst"] != int32(1) {
		t.Errorf("expected sst from the profile, got %v (%T)", sliceDoc["sst"], sliceDoc["sst"])
	}
	if _, ok := sliceDoc["sd"]; ok {
		t.Errorf("the base must not contribute sd, got %v", sliceDoc["sd"])
	}
	if sliceDoc["default_indicator"] != true {
		t.Errorf("expected default_indicator from the profile, got %v", sliceDoc["default_indicator"])
	}

	sessions := anySliceOrEmpty(sliceDoc["session"])
	if len(sessions) != 1 {
		t.Fatalf("expected one session, got %d", len(sessions))
	}
	sessionDoc := toMap(sessions[0])
	if id, ok := sessionDoc["_id"].(bson.ObjectID); !ok || id != storedSessionID {
		t.Errorf("expected the stored session identifier to be reused, got %v", sessionDoc["_id"])
	}
	if sessionDoc["name"] != "internet" {
		t.Errorf("expected name from the profile, got %v", sessionDoc["name"])
	}
}

func TestConvertSlicesFromMintsIdentifiersForNewEntries(t *testing.T) {
	storedSliceID := bson.NewObjectID()
	base := bson.A{bson.M{"_id": storedSliceID, "sst": int32(1)}}

	converted := convertSlicesFrom(bson.A{
		bson.M{"sst": int32(1), "session_list": bson.A{bson.M{"name": "internet"}}},
		bson.M{"sst": int32(2)},
	}, base)

	if len(converted) != 2 {
		t.Fatalf("expected two slices, got %d", len(converted))
	}
	first := toMap(converted[0])
	second := toMap(converted[1])
	if id, ok := first["_id"].(bson.ObjectID); !ok || id != storedSliceID {
		t.Errorf("the first slice must keep its identifier, got %v", first["_id"])
	}
	newID, ok := second["_id"].(bson.ObjectID)
	if !ok || newID.IsZero() || newID == storedSliceID {
		t.Errorf("a slice the base does not carry must get a fresh identifier, got %v", second["_id"])
	}
	// A session inside a reused slice is itself new.
	sessions := anySliceOrEmpty(first["session"])
	sessionDoc := toMap(sessions[0])
	if id, ok := sessionDoc["_id"].(bson.ObjectID); !ok || id.IsZero() || id == storedSliceID {
		t.Errorf("a new session must get a fresh identifier, got %v", sessionDoc["_id"])
	}
}

func TestConvertSlicesWithoutBaseAlwaysMints(t *testing.T) {
	legacyOnly := convertSlicesFrom(bson.A{bson.M{"sst": int32(1), "default_indicator": true}}, nil)
	if len(legacyOnly) != 1 {
		t.Fatalf("expected one slice, got %d", len(legacyOnly))
	}
	doc := toMap(legacyOnly[0])
	if id, ok := doc["_id"].(bson.ObjectID); !ok || id.IsZero() {
		t.Fatalf("expected a minted ObjectId, got %v (%T)", doc["_id"], doc["_id"])
	}

	// A subscriber that carries no stored slices has nothing to reuse.
	second := convertSlicesFrom(bson.A{bson.M{"sst": int32(1), "default_indicator": true}}, nil)
	if a, b := toMap(legacyOnly[0])["_id"], toMap(second[0])["_id"]; a == b {
		t.Error("independent conversions must not share an identifier")
	}
}

// ─── Cross-Runtime Fixture Parity ───
// These tests verify that Go produces identical hashes to Node.
// Expected values are committed in src/server/__tests__/profile-apply-fixtures.json

func TestProfileApplyCrossRuntimeFixture(t *testing.T) {
	// Expected values from profile-apply-fixtures.json
	const expectedSubscriberHash = "940bd7a5f1688ea8d33ccb5136606dbc72e74c1d1e90e2fa4410c38b471db6c1"
	const expectedSubscriberHashDifferentProfile = "e38cc16bbf517243595db8125d386465e44652367f88457d669e58281b7a301b"
	const expectedProfileHash = "e4bf1c4b9dde482776785d53a648bef436773a28565af41efd460cf1390f2e6c"
	const expectedFingerprint = "5bd08437e033eac25a8421657974626d192e98937e0de243b8898ad91229d9d6"

	// Fixture subscriber (must match profile-apply-fixtures.ts exactly)
	subscriber := bson.M{
		"schema_version": 1,
		"imsi":           "460001234567890",
		"msisdn":         bson.A{"13800138000", "13900139000"},
		"imeisv":         "",
		"security": bson.M{
			"opc": "aabbccddee00112233445566778899ff",
			"amf": "8000",
			"k":   "00112233445566778899aabbccddeeff",
			"sqn": 1234,
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 50, "unit": 3},
			"uplink":   bson.M{"value": 25, "unit": 3},
		},
		"slice": bson.A{
			bson.M{
				"sst": 1,
				"sd":  "000001",
				"session": bson.A{
					bson.M{
						"name": "internet",
						"type": 3,
						"ambr": bson.M{
							"downlink": bson.M{"value": 50, "unit": 3},
							"uplink":   bson.M{"value": 25, "unit": 3},
						},
						"qos": bson.M{
							"index": 9,
							"arp": bson.M{
								"priority_level":            8,
								"pre_emption_capability":    1,
								"pre_emption_vulnerability": 1,
							},
						},
						"pcc_rule": bson.A{},
					},
				},
			},
		},
		"access_restriction_data":  4,
		"subscriber_status":        0,
		"network_access_mode":      0,
		"subscribed_rau_tau_timer": 0,
		"webui_meta": bson.M{
			"profile_name": "basic-4g",
		},
	}

	// Fixture profile (must match profile-apply-fixtures.ts exactly)
	profile := bson.M{
		"name": "premium-5g",
		"auth": bson.M{
			"opc": "aabbccddee00112233445566778899ff",
			"amf": "8000",
			"k":   "00112233445566778899aabbccddeeff",
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 100, "unit": 3},
			"uplink":   bson.M{"value": 50, "unit": 3},
		},
		"sliceList": bson.A{
			bson.M{
				"sst": 1,
				"sd":  "000001",
				"session_list": bson.A{
					bson.M{
						"name": "internet",
						"type": 3,
						"ambr": bson.M{
							"downlink": bson.M{"value": 100, "unit": 3},
							"uplink":   bson.M{"value": 50, "unit": 3},
						},
						"qos": bson.M{
							"index": 9,
							"arp": bson.M{
								"priority_level":            8,
								"pre_emption_capability":    1,
								"pre_emption_vulnerability": 1,
							},
						},
						"pcc_rule": bson.A{},
					},
				},
			},
		},
		"access_restriction_data": 32,
	}

	t.Run("subscriber hash matches committed JSON", func(t *testing.T) {
		hash := computeSubscriberPreconditionHash(subscriber)
		if hash != expectedSubscriberHash {
			t.Errorf("expected %s, got %s", expectedSubscriberHash, hash)
		}
	})

	t.Run("subscriber hash: different profile_name produces different hash", func(t *testing.T) {
		subDifferent := deepCopyBsonM(subscriber)
		subDifferent["webui_meta"] = bson.M{"profile_name": "standard-5g"}
		hash := computeSubscriberPreconditionHash(subDifferent)
		if hash != expectedSubscriberHashDifferentProfile {
			t.Errorf("expected %s, got %s", expectedSubscriberHashDifferentProfile, hash)
		}
		if hash == expectedSubscriberHash {
			t.Error("expected different hash for different profile_name")
		}
	})

	t.Run("profile hash matches committed JSON", func(t *testing.T) {
		hash := computeProfilePreconditionHash(profile)
		if hash != expectedProfileHash {
			t.Errorf("expected %s, got %s", expectedProfileHash, hash)
		}
	})

	t.Run("fingerprint matches committed JSON", func(t *testing.T) {
		subHash := computeSubscriberPreconditionHash(subscriber)
		profHash := computeProfilePreconditionHash(profile)
		// afterPreview must match Node AFTER_PREVIEW exactly
		after := SafeSnapshot{
			Imsi:                  "460001234567890",
			Msisdn:                []any{"13800138000", "13900139000"},
			AccessRestrictionData: 32,
			NetworkAccessMode:     0,
			Ambr: bson.M{
				"downlink": bson.M{"value": 100, "unit": 3},
				"uplink":   bson.M{"value": 50, "unit": 3},
			},
			Slices: bson.A{
				bson.M{
					"sst": 1,
					"sd":  "000001",
					"session": bson.A{
						bson.M{
							"name": "internet",
							"type": 3,
							"ambr": bson.M{
								"downlink": bson.M{"value": 100, "unit": 3},
								"uplink":   bson.M{"value": 50, "unit": 3},
							},
							"qos": bson.M{
								"index": 9,
								"arp": bson.M{
									"priority_level":            8,
									"pre_emption_capability":    1,
									"pre_emption_vulnerability": 1,
								},
							},
							"pcc_rule": bson.A{},
						},
					},
				},
			},
		}
		fp := computeProfileApplyFingerprint("460001234567890", "premium-5g", subHash, profHash, after)
		if fp != expectedFingerprint {
			t.Errorf("expected %s, got %s", expectedFingerprint, fp)
		}
	})

	t.Run("sentinel: subscriber hash excludes forbidden fields", func(t *testing.T) {
		// Adding enabled, subscriber_status, operator_specific_data must NOT change hash
		withSentinel := deepCopyBsonM(subscriber)
		withSentinel["enabled"] = false
		withSentinel["subscriber_status"] = 1
		withSentinel["operator_specific_data"] = "sentinel-value"
		hash := computeSubscriberPreconditionHash(withSentinel)
		if hash != expectedSubscriberHash {
			t.Errorf("sentinel fields affected hash: expected %s, got %s", expectedSubscriberHash, hash)
		}
	})

	t.Run("sentinel: profile hash excludes forbidden fields", func(t *testing.T) {
		// Adding name, mcc, mnc, enabled must NOT change hash
		withSentinel := deepCopyBsonM(profile)
		withSentinel["name"] = "different-name"
		withSentinel["mcc"] = "999"
		withSentinel["mnc"] = "99"
		withSentinel["enabled"] = false
		hash := computeProfilePreconditionHash(withSentinel)
		if hash != expectedProfileHash {
			t.Errorf("sentinel fields affected hash: expected %s, got %s", expectedProfileHash, hash)
		}
	})
}

// A template binding is recorded in whichever of four fields the writer used.
// The reader must agree with the attribution filter, or a subscriber bound
// through a legacy field is reported as unbound forever.
func TestGetProfileNameReadsEveryAttributionField(t *testing.T) {
	cases := []struct {
		label string
		doc   bson.M
		want  string
	}{
		{"webui_meta.profile_name", bson.M{"webui_meta": bson.M{"profile_name": "Gold"}}, "Gold"},
		{"webui_meta.profile", bson.M{"webui_meta": bson.M{"profile": "Gold"}}, "Gold"},
		{"profile_name", bson.M{"profile_name": "Gold"}, "Gold"},
		{"profile", bson.M{"profile": "Gold"}, "Gold"},
		{"none", bson.M{"imsi": "001010000000001"}, ""},
		{"decoded nested", bson.M{"webui_meta": bson.D{{Key: "profile", Value: "Gold"}}}, "Gold"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			if got := GetProfileName(tc.doc); got != tc.want {
				t.Errorf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestProfileAttributionFilterCoversEveryBindingField(t *testing.T) {
	if ProfileAttributionFilter("") != nil {
		t.Error("an empty template name must add no condition")
	}

	filter := ProfileAttributionFilter("Gold")
	branches, ok := filter["$or"].(bson.A)
	if !ok || len(branches) != 4 {
		t.Fatalf("expected four attribution branches, got %v", filter)
	}
	seen := map[string]bool{}
	for _, branch := range branches {
		entry, ok := branch.(bson.M)
		if !ok {
			t.Fatalf("unexpected branch type %T", branch)
		}
		for key, value := range entry {
			if value != "Gold" {
				t.Errorf("branch %s must match the template name, got %v", key, value)
			}
			seen[key] = true
		}
	}
	for _, field := range profileBindingFields {
		if !seen[field] {
			t.Errorf("attribution filter is missing the %s branch", field)
		}
	}
}

// The same document must not be in sync for the apply path and drifted for the
// probe: both read the attribution through one rule.
func TestProfileDriftTreatsLegacyBindingAsAttribution(t *testing.T) {
	profile := driftTestProfile()
	applied := BuildSubscriberAfterProfileApply(bson.M{"imsi": "001010000000001"}, profile, "Gold")

	// A subscriber whose binding lives only in the legacy field.
	delete(applied, "webui_meta")
	applied["profile"] = "Gold"

	if state, changed := ProfileDrift(applied, profile, "Gold"); state != DriftInSync {
		t.Errorf("a subscriber bound through a legacy field must read as in sync, got %v", changed)
	}
	if !IsProfileApplyNoEffect(applied, profile, "Gold") {
		t.Error("re-applying to a legacy-bound subscriber must classify as no effect")
	}
}
