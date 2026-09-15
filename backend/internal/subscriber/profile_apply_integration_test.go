package subscriber

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// profileApplyTestRepo creates a test repository for profile apply integration tests.
func profileApplyTestRepo(t *testing.T) (*Repository, *mongo.Database, func()) {
	t.Helper()

	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}

	dbName := "xcloud_test_profile_apply_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)

	repo := &Repository{
		subscribers: db.Collection("subscribers"),
		ocsSubs:     db.Collection("ocs_subscribers"),
		ocsBalances: db.Collection("ocs_balances"),
		tariffPlans: db.Collection("ocs_tariff_plans"),
		profiles:    db.Collection("app_profiles"),
	}

	cleanup := func() {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		_ = db.Drop(ctx2)
		_ = client.Disconnect(ctx2)
	}

	return repo, db, cleanup
}

// seedSubscriber inserts a real Xcloud subscriber document.
func seedSubscriber(t *testing.T, ctx context.Context, coll *mongo.Collection, imsi string) bson.M {
	t.Helper()
	doc := bson.M{
		"schema_version": 1,
		"imsi":           imsi,
		"msisdn":         bson.A{"13800138000"},
		"imeisv":         "",
		"security": bson.M{
			"opc": "existing-opc-value",
			"amf": "8000",
			"k":   "00112233445566778899aabbccddeeff",
			"sqn": int64(1234),
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
								"priority_level":            int64(8),
								"pre_emption_capability":    int64(1),
								"pre_emption_vulnerability": int64(1),
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
	_, err := coll.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	return doc
}

// seedProfile inserts a real Profile document.
func seedProfile(t *testing.T, ctx context.Context, coll *mongo.Collection, name string) bson.M {
	t.Helper()
	doc := bson.M{
		"name": name,
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
								"priority_level":            int64(8),
								"pre_emption_capability":    int64(1),
								"pre_emption_vulnerability": int64(1),
							},
						},
						"pcc_rule": bson.A{},
					},
				},
			},
		},
		"access_restriction_data": 32,
	}
	_, err := coll.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	return doc
}

