package ocs

import (
	"context"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func setupWriteTestDB(t *testing.T) (*Repository, func()) {
	t.Helper()
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Skipf("MongoDB not available: %v", err)
		return nil, func() {}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		t.Skipf("MongoDB ping failed: %v", err)
		return nil, func() {}
	}

	dbName := "xcloud_test_ocs_write_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)
	repo := NewRepository(
		db.Collection("ocs_balances"),
		db.Collection("ocs_sessions"),
		db.Collection("ocs_reservations"),
		db.Collection("ocs_usage_records"),
		db.Collection("ocs_subscribers"),
		db.Collection("ocs_tariff_plans"),
	)
	cleanup := func() {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		_ = db.Drop(ctx2)
		_ = client.Disconnect(ctx2)
	}
	return repo, cleanup
}

func TestSyncBalanceStatus_MirrorsLifecycleAndIncrementsVersion(t *testing.T) {
	repo, cleanup := setupWriteTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()
	ctx := context.Background()

	const imsi = "417010000000401"
	if _, err := repo.balances.InsertOne(ctx, bson.M{
		"imsi": imsi, "status": "active", "version": int64(4),
	}); err != nil {
		t.Fatalf("seed balance: %v", err)
	}

	if err := repo.SyncBalanceStatus(ctx, imsi, "terminated"); err != nil {
		t.Fatalf("sync status: %v", err)
	}

	var balance bson.M
	if err := repo.balances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&balance); err != nil {
		t.Fatalf("reload balance: %v", err)
	}
	if balance["status"] != "terminated" {
		t.Errorf("status = %v, want terminated", balance["status"])
	}
	if got := numericInt64(balance["version"]); got != 5 {
		t.Errorf("version = %d, want 5 after a lifecycle write", got)
	}

	if err := repo.SyncBalanceStatus(ctx, "417010000000499", "terminated"); err != nil {
		t.Errorf("missing balance must be a no-op, got %v", err)
	}
}

func TestSyncBalancePlan_MirrorsRebinding(t *testing.T) {
	repo, cleanup := setupWriteTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()
	ctx := context.Background()

	const imsi = "417010000000402"
	if _, err := repo.balances.InsertOne(ctx, bson.M{
		"imsi": imsi, "plan_id": "plan_old", "version": int64(1),
	}); err != nil {
		t.Fatalf("seed balance: %v", err)
	}

	if err := repo.SyncBalancePlan(ctx, imsi, "plan_new"); err != nil {
		t.Fatalf("sync plan: %v", err)
	}

	var balance bson.M
	if err := repo.balances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&balance); err != nil {
		t.Fatalf("reload balance: %v", err)
	}
	if balance["plan_id"] != "plan_new" {
		t.Errorf("plan_id = %v, want plan_new", balance["plan_id"])
	}
	if got := numericInt64(balance["version"]); got != 2 {
		t.Errorf("version = %d, want 2", got)
	}
}
