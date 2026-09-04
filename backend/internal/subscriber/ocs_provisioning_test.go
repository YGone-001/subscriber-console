package subscriber

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ocsTestRepo creates a test repository connected to a test database.
// Returns the repo and a cleanup function.
func ocsTestRepo(t *testing.T) (*Repository, func()) {
	t.Helper()

	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}

	dbName := "xcloud_test_ocs_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)
	opsDb := client.Database(dbName + "_ops")

	repo := &Repository{
		subscribers: db.Collection("subscribers"),
		ocsSubs:     db.Collection("ocs_subscribers"),
		ocsBalances: db.Collection("ocs_balances"),
		tariffPlans: db.Collection("ocs_tariff_plans"),
	}

	cleanup := func() {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		_ = db.Drop(ctx2)
		_ = opsDb.Drop(ctx2)
		_ = client.Disconnect(ctx2)
	}

	return repo, cleanup
}

// TestProvisionOcsSubscriber_PlanPreserved verifies that when PlanID is nil,
// existing plan_id is preserved (not defaulted to plan_default_10gb).
func TestProvisionOcsSubscriber_PlanPreserved(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417001234567890"
	customPlan := "custom_plan_50gb"

	// Create custom plan in test DB
	_, err := repo.tariffPlans.InsertOne(ctx, bson.M{
		"plan_id": customPlan,
		"name":    "Custom 50GB",
		"status":  "active",
	})
	if err != nil {
		t.Fatalf("insert custom plan: %v", err)
	}

	// First provision — creates with custom plan
	err = repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI:   imsi,
		PlanID: &customPlan,
	})
	if err != nil {
		t.Fatalf("first provision: %v", err)
	}

	// Second provision — no PlanID (nil) — should preserve custom plan
	err = repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI: imsi,
	})
	if err != nil {
		t.Fatalf("second provision: %v", err)
	}

	// Verify plan preserved
	var ocsSub bson.M
	err = repo.ocsSubs.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&ocsSub)
	if err != nil {
		t.Fatalf("find ocs_subscriber: %v", err)
	}
	if ocsSub["plan_id"] != customPlan {
		t.Errorf("plan_id = %v, want %v (preserved)", ocsSub["plan_id"], customPlan)
	}
}

// TestProvisionOcsSubscriber_PlanDefaultsForNew verifies that when PlanID is nil
// and no existing subscriber, defaults to plan_default_10gb.
func TestProvisionOcsSubscriber_PlanDefaultsForNew(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417009999999999"

	// Provision new — no PlanID — should default
	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI: imsi,
	})
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	var ocsSub bson.M
	err = repo.ocsSubs.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&ocsSub)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if ocsSub["plan_id"] != defaultPlanID {
		t.Errorf("plan_id = %v, want %v (default)", ocsSub["plan_id"], defaultPlanID)
	}
}

// TestProvisionOcsSubscriber_MsisdnPresence verifies MSISDN presence semantics:
// - nil = preserve existing (don't $set)
// - pointer = explicit value
func TestProvisionOcsSubscriber_MsisdnPresence(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417001111111111"
	msisdn1 := "1234567890"
	msisdn2 := "9876543210"

	// First provision — set MSISDN
	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI:   imsi,
		MSISDN: &msisdn1,
	})
	if err != nil {
		t.Fatalf("first provision: %v", err)
	}

	// Second provision — nil MSISDN — should preserve existing
	err = repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI: imsi,
	})
	if err != nil {
		t.Fatalf("second provision: %v", err)
	}

	var ocsSub bson.M
	err = repo.ocsSubs.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&ocsSub)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if ocsSub["msisdn"] != msisdn1 {
		t.Errorf("msisdn = %v, want %v (preserved)", ocsSub["msisdn"], msisdn1)
	}

	// Third provision — explicit MSISDN — should update
	err = repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI:   imsi,
		MSISDN: &msisdn2,
	})
	if err != nil {
		t.Fatalf("third provision: %v", err)
	}

	err = repo.ocsSubs.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&ocsSub)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if ocsSub["msisdn"] != msisdn2 {
		t.Errorf("msisdn = %v, want %v (updated)", ocsSub["msisdn"], msisdn2)
	}
}