// TestProfileApplyIntegration_ExistingApplySucceeds verifies a full profile apply
// cycle with real MongoDB: prepare → assert → execute → read back.
func TestProfileApplyIntegration_ExistingApplySucceeds(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, db, cleanup := profileApplyTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	subColl := db.Collection("subscribers")
	seedSubscriber(t, ctx, subColl, "460001234567890")
	seedProfile(t, ctx, db.Collection("app_profiles"), "premium-5g")

	lookup := func(ctx context.Context, imsi string) (bson.M, error) {
		return repo.FindSubscriberByImsi(ctx, imsi)
	}
	profileLookup := func(ctx context.Context, name string) (bson.M, error) {
		return repo.FindProfileByName(ctx, name)
	}

	// Phase 1: Prepare
	intent, err := PrepareFrozenSubscriberProfileApply(ctx, "460001234567890", "premium-5g", lookup, profileLookup)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if intent == nil {
		t.Fatal("prepare returned nil intent")
	}
	if intent.Imsi != "460001234567890" {
		t.Errorf("expected imsi=460001234567890, got %s", intent.Imsi)
	}
	if intent.ProfileName != "premium-5g" {
		t.Errorf("expected profileName=premium-5g, got %s", intent.ProfileName)
	}
	if intent.SubscriberPreconditionHash == "" {
		t.Error("subscriberPreconditionHash is empty")
	}
	if intent.ProfilePreconditionHash == "" {
		t.Error("profilePreconditionHash is empty")
	}

	// Phase 2: Assert
	assertion, err := AssertFrozenSubscriberProfileApply(ctx, *intent, lookup, profileLookup)
	if err != nil {
		t.Fatalf("assert: %v", err)
	}
	if assertion == nil {
		t.Fatal("assert returned nil (drift detected unexpectedly)")
	}

	// Phase 3: Execute
	result, err := ExecuteFrozenSubscriberProfileApply(ctx, assertion, "test-admin", repo.ReplaceSubscriberCAS)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !result.Committed {
		t.Error("expected committed=true")
	}
	if result.Classification != "SUCCESS" {
		t.Errorf("expected classification=SUCCESS, got %s", result.Classification)
	}

	// Read back from Mongo
	saved, err := repo.FindSubscriberByImsi(ctx, "460001234567890")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if saved == nil {
		t.Fatal("subscriber not found after apply")
	}

	// Verify profile auth applied
	sec := toMap(saved["security"])
	if sec == nil {
		t.Fatal("security is nil")
	}
	if sec["k"] != "00112233445566778899aabbccddeeff" {
		t.Errorf("expected K from profile, got %v", sec["k"])
	}
	if sec["opc"] != "aabbccddee00112233445566778899ff" {
		t.Errorf("expected OPc from profile, got %v", sec["opc"])
	}
	if sec["op"] != nil {
		t.Errorf("expected OP=nil, got %v", sec["op"])
	}
	if sec["amf"] != "8000" {
		t.Errorf("expected AMF=8000, got %v", sec["amf"])
	}

	// Verify SQN preserved
	if sec["sqn"] != int64(1234) {
		t.Errorf("expected SQN=1234, got %v (type %T)", sec["sqn"], sec["sqn"])
	}

	// Verify AMBR applied
	ambr := toMap(saved["ambr"])
	if ambr == nil {
		t.Fatal("ambr is nil")
	}
	dl := toMap(ambr["downlink"])
	if dl == nil {
		t.Fatal("downlink is nil")
	}
	dlVal, _ := toInt64(dl["value"])
	if dlVal != 100 {
		t.Errorf("expected ambr downlink=100, got %v", dlVal)
	}

	// Verify access_restriction_data applied
	ard, _ := toInt64(saved["access_restriction_data"])
	if ard != 32 {
		t.Errorf("expected ard=32, got %v (type %T)", saved["access_restriction_data"], saved["access_restriction_data"])
	}

	// Verify slice conversion (session_list → session)
	slices := toSlice(saved["slice"])
	if len(slices) == 0 {
		t.Fatalf("slice is empty (type=%T, raw=%v)", saved["slice"], saved["slice"])
	}
	slice0 := toMap(slices[0])
	if slice0 == nil {
		t.Fatal("slice[0] is nil")
	}
	sessions := toSlice(slice0["session"])
	if len(sessions) == 0 {
		t.Fatal("session is empty")
	}
	sess0 := toMap(sessions[0])
	if sess0 == nil {
		t.Fatal("session[0] is nil")
	}
	if sess0["name"] != "internet" {
		t.Errorf("expected session name=internet, got %v", sess0["name"])
	}

	// Verify QoS/ARP normalized
	qos := toMap(sess0["qos"])
	if qos == nil {
		t.Fatal("qos is nil")
	}
	arp := toMap(qos["arp"])
	if arp == nil {
		t.Fatal("arp is nil")
	}
	pl, _ := toInt64(arp["priority_level"])
	if pl != 8 {
		t.Errorf("expected priority_level=8, got %v", arp["priority_level"])
	}

	// Verify profile binding
	meta := toMap(saved["webui_meta"])
	if meta == nil {
		t.Fatal("webui_meta is nil")
	}
	if meta["profile_name"] != "premium-5g" {
		t.Errorf("expected profile_name=premium-5g, got %v", meta["profile_name"])
	}

	// Verify identity preserved
	if saved["imsi"] != "460001234567890" {
		t.Errorf("imsi changed: %v", saved["imsi"])
	}
}

// TestProfileApplyIntegration_SqnBsonPreservation verifies SQN BSON type
// is preserved through the profile apply cycle.
func TestProfileApplyIntegration_SqnBsonPreservation(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, db, cleanup := profileApplyTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	subColl := db.Collection("subscribers")
	// Seed with int64 SQN
	doc := bson.M{
		"schema_version": 1,
		"imsi":           "460001234567891",
		"msisdn":         bson.A{"13900139000"},
		"security": bson.M{
			"opc": "old-opc",
			"amf": "8000",
			"k":   "00112233445566778899aabbccddeeff",
			"sqn": int64(999999999999),
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 50, "unit": 3},
			"uplink":   bson.M{"value": 25, "unit": 3},
		},
		"slice":                   bson.A{},
		"access_restriction_data": 4,
		"subscriber_status":       0,
		"network_access_mode":     0,
		"webui_meta":              bson.M{"profile_name": "basic-4g"},
	}
	_, err := subColl.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	seedProfile(t, ctx, db.Collection("app_profiles"), "premium-5g")

	lookup := func(ctx context.Context, imsi string) (bson.M, error) {
		return repo.FindSubscriberByImsi(ctx, imsi)
	}
	profileLookup := func(ctx context.Context, name string) (bson.M, error) {
		return repo.FindProfileByName(ctx, name)
	}

	intent, err := PrepareFrozenSubscriberProfileApply(ctx, "460001234567891", "premium-5g", lookup, profileLookup)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	assertion, err := AssertFrozenSubscriberProfileApply(ctx, *intent, lookup, profileLookup)
	if err != nil {
		t.Fatalf("assert: %v", err)
	}
	if assertion == nil {
		t.Fatal("assert returned nil")
	}

	_, err = ExecuteFrozenSubscriberProfileApply(ctx, assertion, "test-admin", repo.ReplaceSubscriberCAS)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}

	// Read back and verify SQN type preserved
	saved, err := repo.FindSubscriberByImsi(ctx, "460001234567891")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	sec := toMap(saved["security"])
	sqnVal := sec["sqn"]
	sqnInt, ok := sqnVal.(int64)
	if !ok {
		t.Errorf("expected SQN type int64, got %T (value: %v)", sqnVal, sqnVal)
	}
	if sqnInt != 999999999999 {
		t.Errorf("expected SQN=999999999999, got %v", sqnInt)
	}
}

