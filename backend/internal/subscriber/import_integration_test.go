package subscriber

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// importTestRepo creates a test repository connected to a test database.
// Returns the repo, the subscribers collection, and a cleanup function.
func importTestRepo(t *testing.T) (*Repository, *mongo.Collection, func()) {
	t.Helper()

	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}

	dbName := "xcloud_test_import_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)

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
		_ = client.Disconnect(ctx2)
	}

	return repo, db.Collection("subscribers"), cleanup
}

// TestImportIntegration_CreateOnly_UniqueImsi verifies the IMSI unique constraint.
func TestImportIntegration_CreateOnly_UniqueImsi(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, coll, cleanup := importTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	// Create unique index on imsi
	_, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "imsi", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		t.Fatalf("create unique index: %v", err)
	}

	// First insert should succeed
	docA := bson.M{
		"imsi":                    "454000000000901",
		"access_restriction_data": 32,
		"traffic_total":           10737418240,
		"traffic_balance":         10737418240,
		"sms_total":               100,
		"sms_balance":             100,
		"plan_id":                 "plan_default_10gb",
	}
	err = repo.InsertSubscriberImportCreateOnly(ctx, docA)
	if err != nil {
		t.Fatalf("first insert failed: %v", err)
	}

	// Verify count
	count, err := coll.CountDocuments(ctx, bson.M{"imsi": "454000000000901"})
	if err != nil {
		t.Fatalf("count failed: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected count=1, got %d", count)
	}

	// Second insert with same IMSI should fail with duplicate key
	docA2 := bson.M{
		"imsi":                    "454000000000901",
		"access_restriction_data": 32,
		"traffic_total":           10737418240,
		"traffic_balance":         10737418240,
		"sms_total":               100,
		"sms_balance":             100,
		"plan_id":                 "plan_default_10gb",
	}
	err = repo.InsertSubscriberImportCreateOnly(ctx, docA2)
	if err == nil {
		t.Fatal("expected duplicate key error, got nil")
	}
	if !mongo.IsDuplicateKeyError(err) {
		t.Fatalf("expected duplicate key error, got: %v", err)
	}

	// Final count should still be1
	count, err = coll.CountDocuments(ctx, bson.M{"imsi": "454000000000901"})
	if err != nil {
		t.Fatalf("final count failed: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected final count=1, got %d", count)
	}
}

// TestImportIntegration_CreateOnly_ConcurrentRace verifies create-only semantics under concurrency.
func TestImportIntegration_CreateOnly_ConcurrentRace(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, coll, cleanup := importTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	// Create unique index on imsi
	_, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "imsi", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		t.Fatalf("create unique index: %v", err)
	}

	// Two candidates with the same IMSI
	imsiB := "454000000000902"
	candidate1 := bson.M{
		"imsi":                    imsiB,
		"access_restriction_data": 32,
		"traffic_total":           10737418240,
		"traffic_balance":         10737418240,
		"sms_total":               100,
		"sms_balance":             100,
		"plan_id":                 "plan_default_10gb",
		"candidate_id":            "candidate-1",
	}
	candidate2 := bson.M{
		"imsi":                    imsiB,
		"access_restriction_data": 32,
		"traffic_total":           10737418240,
		"traffic_balance":         10737418240,
		"sms_total":               100,
		"sms_balance":             100,
		"plan_id":                 "plan_default_10gb",
		"candidate_id":            "candidate-2",
	}

	var wg sync.WaitGroup
	results := make([]error, 2)
	startBarrier := make(chan struct{})

	for i, doc := range []bson.M{candidate1, candidate2} {
		wg.Add(1)
		go func(idx int, d bson.M) {
			defer wg.Done()
			<-startBarrier // synchronize start
			results[idx] = repo.InsertSubscriberImportCreateOnly(ctx, d)
		}(i, doc)
	}

	close(startBarrier) // release both goroutines simultaneously
	wg.Wait()

	// Classify results
	successCount := 0
	duplicateCount := 0
	otherErrorCount := 0
	for _, err := range results {
		if err == nil {
			successCount++
		} else if mongo.IsDuplicateKeyError(err) {
			duplicateCount++
		} else {
			otherErrorCount++
			t.Logf("unexpected error: %v", err)
		}
	}

	if successCount != 1 {
		t.Fatalf("expected exactly1success, got %d", successCount)
	}
	if duplicateCount != 1 {
		t.Fatalf("expected exactly1duplicate-key error, got %d", duplicateCount)
	}
	if otherErrorCount != 0 {
		t.Fatalf("expected0other errors, got %d", otherErrorCount)
	}

	// Final count should be1
	count, err := coll.CountDocuments(ctx, bson.M{"imsi": imsiB})
	if err != nil {
		t.Fatalf("count failed: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected final count=1, got %d", count)
	}

	// Verify the stored document is one of the two candidates (not merged/modified)
	var stored bson.M
	err = coll.FindOne(ctx, bson.M{"imsi": imsiB}).Decode(&stored)
	if err != nil {
		t.Fatalf("find stored doc: %v", err)
	}
	candidateID, ok := stored["candidate_id"].(string)
	if !ok {
		t.Fatal("stored doc missing candidate_id")
	}
	if candidateID != "candidate-1" && candidateID != "candidate-2" {
		t.Fatalf("stored doc has unexpected candidate_id: %v", candidateID)
	}
	t.Logf("winner: %s", candidateID)
}

// TestImportIntegration_CreateOnly_NoUpsert verifies the method uses InsertOne, not upsert.
func TestImportIntegration_CreateOnly_NoUpsert(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, coll, cleanup := importTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	// Create unique index on imsi
	_, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "imsi", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		t.Fatalf("create unique index: %v", err)
	}

	doc := bson.M{
		"imsi":                    "454000000000903",
		"access_restriction_data": 32,
		"traffic_total":           10737418240,
		"traffic_balance":         10737418240,
		"sms_total":               100,
		"sms_balance":             100,
		"plan_id":                 "plan_default_10gb",
		"test_marker":             "original",
	}

	// First insert
	err = repo.InsertSubscriberImportCreateOnly(ctx, doc)
	if err != nil {
		t.Fatalf("first insert failed: %v", err)
	}

	// Try to insert again with different test_marker — should fail
	doc2 := bson.M{
		"imsi":                    "454000000000903",
		"access_restriction_data": 32,
		"traffic_total":           10737418240,
		"traffic_balance":         10737418240,
		"sms_total":               100,
		"sms_balance":             100,
		"plan_id":                 "plan_default_10gb",
		"test_marker":             "modified",
	}
	err = repo.InsertSubscriberImportCreateOnly(ctx, doc2)
	if err == nil {
		t.Fatal("expected duplicate key error for second insert")
	}
	if !mongo.IsDuplicateKeyError(err) {
		t.Fatalf("expected duplicate key error, got: %v", err)
	}

	// Verify the original document is unchanged
	var stored bson.M
	err = coll.FindOne(ctx, bson.M{"imsi": "454000000000903"}).Decode(&stored)
	if err != nil {
		t.Fatalf("find stored doc: %v", err)
	}
	if stored["test_marker"] != "original" {
		t.Fatalf("expected test_marker=original, got %v", stored["test_marker"])
	}

	// Verify InsertOne is used (no upsert/replace/update markers in the method)
	// This is a source-level contract: the method must use InsertOne only
	// The real Mongo behavior above proves it: second insert fails with duplicate key
	fmt.Println("PASS: InsertSubscriberImportCreateOnly uses InsertOne (no upsert)")
}
