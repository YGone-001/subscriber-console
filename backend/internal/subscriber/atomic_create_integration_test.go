package subscriber

import (
	"context"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func seedTariffPlan(t *testing.T, repo *Repository, planID string) {
	t.Helper()
	if _, err := repo.tariffPlans.InsertOne(context.Background(), bson.M{
		"plan_id": planID,
		"name":    planID,
		"status":  "active",
	}); err != nil {
		t.Fatalf("seed tariff plan %s: %v", planID, err)
	}
}

func decodedSubDocument(t *testing.T, raw any) map[string]any {
	t.Helper()
	switch m := raw.(type) {
	case bson.M:
		return m
	case bson.D:
		out := map[string]any{}
		for _, entry := range m {
			out[entry.Key] = entry.Value
		}
		return out
	default:
		t.Fatalf("expected a document, got %T", raw)
		return nil
	}
}

func readOcsBalance(t *testing.T, repo *Repository, imsi string) bson.M {
	t.Helper()
	var balance bson.M
	if err := repo.ocsBalances.FindOne(context.Background(), bson.M{"imsi": imsi}).Decode(&balance); err != nil {
		t.Fatalf("load ocs balance %s: %v", imsi, err)
	}
	return balance
}

func readOcsContract(t *testing.T, repo *Repository, imsi string) bson.M {
	t.Helper()
	var contract bson.M
	if err := repo.ocsSubs.FindOne(context.Background(), bson.M{"imsi": imsi}).Decode(&contract); err != nil {
		t.Fatalf("load ocs contract %s: %v", imsi, err)
	}
	return contract
}

func countDocuments(t *testing.T, repo *Repository, imsi string) (subscribers, contracts, balances int64) {
	t.Helper()
	ctx := context.Background()
	subscribers, err := repo.subscribers.CountDocuments(ctx, bson.M{"imsi": imsi})
	if err != nil {
		t.Fatalf("count subscribers: %v", err)
	}
	contracts, err = repo.ocsSubs.CountDocuments(ctx, bson.M{"imsi": imsi})
	if err != nil {
		t.Fatalf("count ocs subscribers: %v", err)
	}
	balances, err = repo.ocsBalances.CountDocuments(ctx, bson.M{"imsi": imsi})
	if err != nil {
		t.Fatalf("count ocs balances: %v", err)
	}
	return subscribers, contracts, balances
}

// A create carries the record, its 4G configuration and its initial OCS quota in one
// call. The persisted documents must show all three, so no follow-up edit is required
// and no legacy 10 GB / 1h / 100 defaults are invented for buckets nobody supplied.
func TestCreateSubscriberWithConfiguration_WritesRecordConfigurationAndOcs(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	seedTariffPlan(t, repo, "plan_atomic")

	const imsi = "417010000000101"
	msisdn := "963900000101"

	created, err := repo.CreateSubscriberWithConfiguration(
		ctx, imsi, stringPtr("plan_atomic"), &msisdn, nil, "tpl_atomic",
		map[string]any{
			"access_restriction_data": 63,
			"network_access_mode":     2,
			"ambr": bson.M{
				"downlink": bson.M{"value": 100, "unit": 2},
				"uplink":   bson.M{"value": 50, "unit": 2},
			},
			"msisdnList": []any{map[string]any{"msisdn": msisdn}},
			"sliceList": []any{map[string]any{
				"sst":               1,
				"sd":                "000002",
				"default_indicator": true,
				"session_list":      []any{},
			}},
		},
		map[string]any{
			"traffic_total":   int64(10737418240),
			"traffic_balance": int64(10737418240),
		},
	)
	if err != nil {
		t.Fatalf("atomic create: %v", err)
	}
	if created == nil {
		t.Fatal("atomic create returned no document")
	}

	if got := numericInt64(created["access_restriction_data"]); got != 63 {
		t.Errorf("access_restriction_data = %d, want 63", got)
	}
	if got := numericInt64(created["network_access_mode"]); got != 2 {
		t.Errorf("network_access_mode = %d, want 2", got)
	}
	meta := decodedSubDocument(t, created["webui_meta"])
	if meta["profile_name"] != "tpl_atomic" {
		t.Errorf("webui_meta.profile_name = %v, want tpl_atomic", meta["profile_name"])
	}
	if slices := anySliceOrEmpty(created["slice"]); len(slices) != 1 {
		t.Errorf("slice count = %d, want 1", len(slices))
	}
	if addresses := anySliceOrEmpty(created["msisdn"]); len(addresses) != 1 || addresses[0] != msisdn {
		t.Errorf("msisdn = %v, want [%s]", addresses, msisdn)
	}

	contract := readOcsContract(t, repo, imsi)
	if contract["plan_id"] != "plan_atomic" {
		t.Errorf("ocs plan_id = %v, want plan_atomic", contract["plan_id"])
	}
	if contract["status"] != "active" {
		t.Errorf("ocs status = %v, want active", contract["status"])
	}
	if contract["msisdn"] != msisdn {
		t.Errorf("ocs msisdn = %v, want %s", contract["msisdn"], msisdn)
	}

	balance := readOcsBalance(t, repo, imsi)
	if got := numericInt64(balance["data_total"]); got != 10737418240 {
		t.Errorf("data_total = %d, want 10737418240", got)
	}
	if got := numericInt64(balance["data_available"]); got != 10737418240 {
		t.Errorf("data_available = %d, want 10737418240", got)
	}
	if got := numericInt64(balance["data_used"]); got != 0 {
		t.Errorf("data_used = %d, want 0", got)
	}
	for _, absent := range []string{"voice_total", "voice_available", "sms_total", "sms_available", "money_balance"} {
		if _, present := balance[absent]; present {
			t.Errorf("unsupplied bucket %q must stay unconfigured, got %v", absent, balance[absent])
		}
	}
	if balance["plan_id"] != "plan_atomic" {
		t.Errorf("balance plan_id = %v, want plan_atomic", balance["plan_id"])
	}
}

// Creating without quota input must not invent the legacy defaults: the contract is
// still provisioned, but the balance document carries no bucket fields at all.
func TestCreateSubscriberWithConfiguration_LeavesUnsuppliedBucketsUnconfigured(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	seedTariffPlan(t, repo, defaultPlanID)

	const imsi = "417010000000102"
	if _, err := repo.CreateSubscriberWithConfiguration(ctx, imsi, nil, nil, nil, "", nil, nil); err != nil {
		t.Fatalf("atomic create: %v", err)
	}

	balance := readOcsBalance(t, repo, imsi)
	for _, absent := range []string{
		"data_total", "data_available", "data_used",
		"voice_total", "voice_available",
		"sms_total", "sms_available",
		"money_balance",
	} {
		if _, present := balance[absent]; present {
			t.Errorf("unsupplied bucket %q must stay unconfigured, got %v", absent, balance[absent])
		}
	}
	if balance["plan_id"] != defaultPlanID {
		t.Errorf("balance plan_id = %v, want %s", balance["plan_id"], defaultPlanID)
	}
	if contract := readOcsContract(t, repo, imsi); contract["plan_id"] != defaultPlanID {
		t.Errorf("ocs plan_id = %v, want %s", contract["plan_id"], defaultPlanID)
	}
}

// A provisioning failure must leave nothing behind: the inserted subscriber is the
// compensation target, because it was written before OCS was provisioned.
func TestCreateSubscriberWithConfiguration_CompensatesWhenOcsProvisioningFails(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	seedTariffPlan(t, repo, defaultPlanID)

	const imsi = "417010000000103"
	_, err := repo.CreateSubscriberWithConfiguration(ctx, imsi, nil, nil, nil, "", nil, map[string]any{
		"planId": "plan_missing",
	})
	if err == nil {
		t.Fatal("create with a missing OCS plan must fail")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok || govErr.Code != "OCS_PLAN_NOT_FOUND" {
		t.Fatalf("error = %v, want OCS_PLAN_NOT_FOUND", err)
	}

	subscribers, contracts, balances := countDocuments(t, repo, imsi)
	if subscribers != 0 || contracts != 0 || balances != 0 {
		t.Errorf("failed create left rows behind: subscribers=%d contracts=%d balances=%d", subscribers, contracts, balances)
	}
}

// When the sub4G list carries the numbers, its first entry is the primary for
// both the subscriber document and the OCS contract.
func TestCreateSubscriberWithConfiguration_UsesSub4GListAsMsisdnAuthority(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	seedTariffPlan(t, repo, defaultPlanID)

	const imsi = "417010000000106"
	const msisdn = "963900000106"
	created, err := repo.CreateSubscriberWithConfiguration(ctx, imsi, nil, nil, nil, "", map[string]any{
		"msisdnList": []any{map[string]any{"msisdn": msisdn}},
	}, nil)
	if err != nil {
		t.Fatalf("atomic create: %v", err)
	}
	if addresses := anySliceOrEmpty(created["msisdn"]); len(addresses) != 1 || addresses[0] != msisdn {
		t.Errorf("msisdn = %v, want [%s]", addresses, msisdn)
	}
	if contract := readOcsContract(t, repo, imsi); contract["msisdn"] != msisdn {
		t.Errorf("ocs msisdn = %v, want %s", contract["msisdn"], msisdn)
	}
}

// A top-level msisdn that contradicts the sub4G list must be refused rather than
// silently dropped, so the caller learns which number actually wins.
func TestCreateSubscriberWithConfiguration_RejectsMismatchedMsisdn(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	seedTariffPlan(t, repo, defaultPlanID)

	const imsi = "417010000000107"
	topLevel := "963900000107"
	_, err := repo.CreateSubscriberWithConfiguration(ctx, imsi, nil, stringPtr(topLevel), nil, "", map[string]any{
		"msisdnList": []any{map[string]any{"msisdn": "963900000108"}},
	}, nil)
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok || govErr.Code != "MSISDN_MISMATCH" {
		t.Fatalf("error = %v, want MSISDN_MISMATCH", err)
	}

	subscribers, contracts, balances := countDocuments(t, repo, imsi)
	if subscribers != 0 || contracts != 0 || balances != 0 {
		t.Errorf("rejected create left rows behind: subscribers=%d contracts=%d balances=%d", subscribers, contracts, balances)
	}
}

// Reusing an IMSI must not overwrite a retained terminated contract or an orphan
// active contract: both are history/state the create upsert would silently rewrite.
func TestCreateSubscriberWithConfiguration_RefusesExistingOcsContract(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	seedTariffPlan(t, repo, defaultPlanID)

	cases := []struct {
		imsi    string
		status  string
		wantErr string
	}{
		{"417010000000104", "terminated", "OCS_CONTRACT_RETAINED"},
		{"417010000000105", "active", "OCS_CONTRACT_EXISTS"},
	}

	for _, tc := range cases {
		if _, err := repo.ocsSubs.InsertOne(ctx, bson.M{
			"imsi": tc.imsi, "status": tc.status, "plan_id": defaultPlanID,
		}); err != nil {
			t.Fatalf("seed ocs contract %s: %v", tc.imsi, err)
		}

		_, err := repo.CreateSubscriberWithConfiguration(ctx, tc.imsi, nil, nil, nil, "", nil, nil)
		govErr, ok := err.(*SubscriberGovernanceError)
		if !ok || govErr.Code != tc.wantErr {
			t.Fatalf("%s: error = %v, want %s", tc.imsi, err, tc.wantErr)
		}

		subscribers, contracts, balances := countDocuments(t, repo, tc.imsi)
		if subscribers != 0 {
			t.Errorf("%s: subscriber must not be created", tc.imsi)
		}
		if contracts != 1 {
			t.Errorf("%s: the existing contract must be preserved, got %d", tc.imsi, contracts)
		}
		if balances != 0 {
			t.Errorf("%s: no balance must be written over the existing contract", tc.imsi)
		}
	}
}

// The HTTP create endpoint must accept the full configuration in the same request
// that creates the subscriber.
func TestHandleCreate_WithConfigurationWritesOneAtomicRecord(t *testing.T) {
	store := &recordingEvidenceStore{}
	h, repo, cleanup := newCreateHandler(t, store)
	defer cleanup()
	seedTariffPlan(t, repo, "plan_http")

	const imsi = "417010000000141"
	const msisdn = "963900000141"
	body := `{"imsi":"` + imsi + `","msisdn":"` + msisdn + `","planId":"plan_http",` +
		`"sub4G":{"access_restriction_data":63,"network_access_mode":2,` +
		`"msisdnList":[{"msisdn":"` + msisdn + `"}]},` +
		`"ocsTraffic":{"traffic_total":1073741824,"traffic_balance":536870912}}`

	if w := postCreate(t, h, body); w.Code != 201 {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}

	doc, err := repo.FindSubscriberByImsi(context.Background(), imsi)
	if err != nil || doc == nil {
		t.Fatalf("reload subscriber: %v", err)
	}
	if got := numericInt64(doc["access_restriction_data"]); got != 63 {
		t.Errorf("access_restriction_data = %d, want 63", got)
	}
	if got := numericInt64(doc["network_access_mode"]); got != 2 {
		t.Errorf("network_access_mode = %d, want 2", got)
	}

	balance := readOcsBalance(t, repo, imsi)
	if got := numericInt64(balance["data_total"]); got != 1073741824 {
		t.Errorf("data_total = %d, want 1073741824", got)
	}
	if got := numericInt64(balance["data_available"]); got != 536870912 {
		t.Errorf("data_available = %d, want 536870912", got)
	}
	if got := numericInt64(balance["data_used"]); got != 536870912 {
		t.Errorf("data_used = %d, want 536870912", got)
	}
}

// The retained-contract guard must surface as a 409 with its own code, not as an
// internal error the operator cannot interpret.
func TestHandleCreate_RefusesRetainedOcsContract(t *testing.T) {
	store := &recordingEvidenceStore{}
	h, repo, cleanup := newCreateHandler(t, store)
	defer cleanup()
	seedTariffPlan(t, repo, defaultPlanID)

	const imsi = "417010000000142"
	if _, err := repo.ocsSubs.InsertOne(context.Background(), bson.M{
		"imsi": imsi, "status": "terminated", "plan_id": defaultPlanID,
	}); err != nil {
		t.Fatalf("seed retained contract: %v", err)
	}

	w := postCreate(t, h, `{"imsi":"`+imsi+`","planId":"`+defaultPlanID+`"}`)
	if w.Code != 409 {
		t.Fatalf("status = %d, want 409; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "OCS_CONTRACT_RETAINED") {
		t.Errorf("response must carry OCS_CONTRACT_RETAINED: %s", w.Body.String())
	}

	if doc, err := repo.FindSubscriberByImsi(context.Background(), imsi); err != nil || doc != nil {
		t.Errorf("subscriber must not be created: doc=%v err=%v", doc, err)
	}
}
