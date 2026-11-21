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
	RuleRevision     int64           `bson:"ruleRevision,omitempty"`
	DurationIdentity string          `bson:"durationIdentity,omitempty"`
	Kind             string          `bson:"kind"`
	ValidUntil       time.Time       `bson:"validUntil"`
	Alert            *Alert          `bson:"alert"`
	At               string          `bson:"at"`
	Evidence         *MetricEvidence `bson:"evidence,omitempty"`
}

type metricState struct {
	Replay        *MetricReplayStatus    `bson:"replay,omitempty"`
	LastOutcomeAt metricInstant          `bson:"lastOutcomeAt,omitempty"`
	Timing        metricTiming           `bson:"timing"`
	ID            string                 `bson:"_id"`
	Revision      int64                  `bson:"revision"`
	LastAt        metricInstant          `bson:"lastAt"`
	LastSampleID  string                 `bson:"lastSampleId"`
	Status        MetricEvaluationStatus `bson:"status"`
	Pending       *metricTransition      `bson:"pending,omitempty"`
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
func (r *Repository) drainMetricTransition(ctx context.Context, id string, allowedIdentity ...string) error {
	state, err := r.loadMetricState(ctx, id)
	if err != nil || state.Pending == nil {
		return err
	}
	p := state.Pending
	if p.ValidUntil.IsZero() || time.Now().UTC().After(p.ValidUntil) {
		state.Pending = nil
		state.Status.Quality = "indeterminate"
		state.Status.Reason = "publication_expired"
		state.Status.Phase = "unknown"
		resetMetricTiming(state)
		return r.saveMetricState(ctx, state)
	}
	if p.DurationIdentity != "" && (len(allowedIdentity) != 1 || allowedIdentity[0] != p.DurationIdentity) {
		return nil
	}
	if p.RuleRevision > 0 {
		var current AlertRule
		err := r.rules.FindOne(ctx, bson.M{"_id": id}).Decode(&current)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return err
		}
		if errors.Is(err, mongo.ErrNoDocuments) || !current.Enabled || current.Revision != p.RuleRevision {
			return r.cancelMetricTransition(ctx, id)
		}
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
	if p.Kind == "open" {
		state.Status.Phase = "firing"
	} else {
		state.Status.Phase = "idle"
	}
	return r.saveMetricState(ctx, state)
}

// cancelMetricTransition discards unpublished work on an explicit disable/delete.
// It never reports measured recovery or closes an existing alert.
func (r *Repository) cancelMetricTransition(ctx context.Context, id string) error {
	state, err := r.loadMetricState(ctx, id)
	if err != nil || state.Revision == 0 {
		return err
	}
	state.Pending = nil
	state.Status.Quality = "indeterminate"
	state.Status.Reason = "publication_cancelled"
	state.Status.Phase = "unknown"
	resetMetricTiming(state)
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
		options.Find().SetProjection(bson.M{"status": 1, "replay": 1}).SetLimit(int64(len(ids))))
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
			if status.RuleRevision != rule.Revision {
				status = MetricEvaluationStatus{Quality: "indeterminate", Reason: "rule_version_changed", Phase: "unknown", RuleRevision: rule.Revision}
			}
			rule.MetricEvaluation = &status
			rule.MetricReplay = state.Replay
			if state.Replay != nil && state.Replay.RuleRevision != rule.Revision {
				rule.MetricReplay = &MetricReplayStatus{State: "incomplete", Reason: "rule_version_changed", RuleRevision: rule.Revision}
			}
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

func (m *MongoEvaluatorRepository) EvaluateMetric(ctx context.Context, rule *AlertRule, target *nfhealth.HealthTarget, result *nfhealth.CollectionResult, now time.Time) (outcome *EvaluationOutcome, err error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if err = m.repo.lockMetric(ctx); err != nil {
		return nil, err
	}
	defer m.repo.unlockMetric()
	if m.metricSource != nil {
		outcome, err = m.reconcileMetricLocked(ctx, rule, result, now)
		if err != nil {
			m.recordReplayFailure(ctx, rule.RuleID, rule.Revision)
		}
		return outcome, err
	}
	return m.evaluateMetricLocked(ctx, rule, target, result, now, true)
}

func (m *MongoEvaluatorRepository) evaluateMetricLocked(ctx context.Context, rule *AlertRule, target *nfhealth.HealthTarget, result *nfhealth.CollectionResult, now time.Time, publish bool) (*EvaluationOutcome, error) {
	outcome := &EvaluationOutcome{}
	r := m.repo
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
	if err := ValidateMetricCondition(current.ConditionType, current.TargetID, current.ResourceID, current.MetricCondition); err != nil {
		return nil, err
	}
	if m.metricTargets == nil {
		return nil, fmt.Errorf("metric target reader unavailable")
	}
	freshTarget, err := m.metricTargets.GetTarget(ctx, current.TargetID)
	if err != nil || freshTarget == nil {
		if state, loadErr := r.loadMetricState(ctx, current.RuleID); loadErr == nil && state.Revision > 0 {
			resetMetricTiming(state)
			state.Pending = nil
			state.Status = MetricEvaluationStatus{Quality: "indeterminate", Reason: "target_not_eligible", Phase: "unknown", RuleRevision: current.Revision}
			if saveErr := r.saveMetricState(ctx, state); saveErr != nil {
				return nil, saveErr
			}
		}
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("metric target unavailable")
	}
	state, err := r.loadMetricState(ctx, rule.RuleID)
	if err != nil {
		return nil, err
	}

	sample := result.Sample
	eventAt, ordered := metricOutcomeTime(freshTarget, result, now)
	watermark := state.LastOutcomeAt
	if state.LastAt.After(watermark.Time) {
		watermark = state.LastAt
	}
	if ordered && !watermark.IsZero() {
		if eventAt.Before(watermark.Time) {
			return outcome, nil
		}
		if eventAt.Equal(watermark.Time) && (state.Pending == nil || sample == nil || sample.SampleID != state.LastSampleID) {
			return outcome, nil
		}
	}
	if state.Pending != nil && !ordered {
		return outcome, nil
	}
	if state.Pending != nil && !publish {
		if err := r.cancelMetricTransition(ctx, current.RuleID); err != nil {
			return nil, err
		}
		state, err = r.loadMetricState(ctx, current.RuleID)
		if err != nil {
			return nil, err
		}
	}
	if state.Pending != nil {
		p := state.Pending
		epoch, _ := nfhealth.ThresholdContinuity(freshTarget, sample)
		value, _ := nfhealth.ThresholdValue(freshTarget, sample, current.MetricCondition.Metric, now)
		if eventAt.After(watermark.Time) || p.RuleRevision != 0 && p.RuleRevision != current.Revision || p.DurationIdentity != "" && (value == nil || epoch != p.DurationIdentity) {
			if err := r.cancelMetricTransition(ctx, current.RuleID); err != nil {
				return nil, err
			}
		} else if err := r.drainMetricTransition(ctx, current.RuleID, epoch); err != nil {
			return nil, err
		}
		state, err = r.loadMetricState(ctx, current.RuleID)
		if err != nil {
			return nil, err
		}
	}
	if ordered && !watermark.IsZero() && !eventAt.After(watermark.Time) {
		return outcome, nil
	}
	if ordered {
		state.LastOutcomeAt = metricInstant{eventAt}
	}
	coherent := ordered && sample != nil && sample.SampleID != "" && sample.RunID == result.Run.RunID &&
		result.Run.SampleID == sample.SampleID && sample.TargetID == freshTarget.TargetID && sample.ResourceID == freshTarget.ResourceID
	if coherent && sample.SampleID == state.LastSampleID {
		return outcome, nil
	}
	if coherent {
		sampleAt, err := time.Parse(time.RFC3339Nano, sample.CollectedAt)
		coherent = err == nil && sampleAt.Equal(eventAt)
	}
	if coherent {
		state.LastAt = metricInstant{eventAt}
		state.LastSampleID = sample.SampleID
	}
	value, reason := nfhealth.ThresholdValue(freshTarget, sample, current.MetricCondition.Metric, now)
	if !coherent || result.Run.Status == nfhealth.RunStatusFailed || target.TargetID != freshTarget.TargetID {
		value = nil
		reason = "collection_evidence_invalid"
	}
	open, err := m.FindOpenAlert(ctx, current.RuleID, freshTarget.TargetID)
	if err != nil {
		return nil, err
	}
	openID := ""
	if open != nil {
		openID = open.AlertID
	}
	status := MetricEvaluationStatus{Quality: "indeterminate", Reason: reason, Phase: "unknown", RuleRevision: current.Revision}
	if open != nil {
		status.Phase = "firing"
	}
	if ordered {
		status.ObservedAt = eventAt.UTC().Format(time.RFC3339Nano)
	}
	state.Status = status
	identity, gap := nfhealth.ThresholdContinuity(freshTarget, sample)
	state.Status.MaxGapSeconds = gap
	needsContinuity := current.MetricCondition.DurationSeconds > 0 || current.MetricCondition.RecoveryDurationSeconds > 0
	if value != nil && needsContinuity {
		versionAt, err := time.Parse(time.RFC3339Nano, current.UpdatedAt)
		if err != nil || eventAt.Before(versionAt) {
			value = nil
			state.Status.Reason = "rule_version_changed"
		}
		if value != nil && identity == "" {
			value = nil
			state.Status.Reason = "continuity_unverified"
		}
	}
	if value == nil {
		resetMetricTiming(state)
		outcome.Indeterminate++
		return outcome, r.saveMetricState(ctx, state)
	}
	decision := classifyMetric(current.MetricCondition, *value)
	timing, timed := advanceMetricTiming(state.Timing, current, identity, gap, eventAt, sample.SampleID, decision, openID)
	if !publish && timed.Action != "" {
		// Preserve the verified observation segment, but never create a historical
		// incident or clear the actual current incident during replay.
		timing.Direction = decision
		timing.Since = metricInstant{timed.Since}
		timing.FirstSampleID = timed.FirstSampleID
		timing.Observations = timed.Observations
		timed.Action = ""
	}
	state.Timing = timing
	state.Status = timed.Status
	state.Status.RuleRevision = current.Revision
	evidence := &MetricEvidence{Metric: current.MetricCondition.Metric, Series: "unlabeled", Unit: "bytes", Subject: "exporter_process", Value: *value, SampleID: sample.SampleID, ObservedAt: sample.CollectedAt}
	if timed.Action != "" && timed.Status.RequiredSeconds > 0 {
		evidence.ConditionSince = timed.Since.UTC().Format(time.RFC3339Nano)
		evidence.FirstSampleID = timed.FirstSampleID
		evidence.ElapsedSeconds = timed.ElapsedSeconds
		evidence.Observations = timed.Observations
		evidence.MaxGapSeconds = timed.MaxGapSeconds
	}
	at := now.UTC().Format(time.RFC3339Nano)
	if timed.Action == "open" {
		alert := &Alert{AlertID: metricAlertID(current.RuleID, sample.SampleID), SchemaVersion: SchemaVersion,
			RuleID: current.RuleID, RuleRevision: current.Revision, RuleName: current.Name, TargetID: freshTarget.TargetID,
			ResourceID: freshTarget.ResourceID, TargetName: freshTarget.Name, Severity: current.Severity, State: AlertStateActive,
			ConditionType: ConditionTypeMetricThreshold, MetricCondition: current.MetricCondition, TriggerCount: 1,
			FirstTriggeredAt: at, LastTriggeredAt: at, UpdatedAt: at,
			Evidence: AlertEvidence{RunStatus: result.Run.Status, SampleID: sample.SampleID, CollectedAt: sample.CollectedAt, Metric: evidence}}
		state.Pending = &metricTransition{RuleRevision: current.Revision, DurationIdentity: durationPublicationIdentity(current.MetricCondition, identity), Kind: "open", Alert: alert, At: at, ValidUntil: eventAt.Add(time.Duration(nfhealth.FreshnessPolicySeconds(freshTarget)) * time.Second)}
		outcome.Opened++
	} else if timed.Action == "recover" {
		state.Pending = &metricTransition{RuleRevision: current.Revision, DurationIdentity: durationPublicationIdentity(current.MetricCondition, identity), Kind: "recover", Alert: &Alert{AlertID: openID}, At: at, Evidence: evidence, ValidUntil: eventAt.Add(time.Duration(nfhealth.FreshnessPolicySeconds(freshTarget)) * time.Second)}
		outcome.Recovered++
	}
	if err := r.saveMetricState(ctx, state); err != nil {
		return nil, err
	}
	if !publish {
		return outcome, nil
	}
	return outcome, r.drainMetricTransition(ctx, current.RuleID, identity)
}

// Failed runs also break continuity, but an older failed callback cannot erase
// a newer accepted duration segment. Sample identity is checked independently.
func metricOutcomeTime(target *nfhealth.HealthTarget, result *nfhealth.CollectionResult, now time.Time) (time.Time, bool) {
	if result.Run.RunID == "" || result.Run.TargetID != target.TargetID || result.Run.ResourceID != target.ResourceID {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, result.Run.StartedAt)
	return at, err == nil && !at.After(now)
}

func durationPublicationIdentity(condition *MetricCondition, identity string) string {
	if condition.DurationSeconds > 0 || condition.RecoveryDurationSeconds > 0 {
		return identity
	}
	return ""
}
