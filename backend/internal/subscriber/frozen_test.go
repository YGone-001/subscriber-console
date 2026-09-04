package subscriber

import (
	"context"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestSubscriberSafeSnapshot_ExcludesSecurity(t *testing.T) {
	doc := bson.M{
		"imsi":                    "310260123456789",
		"msisdn":                  bson.A{"1234567890"},
		"access_restriction_data": 32,
		"network_access_mode":     2,
		"ambr":                    bson.M{"downlink": bson.M{"value": 1, "unit": 3}},
		"slice":                   bson.A{},
		"security":                bson.M{"k": "secret", "op": "secret", "opc": "secret"},
	}

	snap := SubscriberSafeSnapshot(doc)

	if snap.Imsi != "310260123456789" {
		t.Errorf("expected imsi 310260123456789, got %s", snap.Imsi)
	}
	if len(snap.Msisdn) != 1 {
		t.Errorf("expected 1 msisdn, got %d", len(snap.Msisdn))
	}
	if snap.AccessRestrictionData != 32 {
		t.Errorf("expected ARD 32, got %d", snap.AccessRestrictionData)
	}
	if snap.NetworkAccessMode != 2 {
		t.Errorf("expected NAM 2, got %d", snap.NetworkAccessMode)
	}

	// Verify no security fields leak
	data := stableJSON(snap)
	if containsSubstring(data, "secret") {
		t.Error("safe snapshot must not contain security material")
	}
	if containsSubstring(data, "security") {
		t.Error("safe snapshot must not contain security field")
	}
}

func TestSubscriberSafeSnapshot_NilMsisdn(t *testing.T) {
	doc := bson.M{
		"imsi": "310260123456789",
	}

	snap := SubscriberSafeSnapshot(doc)
	if snap.Msisdn != nil {
		t.Errorf("expected nil msisdn, got %v", snap.Msisdn)
	}
}

func TestPrepareFrozenSubscriberUpdate_Success(t *testing.T) {
	existing := bson.M{
		"imsi":                    "310260123456789",
		"msisdn":                  bson.A{"1234567890"},
		"access_restriction_data": 0,
		"network_access_mode":     0,
		"ambr":                    bson.M{"downlink": bson.M{"value": 1, "unit": 3}},
		"slice":                   bson.A{},
	}

	lookup := func(_ context.Context, imsi string) (bson.M, error) {
		if imsi == "310260123456789" {
			return existing, nil
		}
		return nil, nil
	}

	payload := UpdatePayload{
		Sub4G: map[string]any{
			"access_restriction_data": 32,
		},
	}

	frozen, err := PrepareFrozenSubscriberUpdate(context.Background(), "310260123456789", payload, lookup)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if frozen.Version != "subscriber-update-v1" {
		t.Errorf("expected version subscriber-update-v1, got %s", frozen.Version)
	}
	if frozen.Imsi != "310260123456789" {
		t.Errorf("expected imsi 310260123456789, got %s", frozen.Imsi)
	}
	if frozen.Before.AccessRestrictionData != 0 {
		t.Errorf("expected before ARD 0, got %d", frozen.Before.AccessRestrictionData)
	}
	if frozen.After.AccessRestrictionData != 32 {
		t.Errorf("expected after ARD 32, got %d", frozen.After.AccessRestrictionData)
	}
}

func TestPrepareFrozenSubscriberUpdate_NotFound(t *testing.T) {
	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return nil, nil
	}

	_, err := PrepareFrozenSubscriberUpdate(context.Background(), "310260123456789", UpdatePayload{}, lookup)
	if err == nil {
		t.Fatal("expected error")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != "SUBSCRIBER_NOT_FOUND" {
		t.Errorf("expected SUBSCRIBER_NOT_FOUND, got %s", govErr.Code)
	}
}

func TestPrepareFrozenSubscriberUpdate_AuthMaterialChange(t *testing.T) {
	existing := bson.M{
		"imsi":     "310260123456789",
		"security": bson.M{"k": "00112233445566778899AABBCCDDEEFF"},
	}

	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return existing, nil
	}

	payload := UpdatePayload{
		Auth4G: map[string]any{
			"k": "AABBCCDD00112233445566778899EEFF",
		},
	}

	_, err := PrepareFrozenSubscriberUpdate(context.Background(), "310260123456789", payload, lookup)
	if err == nil {
		t.Fatal("expected error for auth material change")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED" {
		t.Errorf("expected SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED, got %s", govErr.Code)
	}
}

