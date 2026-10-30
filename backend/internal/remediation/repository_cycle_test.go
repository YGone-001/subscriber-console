package remediation

import (
	"context"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func remediationTestRepo(t testing.TB) (*Repository, func()) {
	t.Helper()

	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		t.Skipf("MongoDB ping failed: %v", err)
	}

	dbName := "xcloud_test_remediation_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)
	opsDb := client.Database(dbName + "_ops")
	cleanup := func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer dropCancel()
		_ = db.Drop(dropCtx)
		_ = opsDb.Drop(dropCtx)
		_ = client.Disconnect(dropCtx)
	}
	return NewRepository(db, opsDb), cleanup
}

// Remediation rewrites the balance account, so it must carry the stored billing
// cycle window through unchanged. xCloud stores those fields both as BSON dates
// and as RFC 3339 strings; a reader that only accepted time.Time matched
// neither, so every heal silently reset the cycle to the heal instant.
func TestHealPreservesStoredCycleWindow(t *testing.T) {
	repo, cleanup := remediationTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	const imsi = "460020000000001"
	storedStart := time.Date(2026, 3, 1, 8, 30, 0, 0, time.UTC)
	storedReset := "2026-04-01T08:30:00.000Z"

	if _, err := repo.ocsPlans.InsertOne(ctx, bson.M{"plan_id": defaultOcsPlanID, "status": "active"}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	if _, err := repo.subscribers.InsertOne(ctx, bson.M{"imsi": imsi}); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := repo.ocsBalances.InsertOne(ctx, bson.M{
		"imsi": imsi, "data_total": int64(1000), "data_available": int64(400),
		"cycle_start_at": storedStart, "cycle_reset_at": storedReset,
	}); err != nil {
		t.Fatalf("seed balance: %v", err)
	}

	if err := repo.HealSubscriberDocument(ctx, imsi, "balance_mismatch", nil); err != nil {
		t.Fatalf("heal subscriber: %v", err)
	}

	var healed bson.M
	if err := repo.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&healed); err != nil {
		t.Fatalf("read healed balance: %v", err)
	}

	start, ok := healed["cycle_start_at"].(bson.DateTime)
	if !ok {
		t.Fatalf("cycle_start_at type = %T, want the stored BSON date", healed["cycle_start_at"])
	}
	if !start.Time().Equal(storedStart) {
		t.Fatalf("cycle_start_at = %s, want %s", start.Time(), storedStart)
	}
	if reset, ok := healed["cycle_reset_at"].(string); !ok || reset != storedReset {
		t.Fatalf("cycle_reset_at = %#v, want the stored string %q", healed["cycle_reset_at"], storedReset)
	}
}

// An account without a cycle window starts one at the heal instant.
func TestHealStartsMissingCycleWindow(t *testing.T) {
	repo, cleanup := remediationTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	const imsi = "460020000000002"
	if _, err := repo.ocsPlans.InsertOne(ctx, bson.M{"plan_id": defaultOcsPlanID, "status": "active"}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	if _, err := repo.subscribers.InsertOne(ctx, bson.M{"imsi": imsi}); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := repo.ocsBalances.InsertOne(ctx, bson.M{
		"imsi": imsi, "data_total": int64(1000), "data_available": int64(1000),
		"cycle_start_at": nil,
	}); err != nil {
		t.Fatalf("seed balance: %v", err)
	}

	before := time.Now()
	if err := repo.HealSubscriberDocument(ctx, imsi, "balance_mismatch", nil); err != nil {
		t.Fatalf("heal subscriber: %v", err)
	}

	var healed bson.M
	if err := repo.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&healed); err != nil {
		t.Fatalf("read healed balance: %v", err)
	}
	for _, key := range []string{"cycle_start_at", "cycle_reset_at"} {
		value, ok := healed[key].(bson.DateTime)
		if !ok {
			t.Fatalf("%s type = %T, want a BSON date", key, healed[key])
		}
		if value.Time().Before(before.Add(-time.Minute)) || value.Time().After(time.Now().Add(time.Minute)) {
			t.Fatalf("%s = %s, want the heal instant", key, value.Time())
		}
	}
}