// TestProvisionOcsSubscriber_MsisdnDefaultForNew verifies new subscriber
// without MSISDN gets empty string via $setOnInsert.
func TestProvisionOcsSubscriber_MsisdnDefaultForNew(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417002222222222"

	// Provision new — no MSISDN — should default to ""
	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI: imsi,
	})
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	var ocsSub bson.M
	err = repo.ocsSubs.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&ocsSub)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if ocsSub["msisdn"] != "" {
		t.Errorf("msisdn = %v, want empty string (default for new)", ocsSub["msisdn"])
	}
}

// TestProvisionOcsSubscriber_DataBalanceNew verifies data balance defaults
// for a new subscriber: 10GB total, 0 reserved, 0 used.
func TestProvisionOcsSubscriber_DataBalanceNew(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417003333333333"

	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI: imsi,
	})
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	var bal bson.M
	err = repo.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&bal)
	if err != nil {
		t.Fatalf("find balance: %v", err)
	}

	if numericInt64(bal["data_total"]) != defaultTotalBalance {
		t.Errorf("data_total = %v, want %v", bal["data_total"], defaultTotalBalance)
	}
	if numericInt64(bal["data_reserved"]) != 0 {
		t.Errorf("data_reserved = %v, want 0", bal["data_reserved"])
	}
	if numericInt64(bal["data_used"]) != 0 {
		t.Errorf("data_used = %v, want 0", bal["data_used"])
	}
}

// TestProvisionOcsSubscriber_DataBalanceWithAvailable verifies data balance
// when explicit available is provided: used = total - available.
func TestProvisionOcsSubscriber_DataBalanceWithAvailable(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417004444444444"
	total := int64(10 * 1024 * 1024 * 1024)    // 10GB
	available := int64(5 * 1024 * 1024 * 1024) // 5GB

	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI:          imsi,
		DataTotal:     &total,
		DataAvailable: &available,
	})
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	var bal bson.M
	err = repo.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&bal)
	if err != nil {
		t.Fatalf("find balance: %v", err)
	}

	if numericInt64(bal["data_total"]) != total {
		t.Errorf("data_total = %v, want %v", bal["data_total"], total)
	}
	if numericInt64(bal["data_available"]) != available {
		t.Errorf("data_available = %v, want %v", bal["data_available"], available)
	}
	// used = total - reserved - available = 10GB - 10MB - 5GB
	expectedUsed := total - defaultQuotaPerGrant - available
	if numericInt64(bal["data_used"]) != expectedUsed {
		t.Errorf("data_used = %v, want %v", bal["data_used"], expectedUsed)
	}
	// reserved = QUOTA_PER_GRANT because available < total
	if numericInt64(bal["data_reserved"]) != defaultQuotaPerGrant {
		t.Errorf("data_reserved = %v, want %v", bal["data_reserved"], defaultQuotaPerGrant)
	}
}

// TestProvisionOcsSubscriber_VoiceSmsPreservation verifies voice/SMS balances
// are preserved when not explicitly provided (nil = preserve existing).
func TestProvisionOcsSubscriber_VoiceSmsPreservation(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417005555555555"
	voiceTotal := int64(7200) // 120 minutes
	smsTotal := int64(200)

	// First provision — set voice and SMS
	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI:       imsi,
		VoiceTotal: &voiceTotal,
		SMSTotal:   &smsTotal,
	})
	if err != nil {
		t.Fatalf("first provision: %v", err)
	}

	// Second provision — no voice/SMS — should preserve (use default plan)
	err = repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI: imsi,
	})
	if err != nil {
		t.Fatalf("second provision: %v", err)
	}

	var bal bson.M
	err = repo.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&bal)
	if err != nil {
		t.Fatalf("find balance: %v", err)
	}

	if numericInt64(bal["voice_total"]) != voiceTotal {
		t.Errorf("voice_total = %v, want %v (preserved)", bal["voice_total"], voiceTotal)
	}
	if numericInt64(bal["sms_total"]) != smsTotal {
		t.Errorf("sms_total = %v, want %v (preserved)", bal["sms_total"], smsTotal)
	}
}

