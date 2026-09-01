package tariff

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const defaultPlanID = "plan_default_10gb"

// Repository provides read-only access to tariff plan data.
type Repository struct {
	plans       *mongo.Collection
	subscribers *mongo.Collection
	auditLogs   *mongo.Collection
}

// NewRepository creates a new read-only tariff Repository.
func NewRepository(plans, subscribers, auditLogs *mongo.Collection) *Repository {
	return &Repository{
		plans:       plans,
		subscribers: subscribers,
		auditLogs:   auditLogs,
	}
}

// ListPlans returns all tariff plans with subscriber counts.
func (r *Repository) ListPlans(ctx context.Context) ([]PlanSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cursor, err := r.plans.Find(ctx, bson.M{}, options.Find().SetSort(bson.D{{Key: "plan_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var plans []bson.M
	if err := cursor.All(ctx, &plans); err != nil {
		return nil, err
	}

	result := make([]PlanSummary, 0, len(plans))
	for _, plan := range plans {
		planID := strField(plan, "plan_id")
		subCount, _ := r.subscribers.CountDocuments(ctx, bson.M{"plan_id": planID})
		result = append(result, summarizePlan(plan, int(subCount)))
	}

	if result == nil {
		result = []PlanSummary{}
	}

	return result, nil
}

// GetPlan returns a single tariff plan with rules, or nil if not found.
func (r *Repository) GetPlan(ctx context.Context, planID string) (*PlanDetail, error) {
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

	subCount, _ := r.subscribers.CountDocuments(ctx, bson.M{"plan_id": planID})
	summary := summarizePlan(doc, int(subCount))

	// Normalize rules
	rules := normalizeRules(doc, planID)

	return &PlanDetail{
		PlanSummary: summary,
		Rules:       rules,
	}, nil
}

// GetPlanRules returns rules for a tariff plan.
func (r *Repository) GetPlanRules(ctx context.Context, planID string) (*RulesResponse, error) {
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

	rules := normalizeRules(doc, planID)
	conflicts := detectConflicts(rules)

	return &RulesResponse{
		PlanID:    planID,
		Rules:     rules,
		Conflicts: conflicts,
		Count:     len(rules),
	}, nil
}

// ListPlanSubscribers returns subscribers for a tariff plan.
func (r *Repository) ListPlanSubscribers(ctx context.Context, planID string, limit int) (*SubscribersResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 20
	}

	totalCount, err := r.subscribers.CountDocuments(ctx, bson.M{"plan_id": planID})
	if err != nil {
		return nil, err
	}

	cursor, err := r.subscribers.Find(ctx,
		bson.M{"plan_id": planID},
		options.Find().SetSort(bson.D{{Key: "imsi", Value: 1}}).SetLimit(int64(limit)))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}

	subs := make([]SubscriberEntry, 0, len(docs))
	for _, doc := range docs {
		subs = append(subs, SubscriberEntry{
			IMSI:      strField(doc, "imsi"),
			MSISDN:    strField(doc, "msisdn"),
			Status:    strField(doc, "status"),
			UpdatedAt: timeStr(doc, "updated_at"),
		})
	}
	if subs == nil {
		subs = []SubscriberEntry{}
	}

	return &SubscribersResponse{
		Subscribers: subs,
		Total:       totalCount,
		PlanID:      planID,
	}, nil
}

// DryRunMigrate counts subscribers that would be migrated.
func (r *Repository) DryRunMigrate(ctx context.Context, sourcePlanID, targetPlanID string) (*MigratePreview, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Validate both plans exist
	var sourceDoc, targetDoc bson.M
	if err := r.plans.FindOne(ctx, bson.M{"plan_id": sourcePlanID}).Decode(&sourceDoc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("SOURCE_PLAN_NOT_FOUND")
		}
		return nil, err
	}
	if err := r.plans.FindOne(ctx, bson.M{"plan_id": targetPlanID}).Decode(&targetDoc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("TARGET_PLAN_NOT_FOUND")
		}
		return nil, err
	}

	// Check same plan
	if sourcePlanID == targetPlanID {
		return nil, fmt.Errorf("TARIFF_PLAN_MIGRATE_SAME")
	}

	// Check target not disabled
	if strField(targetDoc, "status") == "disabled" {
		return nil, fmt.Errorf("TARGET_PLAN_DISABLED")
	}

	// Count affected subscribers
	count, err := r.subscribers.CountDocuments(ctx, bson.M{"plan_id": sourcePlanID})
	if err != nil {
		return nil, err
	}

	return &MigratePreview{
		SourcePlanID:    sourcePlanID,
		TargetPlanID:    targetPlanID,
		SubscriberCount: count,
	}, nil
}

