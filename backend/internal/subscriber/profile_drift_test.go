package subscriber

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func driftTestProfile() bson.M {
	return bson.M{
		"name":                    "Gold",
		"auth":                    bson.M{"k": "465b2ce5b8a37f2e19d4a6c8b0e2f417", "opc": "cd6cfa9c8ed9c4c7f5e0d2a9b6c3e4f5", "amf": "8000"},
		"ambr":                    bson.M{"downlink": bson.M{"unit": int32(2), "value": int32(100)}, "uplink": bson.M{"unit": int32(2), "value": int32(50)}},
		"access_restriction_data": int32(0),
		"sliceList": bson.A{bson.M{
			"sd": "000001", "sst": int32(1), "default_indicator": true,
			"session_list": bson.A{bson.M{"name": "internet", "type": int32(1), "pcc_rule": bson.A{}}},
		}},
	}
}

func TestProfileDriftIgnoresMintedEmbeddedIdentifiers(t *testing.T) {
	profile := driftTestProfile()
	applied := BuildSubscriberAfterProfileApply(bson.M{"imsi": "001010000000001"}, profile, "Gold")

	// The slice conversion mints a fresh ObjectId per sub-document on every write,
	// so a subscriber that already carries the template's content must still read
	// as matching or the probe would report permanent drift.
	state, changed := ProfileDrift(applied, profile, "Gold")
	if state != DriftInSync {
		t.Fatalf("a subscriber carrying the template content must read as in sync, got %v", changed)
	}

	// The churn is real in the stored document: the identifiers differ.
	again := BuildSubscriberAfterProfileApply(applied, profile, "Gold")
	if stableJSON(applied["slice"]) == stableJSON(again["slice"]) {
		t.Fatal("the fixture no longer reproduces the identifier churn the probe must tolerate")
	}
}

func TestProfileDriftReportsRealContentDifferences(t *testing.T) {
	profile := driftTestProfile()

	state, changed := ProfileDrift(bson.M{"imsi": "001010000000002"}, profile, "Gold")
	if state != DriftChanged {
		t.Fatalf("an unprovisioned subscriber must read as changed, got %v", state)
	}
	for _, want := range []string{"security", "ambr", "slice", "access_restriction_data", "profile_name"} {
		found := false
		for _, group := range changed {
			if group == want {
				found = true
			}
		}
		if !found {
			t.Errorf("expected %s among the changed groups, got %v", want, changed)
		}
	}

	applied := BuildSubscriberAfterProfileApply(bson.M{"imsi": "001010000000003"}, profile, "Gold")
	applied["ambr"] = bson.M{"downlink": bson.M{"unit": int32(2), "value": int32(7)}, "uplink": bson.M{"unit": int32(2), "value": int32(7)}}
	state, changed = ProfileDrift(applied, profile, "Gold")
	if state != DriftChanged || len(changed) != 1 || changed[0] != "ambr" {
		t.Errorf("an ambr edit must surface alone, got %v %v", state, changed)
	}

	// A different binding is reported apart from the provisioning content.
	unbound := BuildSubscriberAfterProfileApply(bson.M{"imsi": "001010000000004"}, profile, "Gold")
	state, changed = ProfileDrift(unbound, profile, "Other")
	if state != DriftChanged || len(changed) != 1 || changed[0] != "profile_name" {
		t.Errorf("a rebind must surface as profile_name alone, got %v %v", state, changed)
	}
}
