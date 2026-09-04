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

	// First provision — creates with custom plan
	err := repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
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

	// Second provision — no voice/SMS — should preserve
	planId := "custom"
	err = repo.provisionOcsSubscriber(ctx, OcsProvisioningInput{
		IMSI:   imsi,
		PlanID: &planId,
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