// GetPlanOperations returns operations summary and audit history for a tariff plan.
// Mirrors Node buildTariffPlanOperationsSummary: computes aggregate stats across ALL plans.
func (r *Repository) GetPlanOperations(ctx context.Context, planID string, limit int) (*OperationsResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 12
	}

	// Get selected plan
	var selectedDoc bson.M
	err := r.plans.FindOne(ctx, bson.M{"plan_id": planID}).Decode(&selectedDoc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Get all plans for aggregate summary (mirrors Node listTariffPlans call)
	cursor, err := r.plans.Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var allPlans []bson.M
	if err := cursor.All(ctx, &allPlans); err != nil {
		return nil, err
	}

	// Compute subscriber counts per plan
	type planWithCount struct {
		doc      bson.M
		subCount int
	}
	plansWithCounts := make([]planWithCount, 0, len(allPlans))
	for _, p := range allPlans {
		pid := strField(p, "plan_id")
		cnt, _ := r.subscribers.CountDocuments(ctx, bson.M{"plan_id": pid})
		plansWithCounts = append(plansWithCounts, planWithCount{doc: p, subCount: int(cnt)})
	}

	// Aggregate counts (mirrors Node buildTariffPlanOperationsSummary)
	activePlans := 0
	disabledPlans := 0
	totalLinkedSubscribers := 0
	selectedSubCount := 0
	for _, p := range plansWithCounts {
		status := strWithDefault(p.doc, "status", "active")
		if status == "active" {
			activePlans++
		} else if status == "disabled" {
			disabledPlans++
		}
		totalLinkedSubscribers += p.subCount
		if strField(p.doc, "plan_id") == planID {
			selectedSubCount = p.subCount
		}
	}

	selectedSharePct := float64(0)
	if totalLinkedSubscribers > 0 {
		selectedSharePct = float64(int(float64(selectedSubCount)/float64(totalLinkedSubscribers)*1000)) / 10
	}

	// Audit history
	history, err := r.getAuditHistory(ctx, planID, limit)
	if err != nil {
		history = []AuditLogEntry{}
	}

	// LastChangedAt: prefer plan's updated_at, fallback to first history entry
	var lastChangedAt *string
	if updatedAt := timeStr(selectedDoc, "updated_at"); updatedAt != "" {
		lastChangedAt = &updatedAt
	} else if len(history) > 0 && history[0].CreatedAt != "" {
		lastChangedAt = &history[0].CreatedAt
	}

	summary := OperationsSummary{
		TotalPlans:                len(allPlans),
		ActivePlans:               activePlans,
		DisabledPlans:             disabledPlans,
		TotalLinkedSubscribers:    totalLinkedSubscribers,
		SelectedLinkedSubscribers: selectedSubCount,
		SelectedSharePct:          selectedSharePct,
		RecentActivityCount:       len(history),
		LastChangedAt:             lastChangedAt,
	}

	return &OperationsResponse{
		Summary: summary,
		History: history,
	}, nil
}

