package nfalert

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository persists alert rules and alert instances.
//
// Collections (xcloud_ops):
//   - app_nf_alert_rules  operator-authored alerting configuration
//   - app_nf_alerts       open / acknowledged / resolved alert instances
type Repository struct {
	rules  *mongo.Collection
	alerts *mongo.Collection
}

// NewRepository constructs the NF alert persistence adapter.
func NewRepository(rules, alerts *mongo.Collection) *Repository {
	return &Repository{rules: rules, alerts: alerts}
}

// Collections reports the backing collection names, for diagnostics.
func (r *Repository) Collections() (string, string) {
	return r.rules.Name(), r.alerts.Name()
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Deterministic fallback keeps the server alive; uniqueness is still
		// enforced by the unique index on insert.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// CursorData is the keyset pagination cursor payload.
type CursorData struct {
	At string `json:"at"`
	ID string `json:"id"`
}

func encodeCursor(at, id string) *string {
	if at == "" || id == "" {
		return nil
	}
	raw, _ := json.Marshal(CursorData{At: at, ID: id})
	s := base64.RawURLEncoding.EncodeToString(raw)
	return &s
}

func decodeCursor(cursor string) (CursorData, error) {
	if strings.TrimSpace(cursor) == "" {
		return CursorData{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(cursor))
	if err != nil {
		return CursorData{}, validationError("NF_ALERT_INVALID_CURSOR", "cursor is malformed")
	}
	var data CursorData
	if err := json.Unmarshal(raw, &data); err != nil {
		return CursorData{}, validationError("NF_ALERT_INVALID_CURSOR", "cursor is malformed")
	}
	return data, nil
}

// CreateRule inserts a new alert rule with a server-generated identity.
func (r *Repository) CreateRule(ctx context.Context, req *CreateRuleRequest, actor string) (*AlertRule, error) {
	cooldown, err := NormalizeCooldown(req.CooldownSeconds)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	doc := AlertRule{
		RuleID:          newUUID(),
		SchemaVersion:   SchemaVersion,
		Name:            strings.TrimSpace(req.Name),
		Description:     strings.TrimSpace(req.Description),
		Enabled:         enabled,
		TargetID:        strings.TrimSpace(req.TargetID),
		ResourceID:      strings.TrimSpace(req.ResourceID),
		ConditionType:   req.ConditionType,
		Condition:       RuleCondition{},
		Severity:        req.Severity,
		CooldownSeconds: cooldown,
		Revision:        1,
		CreatedAt:       now,
		CreatedBy:       actor,
		UpdatedAt:       now,
		UpdatedBy:       actor,
	}
	if req.Condition != nil {
		doc.Condition = *req.Condition
	}
	if _, err := r.rules.InsertOne(ctx, doc); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil, ErrDuplicateRule
		}
		return nil, err
	}
	return &doc, nil
}

// ErrDuplicateRule signals a uniqueness violation on rule creation.
var ErrDuplicateRule = errors.New("NF_ALERT_RULE_CONFLICT")

// GetRule loads one alert rule.
func (r *Repository) GetRule(ctx context.Context, ruleID string) (*AlertRule, error) {
	var doc AlertRule
	err := r.rules.FindOne(ctx, bson.M{"_id": ruleID}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &doc, nil
}

// ListRules returns a keyset-paginated rule listing.
func (r *Repository) ListRules(ctx context.Context, filter RuleListFilter) ([]AlertRule, *string, bool, error) {
	query := bson.M{}
	if q := strings.TrimSpace(filter.Query); q != "" {
		regex := "^" + escapeRegex(q)
		query["$or"] = bson.A{
			bson.M{"name": bson.M{"$regex": regex, "$options": "i"}},
			bson.M{"description": bson.M{"$regex": regex, "$options": "i"}},
		}
	}
	if filter.Enabled == "true" || filter.Enabled == "false" {
		query["enabled"] = filter.Enabled == "true"
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultPageLimit
	}
	findOpts := options.Find().SetSort(bson.D{
		{Key: "updatedAt", Value: -1},
		{Key: "_id", Value: -1},
	}).SetLimit(int64(limit + 1))

	cursor, err := r.rules.Find(ctx, query, findOpts)
	if err != nil {
		return nil, nil, false, err
	}
	defer cursor.Close(ctx)

	var docs []AlertRule
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, nil, false, err
	}
	hasMore := len(docs) > limit
	if hasMore {
		docs = docs[:limit]
	}
	var next *string
	if hasMore && len(docs) > 0 {
		last := docs[len(docs)-1]
		next = encodeCursor(last.UpdatedAt, last.RuleID)
	}
	return docs, next, hasMore, nil
}

