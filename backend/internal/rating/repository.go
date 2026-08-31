package rating

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const defaultPlanID = "plan_default_10gb"

// Repository provides read-only access to rating policies.
type Repository struct {
	collection *mongo.Collection
}

// NewRepository creates a Repository for the given collection.
func NewRepository(collection *mongo.Collection) *Repository {
	return &Repository{collection: collection}
}

// ListRatings retrieves all rating policies, optionally filtered by planId.
// Matches the Node.js listRatingPolicies() behavior.
func (r *Repository) ListRatings(ctx context.Context, planID string) ([]RatingPolicy, error) {
	filter := bson.M{}
	if planID != "" {
		filter["$or"] = []bson.M{
			{"plan_id": planID},
			{"plan_id": bson.M{"$exists": false}},
			{"plan_id": ""},
		}
	}

	cursor, err := r.collection.Find(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("find ratings: %w", err)
	}
	defer cursor.Close(ctx)

	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("decode ratings: %w", err)
	}

	result := make([]RatingPolicy, 0, len(docs))
	for _, doc := range docs {
		result = append(result, mapToRating(doc))
	}
	if result == nil {
		result = []RatingPolicy{}
	}

	return result, nil
}

// GetRating retrieves a single rating by ID and optional planId.
func (r *Repository) GetRating(ctx context.Context, id string, planID string) (*RatingPolicy, error) {
	filter := bson.M{"rating_group_id": id}
	if planID != "" {
		filter["$or"] = []bson.M{
			{"plan_id": planID},
			{"plan_id": bson.M{"$exists": false}},
			{"plan_id": ""},
		}
	}

	var doc bson.M
	err := r.collection.FindOne(ctx, filter).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find rating: %w", err)
	}

	result := mapToRating(doc)
	return &result, nil
}

func mapToRating(doc bson.M) RatingPolicy {
	rp := RatingPolicy{}
	if v, ok := doc["rating_group_id"]; ok {
		rp.RatingGroupID = numericInt(v)
	}
	if v, ok := doc["currency"].(string); ok {
		rp.Currency = v
	}
	if v, ok := doc["rates"].(string); ok {
		rp.Rates = v
	} else if doc["rates"] != nil {
		rp.Rates = fmt.Sprintf("%v", doc["rates"])
	}
	if v, ok := doc["rates_type"]; ok {
		rp.RatesType = numericInt(v)
	}
	if v, ok := doc["plan_id"].(string); ok {
		rp.PlanID = v
	}
	if v, ok := doc["rule_id"].(string); ok {
		rp.RuleID = v
	}
	if v, ok := doc["apn"].(string); ok {
		rp.Apn = v
	}
	if v, ok := doc["service_identifier"]; ok {
		rp.ServiceIdentifier = numericInt(v)
	}
	if v, ok := doc["charging_type"].(string); ok {
		rp.ChargingType = v
	}
	if v, ok := doc["unit"].(string); ok {
		rp.Unit = v
	}
	if v, ok := doc["quota_per_grant"]; ok {
		rp.QuotaPerGrant = numericInt64(v)
	}
	if v, ok := doc["validity_time"]; ok {
		rp.ValidityTime = numericInt(v)
	}
	if v, ok := doc["volume_threshold"]; ok {
		rp.VolumeThreshold = numericInt64(v)
	}
	if v, ok := doc["priority"]; ok {
		rp.Priority = numericInt(v)
	}
	if v, ok := doc["status"].(string); ok {
		rp.Status = v
	}
	return rp
}

func numericInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return 0
	}
}

func numericInt64(v interface{}) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	default:
		return 0
	}
}
