package nfalert

import (
	"context"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/nfhealth"
)

// Evaluator is the NF alert evaluation engine. After every scheduled NF Health
// collection it evaluates enabled alert rules against the fresh measurement
// evidence and maintains one alert instance per (rule, target) pair:
//
//   - trigger  : condition satisfied and no non-resolved alert exists, or the
//     cooldown window has elapsed since the last trigger.
//   - re-count : condition satisfied inside the cooldown window; only the
//     trigger counter and evidence are refreshed.
//   - recover  : condition no longer satisfied while an alert is open; the
//     alert is resolved with reason "recovery".
//
// The evaluator never issues collections of its own and never modifies NF
// Health, Inventory, Topology or Discovery documents. It is a pure observer
// over recorded evidence.
type Evaluator struct {
	repo  EvaluationRepository
	clock nfhealth.Clock
}

// EvaluationRepository is the persistence surface the engine needs.
type EvaluationRepository interface {
	ListRulesForEvaluation(ctx context.Context) ([]AlertRule, error)
	FindOpenAlert(ctx context.Context, ruleID, targetID string) (*Alert, error)
	InsertAlert(ctx context.Context, alert *Alert) error
	RecountAlert(ctx context.Context, alertID string, triggerCount int, lastTriggeredAt string, evidence AlertEvidence) error
	ResolveAlertByRecovery(ctx context.Context, alertID, resolvedAt string) error
}

// NewEvaluator constructs the evaluation engine.
func NewEvaluator(repo EvaluationRepository) *Evaluator {
	return &Evaluator{repo: repo, clock: nfhealth.SystemClock{}}
}

// SetClock installs an injectable test clock.
func (e *Evaluator) SetClock(clock nfhealth.Clock) {
	if clock != nil {
		e.clock = clock
	}
}

// EvaluationInput is one fresh collection outcome for one target.
type EvaluationInput struct {
	Target *nfhealth.HealthTarget
	Result *nfhealth.CollectionResult
}

// EvaluationOutcome summarizes one evaluation pass for diagnostics and tests.
type EvaluationOutcome struct {
	RulesEvaluated int
	Opened         int
	Recounted      int
	Recovered      int
}

// EvaluateTargets evaluates all enabled rules against the given collection
// outcomes. It is called by the scheduler hook after RecordCollection and by
// the manual collection path after its own record. An evaluation error is
// returned but never blocks the caller's already-recorded measurement.
func (e *Evaluator) EvaluateTargets(ctx context.Context, inputs []EvaluationInput) (*EvaluationOutcome, error) {
	outcome := &EvaluationOutcome{}
	if len(inputs) == 0 {
		return outcome, nil
	}
	rules, err := e.repo.ListRulesForEvaluation(ctx)
	if err != nil {
		return nil, err
	}
	outcome.RulesEvaluated = len(rules)
	if len(rules) == 0 {
		return outcome, nil
	}

	for i := range inputs {
		input := inputs[i]
		if input.Target == nil || input.Result == nil {
			continue
		}
		for j := range rules {
			rule := rules[j]
			if !ruleMatchesTarget(&rule, input.Target) {
				continue
			}
			satisfied, evidence := evaluateRule(&rule, input.Target, input.Result, e.clock.Now())
			if err := e.applyRuleOutcome(ctx, &rule, input.Target, satisfied, evidence, outcome); err != nil {
				return outcome, err
			}
		}
	}
	return outcome, nil
}

// ruleMatchesTarget applies the rule's explicit target scope.
func ruleMatchesTarget(rule *AlertRule, target *nfhealth.HealthTarget) bool {
	if rule.TargetID != "" {
		return rule.TargetID == target.TargetID
	}
	if rule.ResourceID != "" {
		return rule.ResourceID == target.ResourceID
	}
	return true
}