// TestProfileApplyIntegration_SubscriberDrift verifies that drift detection
// prevents overwriting a subscriber that changed between prepare and execute.
func TestProfileApplyIntegration_SubscriberDrift(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, db, cleanup := profileApplyTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	subColl := db.Collection("subscribers")
	seedSubscriber(t, ctx, subColl, "460001234567890")
	seedProfile(t, ctx, db.Collection("app_profiles"), "premium-5g")

	lookup := func(ctx context.Context, imsi string) (bson.M, error) {
		return repo.FindSubscriberByImsi(ctx, imsi)
	}
	profileLookup := func(ctx context.Context, name string) (bson.M, error) {
		return repo.FindProfileByName(ctx, name)
	}

	// Phase 1: Prepare
	intent, err := PrepareFrozenSubscriberProfileApply(ctx, "460001234567890", "premium-5g", lookup, profileLookup)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	// Phase 2: Mutate subscriber directly in Mongo (simulates concurrent change)
	_, err = subColl.UpdateOne(ctx,
		bson.M{"imsi": "460001234567890"},
		bson.M{"$set": bson.M{"ambr.downlink.value": 999}},
	)
	if err != nil {
		t.Fatalf("mutate subscriber: %v", err)
	}

	// Phase 3: Assert should detect drift
	assertion, err := AssertFrozenSubscriberProfileApply(ctx, *intent, lookup, profileLookup)
	if err != nil {
		t.Fatalf("assert: %v", err)
	}
	if assertion != nil {
		t.Error("expected nil assertion (drift), got non-nil")
	}

	// Verify subscriber was NOT overwritten (ambr should still be 999)
	saved, err := repo.FindSubscriberByImsi(ctx, "460001234567890")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	ambr := toMap(saved["ambr"])
	dl := toMap(ambr["downlink"])
	dlVal, _ := toInt64(dl["value"])
	if dlVal != 999 {
		t.Errorf("expected ambr downlink=999 (mutated), got %v", dl["value"])
	}
}

// TestProfileApplyIntegration_ProfileDrift verifies that profile changes
// between prepare and execute are detected.
func TestProfileApplyIntegration_ProfileDrift(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, db, cleanup := profileApplyTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	subColl := db.Collection("subscribers")
	profileColl := db.Collection("app_profiles")
	seedSubscriber(t, ctx, subColl, "460001234567890")
	seedProfile(t, ctx, profileColl, "premium-5g")

	lookup := func(ctx context.Context, imsi string) (bson.M, error) {
		return repo.FindSubscriberByImsi(ctx, imsi)
	}
	profileLookup := func(ctx context.Context, name string) (bson.M, error) {
		return repo.FindProfileByName(ctx, name)
	}

	intent, err := PrepareFrozenSubscriberProfileApply(ctx, "460001234567890", "premium-5g", lookup, profileLookup)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	// Mutate profile in Mongo
	_, err = profileColl.UpdateOne(ctx,
		bson.M{"name": "premium-5g"},
		bson.M{"$set": bson.M{"ambr.downlink.value": 999}},
	)
	if err != nil {
		t.Fatalf("mutate profile: %v", err)
	}

	// Assert should detect profile drift
	assertion, err := AssertFrozenSubscriberProfileApply(ctx, *intent, lookup, profileLookup)
	if err != nil {
		t.Fatalf("assert: %v", err)
	}
	if assertion != nil {
		t.Error("expected nil assertion (profile drift), got non-nil")
	}

	// Verify subscriber untouched
	saved, err := repo.FindSubscriberByImsi(ctx, "460001234567890")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	ambr := toMap(saved["ambr"])
	dl := toMap(ambr["downlink"])
	dlVal, _ := toInt64(dl["value"])
	if dlVal != 50 {
		t.Errorf("expected subscriber ambr downlink=50 (untouched), got %v", dl["value"])
	}
}