// TestProvisionOcsSubscriber_VoiceSmsDefaults verifies voice/SMS defaults
// for a new subscriber.
func TestProvisionOcsSubscriber_VoiceSmsDefaults(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	imsi := "417006666666666"

	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI: imsi,
	})
	if err != nil {
		t.Fatalf("provision: %v", err)
	}

	var bal bson.M
	err = repo.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&bal)
	if err != nil {
		t.Fatalf("find balance: %v", err)
	}

	if numericInt64(bal["voice_total"]) != defaultVoiceTotal {
		t.Errorf("voice_total = %v, want %v", bal["voice_total"], defaultVoiceTotal)
	}
	if numericInt64(bal["sms_total"]) != defaultSmsTotal {
		t.Errorf("sms_total = %v, want %v", bal["sms_total"], defaultSmsTotal)
	}
}

// TestMapOcsTrafficToInput verifies that the HTTP ocsTraffic payload (snake_case)
// maps exactly to OcsProvisioningInput. No value may be silently discarded.
func TestMapOcsTrafficToInput(t *testing.T) {
	ocs := map[string]any{
		"traffic_total":   1000,
		"traffic_balance": 800,
		"voice_total":     500,
		"voice_balance":   400,
		"sms_total":       100,
		"sms_balance":     90,
	}

	input := OcsProvisioningInput{IMSI: "test"}
	mapOcsTrafficToInput(ocs, &input)

	// All six values must reach input
	if input.DataTotal == nil || *input.DataTotal != 1000 {
		t.Errorf("DataTotal = %v, want 1000", input.DataTotal)
	}
	if input.DataAvailable == nil || *input.DataAvailable != 800 {
		t.Errorf("DataAvailable = %v, want 800", input.DataAvailable)
	}
	if input.VoiceTotal == nil || *input.VoiceTotal != 500 {
		t.Errorf("VoiceTotal = %v, want 500", input.VoiceTotal)
	}
	if input.VoiceAvailable == nil || *input.VoiceAvailable != 400 {
		t.Errorf("VoiceAvailable = %v, want 400", input.VoiceAvailable)
	}
	if input.SMSTotal == nil || *input.SMSTotal != 100 {
		t.Errorf("SMSTotal = %v, want 100", input.SMSTotal)
	}
	if input.SMSAvailable == nil || *input.SMSAvailable != 90 {
		t.Errorf("SMSAvailable = %v, want 90", input.SMSAvailable)
	}
}

// TestMapOcsTrafficToInput_PlanIdFallback verifies planId ?? plan_id fallback.
func TestMapOcsTrafficToInput_PlanIdFallback(t *testing.T) {
	// planId takes precedence
	ocs1 := map[string]any{
		"planId":  "plan_a",
		"plan_id": "plan_b",
	}
	input1 := OcsProvisioningInput{IMSI: "test"}
	mapOcsTrafficToInput(ocs1, &input1)
	if input1.PlanID == nil || *input1.PlanID != "plan_a" {
		t.Errorf("PlanID = %v, want plan_a (planId takes precedence)", input1.PlanID)
	}

	// plan_id fallback when planId absent
	ocs2 := map[string]any{
		"plan_id": "plan_b",
	}
	input2 := OcsProvisioningInput{IMSI: "test"}
	mapOcsTrafficToInput(ocs2, &input2)
	if input2.PlanID == nil || *input2.PlanID != "plan_b" {
		t.Errorf("PlanID = %v, want plan_b (plan_id fallback)", input2.PlanID)
	}

	// Neither present → nil
	ocs3 := map[string]any{}
	input3 := OcsProvisioningInput{IMSI: "test"}
	mapOcsTrafficToInput(ocs3, &input3)
	if input3.PlanID != nil {
		t.Errorf("PlanID = %v, want nil (neither present)", input3.PlanID)
	}
}