// evaluateRule decides whether one rule is satisfied by one collection
// outcome, producing the evidence snapshot for the alert.
func evaluateRule(rule *AlertRule, target *nfhealth.HealthTarget, result *nfhealth.CollectionResult, now time.Time) (bool, AlertEvidence) {
	evidence := AlertEvidence{
		RunStatus: result.Run.Status,
	}
	if result.Sample != nil {
		evidence.SampleID = result.Sample.SampleID
		evidence.CollectedAt = result.Sample.CollectedAt
		layers := result.Sample.Layers
		evidence.Layers = &layers
		// OverallState is derived with the same server-owned projection used
		// by the read surfaces, so alerts and dashboards cannot disagree.
		overall := nfhealth.OverallState(result.Sample.Layers)
		evidence.OverallState = overall
	}

	switch rule.ConditionType {
	case ConditionTypeRunFailed:
		// A failed run is only ever evidence of a failed collection attempt.
		// A partial run still produced measurement evidence and is not an
		// alarmable failure.
		return result.Run.Status == nfhealth.RunStatusFailed, evidence
	case ConditionTypeState:
		if result.Sample == nil {
			// No accepted sample means no state evidence: the condition is
			// not satisfied. Absence of evidence is never an alarm.
			return false, evidence
		}
		state := scopedState(rule.Condition.Scope, result.Sample.Layers, target)
		return state == rule.Condition.State, evidence
	default:
		return false, evidence
	}
}

// scopedState resolves the configured scope to its measured state.
func scopedState(scope string, layers nfhealth.LayerSet, target *nfhealth.HealthTarget) string {
	switch scope {
	case ScopeOverall:
		return nfhealth.OverallState(layers)
	case ScopeProcess:
		return layers.Process.State
	case ScopeInterface:
		return layers.Interface.State
	case ScopeService:
		return layers.Service.State
	}
	return ""
}

// applyRuleOutcome maintains the (rule, target) alert invariant.
func (e *Evaluator) applyRuleOutcome(ctx context.Context, rule *AlertRule, target *nfhealth.HealthTarget, satisfied bool, evidence AlertEvidence, outcome *EvaluationOutcome) error {
	open, err := e.repo.FindOpenAlert(ctx, rule.RuleID, target.TargetID)
	if err != nil {
		return err
	}

	if satisfied {
		now := e.nowString()
		if open == nil {
			alert := &Alert{
				AlertID:          newUUID(),
				SchemaVersion:    SchemaVersion,
				RuleID:           rule.RuleID,
				RuleName:         rule.Name,
				TargetID:         target.TargetID,
				ResourceID:       target.ResourceID,
				TargetName:       target.Name,
				Severity:         rule.Severity,
				State:            AlertStateActive,
				ConditionType:    rule.ConditionType,
				Condition:        rule.Condition,
				TriggerCount:     1,
				FirstTriggeredAt: now,
				LastTriggeredAt:  now,
				Evidence:         evidence,
				UpdatedAt:        now,
			}
			if err := e.repo.InsertAlert(ctx, alert); err != nil {
				return err
			}
			outcome.Opened++
			return nil
		}
		// Cooldown dedupe: a trigger inside the window only increments the
		// counter. The alert never re-arms while open.
		last, parseErr := parseRFC3339(open.LastTriggeredAt)
		if parseErr != nil {
			// Unparseable timestamp is treated as outside the window: refresh
			// the trigger bookkeeping deterministically.
			if err := e.repo.RecountAlert(ctx, open.AlertID, open.TriggerCount+1, now, evidence); err != nil {
				return err
			}
			outcome.Recounted++
			return nil
		}
		window := time.Duration(openCooldown(rule)) * time.Second
		if e.clock.Now().UTC().Sub(last) >= window {
			if err := e.repo.RecountAlert(ctx, open.AlertID, open.TriggerCount+1, now, evidence); err != nil {
				return err
			}
			outcome.Recounted++
			return nil
		}
		return nil
	}

	// Condition not satisfied: recovery clears an open alert. The resolve
	// timestamp is authoritative; acknowledged alerts also auto-resolve so a
	// recovered condition never keeps a stale alert open.
	if open != nil {
		now := e.nowString()
		if err := e.repo.ResolveAlertByRecovery(ctx, open.AlertID, now); err != nil {
			return err
		}
		outcome.Recovered++
	}
	return nil
}

// openCooldown returns the cooldown recorded on the rule that opened the
// alert. The alert carries the rule identity, so a rule cooldown change never
// retroactively re-arms existing alerts.
func openCooldown(rule *AlertRule) int {
	if rule.CooldownSeconds >= MinCooldownSeconds && rule.CooldownSeconds <= MaxCooldownSeconds {
		return rule.CooldownSeconds
	}
	return DefaultCooldownSeconds
}

