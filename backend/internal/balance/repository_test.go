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
	auditColl := client.Database("xcloud_ops_test_balance").Collection("app_audit_logs")

	repo := NewRepository(balancesColl, subsColl, auditColl)

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

func TestListBalances_InvariantFilterAndSummaryShareOneResultSet(t *testing.T) {
	repo, cleanup := setupTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()
	ctx := context.Background()

	docs := []bson.M{
		{
			"imsi": "417019999999021", "plan_id": "plan_a", "status": "active", "version": int64(1),
			"data_total": int64(100), "data_used": int64(0), "data_reserved": int64(0), "data_available": int64(100),
			"voice_total": int64(10), "voice_used": int64(0), "voice_reserved": int64(0), "voice_available": int64(10),
			"sms_total": int64(5), "sms_used": int64(0), "sms_available": int64(5),
		},
		{
			"imsi": "417019999999022", "plan_id": "plan_a", "status": "active", "version": int64(1),
			"data_total": int64(100), "data_used": int64(0), "data_reserved": int64(0), "data_available": int64(40),
			"voice_total": int64(10), "voice_used": int64(0), "voice_reserved": int64(0), "voice_available": int64(10),
			"sms_total": int64(5), "sms_used": int64(0), "sms_available": int64(5),
		},
		{
			"imsi": "417019999999023", "plan_id": "plan_b", "status": "suspended", "version": int64(1),
			"data_total": int64(50), "data_used": int64(0), "data_reserved": int64(0), "data_available": int64(50),
			"voice_total": int64(0), "voice_used": int64(0), "voice_reserved": int64(0), "voice_available": int64(0),
			"sms_total": int64(0), "sms_used": int64(0), "sms_available": int64(0),
		},
		{
			"imsi": "417019999999024", "plan_id": "plan_a", "status": "active", "version": int64(1),
		},
	}
	for _, doc := range docs {
		if _, err := repo.balances.InsertOne(ctx, doc); err != nil {
			t.Fatalf("seed balance: %v", err)
		}
	}

	all, err := repo.ListBalances(ctx, BalanceQueryOptions{Page: 1, Limit: 20})
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if all.Total != 4 {
		t.Errorf("total = %d, want 4", all.Total)
	}
	if all.Summary.TotalSubscribers != 4 || all.Summary.TotalDataAllocated != 250 {
		t.Errorf("summary = %+v, want 4 accounts and 250 allocated", all.Summary)
	}

	valid, err := repo.ListBalances(ctx, BalanceQueryOptions{Page: 1, Limit: 1, InvariantStatus: "valid"})
	if err != nil {
		t.Fatalf("list valid: %v", err)
	}
	if valid.Total != 2 || valid.TotalPages != 2 || len(valid.Records) != 1 {
		t.Errorf("valid page = total %d pages %d records %d, want 2/2/1", valid.Total, valid.TotalPages, len(valid.Records))
	}
	if valid.Summary.TotalSubscribers != 2 || valid.Summary.TotalDataAllocated != 150 {
		t.Errorf("valid summary = %+v, want the filtered 2 accounts and 150", valid.Summary)
	}

	broken, err := repo.ListBalances(ctx, BalanceQueryOptions{Page: 1, Limit: 20, InvariantStatus: "broken"})
	if err != nil {
		t.Fatalf("list broken: %v", err)
	}
	if broken.Total != 1 || broken.Records[0].IMSI != "417019999999022" {
		t.Errorf("broken result = %+v, want only 417019999999022", broken)
	}

	activePlanA, err := repo.ListBalances(ctx, BalanceQueryOptions{Page: 1, Limit: 20, Status: "active", PlanID: "plan_a"})
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	if activePlanA.Total != 3 {
		t.Errorf("active plan_a total = %d, want 3", activePlanA.Total)
	}
	if activePlanA.Summary.TotalSubscribers != 3 {
		t.Errorf("filtered summary = %+v, want 3 accounts", activePlanA.Summary)
	}
}

func TestMapBalanceView_ContractIsStatusAndPlanAuthority(t *testing.T) {
	const imsi = "417019999999010"
	balance := bson.M{
		"imsi":            imsi,
		"plan_id":         "plan_cached",
		"status":          "active",
		"data_total":      int64(1000),
		"data_used":       int64(0),
		"data_reserved":   int64(0),
		"data_available":  int64(1000),
		"voice_total":     int64(0),
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": int64(0),
		"sms_total":       int64(0),
		"sms_used":        int64(0),
		"sms_available":   int64(0),
		"version":         int64(3),
	}

	contract := bson.M{"imsi": imsi, "plan_id": "plan_contract", "status": "terminated"}
	view := mapBalanceView(balance, map[string]bson.M{imsi: contract})
	if view.PlanID == nil || *view.PlanID != "plan_contract" {
		t.Errorf("plan = %v, want the contract's plan_contract", view.PlanID)
	}
	if view.Status == nil || *view.Status != "terminated" {
		t.Errorf("status = %v, want the contract's terminated", view.Status)
	}

	orphan := mapBalanceView(balance, map[string]bson.M{})
	if orphan.PlanID == nil || *orphan.PlanID != "plan_cached" || orphan.Status == nil || *orphan.Status != "active" {
		t.Errorf("orphan projection = %v/%v, want the account's own cached values", orphan.PlanID, orphan.Status)
	}
}

func TestRepository_GetContractStatus(t *testing.T) {
	repo, cleanup := setupTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()

	ctx := context.Background()
	const imsi = "417019999999011"
	if _, err := repo.subscribers.InsertOne(ctx, bson.M{"imsi": imsi, "status": "terminated"}); err != nil {
		t.Fatalf("seed contract: %v", err)
	}

	status, err := repo.GetContractStatus(ctx, imsi)
	if err != nil {
		t.Fatalf("get contract status: %v", err)
	}
	if status != "terminated" {
		t.Errorf("status = %q, want terminated", status)
	}

	missing, err := repo.GetContractStatus(ctx, "417019999999012")
	if err != nil || missing != "" {
		t.Errorf("missing contract = %q, %v; want empty and nil", missing, err)
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
