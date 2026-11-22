package nfalert

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/nfhealth"
)

// ConditionTypeMetricAnalysis turns a published baseline deviation or a
// confirmed sustained trend into an alert. It is explicit: no rule means no
// alert and no notification, which is the shadow-observation default.
const ConditionTypeMetricAnalysis = "metric_analysis"

const (
	// AnalysisKindDeviation selects the baseline deviation record.
	AnalysisKindDeviation = "baseline"
	// AnalysisKindTrend selects the sustained trend record.
	AnalysisKindTrend = "trend"
	// AnalysisFreshnessSeconds bounds which events may notify. An event whose
	// hour is older than this came from a repair or a replay and must not page an
	// operator.
	AnalysisFreshnessSeconds = 7200
	// AnalysisRecoveryConfirmations is the number of consecutive valid normal
	// analyses required before an open analysis alert is closed.
	AnalysisRecoveryConfirmations = 2
)

// AnalysisCondition is the immutable rule payload for an analysis alert.
type AnalysisCondition struct {
	Metric           string `json:"metric" bson:"metric"`
	Series           string `json:"series" bson:"series"`
	Kind             string `json:"kind" bson:"kind"`
	Direction        string `json:"direction,omitempty" bson:"direction,omitempty"`
	AlgorithmVersion string `json:"algorithmVersion" bson:"algorithmVersion"`
	PolicyVersion    string `json:"policyVersion" bson:"policyVersion"`
}

// AnalysisEvidence is the retained, display-safe summary of the event that
// opened or closed an analysis alert.
type AnalysisEvidence struct {
	Metric           string   `json:"metric" bson:"metric"`
	Series           string   `json:"series" bson:"series"`
	Kind             string   `json:"kind" bson:"kind"`
	State            string   `json:"state" bson:"state"`
	Direction        string   `json:"direction,omitempty" bson:"direction,omitempty"`
	Reason           string   `json:"reason,omitempty" bson:"reason,omitempty"`
	BucketStart      string   `json:"bucketStart" bson:"bucketStart"`
	AlgorithmVersion string   `json:"algorithmVersion" bson:"algorithmVersion"`
	PolicyVersion    string   `json:"policyVersion" bson:"policyVersion"`
	Value            *float64 `json:"value,omitempty" bson:"value,omitempty"`
	Median           *float64 `json:"median,omitempty" bson:"median,omitempty"`
	Score            *float64 `json:"score,omitempty" bson:"score,omitempty"`
	Slope            *float64 `json:"slope,omitempty" bson:"slope,omitempty"`
	Fit              *float64 `json:"fit,omitempty" bson:"fit,omitempty"`
	Confirmed        bool     `json:"confirmed,omitempty" bson:"confirmed,omitempty"`
	BaselineEligible int      `json:"baselineEligible,omitempty" bson:"baselineEligible,omitempty"`
}

func analysisKey(parts ...string) string {
	raw := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(raw[:])
}

func sameAnalysisCondition(a, b *AnalysisCondition) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Metric == b.Metric && a.Series == b.Series && a.Kind == b.Kind && a.Direction == b.Direction &&
		a.AlgorithmVersion == b.AlgorithmVersion && a.PolicyVersion == b.PolicyVersion
}

// ValidateAnalysisCondition accepts only the frozen, server-owned analysis
// policy. A rule pins the exact algorithm and policy version it was authored
// against, so a later policy change cannot silently alter an existing rule.
func ValidateAnalysisCondition(kind, targetID, resourceID string, c *AnalysisCondition, enabled bool) error {
	if kind != ConditionTypeMetricAnalysis {
		if c != nil {
			return validationError("NF_ALERT_INVALID_ANALYSIS", "analysisCondition requires metric_analysis")
		}
		return nil
	}
	if !enabled {
		return validationError("NF_ALERT_ANALYSIS_DISABLED", "metric analysis alerts are disabled on this deployment")
	}
	if targetID == "" || resourceID != "" {
		return validationError("NF_ALERT_INVALID_ANALYSIS", "an analysis rule requires one explicit target")
	}
	if c == nil || c.Metric != nfhealth.MetricAggregateMetric || c.Series != "unlabeled" {
		return validationError("NF_ALERT_INVALID_ANALYSIS", "the approved gauge with an unlabeled series is required")
	}
	switch c.Kind {
	case AnalysisKindDeviation:
		if c.Direction != "" && c.Direction != "rising" && c.Direction != "falling" {
			return validationError("NF_ALERT_INVALID_ANALYSIS", "deviation direction must be rising, falling or empty")
		}
		if c.AlgorithmVersion != nfhealth.MetricAnalysisVersion || c.PolicyVersion != nfhealth.MetricAnalysisPolicyVersion {
			return validationError("NF_ALERT_INVALID_ANALYSIS", "deviation rule must pin the current analysis policy")
		}
	case AnalysisKindTrend:
		if c.Direction != "rising" && c.Direction != "falling" {
			return validationError("NF_ALERT_INVALID_ANALYSIS", "trend rule must choose rising or falling")
		}
		if c.AlgorithmVersion != nfhealth.MetricTrendVersion || c.PolicyVersion != nfhealth.MetricTrendPolicyVersion {
			return validationError("NF_ALERT_INVALID_ANALYSIS", "trend rule must pin the current trend policy")
		}
	default:
		return validationError("NF_ALERT_INVALID_ANALYSIS", "analysis kind must be baseline or trend")
	}
	return nil
}

