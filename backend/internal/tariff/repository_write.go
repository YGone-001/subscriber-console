package tariff

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// CreatePlan inserts a new tariff plan. Returns error if plan_id already exists.
// Uses bson.M to preserve all fields from the input document.
func (r *Repository) CreatePlan(ctx context.Context, doc bson.M) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	planID, _ := doc["plan_id"].(string)
	if planID == "" {
		return fmt.Errorf("INVALID_PLAN_ID")
	}

	// Check for existing plan
	existing, err := r.plans.CountDocuments(ctx, bson.M{"plan_id": planID})
	if err != nil {
		return err
	}
	if existing > 0 {
		return fmt.Errorf("TARIFF_PLAN_EXISTS")
	}

	now := time.Now().UTC()
	doc["created_at"] = now
	doc["updated_at"] = now
	if _, ok := doc["status"]; !ok {
		doc["status"] = "active"
	}

	_, err = r.plans.InsertOne(ctx, doc)
	return err
}

// GetPlanRaw returns the raw BSON document for a tariff plan, or nil if not found.
// Used for before-snapshots in governance flows.
func (r *Repository) GetPlanRaw(ctx context.Context, planID string) (bson.M, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.plans.FindOne(ctx, bson.M{"plan_id": planID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return doc, nil
}

// UpdatePlan replaces a tariff plan document. Returns error if plan not found.
// Uses bson.M to preserve unknown fields.
func (r *Repository) UpdatePlan(ctx context.Context, planID string, doc bson.M) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	doc["plan_id"] = planID
	doc["updated_at"] = time.Now().UTC()

	result, err := r.plans.ReplaceOne(ctx, bson.M{"plan_id": planID}, doc)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("TARIFF_PLAN_NOT_FOUND")
	}
	return nil
}

// DeletePlan removes a tariff plan. Returns error if plan is the default plan.
func (r *Repository) DeletePlan(ctx context.Context, planID string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if planID == defaultPlanID {
		return fmt.Errorf("DEFAULT_TARIFF_PLAN_PROTECTED")
	}

	result, err := r.plans.DeleteOne(ctx, bson.M{"plan_id": planID})
	if err != nil {
		return err
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("TARIFF_PLAN_NOT_FOUND")
	}
	return nil
}

// SetPlanStatus updates only the status field of a tariff plan.
// Returns error if plan not found.
func (r *Repository) SetPlanStatus(ctx context.Context, planID, status string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	result, err := r.plans.UpdateOne(ctx,
		bson.M{"plan_id": planID},
		bson.M{"$set": bson.M{"status": status, "updated_at": time.Now().UTC()}},
	)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("TARIFF_PLAN_NOT_FOUND")
	}
	return nil
}

// CountSubscribersByPlan returns the number of subscribers assigned to a tariff plan.
func (r *Repository) CountSubscribersByPlan(ctx context.Context, planID string) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	return r.subscribers.CountDocuments(ctx, bson.M{"plan_id": planID})
}
