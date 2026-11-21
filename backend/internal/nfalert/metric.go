package nfalert

import (
	"math"
	"subscriber/internal/nfhealth"
)

const MaxMetricDurationSeconds = 3600

type MetricCondition struct {
	DurationSeconds         int      `json:"durationSeconds,omitempty" bson:"durationSeconds,omitempty"`
	RecoveryDurationSeconds int      `json:"recoveryDurationSeconds,omitempty" bson:"recoveryDurationSeconds,omitempty"`
	Metric                  string   `json:"metric" bson:"metric"`
	Series                  string   `json:"series" bson:"series"`
	Operator                string   `json:"operator" bson:"operator"`
	Threshold               *float64 `json:"threshold" bson:"threshold"`
	RecoveryThreshold       *float64 `json:"recoveryThreshold" bson:"recoveryThreshold"`
}

type MetricEvidence struct {
	ConditionSince string  `json:"conditionSince,omitempty" bson:"conditionSince,omitempty"`
	FirstSampleID  string  `json:"firstSampleId,omitempty" bson:"firstSampleId,omitempty"`
	ElapsedSeconds int     `json:"elapsedSeconds,omitempty" bson:"elapsedSeconds,omitempty"`
	Observations   int     `json:"observations,omitempty" bson:"observations,omitempty"`
	MaxGapSeconds  int     `json:"maxGapSeconds,omitempty" bson:"maxGapSeconds,omitempty"`
	Metric         string  `json:"metric" bson:"metric"`
	Series         string  `json:"series" bson:"series"`
	Unit           string  `json:"unit" bson:"unit"`
	Subject        string  `json:"subject" bson:"subject"`
	Value          float64 `json:"value" bson:"value"`
	SampleID       string  `json:"sampleId" bson:"sampleId"`
	ObservedAt     string  `json:"observedAt" bson:"observedAt"`
}

type MetricEvaluationStatus struct {
	RuleRevision    int64  `json:"ruleRevision,omitempty" bson:"ruleRevision,omitempty"`
	Phase           string `json:"phase,omitempty" bson:"phase,omitempty"`
	ConditionSince  string `json:"conditionSince,omitempty" bson:"conditionSince,omitempty"`
	ElapsedSeconds  int    `json:"elapsedSeconds,omitempty" bson:"elapsedSeconds,omitempty"`
	RequiredSeconds int    `json:"requiredSeconds,omitempty" bson:"requiredSeconds,omitempty"`
	Observations    int    `json:"observations,omitempty" bson:"observations,omitempty"`
	MaxGapSeconds   int    `json:"maxGapSeconds,omitempty" bson:"maxGapSeconds,omitempty"`
	Quality         string `json:"quality" bson:"quality"`
	Reason          string `json:"reason" bson:"reason"`
	ObservedAt      string `json:"observedAt,omitempty" bson:"observedAt,omitempty"`
}

func sameMetricCondition(a, b *MetricCondition) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.DurationSeconds == b.DurationSeconds && a.RecoveryDurationSeconds == b.RecoveryDurationSeconds && a.Metric == b.Metric && a.Series == b.Series && a.Operator == b.Operator &&
		a.Threshold != nil && b.Threshold != nil && *a.Threshold == *b.Threshold &&
		a.RecoveryThreshold != nil && b.RecoveryThreshold != nil && *a.RecoveryThreshold == *b.RecoveryThreshold
}

func ValidateMetricCondition(kind, targetID, resourceID string, m *MetricCondition) error {
	if kind != ConditionTypeMetricThreshold {
		if m != nil {
			return validationError("NF_ALERT_INVALID_METRIC", "metricCondition requires metric_threshold")
		}
		return nil
	}
	if targetID == "" || resourceID != "" {
		return validationError("NF_ALERT_INVALID_METRIC", "metric threshold requires one explicit target")
	}
	if m == nil || !nfhealth.ThresholdMetricApproved(m.Metric) || m.Series != "unlabeled" ||
		m.Threshold == nil || m.RecoveryThreshold == nil {
		return validationError("NF_ALERT_INVALID_METRIC", "an approved metric, unlabeled series and both thresholds are required")
	}
	if m.DurationSeconds < 0 || m.DurationSeconds > MaxMetricDurationSeconds || m.RecoveryDurationSeconds < 0 || m.RecoveryDurationSeconds > MaxMetricDurationSeconds {
		return validationError("NF_ALERT_INVALID_METRIC", "durations must be integer seconds between 0 and 3600")
	}
	for _, value := range []float64{*m.Threshold, *m.RecoveryThreshold} {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return validationError("NF_ALERT_INVALID_METRIC", "thresholds must be finite and nonnegative")
		}
	}
	switch m.Operator {
	case "gt", "gte":
		if *m.RecoveryThreshold > *m.Threshold {
			return validationError("NF_ALERT_INVALID_METRIC", "recovery threshold must not exceed trigger threshold")
		}
	case "lt", "lte":
		if *m.RecoveryThreshold < *m.Threshold {
			return validationError("NF_ALERT_INVALID_METRIC", "recovery threshold must not be below trigger threshold")
		}
	default:
		return validationError("NF_ALERT_INVALID_METRIC", "operator must be gt, gte, lt or lte")
	}
	return nil
}

// classifyMetric has three outcomes: trigger, recover and hold. Indeterminate
// evidence is handled before comparison, never mapped to a recovery.
func classifyMetric(m *MetricCondition, value float64) string {
	trigger, recover := *m.Threshold, *m.RecoveryThreshold
	switch m.Operator {
	case "gt":
		if value > trigger {
			return "trigger"
		}
		if value <= recover {
			return "recover"
		}
	case "gte":
		if value >= trigger {
			return "trigger"
		}
		if value < recover {
			return "recover"
		}
	case "lt":
		if value < trigger {
			return "trigger"
		}
		if value >= recover {
			return "recover"
		}
	case "lte":
		if value <= trigger {
			return "trigger"
		}
		if value > recover {
			return "recover"
		}
	}
	return "hold"
}

// MetricObservation is independent of the immutable trigger and recovery proof.
type MetricObservation struct {
	Status   MetricEvaluationStatus `json:"status" bson:"status"`
	Evidence *MetricEvidence        `json:"evidence,omitempty" bson:"evidence,omitempty"`
}

// MetricAlertSummary contains only retained, display-safe alert evidence.
type MetricAlertSummary struct {
	RuleRevision int64            `json:"ruleRevision" bson:"ruleRevision"`
	Condition    *MetricCondition `json:"condition" bson:"condition"`
	Trigger      *MetricEvidence  `json:"trigger" bson:"trigger"`
	Recovery     *MetricEvidence  `json:"recovery,omitempty" bson:"recovery,omitempty"`
}
