package nfalert

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/nfhealth"
)

// One controller owns evaluation. The gate also serializes rule edits/deletes;
// CAS and the durable transition protect publication across process crashes.
func (r *Repository) lockMetric(ctx context.Context) error {
	select {
	case r.metricGate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *Repository) unlockMetric() { <-r.metricGate }

func (r *Repository) metricStates() *mongo.Collection {
	return r.rules.Database().Collection("app_nf_metric_rule_states")
}

type metricTransition struct {
	Kind       string          `bson:"kind"`
	ValidUntil time.Time       `bson:"validUntil"`
	Alert      *Alert          `bson:"alert"`
	At         string          `bson:"at"`
	Evidence   *MetricEvidence `bson:"evidence,omitempty"`
}

type metricState struct {
	ID           string                 `bson:"_id"`
	Revision     int64                  `bson:"revision"`
	LastAt       time.Time              `bson:"lastAt"`
	LastSampleID string                 `bson:"lastSampleId"`
	Status       MetricEvaluationStatus `bson:"status"`
	Pending      *metricTransition      `bson:"pending,omitempty"`
}

func (r *Repository) loadMetricState(ctx context.Context, id string) (*metricState, error) {
	var state metricState
	err := r.metricStates().FindOne(ctx, bson.M{"_id": id}).Decode(&state)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return &metricState{ID: id}, nil
	}
	return &state, err
}
func (r *Repository) saveMetricState(ctx context.Context, state *metricState) error {
	prior := state.Revision
	state.Revision++
	if prior == 0 {
		_, err := r.metricStates().InsertOne(ctx, state)
		return err
	}
	res, err := r.metricStates().ReplaceOne(ctx, bson.M{"_id": state.ID, "revision": prior}, state)
	if err != nil {
		return err
	}
	if res.MatchedCount != 1 {
		return ErrRevisionConflict
	}
	return nil
}

// No raw sample/label/endpoint is copied into the journal. Its alert snapshot
// is the display-safe immutable evidence required to replay an interrupted write.
func (r *Repository) drainMetricTransition(ctx context.Context, id string) error {
	state, err := r.loadMetricState(ctx, id)
	if err != nil || state.Pending == nil {
		return err
	}
	p := state.Pending
	if p.ValidUntil.IsZero() || time.Now().UTC().After(p.ValidUntil) {
		state.Pending = nil
		state.Status.Quality = "indeterminate"
		state.Status.Reason = "publication_expired"
		return r.saveMetricState(ctx, state)
	}
	switch p.Kind {
	case "open":
		_, err := r.alerts.InsertOne(ctx, p.Alert)
		if err != nil {
			if !mongo.IsDuplicateKeyError(err) {
				return err
			}
			var existing Alert
			if err := r.alerts.FindOne(ctx, bson.M{"_id": p.Alert.AlertID}).Decode(&existing); err != nil {
				return err
			}
			if existing.RuleID != id || existing.TargetID != p.Alert.TargetID {
				return ErrRevisionConflict
			}
		}
		// The existing outbox deduplicates alertId/event/channel. Re-emission repairs
		// a crash after insertion but before notification intent publication.
		r.emitAlertEvent(ctx, buildAlertEvent(AlertEventOpened, p.Alert, p.At))
	case "recover":
		var alert Alert
		err := r.alerts.FindOneAndUpdate(ctx,
			bson.M{"_id": p.Alert.AlertID, "state": bson.M{"$in": AlertOpenStates}},
			bson.M{"$set": bson.M{"state": AlertStateResolved, "resolvedReason": ResolveReasonRecovery,
				"resolvedAt": p.At, "updatedAt": p.At, "metricRecovery": p.Evidence}},
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&alert)
		if errors.Is(err, mongo.ErrNoDocuments) {
			if err := r.alerts.FindOne(ctx, bson.M{"_id": p.Alert.AlertID}).Decode(&alert); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if alert.ResolvedReason == ResolveReasonRecovery && alert.ResolvedAt == p.At {
			r.emitAlertEvent(ctx, buildAlertEvent(AlertEventRecovered, &alert, p.At))
		}
	default:
		return fmt.Errorf("unknown metric transition")
	}
	state.Pending = nil
	return r.saveMetricState(ctx, state)
}

// cancelMetricTransition discards unpublished work on an explicit disable/delete.
// It never reports measured recovery or closes an existing alert.
func (r *Repository) cancelMetricTransition(ctx context.Context, id string) error {
	state, err := r.loadMetricState(ctx, id)
	if err != nil || state.Revision == 0 || state.Pending == nil {
		return err
	}
	state.Pending = nil
	state.Status.Quality = "indeterminate"
	state.Status.Reason = "publication_cancelled"
	return r.saveMetricState(ctx, state)
}

func (r *Repository) attachMetricStatus(ctx context.Context, rules []*AlertRule) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	ids := []string{}
	byID := map[string]*AlertRule{}
	for _, rule := range rules {
		if rule.ConditionType == ConditionTypeMetricThreshold {
			ids = append(ids, rule.RuleID)
			byID[rule.RuleID] = rule
		}
	}
	if len(ids) == 0 {
		return nil
	}
	cursor, err := r.metricStates().Find(ctx, bson.M{"_id": bson.M{"$in": ids}},
		options.Find().SetProjection(bson.M{"status": 1}).SetLimit(int64(len(ids))))
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var state metricState
		if err := cursor.Decode(&state); err != nil {
			return err
		}
		if rule := byID[state.ID]; rule != nil {
			status := state.Status
			rule.MetricEvaluation = &status
		}
	}
	return cursor.Err()
}