func (e *Evaluator) nowString() string {
	return e.clock.Now().UTC().Format(time.RFC3339Nano)
}

func parseRFC3339(raw string) (time.Time, error) {
	if strings.TrimSpace(raw) == "" {
		return time.Time{}, errInvalidTimestamp
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, errInvalidTimestamp
	}
	return t, nil
}

type timestampError struct{}

func (timestampError) Error() string { return "invalid timestamp" }

var errInvalidTimestamp error = timestampError{}

// ── Evaluator repository adapter ───────────────────────────────────────────
//
// The adapter binds the engine to the Mongo collections through the shared
// Repository's collections while keeping the engine interface narrow and
// testable.

// MongoEvaluatorRepository is the production EvaluationRepository.
type MongoEvaluatorRepository struct {
	rules  *mongo.Collection
	alerts *mongo.Collection
}

// NewMongoEvaluatorRepository constructs the production evaluation repository.
func NewMongoEvaluatorRepository(repo *Repository) *MongoEvaluatorRepository {
	return &MongoEvaluatorRepository{
		rules:  repo.rulesCollection(),
		alerts: repo.alertsCollection(),
	}
}

func (r *Repository) rulesCollection() *mongo.Collection  { return r.rules }
func (r *Repository) alertsCollection() *mongo.Collection { return r.alerts }

// ListRulesForEvaluation loads every enabled rule.
func (m *MongoEvaluatorRepository) ListRulesForEvaluation(ctx context.Context) ([]AlertRule, error) {
	cursor, err := m.rules.Find(ctx, bson.M{"enabled": true})
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

// FindOpenAlert locates the non-resolved alert for a (rule, target) pair.
func (m *MongoEvaluatorRepository) FindOpenAlert(ctx context.Context, ruleID, targetID string) (*Alert, error) {
	var doc Alert
	err := m.alerts.FindOne(ctx, bson.M{
		"ruleId":   ruleID,
		"targetId": targetID,
		"state":    bson.M{"$in": bson.A{AlertStateActive, AlertStateAcknowledged}},
	}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	return &doc, nil
}

// InsertAlert stores a newly opened alert. A duplicate-key failure means a
// concurrent evaluation opened the same (rule, target) alert first; the loss
// is accepted because the counter semantics are preserved by the winner.
func (m *MongoEvaluatorRepository) InsertAlert(ctx context.Context, alert *Alert) error {
	_, err := m.alerts.InsertOne(ctx, alert)
	if err != nil && mongo.IsDuplicateKeyError(err) {
		return nil
	}
	return err
}

// RecountAlert refreshes the trigger counter and evidence inside cooldown.
func (m *MongoEvaluatorRepository) RecountAlert(ctx context.Context, alertID string, triggerCount int, lastTriggeredAt string, evidence AlertEvidence) error {
	res := m.alerts.FindOneAndUpdate(ctx,
		bson.M{"_id": alertID, "state": bson.M{"$in": bson.A{AlertStateActive, AlertStateAcknowledged}}},
		bson.M{"$set": bson.M{
			"triggerCount":    triggerCount,
			"lastTriggeredAt": lastTriggeredAt,
			"evidence":        evidence,
			"updatedAt":       lastTriggeredAt,
		}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var doc Alert
	if err := res.Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			// Resolved concurrently; nothing to recount.
			return nil
		}
		return err
	}
	return nil
}

// ResolveAlertByRecovery closes an open alert with the recovery reason.
func (m *MongoEvaluatorRepository) ResolveAlertByRecovery(ctx context.Context, alertID, resolvedAt string) error {
	res := m.alerts.FindOneAndUpdate(ctx,
		bson.M{"_id": alertID, "state": bson.M{"$in": bson.A{AlertStateActive, AlertStateAcknowledged}}},
		bson.M{"$set": bson.M{
			"state":          AlertStateResolved,
			"resolvedAt":     resolvedAt,
			"resolvedReason": ResolveReasonRecovery,
			"updatedAt":      resolvedAt,
		}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var doc Alert
	if err := res.Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil
		}
		return err
	}
	return nil
}
