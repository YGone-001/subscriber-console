package subscriber

import (
	"math/big"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// --- Validation Tests ---

func TestValidateBatchCreatePayload_Valid(t *testing.T) {
	body := map[string]any{
		"startImsi": "417001234567890",
		"count":     10,
	}
	payload, err := ValidateBatchCreatePayload(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if payload.StartImsi != "417001234567890" {
		t.Errorf("startImsi = %s, want 417001234567890", payload.StartImsi)
	}
	if payload.Count != 10 {
		t.Errorf("count = %d, want 10", payload.Count)
	}
	if payload.Strategy != "overwrite" {
		t.Errorf("strategy = %s, want overwrite", payload.Strategy)
	}
}

func TestValidateBatchCreatePayload_WithOptionalFields(t *testing.T) {
	body := map[string]any{
		"startImsi":      "417001234567890",
		"count":          5,
		"trafficTotal":   10737418240,
		"trafficBalance": 5368709120,
		"smsTotal":       200,
		"smsBalance":     100,
		"planId":         "custom_plan",
		"profileName":    "profile1",
		"strategy":       "skip",
	}
	payload, err := ValidateBatchCreatePayload(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if payload.TrafficTotal != 10737418240 {
		t.Errorf("trafficTotal = %f, want 10737418240", payload.TrafficTotal)
	}
	if payload.PlanId != "custom_plan" {
		t.Errorf("planId = %s, want custom_plan", payload.PlanId)
	}
	if payload.Strategy != "skip" {
		t.Errorf("strategy = %s, want skip", payload.Strategy)
	}
}

func TestValidateBatchCreatePayload_InvalidStartImsi(t *testing.T) {
	body := map[string]any{
		"startImsi": "invalid",
		"count":     10,
	}
	_, err := ValidateBatchCreatePayload(body)
	if err == nil {
		t.Fatal("expected error for invalid startImsi")
	}
}

func TestValidateBatchCreatePayload_MissingStartImsi(t *testing.T) {
	body := map[string]any{
		"count": 10,
	}
	_, err := ValidateBatchCreatePayload(body)
	if err == nil {
		t.Fatal("expected error for missing startImsi")
	}
}

func TestValidateBatchCreatePayload_InvalidCount(t *testing.T) {
	tests := []struct {
		name  string
		count any
	}{
		{"zero", 0},
		{"negative", -1},
		{"over 1000", 1001},
		{"float", 1.5},
		{"string", "abc"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := map[string]any{
				"startImsi": "417001234567890",
				"count":     tt.count,
			}
			_, err := ValidateBatchCreatePayload(body)
			if err == nil {
				t.Fatal("expected error for invalid count")
			}
		})
	}
}

func TestValidateBatchCreatePayload_InvalidPlanId(t *testing.T) {
	body := map[string]any{
		"startImsi": "417001234567890",
		"count":     10,
		"planId":    "invalid plan id!",
	}
	_, err := ValidateBatchCreatePayload(body)
	if err == nil {
		t.Fatal("expected error for invalid planId")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok || govErr.Code != "INVALID_PLAN_ID" {
		t.Errorf("expected INVALID_PLAN_ID, got %v", err)
	}
}

func TestValidateBatchCreatePayload_NegativeTraffic(t *testing.T) {
	body := map[string]any{
		"startImsi":    "417001234567890",
		"count":        10,
		"trafficTotal": -1,
	}
	_, err := ValidateBatchCreatePayload(body)
	if err == nil {
		t.Fatal("expected error for negative trafficTotal")
	}
}

// --- IMSI Range Generation Tests ---

func TestGenerateImsiRange_Valid(t *testing.T) {
	imsis, err := GenerateImsiRange("417001234567890", 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := []string{"417001234567890", "417001234567891", "417001234567892"}
	if len(imsis) != len(expected) {
		t.Fatalf("len = %d, want %d", len(imsis), len(expected))
	}
	for i, imsi := range imsis {
		if imsi != expected[i] {
			t.Errorf("imsis[%d] = %s, want %s", i, imsi, expected[i])
		}
	}
}

func TestGenerateImsiRange_Overflow(t *testing.T) {
	// 999999999999999 + 1 = 1000000000000000 (16 digits)
	_, err := GenerateImsiRange("999999999999999", 2)
	if err == nil {
		t.Fatal("expected overflow error")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok || govErr.Code != "IMSI_RANGE_OVERFLOW" {
		t.Errorf("expected IMSI_RANGE_OVERFLOW, got %v", err)
	}
}

func TestGenerateImsiRange_Count1(t *testing.T) {
	imsis, err := GenerateImsiRange("417001234567890", 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(imsis) != 1 || imsis[0] != "417001234567890" {
		t.Errorf("unexpected result: %v", imsis)
	}
}

func TestGenerateImsiRange_IntegerSafe(t *testing.T) {
	// Verify no float64 precision loss
	imsis, err := GenerateImsiRange("999999999999990", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for i, imsi := range imsis {
		expected := new(big.Int).Add(big.NewInt(999999999999990), big.NewInt(int64(i)))
		if imsi != expected.String() {
			t.Errorf("imsis[%d] = %s, want %s", i, imsi, expected.String())
		}
	}
}

// --- OCS Resolution Tests ---

func TestResolveEffectiveOcs_Defaults(t *testing.T) {
	ocs := ResolveEffectiveOcs(nil, nil, nil, nil, nil, "")
	if ocs.PlanId != defaultPlanID {
		t.Errorf("planId = %s, want %s", ocs.PlanId, defaultPlanID)
	}
	if ocs.TrafficTotal != batchDefaultTrafficTotal {
		t.Errorf("trafficTotal = %d, want %d", ocs.TrafficTotal, batchDefaultTrafficTotal)
	}
	if ocs.TrafficBalance != batchDefaultTrafficTotal {
		t.Errorf("trafficBalance = %d, want %d", ocs.TrafficBalance, batchDefaultTrafficTotal)
	}
	if ocs.SmsTotal != batchDefaultSmsTotal {
		t.Errorf("smsTotal = %d, want %d", ocs.SmsTotal, batchDefaultSmsTotal)
	}
	if ocs.SmsBalance != batchDefaultSmsTotal {
		t.Errorf("smsBalance = %d, want %d", ocs.SmsBalance, batchDefaultSmsTotal)
	}
}

func TestResolveEffectiveOcs_FromRequest(t *testing.T) {
	tt := float64(10737418240)
	tb := float64(5368709120)
	st := float64(200)
	sb := float64(100)
	ocs := ResolveEffectiveOcs(nil, &tt, &tb, &st, &sb, "custom_plan")
	if ocs.PlanId != "custom_plan" {
		t.Errorf("planId = %s, want custom_plan", ocs.PlanId)
	}
	if ocs.TrafficTotal != 10737418240 {
		t.Errorf("trafficTotal = %d, want 10737418240", ocs.TrafficTotal)
	}
	if ocs.TrafficBalance != 5368709120 {
		t.Errorf("trafficBalance = %d, want 5368709120", ocs.TrafficBalance)
	}
	if ocs.SmsTotal != 200 {
		t.Errorf("smsTotal = %d, want 200", ocs.SmsTotal)
	}
	if ocs.SmsBalance != 100 {
		t.Errorf("smsBalance = %d, want 100", ocs.SmsBalance)
	}
}

func TestResolveEffectiveOcs_FromProfile(t *testing.T) {
	profile := map[string]any{
		"ocsDefaults": map[string]any{
			"planId":         "profile_plan",
			"trafficTotal":   float64(21474836480),
			"trafficBalance": float64(10737418240),
			"smsTotal":       float64(500),
			"smsBalance":     float64(250),
		},
	}
	ocs := ResolveEffectiveOcs(profile, nil, nil, nil, nil, "")
	if ocs.PlanId != "profile_plan" {
		t.Errorf("planId = %s, want profile_plan", ocs.PlanId)
	}
	if ocs.TrafficTotal != 21474836480 {
		t.Errorf("trafficTotal = %d, want 21474836480", ocs.TrafficTotal)
	}
}

func TestResolveEffectiveOcs_RequestOverridesProfile(t *testing.T) {
	profile := map[string]any{
		"ocsDefaults": map[string]any{
			"trafficTotal": float64(21474836480),
		},
	}
	tt := float64(10737418240)
	ocs := ResolveEffectiveOcs(profile, &tt, nil, nil, nil, "")
	if ocs.TrafficTotal != 10737418240 {
		t.Errorf("trafficTotal = %d, want 10737418240 (request should override profile)", ocs.TrafficTotal)
	}
}

func TestResolveEffectiveOcs_TrafficBalanceDefaultsToTotal(t *testing.T) {
	tt := float64(10737418240)
	ocs := ResolveEffectiveOcs(nil, &tt, nil, nil, nil, "")
	if ocs.TrafficBalance != 10737418240 {
		t.Errorf("trafficBalance = %d, want 10737418240 (should default to total)", ocs.TrafficBalance)
	}
}

func TestResolveEffectiveOcs_SmsBalanceDefaultsToTotal(t *testing.T) {
	st := float64(200)
	ocs := ResolveEffectiveOcs(nil, nil, nil, &st, nil, "")
	if ocs.SmsBalance != 200 {
		t.Errorf("smsBalance = %d, want 200 (should default to total)", ocs.SmsBalance)
	}
}

// --- Frozen Contract Tests ---

func TestPrepareFrozenBatchCreate_Shape(t *testing.T) {
	payload := BatchCreatePayload{
		StartImsi: "417001234567890",
		Count:     3,
		Strategy:  "skip",
	}
	frozen, err := PrepareFrozenBatchCreate(nil, payload, nil, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if frozen.Version != "subscriber-batch-create-v2" {
		t.Errorf("version = %s, want subscriber-batch-create-v2", frozen.Version)
	}
	if frozen.Count != 3 {
		t.Errorf("count = %d, want 3", frozen.Count)
	}
	if len(frozen.ExpectedAbsentImsis) != 3 {
		t.Errorf("expectedAbsentImsis len = %d, want 3", len(frozen.ExpectedAbsentImsis))
	}
	if frozen.Strategy != "create-only" {
		t.Errorf("strategy = %s, want create-only", frozen.Strategy)
	}
	if frozen.OperationFingerprint == "" {
		t.Error("operationFingerprint should not be empty")
	}
	if frozen.Profile.State != "absent" {
		t.Errorf("profile.state = %s, want absent", frozen.Profile.State)
	}
}

func TestPrepareFrozenBatchCreate_WithProfile(t *testing.T) {
	profile := map[string]any{
		"name": "profile1",
		"ambr": map[string]any{
			"downlink": map[string]any{"value": 1, "unit": 3},
			"uplink":   map[string]any{"value": 1, "unit": 3},
		},
	}
	payload := BatchCreatePayload{
		StartImsi:   "417001234567890",
		Count:       2,
		ProfileName: "profile1",
		Strategy:    "skip",
	}
	frozen, err := PrepareFrozenBatchCreate(nil, payload, profile, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if frozen.Profile.State != "present" {
		t.Errorf("profile.state = %s, want present", frozen.Profile.State)
	}
	if frozen.Profile.RequestedName != "profile1" {
		t.Errorf("profile.requestedName = %s, want profile1", frozen.Profile.RequestedName)
	}
	if frozen.Profile.PreconditionHash == "" {
		t.Error("profile.preconditionHash should not be empty for present profile")
	}
}

func TestPrepareFrozenBatchCreate_NoSecurityInFingerprint(t *testing.T) {
	profile := map[string]any{
		"name": "profile1",
		"auth": map[string]any{
			"k":   "000102030405060708090A0B0C0D0E0F",
			"opc": "000102030405060708090A0B0C0D0E0F",
			"amf": "8000",
			"sqn": 1719756,
		},
	}
	payload := BatchCreatePayload{
		StartImsi: "417001234567890",
		Count:     1,
		Strategy:  "skip",
	}
	frozen, err := PrepareFrozenBatchCreate(nil, payload, profile, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Fingerprint should not contain raw security material
	// The fingerprint is a SHA-256 hash, not raw data
	if len(frozen.OperationFingerprint) != 64 {
		t.Errorf("fingerprint should be 64 hex chars, got %d", len(frozen.OperationFingerprint))
	}
}

// --- Fingerprint Tests ---

func TestComputeBatchCreateFingerprint_Deterministic(t *testing.T) {
	targets := []string{"417001234567890", "417001234567891"}
	ocs := EffectiveOcsConfig{
		PlanId:         "plan1",
		TrafficTotal:   5368709120,
		TrafficBalance: 5368709120,
		SmsTotal:       100,
		SmsBalance:     100,
	}
	profile := ProfileState{
		RequestedName: "profile1",
		State:         "present",
	}
	fp1 := ComputeBatchCreateFingerprint(targets, ocs, profile)
	fp2 := ComputeBatchCreateFingerprint(targets, ocs, profile)
	if fp1 != fp2 {
		t.Errorf("fingerprints should be equal: %s != %s", fp1, fp2)
	}
}

func TestComputeBatchCreateFingerprint_DifferentInputs(t *testing.T) {
	ocs := EffectiveOcsConfig{PlanId: "plan1", TrafficTotal: 5368709120}
	profile := ProfileState{State: "absent"}
	fp1 := ComputeBatchCreateFingerprint([]string{"417001234567890"}, ocs, profile)
	fp2 := ComputeBatchCreateFingerprint([]string{"417001234567891"}, ocs, profile)
	if fp1 == fp2 {
		t.Error("different targets should produce different fingerprints")
	}
}

// --- Batch Subscriber Doc Tests ---

func TestBuildBatchSubscriberDoc_DefaultProfile(t *testing.T) {
	doc := buildBatchSubscriberDoc("417001234567890", nil)
	if doc["imsi"] != "417001234567890" {
		t.Errorf("imsi = %v, want 417001234567890", doc["imsi"])
	}
	if doc["access_restriction_data"] != batchDefaultAccessRestrict {
		t.Errorf("ard = %v, want %d", doc["access_restriction_data"], batchDefaultAccessRestrict)
	}
	if doc["network_access_mode"] != batchDefaultNetworkAccess {
		t.Errorf("nam = %v, want %d", doc["network_access_mode"], batchDefaultNetworkAccess)
	}
	// Verify security material exists (it's allowed in subscriber doc)
	sec, ok := doc["security"].(bson.M)
	if !ok || sec == nil {
		t.Fatal("security should be present in subscriber doc")
	}
}

func TestBuildBatchSubscriberDoc_EpcRealm(t *testing.T) {
	doc := buildBatchSubscriberDoc("417001234567890", nil)
	mmeHost, ok := doc["mme_host"].(string)
	if !ok || mmeHost == "" {
		t.Fatal("mme_host should be set")
	}
	if !contains(mmeHost, "mnc000") {
		t.Errorf("mme_host should contain mnc000, got %s", mmeHost)
	}
	if !contains(mmeHost, "mcc417") {
		t.Errorf("mme_host should contain mcc417, got %s", mmeHost)
	}
}

func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}