// UpdateRule applies a CAS-guarded mutable-field update. Identity fields
// (targetId, resourceId) are immutable by design.
func (r *Repository) UpdateRule(ctx context.Context, ruleID string, req *UpdateRuleRequest, actor string) (*AlertRule, *AlertRule, error) {
	existing, err := r.GetRule(ctx, ruleID)
	if err != nil {
		return nil, nil, err
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}
	m := req.Rule
	updated := *existing
	updated.Name = strings.TrimSpace(m.Name)
	updated.Description = strings.TrimSpace(m.Description)
	updated.Enabled = m.Enabled
	updated.ConditionType = m.ConditionType
	updated.Condition = RuleCondition{}
	if m.Condition != nil {
		updated.Condition = *m.Condition
	}
	updated.Severity = m.Severity
	updated.CooldownSeconds, err = NormalizeCooldown(m.CooldownSeconds)
	if err != nil {
		return nil, nil, err
	}
	updated.Revision = existing.Revision + 1
	updated.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	updated.UpdatedBy = actor

	res := r.rules.FindOneAndUpdate(ctx,
		bson.M{"_id": ruleID, "revision": existing.Revision},
		bson.M{"$set": bson.M{
			"name":            updated.Name,
			"description":     updated.Description,
			"enabled":         updated.Enabled,
			"conditionType":   updated.ConditionType,
			"condition":       updated.Condition,
			"severity":        updated.Severity,
			"cooldownSeconds": updated.CooldownSeconds,
			"revision":        updated.Revision,
			"updatedAt":       updated.UpdatedAt,
			"updatedBy":       updated.UpdatedBy,
		}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var doc AlertRule
	if err := res.Decode(&doc); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil, ErrRevisionConflict
		}
		return nil, nil, err
	}
	return existing, &doc, nil
}

// DeleteRule removes a rule and resolves its open alerts. Open alerts are
// never orphaned: the rule deletion is recorded as the resolve reason.
func (r *Repository) DeleteRule(ctx context.Context, ruleID string, actor string) (*AlertRule, []Alert, error) {
	existing, err := r.GetRule(ctx, ruleID)
	if err != nil {
		return nil, nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = r.rules.DeleteOne(ctx, bson.M{"_id": ruleID})
	if err != nil {
		return nil, nil, err
	}
	resolved, err := r.resolveRuleAlerts(ctx, ruleID, now, actor)
	if err != nil {
		return existing, nil, err
	}
	return existing, resolved, nil
}

func (r *Repository) resolveRuleAlerts(ctx context.Context, ruleID, now, actor string) ([]Alert, error) {
	query := bson.M{"ruleId": ruleID, "state": bson.M{"$in": bson.A{AlertStateActive, AlertStateAcknowledged}}}
	cursor, err := r.alerts.Find(ctx, query)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var open []Alert
	if err := cursor.All(ctx, &open); err != nil {
		return nil, err
	}
	if len(open) == 0 {
		return nil, nil
	}
	_, err = r.alerts.UpdateMany(ctx, query, bson.M{"$set": bson.M{
		"state":          AlertStateResolved,
		"resolvedAt":     now,
		"resolvedReason": ResolveReasonRuleDeleted,
		"updatedAt":      now,
	}})
	if err != nil {
		return nil, err
	}
	for i := range open {
		open[i].State = AlertStateResolved
		open[i].ResolvedAt = now
		open[i].ResolvedReason = ResolveReasonRuleDeleted
		open[i].UpdatedAt = now
	}
	return open, nil
}

// ListRulesForEvaluation loads all enabled rules for the evaluation engine.
// The rule set is bounded by operator authorship, so one full load per
// evaluation pass is a bounded query.
func (r *Repository) ListRulesForEvaluation(ctx context.Context) ([]AlertRule, error) {
	cursor, err := r.rules.Find(ctx, bson.M{"enabled": true})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	var docs []AlertRule
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, err
	}
	return docs, nil
}

