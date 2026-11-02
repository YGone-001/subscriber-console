package subscriber

import (
	"context"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// A row must not claim a tariff plan it was never assigned. The default plan
// exists in this fixture, so a contract-less subscriber and a contract whose
// plan_id is empty would both inherit its name and status through the old
// default lookup.
func TestSubscriberListDoesNotFabricateADefaultPlan(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := repo.tariffPlans.InsertOne(ctx, bson.M{
		"plan_id": defaultPlanID, "name": "Default 10GB Data Plan", "status": "disabled",
		"volume_threshold": int64(0),
	}); err != nil {
		t.Fatalf("seed default plan: %v", err)
	}
	if _, err := repo.subscribers.InsertMany(ctx, []any{
		bson.M{"_id": "no-contract", "imsi": "460029990000031", "access_restriction_data": 32},
		bson.M{"_id": "empty-plan", "imsi": "460029990000032", "access_restriction_data": 32},
	}); err != nil {
		t.Fatalf("seed subscribers: %v", err)
	}
	if _, err := repo.ocsSubs.InsertOne(ctx, bson.M{
		"imsi": "460029990000032", "status": "active", "plan_id": "",
	}); err != nil {
		t.Fatalf("seed contract: %v", err)
	}

	result, err := repo.ListSubscriberRowsFiltered(ctx, 1, 50, "",
		SubscriberListFilters{SearchBy: "imsi", Status: "all"}, "imsi", "asc")
	if err != nil {
		t.Fatalf("list subscribers: %v", err)
	}
	if result.Total != 2 {
		t.Fatalf("total = %d, want 2", result.Total)
	}
	for _, row := range result.Subscribers {
		if row.Policy != "" || row.PolicyName != "" || row.PolicyStatus != "" {
			t.Fatalf("%s reports policy=%q name=%q status=%q, want no plan evidence",
				row.IMSI, row.Policy, row.PolicyName, row.PolicyStatus)
		}
		if row.Provisioning.TariffPlan {
			t.Fatalf("%s claims a provisioned tariff plan", row.IMSI)
		}
	}
}
