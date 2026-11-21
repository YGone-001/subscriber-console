package nfalert

import "time"

// metricTiming is an observation-only clock. It does not schedule a timeout and
// cannot transition an alert in the absence of another accepted observation.
type metricTiming struct {
	RuleRevision  int64         `bson:"ruleRevision"`
	Identity      string        `bson:"identity"`
	LastValidAt   metricInstant `bson:"lastValidAt"`
	OpenAlertID   string        `bson:"openAlertId"`
	Direction     string        `bson:"direction"`
	Since         metricInstant `bson:"since"`
	FirstSampleID string        `bson:"firstSampleId"`
	Observations  int           `bson:"observations"`
}

type metricTimingDecision struct {
	Action         string
	Status         MetricEvaluationStatus
	Since          time.Time
	FirstSampleID  string
	ElapsedSeconds int
	Observations   int
	MaxGapSeconds  int
}

// advanceMetricTiming receives valid, strictly increasing observations only.
// Equality is checked using time.Duration, never a rounded elapsed display value.
func advanceMetricTiming(prior metricTiming, rule *AlertRule, identity string, gap int, at time.Time, sampleID, decision, openID string) (metricTiming, metricTimingDecision) {
	status := MetricEvaluationStatus{Quality: "measured", Reason: decision, Phase: "idle", ObservedAt: at.UTC().Format(time.RFC3339Nano), MaxGapSeconds: gap}
	if openID != "" {
		status.Phase = "firing"
	}
	next := prior
	if !prior.LastValidAt.IsZero() && !at.After(prior.LastValidAt.Time) {
		return prior, metricTimingDecision{Status: status}
	}
	if prior.RuleRevision != rule.Revision || prior.Identity != identity || prior.OpenAlertID != openID ||
		prior.LastValidAt.IsZero() || at.Sub(prior.LastValidAt.Time) > time.Duration(gap)*time.Second {
		next = metricTiming{RuleRevision: rule.Revision, Identity: identity, OpenAlertID: openID}
	}
	next.LastValidAt = metricInstant{at}
	result := metricTimingDecision{Status: status, MaxGapSeconds: gap}
	direction := ""
	seconds := 0
	if openID == "" && decision == "trigger" {
		direction = "trigger"
		seconds = rule.MetricCondition.DurationSeconds
	}
	if openID != "" && decision == "recover" {
		direction = "recover"
		seconds = rule.MetricCondition.RecoveryDurationSeconds
	}
	if direction == "" {
		next.Direction = ""
		next.Since = metricInstant{}
		next.FirstSampleID = ""
		next.Observations = 0
		return next, result
	}
	if next.Direction != direction || next.Since.IsZero() {
		next.Direction = direction
		next.Since = metricInstant{at}
		next.FirstSampleID = sampleID
		next.Observations = 0
	}
	next.Observations++
	elapsed := at.Sub(next.Since.Time)
	result.Since = next.Since.Time
	result.FirstSampleID = next.FirstSampleID
	result.Observations = next.Observations
	result.ElapsedSeconds = int(elapsed / time.Second)
	result.Status.ConditionSince = next.Since.UTC().Format(time.RFC3339Nano)
	result.Status.RequiredSeconds = seconds
	result.Status.ElapsedSeconds = result.ElapsedSeconds
	result.Status.Observations = next.Observations
	if direction == "trigger" {
		result.Status.Phase = "pending"
		result.Status.Reason = "pending_trigger"
	} else {
		result.Status.Phase = "recovering"
		result.Status.Reason = "pending_recovery"
	}
	if seconds == 0 || (next.Observations >= 2 && sampleID != next.FirstSampleID && elapsed >= time.Duration(seconds)*time.Second) {
		if direction == "trigger" {
			result.Action = "open"
		} else {
			result.Action = "recover"
		}
		result.Status.Reason = decision
		// An interrupted publication retains its own complete evidence in Pending.
		next.Direction = ""
		next.Since = metricInstant{}
		next.FirstSampleID = ""
		next.Observations = 0
	}
	return next, result
}

func resetMetricTiming(state *metricState) { state.Timing = metricTiming{} }