// GetAlert loads one alert instance.
func (r *Repository) GetAlert(ctx context.Context, alertID string) (*Alert, error) {
	var doc Alert
	err := r.alerts.FindOne(ctx, bson.M{"_id": alertID}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrAlertNotFound
		}
		return nil, err
	}
	return &doc, nil
}

// ListAlerts returns a keyset-paginated alert listing.
func (r *Repository) ListAlerts(ctx context.Context, filter AlertListFilter) ([]Alert, *string, bool, error) {
	query := bson.M{}
	switch filter.State {
	case "", AlertStateActive, AlertStateAcknowledged, AlertStateResolved:
		if filter.State != "" {
			query["state"] = filter.State
		}
	default:
		return nil, nil, false, validationError("NF_ALERT_INVALID_STATE_FILTER", "state must be active, acknowledged or resolved")
	}
	if filter.Severity != "" {
		switch filter.Severity {
		case SeverityCritical, SeverityWarning, SeverityInfo:
			query["severity"] = filter.Severity
		default:
			return nil, nil, false, validationError("NF_ALERT_INVALID_SEVERITY_FILTER", "severity must be critical, warning or info")
		}
	}
	if q := strings.TrimSpace(filter.Query); q != "" {
		regex := "^" + escapeRegex(q)
		query["$or"] = bson.A{
			bson.M{"ruleName": bson.M{"$regex": regex, "$options": "i"}},
			bson.M{"targetName": bson.M{"$regex": regex, "$options": "i"}},
		}
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultPageLimit
	}
	findOpts := options.Find().SetSort(bson.D{
		{Key: "updatedAt", Value: -1},
		{Key: "_id", Value: -1},
	}).SetLimit(int64(limit + 1))

	cursor, err := r.alerts.Find(ctx, query, findOpts)
	if err != nil {
		return nil, nil, false, err
	}
	defer cursor.Close(ctx)

	var docs []Alert
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, nil, false, err
	}
	hasMore := len(docs) > limit
	if hasMore {
		docs = docs[:limit]
	}
	var next *string
	if hasMore && len(docs) > 0 {
		last := docs[len(docs)-1]
		next = encodeCursor(last.UpdatedAt, last.AlertID)
	}
	return docs, next, hasMore, nil
}

// AcknowledgeAlert marks an active alert as acknowledged by an operator.
// Acknowledging an already-acknowledged alert is idempotent; resolving a
// resolved one fails with ErrAlertResolved.
func (r *Repository) AcknowledgeAlert(ctx context.Context, alertID, actor string) (*Alert, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res := r.alerts.FindOneAndUpdate(ctx,
		bson.M{"_id": alertID, "state": bson.M{"$in": bson.A{AlertStateActive, AlertStateAcknowledged}}},
		bson.M{"$set": bson.M{
			"state":          AlertStateAcknowledged,
			"acknowledgedAt": now,
			"acknowledgedBy": actor,
			"updatedAt":      now,
		}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var doc Alert
	if err := res.Decode(&doc); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			// Distinguish "never existed" from "already resolved".
			if _, err := r.GetAlert(ctx, alertID); err != nil {
				return nil, err
			}
			return nil, ErrAlertResolved
		}
		return nil, err
	}
	return &doc, nil
}

// ResolveAlert manually resolves an active or acknowledged alert.
func (r *Repository) ResolveAlert(ctx context.Context, alertID, actor string) (*Alert, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res := r.alerts.FindOneAndUpdate(ctx,
		bson.M{"_id": alertID, "state": bson.M{"$in": bson.A{AlertStateActive, AlertStateAcknowledged}}},
		bson.M{"$set": bson.M{
			"state":          AlertStateResolved,
			"resolvedAt":     now,
			"resolvedReason": ResolveReasonManual,
			"updatedAt":      now,
		}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var doc Alert
	if err := res.Decode(&doc); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			if _, err := r.GetAlert(ctx, alertID); err != nil {
				return nil, err
			}
			return nil, ErrAlertResolved
		}
		return nil, err
	}
	return &doc, nil
}

func escapeRegex(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '.', '+', '*', '?', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
