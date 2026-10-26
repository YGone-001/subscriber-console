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

func TestProfileDriftIgnoresEmbeddedIdentifiers(t *testing.T) {
	profile := driftTestProfile()
	applied := BuildSubscriberAfterProfileApply(bson.M{"imsi": "001010000000001"}, profile, "Gold")

	// A subscriber that already carries the template's content must read as
	// matching, whatever its embedded identifiers are.
	state, changed := ProfileDrift(applied, profile, "Gold")
	if state != DriftInSync {
		t.Fatalf("a subscriber carrying the template content must read as in sync, got %v", changed)
	}

	// Documents written before identifier reuse, or by the batch-create path,
	// carry identifiers this conversion would never produce; content still
	// matches, so the probe must not report drift.
	if state, changed := ProfileDrift(rotatedSliceIDs(applied), profile, "Gold"); state != DriftInSync {
		t.Fatalf("an identifier difference must not be reported as drift, got %v", changed)
	}

	// Conversion reuses the stored identifiers, so the projection is stable.
	again := BuildSubscriberAfterProfileApply(applied, profile, "Gold")
	if stableJSON(applied["slice"]) != stableJSON(again["slice"]) {
		t.Errorf("re-applying must not rewrite embedded identifiers: %s != %s",
			stableJSON(applied["slice"]), stableJSON(again["slice"]))
	}
}

// rotatedSliceIDs replaces every embedded _id in a subscriber's slice array.
func rotatedSliceIDs(doc bson.M) bson.M {
	rotated := deepCopyBsonM(doc)
	rewritten := make(bson.A, 0)
	for _, entry := range anySliceOrEmpty(rotated["slice"]) {
		slice := toMap(entry)
		if slice == nil {
			continue
		}
		slice["_id"] = bson.NewObjectID()
		if slice["session"] != nil {
			sessions := make(bson.A, 0)
			for _, entry := range anySliceOrEmpty(slice["session"]) {
				session := toMap(entry)
				if session == nil {
					continue
				}
				session["_id"] = bson.NewObjectID()
				sessions = append(sessions, session)
			}
			slice["session"] = sessions
		}
		rewritten = append(rewritten, slice)
	}
	rotated["slice"] = rewritten
	return rotated
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
