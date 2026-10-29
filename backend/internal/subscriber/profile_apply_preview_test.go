package subscriber

import (
	"context"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestBuildProfileApplyPreviewReportsChangesAndBindsToken(t *testing.T) {
	subscriber := bson.M{
		"imsi":                    "460001234567890",
		"access_restriction_data": int64(0),
		"ambr":                    bson.M{"downlink": bson.M{"value": int64(100), "unit": int64(2)}},
		"slice":                   bson.A{},
		"security":                bson.M{"k": "00112233445566778899aabbccddeeff", "opc": "11112222333344445555666677778888"},
	}
	profile := bson.M{
		"name":                    "tpl-a",
		"access_restriction_data": int64(32),
		"ambr":                    bson.M{"downlink": bson.M{"value": int64(200), "unit": int64(2)}},
		"sliceList":               bson.A{},
		"auth":                    bson.M{"k": "00112233445566778899aabbccddeeff", "opc": "99992222333344445555666677778888"},
	}
	lookup := func(context.Context, string) (bson.M, error) { return subscriber, nil }
	profileLookup := func(context.Context, string) (bson.M, error) { return profile, nil }

	preview, err := BuildProfileApplyPreview(context.Background(), "460001234567890", "tpl-a", lookup, profileLookup)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.State != DriftChanged || preview.NoEffect {
		t.Fatalf("state=%q noEffect=%v, want changed", preview.State, preview.NoEffect)
	}
	if !preview.SecurityChanged {
		t.Fatal("credential change must be reported")
	}
	if preview.PreviewToken == "" {
		t.Fatal("preview token must be present")
	}
	if len(preview.ChangedGroups) == 0 {
		t.Fatal("changed groups must be reported")
	}

	intent, err := PrepareFrozenSubscriberProfileApply(context.Background(), "460001234567890", "tpl-a", lookup, profileLookup)
	if err != nil {
		t.Fatalf("prepare apply: %v", err)
	}
	if preview.PreviewToken != intent.OperationFingerprint {
		t.Fatalf("preview token must bind the apply intent: %q != %q", preview.PreviewToken, intent.OperationFingerprint)
	}

	archivedProfile := bson.M{
		"name":      "tpl-a",
		"archived":  true,
		"auth":      profile["auth"],
		"ambr":      profile["ambr"],
		"sliceList": profile["sliceList"],
	}
	archivedLookup := func(context.Context, string) (bson.M, error) { return archivedProfile, nil }
	if _, err := BuildProfileApplyPreview(context.Background(), "460001234567890", "tpl-a", lookup, archivedLookup); err == nil {
		t.Fatal("an archived profile must not be previewed")
	}

	applied := BuildSubscriberAfterProfileApply(subscriber, profile, "tpl-a")
	sameLookup := func(context.Context, string) (bson.M, error) { return applied, nil }
	noChange, err := BuildProfileApplyPreview(context.Background(), "460001234567890", "tpl-a", sameLookup, profileLookup)
	if err != nil {
		t.Fatalf("preview in-sync: %v", err)
	}
	if !noChange.NoEffect || noChange.State != DriftInSync {
		t.Fatalf("expected no-effect preview, got %+v", noChange)
	}
}