// TestProfileApplyIntegration_CasRace verifies that a CAS conflict prevents
// overwriting a subscriber that was modified between assert and execute.
func TestProfileApplyIntegration_CasRace(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, db, cleanup := profileApplyTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	subColl := db.Collection("subscribers")
	seedSubscriber(t, ctx, subColl, "460001234567890")
	seedProfile(t, ctx, db.Collection("app_profiles"), "premium-5g")

	lookup := func(ctx context.Context, imsi string) (bson.M, error) {
		return repo.FindSubscriberByImsi(ctx, imsi)
	}
	profileLookup := func(ctx context.Context, name string) (bson.M, error) {
		return repo.FindProfileByName(ctx, name)
	}

	intent, err := PrepareFrozenSubscriberProfileApply(ctx, "460001234567890", "premium-5g", lookup, profileLookup)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	assertion, err := AssertFrozenSubscriberProfileApply(ctx, *intent, lookup, profileLookup)
	if err != nil {
		t.Fatalf("assert: %v", err)
	}
	if assertion == nil {
		t.Fatal("assert returned nil")
	}

	// Mutate subscriber AFTER assert but BEFORE execute (simulates race)
	_, err = subColl.UpdateOne(ctx,
		bson.M{"imsi": "460001234567890"},
		bson.M{"$set": bson.M{"subscriber_status": 1}},
	)
	if err != nil {
		t.Fatalf("race mutate: %v", err)
	}

	// Execute should fail with CAS conflict
	result, err := ExecuteFrozenSubscriberProfileApply(ctx, assertion, "test-admin", repo.ReplaceSubscriberCAS)
	if err == nil {
		t.Fatal("expected CAS error, got nil")
	}
	if result != nil {
		t.Error("expected nil result on CAS failure")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T: %v", err, err)
	}
	if govErr.Code != "SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED" {
		t.Errorf("expected PRECONDITION_CHANGED, got %s", govErr.Code)
	}

	// Verify newer subscriber survives
	saved, err := repo.FindSubscriberByImsi(ctx, "460001234567890")
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	ss, _ := toInt64(saved["subscriber_status"])
	if ss != 1 {
		t.Errorf("expected subscriber_status=1 (race winner), got %v", saved["subscriber_status"])
	}
}

// TestProfileApplyIntegration_OcsUntouched verifies that Profile Apply
// does not modify any OCS collections.
func TestProfileApplyIntegration_OcsUntouched(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, db, cleanup := profileApplyTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	subColl := db.Collection("subscribers")
	seedSubscriber(t, ctx, subColl, "460001234567890")
	seedProfile(t, ctx, db.Collection("app_profiles"), "premium-5g")

	// Seed OCS data
	ocsSubColl := db.Collection("ocs_subscribers")
	ocsBalColl := db.Collection("ocs_balances")
	_, err := ocsSubColl.InsertOne(ctx, bson.M{"imsi": "460001234567890", "plan_id": "test_plan"})
	if err != nil {
		t.Fatalf("seed ocs_subscribers: %v", err)
	}
	_, err = ocsBalColl.InsertOne(ctx, bson.M{"imsi": "460001234567890", "balance": 1000})
	if err != nil {
		t.Fatalf("seed ocs_balances: %v", err)
	}

	// Capture OCS state before
	ocsSubBefore, _ := ocsSubColl.CountDocuments(ctx, bson.M{"imsi": "460001234567890"})
	ocsBalBefore, _ := ocsBalColl.CountDocuments(ctx, bson.M{"imsi": "460001234567890"})

	lookup := func(ctx context.Context, imsi string) (bson.M, error) {
		return repo.FindSubscriberByImsi(ctx, imsi)
	}
	profileLookup := func(ctx context.Context, name string) (bson.M, error) {
		return repo.FindProfileByName(ctx, name)
	}

	intent, err := PrepareFrozenSubscriberProfileApply(ctx, "460001234567890", "premium-5g", lookup, profileLookup)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}

	assertion, err := AssertFrozenSubscriberProfileApply(ctx, *intent, lookup, profileLookup)
	if err != nil {
		t.Fatalf("assert: %v", err)
	}
	if assertion == nil {
		t.Fatal("assert returned nil")
	}

	_, err = ExecuteFrozenSubscriberProfileApply(ctx, assertion, "test-admin", repo.ReplaceSubscriberCAS)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}

	// Verify OCS unchanged
	ocsSubAfter, _ := ocsSubColl.CountDocuments(ctx, bson.M{"imsi": "460001234567890"})
	ocsBalAfter, _ := ocsBalColl.CountDocuments(ctx, bson.M{"imsi": "460001234567890"})

	if ocsSubBefore != ocsSubAfter {
		t.Errorf("ocs_subscribers count changed: before=%d, after=%d", ocsSubBefore, ocsSubAfter)
	}
	if ocsBalBefore != ocsBalAfter {
		t.Errorf("ocs_balances count changed: before=%d, after=%d", ocsBalBefore, ocsBalAfter)
	}

	// Also verify OCS documents were not modified
	var ocsSub bson.M
	err = ocsSubColl.FindOne(ctx, bson.M{"imsi": "460001234567890"}).Decode(&ocsSub)
	if err != nil {
		t.Fatalf("read ocs_sub: %v", err)
	}
	if ocsSub["plan_id"] != "test_plan" {
		t.Errorf("ocs_subscribers plan_id changed: %v", ocsSub["plan_id"])
	}
}

