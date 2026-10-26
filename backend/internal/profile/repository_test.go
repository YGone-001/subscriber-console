package profile

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestProfileContentSummaryCountsSessionsAndPCCRules(t *testing.T) {
	doc := bson.M{
		"sliceList": bson.A{
			bson.M{
				"session_list": bson.A{
					bson.M{"pcc_rule": bson.A{bson.M{}, bson.M{}}},
					bson.M{},
				},
			},
			bson.M{"session_list": bson.A{bson.M{"pcc_rule": bson.A{bson.M{}}}}},
			bson.M{},
		},
	}

	sessions, rules := profileContentSummary(doc)
	if sessions != 3 {
		t.Errorf("expected 3 sessions, got %d", sessions)
	}
	if rules != 3 {
		t.Errorf("expected 3 PCC rules, got %d", rules)
	}
}

func TestProfileContentSummaryHandlesDecodedDocumentShapes(t *testing.T) {
	// Nested documents and arrays decode as bson.D / []any depending on the
	// target, which is why the summary cannot rely on a single assertion.
	doc := bson.M{
		"sliceList": []any{
			bson.D{{Key: "session_list", Value: []any{
				bson.D{{Key: "pcc_rule", Value: []any{bson.M{}}}},
			}}},
		},
	}

	sessions, rules := profileContentSummary(doc)
	if sessions != 1 {
		t.Errorf("expected 1 session, got %d", sessions)
	}
	if rules != 1 {
		t.Errorf("expected 1 PCC rule, got %d", rules)
	}
}

func TestProfileAMBRReportsOnlyDeclaredSides(t *testing.T) {
	doc := bson.M{
		"ambr": bson.M{
			"downlink": bson.M{"unit": int32(2), "value": int32(100)},
			"uplink":   bson.M{"unit": int32(2), "value": int32(50)},
		},
	}
	ambr := profileAMBR(doc)
	if ambr == nil {
		t.Fatal("expected AMBR projection")
	}
	if ambr.Downlink == nil || ambr.Downlink.Value != 100 || ambr.Downlink.Unit != 2 {
		t.Errorf("unexpected downlink: %+v", ambr.Downlink)
	}
	if ambr.Uplink == nil || ambr.Uplink.Value != 50 {
		t.Errorf("unexpected uplink: %+v", ambr.Uplink)
	}

	if profileAMBR(bson.M{}) != nil {
		t.Error("a template without AMBR must project nil")
	}

	partial := profileAMBR(bson.M{"ambr": bson.M{"downlink": bson.M{"value": int32(100)}}})
	if partial != nil {
		t.Error("a side without a unit must not be reported as measured")
	}
}

func TestOptionalIntFieldKeepsMissingDistinctFromZero(t *testing.T) {
	if optionalIntField(bson.M{}, "access_restriction_data") != nil {
		t.Error("absent field must project nil")
	}

	zero := optionalIntField(bson.M{"access_restriction_data": int32(0)}, "access_restriction_data")
	if zero == nil {
		t.Fatal("an explicit zero must be reported")
	}
	if *zero != 0 {
		t.Errorf("expected 0, got %d", *zero)
	}

	suspended := optionalIntField(bson.M{"access_restriction_data": int32(255)}, "access_restriction_data")
	if suspended == nil || *suspended != 255 {
		t.Errorf("expected 255, got %v", suspended)
	}
}

func TestHasOCSDefaultsIgnoresEmptyObject(t *testing.T) {
	if hasOCSDefaults(bson.M{}) {
		t.Error("a template without ocsDefaults must not report configured")
	}
	if hasOCSDefaults(bson.M{"ocsDefaults": bson.M{}}) {
		t.Error("an empty ocsDefaults object must not report configured")
	}
	if !hasOCSDefaults(bson.M{"ocsDefaults": bson.M{"planId": "plan_default_10gb"}}) {
		t.Error("a declared ocsDefaults must report configured")
	}
}
