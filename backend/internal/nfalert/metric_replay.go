package nfalert

import (
	"context"
	"errors"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/nfhealth"
	"time"
)

const MetricReplayBatchLimit = 128
const MetricReplayLookback = 2 * time.Hour

type MetricOutcomeSource interface {
	MetricOutcomes(context.Context, string, string, time.Time, time.Time, int) (nfhealth.MetricOutcomeBatch, error)
}

type MetricReplayStatus struct {
	State            string `json:"state" bson:"state"`
	Reason           string `json:"reason" bson:"reason"`
	LastAttemptAt    string `json:"lastAttemptAt" bson:"lastAttemptAt"`
	LastSuccessAt    string `json:"lastSuccessAt,omitempty" bson:"lastSuccessAt,omitempty"`
	ProcessedThrough string `json:"processedThrough,omitempty" bson:"processedThrough,omitempty"`
	LastRunID        string `json:"lastRunId,omitempty" bson:"lastRunId,omitempty"`
	WindowFrom       string `json:"windowFrom,omitempty" bson:"windowFrom,omitempty"`
	Processed        int    `json:"processed" bson:"processed"`
	Historical       int    `json:"historical" bson:"historical"`
	Gaps             int    `json:"gaps" bson:"gaps"`
	More             bool   `json:"more" bson:"more"`
	Failures         int    `json:"failures" bson:"failures"`
	RuleRevision     int64  `json:"ruleRevision" bson:"ruleRevision"`
}

func (m *MongoEvaluatorRepository) SetMetricOutcomeSource(source MetricOutcomeSource) {
	m.metricSource = source
}

func (m *MongoEvaluatorRepository) recordReplayFailure(ctx context.Context, id string, revision int64) {
	repair, cancel := context.WithTimeout(context.WithoutCancel(ctx), 500*time.Millisecond)
	defer cancel()
	state, err := m.repo.loadMetricState(repair, id)
	if err != nil {
		return
	}
	status := state.Replay
	if status == nil {
		status = &MetricReplayStatus{}
	}
	var current AlertRule
	if err := m.rules.FindOne(repair, bson.M{"_id": id}, options.FindOne().SetProjection(bson.M{"revision": 1})).Decode(&current); err == nil {
		revision = current.Revision
	}
	status.RuleRevision = revision
	status.State = "failed"
	status.Reason = "evaluation_unavailable"
	status.LastAttemptAt = time.Now().UTC().Format(time.RFC3339Nano)
	status.Failures++
	state.Replay = status
	_ = m.repo.saveMetricState(repair, state)
}