// ClassifyAnalysis has exactly three outcomes. Unusable or unconfirmed evidence
// always holds: it can neither open nor close an alert.
func ClassifyAnalysis(c *AnalysisCondition, record nfhealth.MetricAnalysis) string {
	if c == nil {
		return "hold"
	}
	if record.Metric != c.Metric || record.Series != c.Series || record.AlgorithmVersion != c.AlgorithmVersion || record.PolicyVersion != c.PolicyVersion {
		return "hold"
	}
	switch record.State {
	case nfhealth.AnalysisInsufficientData, nfhealth.AnalysisUnavailable:
		return "hold"
	}
	if c.Kind == AnalysisKindTrend {
		if record.Kind != "trend" {
			return "hold"
		}
		switch record.State {
		case nfhealth.TrendRising, nfhealth.TrendFalling:
			if !record.Confirmed || record.State != c.Direction {
				return "hold"
			}
			return "fire"
		case nfhealth.TrendStable:
			return "recover"
		}
		return "hold"
	}
	if record.Kind != "" && record.Kind != AnalysisKindDeviation {
		return "hold"
	}
	switch record.State {
	case nfhealth.AnalysisAnomaly:
		if c.Direction != "" && record.Direction != c.Direction {
			return "hold"
		}
		return "fire"
	case nfhealth.AnalysisOK:
		return "recover"
	}
	return "hold"
}

func analysisAlertID(ruleID string, record nfhealth.MetricAnalysis) string {
	// One alert per rule and analyzed hour, so replaying the same event cannot
	// create a second instance.
	return analysisKey(ruleID, record.TargetID, record.Series, record.Kind, record.AlgorithmVersion, record.PolicyVersion, record.BucketStart.UTC().Format(time.RFC3339))
}

func analysisEvidence(record nfhealth.MetricAnalysis) *AnalysisEvidence {
	return &AnalysisEvidence{
		Metric: record.Metric, Series: record.Series, Kind: record.Kind, State: record.State, Direction: record.Direction, Reason: record.Reason,
		BucketStart: record.BucketStart.UTC().Format(time.RFC3339), AlgorithmVersion: record.AlgorithmVersion, PolicyVersion: record.PolicyVersion,
		Value: record.Value, Median: record.Median, Score: record.Score, Slope: record.Slope, Fit: record.Fit, Confirmed: record.Confirmed,
		BaselineEligible: record.BaselineEligible,
	}
}

type analysisState struct {
	ID                string `bson:"_id"`
	RuleID            string `bson:"ruleId"`
	TargetID          string `bson:"targetId"`
	Series            string `bson:"series"`
	Revision          int64  `bson:"revision"`
	LastBucket        string `bson:"lastBucket"`
	ConsecutiveNormal int    `bson:"consecutiveNormal"`
	OpenAlertID       string `bson:"openAlertId"`
	UpdatedAt         string `bson:"updatedAt"`
}

func analysisStateID(ruleID, targetID, series string) string {
	return analysisKey("analysis-state", ruleID, targetID, series)
}

