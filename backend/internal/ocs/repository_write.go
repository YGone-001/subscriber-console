package ocs

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

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

// SyncBalanceStatus mirrors the contract lifecycle status into the balance
// account. The contract remains the authority; this keeps status filters and
// the storefront projection aligned. A missing balance is a no-op because
// legacy contracts may not have been provisioned with one.
func (r *Repository) SyncBalanceStatus(ctx context.Context, imsi, status string) error {
	if r.balances == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := r.balances.UpdateOne(ctx,
		bson.M{"imsi": imsi},
		bson.M{
			"$set": bson.M{"status": status, "updated_at": time.Now().UTC()},
			"$inc": bson.M{"version": 1},
		},
	)
	return err
}

// SyncBalancePlan mirrors a tariff rebinding into the balance account so the
// plan filter and the account projection agree with the contract.
func (r *Repository) SyncBalancePlan(ctx context.Context, imsi, planID string) error {
	if r.balances == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	update := bson.M{
		"$set": bson.M{"plan_id": planID, "updated_at": time.Now().UTC()},
		"$inc": bson.M{"version": 1},
	}
	if planID == "" {
		// Reverting a legacy contract that never reported a plan must remove the
		// field rather than leave an empty string behind.
		update = bson.M{
			"$unset": bson.M{"plan_id": ""},
			"$set":   bson.M{"updated_at": time.Now().UTC()},
			"$inc":   bson.M{"version": 1},
		}
	}
	_, err := r.balances.UpdateOne(ctx, bson.M{"imsi": imsi}, update)
	return err
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