func (m *MongoEvaluatorRepository) reconcileMetricLocked(ctx context.Context, input *AlertRule, hint *nfhealth.CollectionResult, now time.Time) (*EvaluationOutcome, error) {
	total := &EvaluationOutcome{}
	rule, err := m.repo.GetRule(ctx, input.RuleID)
	if errors.Is(err, ErrNotFound) {
		return total, nil
	}
	if err != nil {
		return nil, err
	}
	if !rule.Enabled || rule.ConditionType != ConditionTypeMetricThreshold {
		return total, nil
	}
	if m.metricTargets == nil {
		return nil, errors.New("metric target reader unavailable")
	}
	target, err := m.metricTargets.GetTarget(ctx, rule.TargetID)
	if err != nil || target == nil {
		if state, loadErr := m.repo.loadMetricState(ctx, rule.RuleID); loadErr == nil && state.Revision > 0 {
			resetMetricTiming(state)
			state.Pending = nil
			state.Status = MetricEvaluationStatus{Quality: "indeterminate", Reason: "target_not_eligible", Phase: "unknown", RuleRevision: rule.Revision}
			if saveErr := m.repo.saveMetricState(ctx, state); saveErr != nil {
				return nil, saveErr
			}
		}
		if err != nil {
			return nil, err
		}
		return nil, errors.New("metric target unavailable")
	}
	state, err := m.repo.loadMetricState(ctx, rule.RuleID)
	if err != nil {
		return nil, err
	}
	from, err := time.Parse(time.RFC3339Nano, rule.UpdatedAt)
	if err != nil {
		return nil, err
	}
	replay := state.Replay
	if replay == nil || replay.RuleRevision != rule.Revision {
		replay = &MetricReplayStatus{RuleRevision: rule.Revision}
	} else if at, e := time.Parse(time.RFC3339Nano, replay.ProcessedThrough); e == nil && at.After(from) {
		from = at
	}
	watermark := state.LastOutcomeAt.Time
	if state.LastAt.After(watermark) {
		watermark = state.LastAt.Time
	}
	if watermark.After(from) {
		from = watermark
	}
	truncated := false
	if from.Before(now.Add(-MetricReplayLookback)) {
		from = now.Add(-MetricReplayLookback)
		resetMetricTiming(state)
		truncated = true
	}
	if from.After(now) {
		return nil, errors.New("metric replay clock is behind policy")
	}
	batch, err := m.metricSource.MetricOutcomes(ctx, target.TargetID, target.ResourceID, from, now, MetricReplayBatchLimit)
	if err != nil {
		return nil, err
	}
	if hint != nil && !batch.More {
		at, parseErr := time.Parse(time.RFC3339Nano, hint.Run.StartedAt)
		if parseErr == nil && at.After(watermark) && !at.After(now) {
			found := false
			for _, outcome := range batch.Outcomes {
				if outcome.Run.RunID == hint.Run.RunID {
					found = true
					break
				}
			}
			if !found {
				batch.More = true
				batch.Reason = "recording_not_visible"
			}
		}
	}
	if truncated || batch.Gaps > 0 {
		resetMetricTiming(state)
		if err := m.repo.saveMetricState(ctx, state); err != nil {
			return nil, err
		}
	}
	replay.LastAttemptAt = now.UTC().Format(time.RFC3339Nano)
	replay.WindowFrom = from.UTC().Format(time.RFC3339Nano)
	replay.Processed = 0
	replay.Historical = 0
	replay.Gaps = batch.Gaps
	replay.More = batch.More
	replay.Reason = batch.Reason
	if truncated {
		replay.Reason = "lookback_exceeded"
		replay.Gaps++
	}
	for i := range batch.Outcomes {
		result := &batch.Outcomes[i]
		at, err := time.Parse(time.RFC3339Nano, result.Run.StartedAt)
		if err != nil {
			return nil, err
		}
		// All intermediate rows, even fresh ones, are observation-only. Publication
		// is reserved for the latest fully-read fresh evidence at the fixed cutoff.
		publish := !batch.More && i == len(batch.Outcomes)-1 && now.Sub(at) <= time.Duration(nfhealth.FreshnessPolicySeconds(target))*time.Second
		evaluationAt := now
		if !publish {
			evaluationAt = at
			replay.Historical++
		}
		outcome, err := m.evaluateMetricLocked(ctx, rule, target, result, evaluationAt, publish)
		if err != nil {
			return nil, err
		}
		total.Opened += outcome.Opened
		total.Recovered += outcome.Recovered
		total.Indeterminate += outcome.Indeterminate
		replay.Processed++
		replay.ProcessedThrough = at.UTC().Format(time.RFC3339Nano)
		replay.LastRunID = result.Run.RunID
	}
	if batch.More {
		replay.State = "partial"
	} else if replay.Gaps > 0 {
		replay.State = "incomplete"
	} else {
		replay.State = "caught_up"
		replay.LastSuccessAt = replay.LastAttemptAt
	}
	if !batch.More && len(batch.Outcomes) == 0 && state.Pending != nil && now.After(state.Pending.ValidUntil) {
		if err := m.repo.drainMetricTransition(ctx, rule.RuleID); err != nil {
			return nil, err
		}
	}
	state, err = m.repo.loadMetricState(ctx, rule.RuleID)
	if err != nil {
		return nil, err
	}
	state.Replay = replay
	return total, m.repo.saveMetricState(ctx, state)
}

// ScanMetricRules is keyset-paged for fairness and has an independent deadline.
func (m *MongoEvaluatorRepository) ScanMetricRules(ctx context.Context, after string) ([]AlertRule, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	q := bson.M{"enabled": true, "conditionType": ConditionTypeMetricThreshold}
	if after != "" {
		q["_id"] = bson.M{"$gt": after}
	}
	cursor, err := m.rules.Find(ctx, q, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(17))
	if err != nil {
		return nil, false, err
	}
	defer cursor.Close(ctx)
	var rules []AlertRule
	if err := cursor.All(ctx, &rules); err != nil {
		return nil, false, err
	}
	more := len(rules) > 16
	if more {
		rules = rules[:16]
	}
	return rules, more, nil
}
