package subscriber

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Subscriber-list golden baseline.
//
// The current list implementation fetches all matching subscribers and applies
// filters, facets and pagination in Go. Before that path is replaced by a Mongo
// aggregation, these cases freeze its observable output: every row field, the
// facet summary, pagination and MSISDN fallback metadata.
type subscriberListGoldenCase struct {
	name      string
	query     string
	filters   SubscriberListFilters
	sortField string
	sortOrder string
	page, lim int
}

func subscriberListGoldenCases() []subscriberListGoldenCase {
	return []subscriberListGoldenCase{
		{name: "all", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "status_active", filters: SubscriberListFilters{SearchBy: "imsi", Status: "active"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "status_restricted", filters: SubscriberListFilters{SearchBy: "imsi", Status: "restricted"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "status_low_traffic", filters: SubscriberListFilters{SearchBy: "imsi", Status: "lowTraffic"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "contract_active", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", ContractStatus: "active"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "contract_suspended", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", ContractStatus: "suspended"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "contract_terminated", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", ContractStatus: "terminated"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "contract_none", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", ContractStatus: "none"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "provisioning_complete", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", Provisioning: "complete"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "provisioning_incomplete", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", Provisioning: "incomplete"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "provisioning_missing_contract", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", Provisioning: "missing_contract"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "provisioning_missing_balance", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", Provisioning: "missing_balance"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "provisioning_missing_plan", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", Provisioning: "missing_plan"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "plan_a", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", PlanID: "plan_a"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "plan_b", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", PlanID: "plan_b"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "balance_exhausted", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", BalanceStatus: "exhausted"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "balance_low", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", BalanceStatus: "low"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "balance_normal", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", BalanceStatus: "normal"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "balance_available_alias", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", BalanceStatus: "available"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "balance_missing", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", BalanceStatus: "missing"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "profile_tpl_a", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", ProfileFilter: "tpl_a"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "profile_tpl_b", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all", ProfileFilter: "tpl_b"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "search_imsi_prefix", query: "46002000000000", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "search_msisdn_fallback", query: "18800000002", filters: SubscriberListFilters{SearchBy: "auto", Status: "all"}, sortField: "imsi", sortOrder: "asc", page: 1, lim: 50},
		{name: "page_two", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all"}, sortField: "imsi", sortOrder: "asc", page: 2, lim: 2},
		{name: "sort_usage_desc", filters: SubscriberListFilters{SearchBy: "imsi", Status: "all"}, sortField: "usage", sortOrder: "desc", page: 1, lim: 50},
	}
}

// Run with UPDATE_SUBSCRIBER_LIST_GOLDEN=1 to regenerate the fixture after an
// intentional contract change; otherwise the test is a strict comparison.
func TestSubscriberListGoldenBaseline(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	seedListGoldenFixture(t, repo)

	cases := subscriberListGoldenCases()

	type caseResult struct {
		Name   string                              `json:"name"`
		Result SubscriberListResult[SubscriberRow] `json:"result"`
	}
	results := make([]caseResult, 0, len(cases))
	for _, tc := range cases {
		result, err := repo.ListSubscriberRowsFiltered(
			context.Background(), tc.page, tc.lim, tc.query, tc.filters, tc.sortField, tc.sortOrder,
		)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		results = append(results, caseResult{Name: tc.name, Result: result})
	}

	payload, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		t.Fatalf("marshal golden result: %v", err)
	}
	payload = append(payload, '\n')
	path := filepath.Join("testdata", "subscriber-list-baseline.json")
	if dump := os.Getenv("DUMP_SUBSCRIBER_LIST_ACTUAL"); dump != "" {
		if err := os.WriteFile(dump, payload, 0o644); err != nil {
			t.Fatalf("write actual subscriber list: %v", err)
		}
	}
	if os.Getenv("UPDATE_SUBSCRIBER_LIST_GOLDEN") == "1" {
		if err := os.WriteFile(path, payload, 0o644); err != nil {
			t.Fatalf("write golden fixture: %v", err)
		}
		return
	}
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden fixture (run with UPDATE_SUBSCRIBER_LIST_GOLDEN=1 to create it): %v", err)
	}
	if string(payload) != string(expected) {
		t.Fatalf("subscriber list output diverged from the baseline in %s", path)
	}
}

func seedListGoldenFixture(t *testing.T, repo *Repository) {
	t.Helper()
	ctx := context.Background()
	fixed := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

	plans := []any{
		bson.M{"plan_id": "plan_a", "name": "Plan A", "status": "active", "volume_threshold": int64(100)},
		bson.M{"plan_id": "plan_b", "name": "Plan B", "status": "disabled", "volume_threshold": int64(0)},
	}
	if _, err := repo.tariffPlans.InsertMany(ctx, plans); err != nil {
		t.Fatalf("seed plans: %v", err)
	}

	subscribers := []any{
		bson.M{
			"_id": "sub-1", "imsi": "460020000000001", "msisdn": bson.A{"18800000001"},
			"access_restriction_data": 32,
			"webui_meta":              bson.M{"profile_name": "tpl_a", "updated_at": fixed},
			"updated_at":              fixed,
		},
		bson.M{
			"_id": "sub-2", "imsi": "460020000000002", "msisdn": bson.A{"18800000002"},
			"access_restriction_data": 63, "profile_name": "tpl_b",
			"updated_at": fixed,
		},
		bson.M{
			"_id": "sub-3", "imsi": "460020000000003", "msisdn": bson.A{"18800000003"},
			"access_restriction_data": 32, "updated_at": fixed,
		},
		bson.M{
			"_id": "sub-4", "imsi": "460020000000004", "msisdn": bson.A{"18800000004"},
			"access_restriction_data": 255, "updated_at": fixed,
		},
		bson.M{
			"_id": "sub-5", "imsi": "460020000000005", "msisdn": bson.A{"18800000005"},
			"access_restriction_data": 32, "updated_at": fixed,
		},
		bson.M{
			"_id": "sub-6", "imsi": "460020000000006", "msisdn": bson.A{"18800000006"},
			"access_restriction_data": 32, "updated_at": fixed,
		},
		// The xCloud MSISDN has appeared both as a scalar list and as the legacy
		// msisdnList form, and an explicit null access_restriction_data is not the
		// same fact as an absent one. Both shapes are pinned here.
		bson.M{
			"_id": "sub-7", "imsi": "460020000000007",
			"msisdnList":              bson.A{bson.M{"msisdn": "18800000007"}},
			"access_restriction_data": nil, "updated_at": fixed,
		},
		bson.M{
			"_id": "sub-8", "imsi": "460020000000008", "updated_at": fixed,
		},
	}
	if _, err := repo.subscribers.InsertMany(ctx, subscribers); err != nil {
		t.Fatalf("seed subscribers: %v", err)
	}

	contracts := []any{
		bson.M{"_id": "contract-1", "imsi": "460020000000001", "plan_id": "plan_a", "status": "active", "updated_at": fixed},
		bson.M{"_id": "contract-2", "imsi": "460020000000002", "plan_id": "plan_a", "status": "suspended", "updated_at": fixed},
		bson.M{"_id": "contract-4", "imsi": "460020000000004", "plan_id": "plan_b", "status": "active", "updated_at": fixed},
		bson.M{"_id": "contract-5", "imsi": "460020000000005", "plan_id": "plan_missing", "status": "active", "updated_at": fixed},
		bson.M{"_id": "contract-6", "imsi": "460020000000006", "plan_id": "plan_a", "status": "terminated", "updated_at": fixed},
		// contract-7 carries a different MSISDN than the subscriber document to
		// pin that the xCloud value wins. contract-8 has an empty plan_id, which
		// resolves through the default plan, and its MSISDN is the only one.
		bson.M{"_id": "contract-7", "imsi": "460020000000007", "plan_id": "plan_a", "status": "active", "msisdn": "18800000907", "updated_at": fixed},
		bson.M{"_id": "contract-8", "imsi": "460020000000008", "plan_id": "", "status": "active", "msisdn": "18800000008", "updated_at": fixed},
	}
	if _, err := repo.ocsSubs.InsertMany(ctx, contracts); err != nil {
		t.Fatalf("seed contracts: %v", err)
	}

	balances := []any{
		bson.M{
			"imsi": "460020000000001", "data_total": int64(1000), "data_used": int64(100), "data_available": int64(900),
			"sms_total": int64(10), "sms_used": int64(0), "sms_available": int64(10),
		},
		bson.M{
			"imsi": "460020000000002", "data_total": int64(100), "data_used": int64(50), "data_available": int64(50),
			"sms_total": int64(10), "sms_used": int64(10), "sms_available": int64(0),
		},
		bson.M{
			"imsi": "460020000000004", "data_total": int64(100), "data_used": int64(100), "data_available": int64(0),
			"sms_total": int64(10), "sms_used": int64(10), "sms_available": int64(0),
		},
		bson.M{
			"imsi": "460020000000006", "data_total": int64(200), "data_used": int64(0), "data_available": int64(200),
			"sms_total": int64(10), "sms_used": int64(0), "sms_available": int64(10),
		},
		// sub-7 has no SMS fields at all; sub-8 has no data_available, so its
		// balance state is unmeasurable rather than exhausted.
		bson.M{
			"imsi": "460020000000007", "data_total": int64(500), "data_used": int64(0), "data_available": int64(500),
		},
		bson.M{
			"imsi": "460020000000008", "data_total": int64(300), "data_used": int64(120),
		},
	}
	if _, err := repo.ocsBalances.InsertMany(ctx, balances); err != nil {
		t.Fatalf("seed balances: %v", err)
	}
}