func TestPrepareFrozenSubscriberUpdate_SameAuthMaterial(t *testing.T) {
	existing := bson.M{
		"imsi":                    "310260123456789",
		"access_restriction_data": 0,
		"security":                bson.M{"k": "00112233445566778899AABBCCDDEEFF"},
	}

	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return existing, nil
	}

	payload := UpdatePayload{
		Auth4G: map[string]any{
			"k": "00112233445566778899AABBCCDDEEFF",
		},
		Sub4G: map[string]any{
			"access_restriction_data": 32,
		},
	}

	frozen, err := PrepareFrozenSubscriberUpdate(context.Background(), "310260123456789", payload, lookup)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Auth should be stripped from frozen payload
	if frozen.Payload.Auth4G != nil {
		t.Error("frozen payload must not contain auth4G")
	}
}

func TestPrepareFrozenSubscriberUpdate_NoEffect(t *testing.T) {
	existing := bson.M{
		"imsi":                    "310260123456789",
		"access_restriction_data": 32,
	}

	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return existing, nil
	}

	payload := UpdatePayload{
		Sub4G: map[string]any{
			"access_restriction_data": 32,
		},
	}

	_, err := PrepareFrozenSubscriberUpdate(context.Background(), "310260123456789", payload, lookup)
	if err == nil {
		t.Fatal("expected error for no-effect update")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != "SUBSCRIBER_UPDATE_NO_EFFECT" {
		t.Errorf("expected SUBSCRIBER_UPDATE_NO_EFFECT, got %s", govErr.Code)
	}
}

func TestExecuteFrozenSubscriberUpdate_Success(t *testing.T) {
	existing := bson.M{
		"imsi":                    "310260123456789",
		"access_restriction_data": 0,
	}

	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return existing, nil
	}

	write := func(_ context.Context, imsi string, _ UpdatePayload, _ bson.M) (bson.M, error) {
		updated := bson.M{
			"imsi":                    imsi,
			"access_restriction_data": 32,
		}
		return updated, nil
	}

	frozen := &FrozenSubscriberUpdate{
		Version: "subscriber-update-v1",
		Imsi:    "310260123456789",
		Before:  SubscriberSafeSnapshot(existing),
	}

	result, err := ExecuteFrozenSubscriberUpdate(context.Background(), frozen, lookup, write)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Imsi != "310260123456789" {
		t.Errorf("expected imsi 310260123456789, got %s", result.Imsi)
	}
}

func TestExecuteFrozenSubscriberUpdate_PreconditionChanged(t *testing.T) {
	existing := bson.M{
		"imsi":                    "310260123456789",
		"access_restriction_data": 0,
	}

	changed := bson.M{
		"imsi":                    "310260123456789",
		"access_restriction_data": 64, // Changed!
	}

	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return changed, nil
	}

	write := func(_ context.Context, _ string, _ UpdatePayload, _ bson.M) (bson.M, error) {
		return nil, nil
	}

	frozen := &FrozenSubscriberUpdate{
		Version: "subscriber-update-v1",
		Imsi:    "310260123456789",
		Before:  SubscriberSafeSnapshot(existing),
	}

	_, err := ExecuteFrozenSubscriberUpdate(context.Background(), frozen, lookup, write)
	if err == nil {
		t.Fatal("expected error for precondition changed")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED" {
		t.Errorf("expected SUBSCRIBER_UPDATE_PRECONDITION_CHANGED, got %s", govErr.Code)
	}
}

func TestExecuteFrozenSubscriberDelete_Success(t *testing.T) {
	existing := bson.M{
		"imsi": "310260123456789",
	}

	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return existing, nil
	}

	deleteFn := func(_ context.Context, _ string, _ bson.M) (bool, error) {
		return true, nil
	}

	frozen := &FrozenSubscriberDelete{
		Version: "subscriber-delete-v1",
		Imsi:    "310260123456789",
		Before:  SubscriberSafeSnapshot(existing),
	}

	result, err := ExecuteFrozenSubscriberDelete(context.Background(), frozen, lookup, deleteFn)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Deleted {
		t.Error("expected deleted=true")
	}
}

func TestExecuteFrozenSubscriberDelete_PreconditionChanged(t *testing.T) {
	existing := bson.M{
		"imsi": "310260123456789",
	}

	lookup := func(_ context.Context, _ string) (bson.M, error) {
		return nil, nil // Subscriber no longer exists
	}

	deleteFn := func(_ context.Context, _ string, _ bson.M) (bool, error) {
		return false, nil
	}

	frozen := &FrozenSubscriberDelete{
		Version: "subscriber-delete-v1",
		Imsi:    "310260123456789",
		Before:  SubscriberSafeSnapshot(existing),
	}

	_, err := ExecuteFrozenSubscriberDelete(context.Background(), frozen, lookup, deleteFn)
	if err == nil {
		t.Fatal("expected error for precondition changed")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != "SUBSCRIBER_DELETE_PRECONDITION_CHANGED" {
		t.Errorf("expected SUBSCRIBER_DELETE_PRECONDITION_CHANGED, got %s", govErr.Code)
	}
}

func containsSubstring(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsAt(s, sub))
}

func containsAt(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