// PublishMetricAnalysis evaluates every enabled analysis rule of the target
// against one published record. It never reads raw samples and never creates an
// alert for a rule the operator did not author.
func (m *MongoEvaluatorRepository) PublishMetricAnalysis(ctx context.Context, target *nfhealth.HealthTarget, record nfhealth.MetricAnalysis) error {
	if m == nil || target == nil || m.repo == nil {
		return nil
	}
	cursor, err := m.rules.Find(ctx, bson.M{"enabled": true, "conditionType": ConditionTypeMetricAnalysis, "targetId": target.TargetID})
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	var rules []AlertRule
	if err := cursor.All(ctx, &rules); err != nil {
		return err
	}
	var lastErr error
	for i := range rules {
		if err := m.evaluateAnalysisRule(ctx, &rules[i], target, record, time.Now().UTC()); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

func (m *MongoEvaluatorRepository) evaluateAnalysisRule(ctx context.Context, rule *AlertRule, target *nfhealth.HealthTarget, record nfhealth.MetricAnalysis, now time.Time) error {
	outcome := ClassifyAnalysis(rule.AnalysisCondition, record)
	states := m.repo.metricStates()
	stateID := analysisStateID(rule.RuleID, target.TargetID, record.Series)
	var state analysisState
	err := states.FindOne(ctx, bson.M{"_id": stateID}).Decode(&state)
	if err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	bucket := record.BucketStart.UTC().Format(time.RFC3339)
	// An already evaluated hour with unusable evidence is not re-evaluated.
	if state.LastBucket == bucket && outcome == "hold" {
		return nil
	}
	switch outcome {
	case "fire":
		if state.OpenAlertID != "" {
			break
		}
		alert := m.buildAnalysisAlert(rule, target, record, now)
		if err := m.insertAnalysisAlert(ctx, alert, record, now); err != nil {
			return err
		}
		state.OpenAlertID, state.ConsecutiveNormal = alert.AlertID, 0
	case "recover":
		if state.OpenAlertID == "" {
			state.ConsecutiveNormal = 0
			break
		}
		state.ConsecutiveNormal++
		if state.ConsecutiveNormal < AnalysisRecoveryConfirmations {
			break
		}
		if err := m.closeAnalysisAlert(ctx, state.OpenAlertID, record, now); err != nil {
			return err
		}
		state.OpenAlertID, state.ConsecutiveNormal = "", 0
	case "hold":
		// Unavailable or unconfirmed evidence never advances recovery.
		state.ConsecutiveNormal = 0
	}
	state.ID, state.RuleID, state.TargetID, state.Series = stateID, rule.RuleID, target.TargetID, record.Series
	state.LastBucket, state.UpdatedAt = bucket, now.Format(time.RFC3339Nano)
	state.Revision++
	_, err = states.ReplaceOne(ctx, bson.M{"_id": stateID}, state, options.Replace().SetUpsert(true))
	return err
}

func (m *MongoEvaluatorRepository) buildAnalysisAlert(rule *AlertRule, target *nfhealth.HealthTarget, record nfhealth.MetricAnalysis, now time.Time) *Alert {
	stamp := now.UTC().Format(time.RFC3339Nano)
	return &Alert{
		AlertID: analysisAlertID(rule.RuleID, record), SchemaVersion: SchemaVersion,
		RuleID: rule.RuleID, RuleName: rule.Name, TargetID: target.TargetID, ResourceID: target.ResourceID, TargetName: target.Name,
		Severity: rule.Severity, State: AlertStateActive, ConditionType: ConditionTypeMetricAnalysis,
		TriggerCount: 1, FirstTriggeredAt: stamp, LastTriggeredAt: stamp, UpdatedAt: stamp,
		Evidence: AlertEvidence{RunStatus: "analysis", CollectedAt: record.BucketStart.UTC().Format(time.RFC3339), Analysis: analysisEvidence(record)},
	}
}

// insertAnalysisAlert suppresses the notification for a stale event. The alert
// still exists as evidence, but a repair or replay must not page an operator.
func (m *MongoEvaluatorRepository) insertAnalysisAlert(ctx context.Context, alert *Alert, record nfhealth.MetricAnalysis, now time.Time) error {
	if _, err := m.alerts.InsertOne(ctx, alert); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil
		}
		return err
	}
	if now.Sub(record.BucketStart) > AnalysisFreshnessSeconds*time.Second {
		return nil
	}
	m.emit(ctx, buildAlertEvent(AlertEventOpened, alert, alert.UpdatedAt))
	return nil
}

func (m *MongoEvaluatorRepository) closeAnalysisAlert(ctx context.Context, alertID string, record nfhealth.MetricAnalysis, now time.Time) error {
	stamp := now.UTC().Format(time.RFC3339Nano)
	res := m.alerts.FindOneAndUpdate(ctx,
		bson.M{"_id": alertID, "state": bson.M{"$in": AlertOpenStates}},
		bson.M{"$set": bson.M{"state": AlertStateResolved, "resolvedAt": stamp, "resolvedReason": "analysis_recovered", "updatedAt": stamp, "evidence.analysis": analysisEvidence(record)}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var doc Alert
	if err := res.Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil
		}
		return err
	}
	m.emit(ctx, buildAlertEvent(AlertEventResolved, &doc, stamp))
	return nil
}
