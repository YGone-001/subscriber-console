package nfalert

import (
	"math"
	"subscriber/internal/nfhealth"
)

type MetricCondition struct {
	Metric            string   `json:"metric" bson:"metric"`
	Series            string   `json:"series" bson:"series"`
	Operator          string   `json:"operator" bson:"operator"`
	Threshold         *float64 `json:"threshold" bson:"threshold"`
	RecoveryThreshold *float64 `json:"recoveryThreshold" bson:"recoveryThreshold"`
}

type MetricEvidence struct {
	Metric     string  `json:"metric" bson:"metric"`
	Series     string  `json:"series" bson:"series"`
	Unit       string  `json:"unit" bson:"unit"`
	Subject    string  `json:"subject" bson:"subject"`
	Value      float64 `json:"value" bson:"value"`
	SampleID   string  `json:"sampleId" bson:"sampleId"`
	ObservedAt string  `json:"observedAt" bson:"observedAt"`
}

type MetricEvaluationStatus struct {
	Quality    string `json:"quality" bson:"quality"`
	Reason     string `json:"reason" bson:"reason"`
	ObservedAt string `json:"observedAt,omitempty" bson:"observedAt,omitempty"`
}

func sameMetricCondition(a, b *MetricCondition) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Metric == b.Metric && a.Series == b.Series && a.Operator == b.Operator &&
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
