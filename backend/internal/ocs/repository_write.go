package ocs

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// CreateSubscriberContract upserts an OCS subscriber contract document.
// Uses bson.M to preserve unknown fields. Sets created_at/updated_at on insert.
func (r *Repository) CreateSubscriberContract(ctx context.Context, doc bson.M) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	now := time.Now().UTC()
	doc["updated_at"] = now

	_, err := r.subscribers.UpdateOne(ctx,
		bson.M{"imsi": doc["imsi"]},
		bson.M{
			"$set":         doc,
			"$setOnInsert": bson.M{"created_at": now},
		},
		options.UpdateOne().SetUpsert(true),
	)
	return err
}

// GetSubscriberRaw returns the raw BSON document for an OCS subscriber, or nil if not found.
// Used for before-snapshots in governance flows.
func (r *Repository) GetSubscriberRaw(ctx context.Context, imsi string) (bson.M, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.subscribers.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return doc, nil
}

// UpdateTariffBinding updates the tariff plan binding for an OCS subscriber.
// Returns error if subscriber not found.
func (r *Repository) UpdateTariffBinding(ctx context.Context, imsi, planID string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	result, err := r.subscribers.UpdateOne(ctx,
		bson.M{"imsi": imsi},
		bson.M{"$set": bson.M{"plan_id": planID, "updated_at": time.Now().UTC()}},
	)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("OCS_SUBSCRIBER_NOT_FOUND")
	}
	return nil
}

// SetContractStatus updates the status field of an OCS subscriber contract.
// Returns error if subscriber not found.
func (r *Repository) SetContractStatus(ctx context.Context, imsi, status string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	result, err := r.subscribers.UpdateOne(ctx,
		bson.M{"imsi": imsi},
		bson.M{"$set": bson.M{"status": status, "updated_at": time.Now().UTC()}},
	)
	if err != nil {
		return err
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("OCS_SUBSCRIBER_NOT_FOUND")
	}
	return nil
}

// TerminateContract deletes an OCS subscriber contract.
// Returns error if subscriber not found.
func (r *Repository) TerminateContract(ctx context.Context, imsi string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	result, err := r.subscribers.DeleteOne(ctx, bson.M{"imsi": imsi})
	if err != nil {
		return err
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("OCS_SUBSCRIBER_NOT_FOUND")
	}
	return nil
}

// GetTariffPlanStatus returns the status of a tariff plan, or error if not found.
// Used to validate tariff dependency before creating/updating OCS subscriber contracts.
func (r *Repository) GetTariffPlanStatus(ctx context.Context, planID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.plans.FindOne(ctx, bson.M{"plan_id": planID}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return "", fmt.Errorf("OCS_TARIFF_NOT_FOUND")
	}
	if err != nil {
		return "", err
	}
	status, _ := doc["status"].(string)
	return status, nil
}
