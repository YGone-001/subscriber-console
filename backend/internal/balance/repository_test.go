package balance

import (
	"context"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func setupTestDB(t *testing.T) (*Repository, func()) {
	t.Helper()
	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Skipf("MongoDB not available at %s: %v", uri, err)
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		t.Skipf("MongoDB ping failed: %v", err)
		return nil, nil
	}

	testDBName := "xcloud_test_balance"
	balancesColl := client.Database(testDBName).Collection("ocs_balances")
	subsColl := client.Database(testDBName).Collection("ocs_subscribers")
	approvalsColl := client.Database("xcloud_ops_test_balance").Collection("app_approvals")
	auditColl := client.Database("xcloud_ops_test_balance").Collection("app_audit_logs")

	repo := NewRepository(balancesColl, subsColl, approvalsColl, auditColl)

	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Database(testDBName).Drop(ctx)
		_ = client.Database("xcloud_ops_test_balance").Drop(ctx)
		_ = client.Disconnect(ctx)
	}

	return repo, cleanup
}

func TestRepository_AdjustBalanceCAS_Success(t *testing.T) {
	repo, cleanup := setupTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()

	ctx := context.Background()
	testIMSI := "417019999999001"

	// Seed balance doc
	doc := bson.M{
		"imsi":            testIMSI,
		"data_total":      int64(1000),
		"data_used":       int64(200),
		"data_reserved":   int64(100),
		"data_available":  int64(700),
		"voice_total":     int64(3600),
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": int64(3600),
		"sms_total":       int64(100),
		"sms_used":        int64(0),
		"sms_available":   int64(100),
		"version":         int64(1),
		"status":          "active",
		"updated_at":      time.Now().UTC().Format(time.RFC3339),
	}
	_, err := repo.balances.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("failed to insert test doc: %v", err)
	}

	// 1. Credit 500 data
	res, err := repo.AdjustBalanceCAS(ctx, testIMSI, 1, "data", "credit", 500)
	if err != nil {
		t.Fatalf("expected credit to succeed, got %v", err)
	}
	if res.After.DataTotal != 1500 || res.After.DataAvailable != 1200 {
		t.Errorf("unexpected credit after: total=%d, avail=%d", res.After.DataTotal, res.After.DataAvailable)
	}
	if res.After.Version != 2 {
		t.Errorf("expected version 2, got %d", res.After.Version)
	}

	// 2. Debit 200 data with version 2
	res2, err := repo.AdjustBalanceCAS(ctx, testIMSI, 2, "data", "debit", 200)
	if err != nil {
		t.Fatalf("expected debit to succeed, got %v", err)
	}
	if res2.After.DataTotal != 1300 || res2.After.DataAvailable != 1000 {
		t.Errorf("unexpected debit after: total=%d, avail=%d", res2.After.DataTotal, res2.After.DataAvailable)
	}
	if res2.After.Version != 3 {
		t.Errorf("expected version 3, got %d", res2.After.Version)
	}
}

func TestRepository_AdjustBalanceCAS_Conflict(t *testing.T) {
	repo, cleanup := setupTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()

	ctx := context.Background()
	testIMSI := "417019999999002"

	doc := bson.M{
		"imsi":            testIMSI,
		"data_total":      int64(1000),
		"data_used":       int64(0),
		"data_reserved":   int64(0),
		"data_available":  int64(1000),
		"voice_total":     int64(3600),
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": int64(3600),
		"sms_total":       int64(100),
		"sms_used":        int64(0),
		"sms_available":   int64(100),
		"version":         int64(5),
		"status":          "active",
	}
	_, err := repo.balances.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("failed to insert test doc: %v", err)
	}

	// Attempt CAS with stale version 4 (expected version 5)
	_, err = repo.AdjustBalanceCAS(ctx, testIMSI, 4, "data", "credit", 100)
	if err != ErrPreconditionChanged {
		t.Fatalf("expected ErrPreconditionChanged, got %v", err)
	}
}

func TestRepository_AdjustBalanceCAS_InsufficientBalance(t *testing.T) {
	repo, cleanup := setupTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()

	ctx := context.Background()
	testIMSI := "417019999999003"

	doc := bson.M{
		"imsi":            testIMSI,
		"data_total":      int64(500),
		"data_used":       int64(100),
		"data_reserved":   int64(100),
		"data_available":  int64(300),
		"voice_total":     int64(3600),
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": int64(3600),
		"sms_total":       int64(100),
		"sms_used":        int64(0),
		"sms_available":   int64(100),
		"version":         int64(1),
	}
	_, err := repo.balances.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("failed to insert test doc: %v", err)
	}

	// Debit 400 when available is 300
	_, err = repo.AdjustBalanceCAS(ctx, testIMSI, 1, "data", "debit", 400)
	if err != ErrInsufficientBalance {
		t.Fatalf("expected ErrInsufficientBalance, got %v", err)
	}
}
