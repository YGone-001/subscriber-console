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
			"opc":       "old-opc",
			"amf":       "8000",
			"key":       "00112233445566778899aabbccddeeff",
			"algorithm": "milenage",
			"sqn":       "000000001234",
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
				"opc":       "aabbccddee00112233445566778899ff",
				"amf":       "8000",
				"key":       "00112233445566778899aabbccddeeff",
				"algorithm": "milenage",
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
				"key": "00112233445566778899aabbccddeeff",
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
		"sliceList": bson.A{},
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
			"opc":       "same-opc",
			"amf":       "8000",
			"key":       "key",
			"algorithm": "milenage",
			"sqn":       "1234",
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 100, "unit": 3},
			"uplink":   bson.M{"value": 50, "unit": 3},
		},
		"slice":                  bson.A{},
		"access_restriction_data": 32,
		"webui_meta": bson.M{
			"profile_name": "same-profile",
		},
	}

	profile := bson.M{
		"name": "same-profile",
		"auth": bson.M{
			"opc":       "same-opc",
			"amf":       "8000",
			"key":       "key",
			"algorithm": "milenage",
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 100, "unit": 3},
			"uplink":   bson.M{"value": 50, "unit": 3},
		},
		"sliceList":              bson.A{},
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
		if getProfileName(doc) != "test-profile" {
			t.Errorf("expected test-profile, got %s", getProfileName(doc))
		}
	})

	t.Run("without webui_meta", func(t *testing.T) {
		doc := bson.M{}
		if getProfileName(doc) != "" {
			t.Errorf("expected empty, got %s", getProfileName(doc))
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
