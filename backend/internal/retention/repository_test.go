package retention

import (
	"context"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func setupRetentionDB(t *testing.T) (*Repository, *mongo.Collection, func()) {
	t.Helper()
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Skipf("MongoDB not available: %v", err)
		return nil, nil, nil
	}
	pingCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		t.Skipf("MongoDB ping failed: %v", err)
		return nil, nil, nil
	}

	dbName := "xcloud_test_retention"
	opsName := "xcloud_ops_test_retention"
	contracts := client.Database(dbName).Collection("ocs_subscribers")
	balances := client.Database(dbName).Collection("ocs_balances")
	adjustments := client.Database(opsName).Collection("ocs_balance_adjustments")
	audits := client.Database(opsName).Collection("app_audit_logs")
	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Database(dbName).Drop(ctx)
		_ = client.Database(opsName).Drop(ctx)
		_ = client.Disconnect(ctx)
	}
	return NewRepository(contracts, balances, adjustments), audits, cleanup
}

func TestListCandidatesOnlyReturnsTerminatedOutsideWindow(t *testing.T) {
	repo, _, cleanup := setupRetentionDB(t)
	if repo == nil {
		return
	}
	defer cleanup()
	ctx := context.Background()
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

	seed := []bson.M{
		{"imsi": "417010000000001", "status": "terminated", "updated_at": now.AddDate(0, 0, -400)},
		{"imsi": "417010000000002", "status": "terminated", "updated_at": now.AddDate(0, 0, -10)},
		{"imsi": "417010000000003", "status": "active", "updated_at": now.AddDate(0, 0, -400)},
		{"imsi": "417010000000004", "status": "terminated"},
	}
	if _, err := repo.contracts.InsertMany(ctx, []any{seed[0], seed[1], seed[2], seed[3]}); err != nil {
		t.Fatalf("seed contracts: %v", err)
	}

	candidates, total, err := repo.ListCandidates(ctx, now.AddDate(0, 0, -365))
	if err != nil {
		t.Fatalf("ListCandidates: %v", err)
	}
	if total != 1 || len(candidates) != 1 || candidates[0].IMSI != "417010000000001" {
		t.Fatalf("candidates=%+v total=%d, want only the old terminated contract", candidates, total)
	}
}

func TestPurgeContractCascadesWithoutTouchingAudit(t *testing.T) {
	repo, audits, cleanup := setupRetentionDB(t)
	if repo == nil {
		return
	}
	defer cleanup()
	ctx := context.Background()
	imsi := "417010000000010"
	now := time.Now().UTC().AddDate(0, 0, -400)

	if _, err := repo.contracts.InsertOne(ctx, bson.M{"imsi": imsi, "status": "terminated", "updated_at": now}); err != nil {
		t.Fatalf("seed contract: %v", err)
	}
	if _, err := repo.balances.InsertOne(ctx, bson.M{"imsi": imsi, "data_total": int64(1)}); err != nil {
		t.Fatalf("seed balance: %v", err)
	}
	if _, err := repo.adjustments.InsertOne(ctx, bson.M{"imsi": imsi, "adjustmentId": "adj-1"}); err != nil {
		t.Fatalf("seed adjustment: %v", err)
	}
	if _, err := audits.InsertOne(ctx, bson.M{"action": "BALANCE_ADJUST", "targetId": "balance:" + imsi}); err != nil {
		t.Fatalf("seed audit: %v", err)
	}

	counts, err := repo.PurgeContract(ctx, imsi)
	if err != nil {
		t.Fatalf("PurgeContract: %v", err)
	}
	if counts.Contracts != 1 || counts.Balances != 1 || counts.Adjustments != 1 {
		t.Fatalf("counts = %+v, want one of each", counts)
	}
	if count, _ := repo.contracts.CountDocuments(ctx, bson.M{"imsi": imsi}); count != 0 {
		t.Fatalf("contract remains: %d", count)
	}
	if count, _ := repo.balances.CountDocuments(ctx, bson.M{"imsi": imsi}); count != 0 {
		t.Fatalf("balance remains: %d", count)
	}
	if count, _ := repo.adjustments.CountDocuments(ctx, bson.M{"imsi": imsi}); count != 0 {
		t.Fatalf("adjustment remains: %d", count)
	}
	if count, _ := audits.CountDocuments(ctx, bson.M{"targetId": "balance:" + imsi}); count != 1 {
		t.Fatalf("audit history must be retained, count=%d", count)
	}
}

func TestPurgeContractRefusesActiveContract(t *testing.T) {
	repo, _, cleanup := setupRetentionDB(t)
	if repo == nil {
		return
	}
	defer cleanup()
	ctx := context.Background()
	imsi := "417010000000011"
	if _, err := repo.contracts.InsertOne(ctx, bson.M{"imsi": imsi, "status": "active", "updated_at": time.Now().UTC()}); err != nil {
		t.Fatalf("seed contract: %v", err)
	}
	if _, err := repo.PurgeContract(ctx, imsi); err != ErrNotTerminated {
		t.Fatalf("PurgeContract(active) = %v, want ErrNotTerminated", err)
	}
}
