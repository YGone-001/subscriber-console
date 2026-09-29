package rating

import (
	"context"
	"fmt"
	"sort"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const defaultPlanID = "plan_default_10gb"

// Repository provides read-only access to rating policies.
//
// Rating policies are DERIVED from tariff plan rules, matching the Node.js
// ocsBillingRepository.listRatingPolicies() behavior. The plan is the single
// source of truth; there is no standalone ratings collection read path.
type Repository struct {
	tariffPlans *mongo.Collection
}

// NewRepository creates a Repository backed by the tariff plans collection.
func NewRepository(tariffPlans *mongo.Collection) *Repository {
	return &Repository{tariffPlans: tariffPlans}
}

// ListRatings retrieves all rating policies, optionally filtered by planId.
// Matches the Node.js listRatingPolicies() behavior.
func (r *Repository) ListRatings(ctx context.Context, planID string) ([]RatingPolicy, error) {
	plan, err := r.loadPlan(ctx, planID)
	if err != nil {
		return nil, err
	}
	if plan == nil {
		return []RatingPolicy{}, nil
	}

	resolvedPlanID := planIDOf(plan, planID)
	rules := planRules(plan)
	policies := make([]RatingPolicy, 0, len(rules))
	for _, rule := range rules {
		if numericInt64(rule["rating_group"]) > 0 {
			policies = append(policies, normalizePolicy(rule, resolvedPlanID))
		}
	}
	sort.SliceStable(policies, func(i, j int) bool {
		return policies[i].RatingGroupID < policies[j].RatingGroupID
	})
	return policies, nil
}

// GetRating retrieves a single rating by ID and optional planId.
// Matches the Node.js getRatingPolicy() behavior.
func (r *Repository) GetRating(ctx context.Context, id string, planID string) (*RatingPolicy, error) {
	plan, err := r.loadPlan(ctx, planID)
	if err != nil {
		return nil, err
	}
	if plan == nil {
		return nil, nil
	}

	resolvedPlanID := planIDOf(plan, planID)
	for _, rule := range planRules(plan) {
		ratingGroup := numericInt64(rule["rating_group"])
		if ratingGroup <= 0 {
			continue
		}
		if fmt.Sprintf("%d", ratingGroup) == id {
			policy := normalizePolicy(rule, resolvedPlanID)
			return &policy, nil
		}
	}
	return nil, nil
}

// loadPlan resolves the tariff plan document. An empty planId resolves to the
// default plan id, mirroring Node.js normalizePlanId().
func (r *Repository) loadPlan(ctx context.Context, planID string) (bson.M, error) {
	resolved := planID
	if resolved == "" {
		resolved = defaultPlanID
	}

	var doc bson.M
	err := r.tariffPlans.FindOne(ctx, bson.M{"plan_id": resolved}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find tariff plan: %w", err)
	}
	return doc, nil
}

func planRules(plan bson.M) []bson.M {
	raw := asDocumentList(plan["rules"])
	rules := make([]bson.M, 0, len(raw))
	for _, doc := range raw {
		rules = append(rules, bson.M(doc))
	}
	return rules
}

// planIDOf returns the plan document's own plan_id (Node uses plan.plan_id in
// normalizePolicy), falling back to the requested id.
func planIDOf(plan bson.M, requested string) string {
	if s, ok := plan["plan_id"].(string); ok && s != "" {
		return s
	}
	if requested != "" {
		return requested
	}
	return defaultPlanID
}

// normalizePolicy mirrors the Node.js normalizePolicy() mapping, including its
// defaults for absent fields.
func normalizePolicy(rule bson.M, planID string) RatingPolicy {
	rp := RatingPolicy{}
	rp.RatingGroupID = int(numericInt64(rule["rating_group"]))
	rp.Currency = stringOr(rule["currency"], "USD")
	rp.Rates = stringOr(rule["rates"], "0")
	rp.RatesType = numericInt(rule["rates_type"])
	if rp.RatesType == 0 {
		rp.RatesType = 2
	}
	rp.PlanID = planID
	rp.RuleID = stringOr(rule["rule_id"], "")
	rp.Apn = stringOr(rule["apn"], "")
	rp.ServiceIdentifier = numericInt(rule["service_identifier"])
	rp.ChargingType = stringOr(rule["charging_type"], "")
	rp.Unit = stringOr(rule["unit"], "bytes")
	rp.QuotaPerGrant = numericInt64(rule["quota_per_grant"])
	rp.ValidityTime = numericInt(rule["validity_time"])
	rp.VolumeThreshold = numericInt64(rule["volume_threshold"])
	rp.Priority = numericInt(rule["priority"])
	if rp.Priority == 0 {
		rp.Priority = 100
	}
	rp.Status = stringOr(rule["status"], "active")
	return rp
}

// stringOr mirrors Node.js asString(value, fallback): undefined/null/empty
// falls back; everything else is stringified.
func stringOr(v interface{}, fallback string) string {
	if v == nil {
		return fallback
	}
	if s, ok := v.(string); ok {
		if s == "" {
			return fallback
		}
		return s
	}
	return fmt.Sprintf("%v", v)
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

// asDocument normalizes a dynamically decoded BSON document into a plain map.
// The driver decodes nested documents into bson.D by default (arrays become
// bson.A), so all shapes are tolerated.
func asDocument(v interface{}) (map[string]interface{}, bool) {
	switch m := v.(type) {
	case bson.M:
		return m, true
	case map[string]interface{}:
		return m, true
	case bson.D:
		out := make(map[string]interface{}, len(m))
		for _, elem := range m {
			out[elem.Key] = elem.Value
		}
		return out, true
	default:
		return nil, false
	}
}

// asDocumentList extracts a document array from a dynamically decoded BSON
// value, skipping non-document entries.
func asDocumentList(v interface{}) []map[string]interface{} {
	var items []interface{}
	switch a := v.(type) {
	case bson.A:
		items = a
	case []interface{}:
		items = a
	}
	out := make([]map[string]interface{}, 0, len(items))
	for _, item := range items {
		if doc, ok := asDocument(item); ok {
			out = append(out, doc)
		}
	}
	return out
}