// MetricTargetReader reads the current target, never an address supplied by a client.
type MetricTargetReader interface {
	GetTarget(context.Context, string) (*nfhealth.HealthTarget, error)
}

type MetricTargetReaderFunc func(context.Context, string) (*nfhealth.HealthTarget, error)

func (f MetricTargetReaderFunc) GetTarget(ctx context.Context, id string) (*nfhealth.HealthTarget, error) {
	return f(ctx, id)
}

func metricAlertID(ruleID, sampleID string) string {
	hash := sha256.Sum256([]byte(ruleID + ":" + sampleID))
	hash[6] = hash[6]&15 | 0x50
	hash[8] = hash[8]&63 | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", hash[:4], hash[4:6], hash[6:8], hash[8:10], hash[10:16])
}

func (m *MongoEvaluatorRepository) SetMetricTargetReader(reader MetricTargetReader) {
	m.metricTargets = reader
}

func (m *MongoEvaluatorRepository) EvaluateMetric(ctx context.Context, rule *AlertRule, target *nfhealth.HealthTarget, result *nfhealth.CollectionResult, now time.Time) (*EvaluationOutcome, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	outcome := &EvaluationOutcome{}
	r := m.repo
	if err := r.lockMetric(ctx); err != nil {
		return nil, err
	}
	defer r.unlockMetric()
	current, err := r.GetRule(ctx, rule.RuleID)
	if errors.Is(err, ErrNotFound) {
		return outcome, nil
	}
	if err != nil {
		return nil, err
	}
	if !current.Enabled || current.ConditionType != ConditionTypeMetricThreshold {
		return outcome, nil
	}
	if err := r.drainMetricTransition(ctx, rule.RuleID); err != nil {
		return nil, err
	}
	if err := ValidateMetricCondition(current.ConditionType, current.TargetID, current.ResourceID, current.MetricCondition); err != nil {
		return nil, err
	}
	if m.metricTargets == nil {
		return nil, fmt.Errorf("metric target reader unavailable")
	}
	freshTarget, err := m.metricTargets.GetTarget(ctx, current.TargetID)
	if err != nil {
		return nil, err
	}
	if freshTarget == nil {
		return nil, fmt.Errorf("metric target unavailable")
	}
	state, err := r.loadMetricState(ctx, rule.RuleID)
	if err != nil {
		return nil, err
	}
	sample := result.Sample
	coherent := sample != nil && sample.SampleID != "" && result.Run.RunID != "" &&
		result.Run.SampleID == sample.SampleID && sample.RunID == result.Run.RunID &&
		sample.TargetID == freshTarget.TargetID && sample.ResourceID == freshTarget.ResourceID &&
		result.Run.TargetID == freshTarget.TargetID && result.Run.ResourceID == freshTarget.ResourceID
	if coherent {
		at, err := time.Parse(time.RFC3339Nano, sample.CollectedAt)
		if err == nil && !at.After(now) {
			if !state.LastAt.IsZero() && !at.After(state.LastAt) {
				return outcome, nil
			}
			state.LastAt = at
			state.LastSampleID = sample.SampleID
		}
	}
	value, reason := nfhealth.ThresholdValue(freshTarget, sample, current.MetricCondition.Metric, now)
	if result.Run.Status == nfhealth.RunStatusFailed || sample == nil || result.Run.RunID == "" ||
		sample.SampleID == "" || result.Run.SampleID != sample.SampleID || sample.RunID != result.Run.RunID ||
		result.Run.TargetID != freshTarget.TargetID || result.Run.ResourceID != freshTarget.ResourceID ||
		target.TargetID != freshTarget.TargetID {
		value = nil
		reason = "collection_evidence_invalid"
	}
	state.Status = MetricEvaluationStatus{Quality: "indeterminate", Reason: reason}
	if sample != nil {
		state.Status.ObservedAt = sample.CollectedAt
	}
	if value == nil {
		outcome.Indeterminate++
		return outcome, r.saveMetricState(ctx, state)
	}
	state.Status.Quality = "measured"
	evidence := &MetricEvidence{Metric: current.MetricCondition.Metric, Series: "unlabeled", Unit: "bytes",
		Subject: "exporter_process", Value: *value, SampleID: sample.SampleID, ObservedAt: sample.CollectedAt}
	open, err := m.FindOpenAlert(ctx, current.RuleID, freshTarget.TargetID)
	if err != nil {
		return nil, err
	}
	at := now.UTC().Format(time.RFC3339Nano)
	decision := classifyMetric(current.MetricCondition, *value)
	state.Status.Reason = decision
	if decision == "trigger" && open == nil {
		alert := &Alert{AlertID: metricAlertID(current.RuleID, sample.SampleID), SchemaVersion: SchemaVersion,
			RuleID: current.RuleID, RuleRevision: current.Revision, RuleName: current.Name,
			TargetID: freshTarget.TargetID, ResourceID: freshTarget.ResourceID, TargetName: freshTarget.Name,
			Severity: current.Severity, State: AlertStateActive, ConditionType: ConditionTypeMetricThreshold,
			MetricCondition: current.MetricCondition, TriggerCount: 1, FirstTriggeredAt: at, LastTriggeredAt: at, UpdatedAt: at,
			Evidence: AlertEvidence{RunStatus: result.Run.Status, SampleID: sample.SampleID, CollectedAt: sample.CollectedAt, Metric: evidence}}
		state.Pending = &metricTransition{Kind: "open", Alert: alert, At: at, ValidUntil: state.LastAt.Add(time.Duration(nfhealth.FreshnessPolicySeconds(freshTarget)) * time.Second)}
		outcome.Opened++
	} else if decision == "recover" && open != nil {
		state.Pending = &metricTransition{Kind: "recover", Alert: &Alert{AlertID: open.AlertID}, At: at, Evidence: evidence, ValidUntil: state.LastAt.Add(time.Duration(nfhealth.FreshnessPolicySeconds(freshTarget)) * time.Second)}
		outcome.Recovered++
	}
	if err := r.saveMetricState(ctx, state); err != nil {
		return nil, err
	}
	return outcome, r.drainMetricTransition(ctx, current.RuleID)
}