func (r *Repository) getAuditHistory(ctx context.Context, planID string, limit int) ([]AuditLogEntry, error) {
	filter := bson.M{
		"$or": bson.A{
			bson.M{"resource.id": bson.M{"$regex": planID, "$options": "i"}},
			bson.M{"targetId": bson.M{"$regex": planID, "$options": "i"}},
		},
	}

	cursor, err := r.auditLogs.Find(ctx, filter,
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(int64(limit)))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var entries []AuditLogEntry
	for cursor.Next(ctx) {
		var doc bson.M
		if cursor.Decode(&doc) == nil {
			entries = append(entries, AuditLogEntry{
				ID:        strField(doc, "id"),
				Action:    strField(doc, "action"),
				Module:    strField(doc, "module"),
				Result:    strField(doc, "result"),
				RiskLevel: strField(doc, "riskLevel"),
				Actor:     strField(doc, "actor"),
				CreatedAt: timeStr(doc, "createdAt"),
			})
		}
	}

	if entries == nil {
		entries = []AuditLogEntry{}
	}

	return entries, nil
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func summarizePlan(doc bson.M, subscriberCount int) PlanSummary {
	planID := strField(doc, "plan_id")
	return PlanSummary{
		PlanID:          planID,
		Name:            strWithDefault(doc, "name", planID),
		Description:     strField(doc, "description"),
		Status:          strWithDefault(doc, "status", "active"),
		QuotaPerGrant:   numericInt64WithDefault(doc, "quota_per_grant", 1073741824),
		ValidityTime:    int(numericInt64WithDefault(doc, "validity_time", 86400)),
		VolumeThreshold: numericInt64WithDefault(doc, "volume_threshold", 1048576),
		RulesCount:      ruleCount(doc),
		SubscriberCount: subscriberCount,
		IsDefault:       planID == defaultPlanID,
		CreatedAt:       timeStr(doc, "created_at"),
		UpdatedAt:       timeStr(doc, "updated_at"),
	}
}

func normalizeRules(doc bson.M, planID string) []RatingPolicy {
	rulesRaw, ok := doc["rules"]
	if !ok || rulesRaw == nil {
		return []RatingPolicy{}
	}

	arr, ok := rulesRaw.(bson.A)
	if !ok {
		return []RatingPolicy{}
	}

	result := make([]RatingPolicy, 0, len(arr))
	for _, r := range arr {
		rule, ok := r.(bson.M)
		if !ok {
			continue
		}
		result = append(result, RatingPolicy{
			RatingGroupID:     numericInt64(rule["rating_group"]),
			Currency:          strWithDefault(rule, "currency", "USD"),
			Rates:             strWithDefault(rule, "rates", "0"),
			RatesType:         int(numericInt64WithDefault(rule, "rates_type", 2)),
			PlanID:            planID,
			RuleID:            strField(rule, "rule_id"),
			APN:               strField(rule, "apn"),
			ServiceIdentifier: numericInt64(rule["service_identifier"]),
			ChargingType:      strField(rule, "charging_type"),
			Unit:              strWithDefault(rule, "unit", "bytes"),
			QuotaPerGrant:     numericInt64(rule["quota_per_grant"]),
			ValidityTime:      int(numericInt64(rule["validity_time"])),
			VolumeThreshold:   numericInt64(rule["volume_threshold"]),
			Priority:          int(numericInt64WithDefault(rule, "priority", 100)),
			Status:            strWithDefault(rule, "status", "active"),
		})
	}

	return result
}

func detectConflicts(rules []RatingPolicy) []RuleConflict {
	var conflicts []RuleConflict
	for i := 0; i < len(rules); i++ {
		for j := i + 1; j < len(rules); j++ {
			if rules[i].RatingGroupID == rules[j].RatingGroupID &&
				rules[i].APN == rules[j].APN &&
				rules[i].ServiceIdentifier == rules[j].ServiceIdentifier {
				conflicts = append(conflicts, RuleConflict{
					RuleID1: rules[i].RuleID,
					RuleID2: rules[j].RuleID,
					Type:    "duplicate",
					Message: fmt.Sprintf("Rules %s and %s have the same rating_group, APN, and service_identifier", rules[i].RuleID, rules[j].RuleID),
				})
			}
		}
	}
	if conflicts == nil {
		conflicts = []RuleConflict{}
	}
	return conflicts
}

func ruleCount(doc bson.M) int {
	if rules, ok := doc["rules"]; ok && rules != nil {
		if arr, ok := rules.(bson.A); ok {
			return len(arr)
		}
	}
	return 0
}

func strField(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func strWithDefault(doc bson.M, key, fallback string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return fallback
	}
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

func timeStr(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.DateTime:
		return t.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	default:
		return ""
	}
}

func numericInt64(v any) int64 {
	switch val := v.(type) {
	case int32:
		return int64(val)
	case int64:
		return val
	case float64:
		return int64(val)
	case bson.Decimal128:
		if val.IsNaN() || val.IsInf() != 0 {
			return 0
		}
		bi, exp, err := val.BigInt()
		if err != nil {
			return 0
		}
		if exp > 0 {
			for i := 0; i < exp; i++ {
				bi = bi.Mul(bi, bigInt10)
			}
		}
		return bi.Int64()
	default:
		return 0
	}
}

var bigInt10 = big.NewInt(10)

func numericInt64WithDefault(doc bson.M, key string, fallback int64) int64 {
	v, ok := doc[key]
	if !ok || v == nil {
		return fallback
	}
	n := numericInt64(v)
	if n == 0 && fallback != 0 {
		return fallback
	}
	return n
}