// TestMapOcsTrafficToInput_EmptyPayload verifies empty ocsTraffic doesn't set any fields.
func TestMapOcsTrafficToInput_EmptyPayload(t *testing.T) {
	ocs := map[string]any{}
	input := OcsProvisioningInput{IMSI: "test"}
	mapOcsTrafficToInput(ocs, &input)

	if input.PlanID != nil {
		t.Errorf("PlanID = %v, want nil", input.PlanID)
	}
	if input.DataTotal != nil {
		t.Errorf("DataTotal = %v, want nil", input.DataTotal)
	}
	if input.DataAvailable != nil {
		t.Errorf("DataAvailable = %v, want nil", input.DataAvailable)
	}
	if input.VoiceTotal != nil {
		t.Errorf("VoiceTotal = %v, want nil", input.VoiceTotal)
	}
	if input.VoiceAvailable != nil {
		t.Errorf("VoiceAvailable = %v, want nil", input.VoiceAvailable)
	}
	if input.SMSTotal != nil {
		t.Errorf("SMSTotal = %v, want nil", input.SMSTotal)
	}
	if input.SMSAvailable != nil {
		t.Errorf("SMSAvailable = %v, want nil", input.SMSAvailable)
	}
}

// TestGetOrCreateDefaultTariffPlan_Creates verifies that requesting the default plan
// when it doesn't exist creates it with the canonical schema.
func TestGetOrCreateDefaultTariffPlan_Creates(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	plan, err := repo.getOrCreateDefaultTariffPlan(ctx)
	if err != nil {
		t.Fatalf("getOrCreateDefaultTariffPlan: %v", err)
	}

	if plan["plan_id"] != defaultPlanID {
		t.Errorf("plan_id = %v, want %v", plan["plan_id"], defaultPlanID)
	}
	if plan["name"] != "Default 10GB Data Plan" {
		t.Errorf("name = %v, want 'Default 10GB Data Plan'", plan["name"])
	}
	if plan["status"] != "active" {
		t.Errorf("status = %v, want active", plan["status"])
	}
	if plan["unit"] != "bytes" {
		t.Errorf("unit = %v, want bytes", plan["unit"])
	}

	// Verify rules
	rules, ok := plan["rules"].([]any)
	if !ok {
		t.Fatalf("rules type = %T, want []any", plan["rules"])
	}
	if len(rules) != 4 {
		t.Errorf("rules len = %d, want 4", len(rules))
	}
}

// TestGetOrCreateDefaultTariffPlan_Idempotent verifies duplicate creation race tolerance.
func TestGetOrCreateDefaultTariffPlan_Idempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	// First call creates
	plan1, err := repo.getOrCreateDefaultTariffPlan(ctx)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}

	// Second call returns existing
	plan2, err := repo.getOrCreateDefaultTariffPlan(ctx)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}

	if plan1["plan_id"] != plan2["plan_id"] {
		t.Errorf("plan_id mismatch: %v vs %v", plan1["plan_id"], plan2["plan_id"])
	}
}

// TestGetTariffPlan_DefaultCreates verifies getTariffPlan creates default when missing.
func TestGetTariffPlan_DefaultCreates(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	plan, err := repo.getTariffPlan(ctx, defaultPlanID)
	if err != nil {
		t.Fatalf("getTariffPlan(default): %v", err)
	}
	if plan == nil {
		t.Fatal("plan is nil, want created default")
	}
	if plan["plan_id"] != defaultPlanID {
		t.Errorf("plan_id = %v, want %v", plan["plan_id"], defaultPlanID)
	}
}

// TestGetTariffPlan_CustomMissing returns nil for non-default missing plans.
func TestGetTariffPlan_CustomMissing(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	plan, err := repo.getTariffPlan(ctx, "nonexistent_plan")
	if err != nil {
		t.Fatalf("getTariffPlan: %v", err)
	}
	if plan != nil {
		t.Errorf("plan = %v, want nil for missing custom plan", plan)
	}
}
