package nfalert

import "context"

// Alert transition events emitted to a notification sink.
const (
	AlertEventOpened       = "opened"
	AlertEventRecovered    = "recovered"
	AlertEventAcknowledged = "acknowledged"
	AlertEventResolved     = "resolved"
)

// AlertEvent is a notification intent emitted after an alert instance
// transitions. It carries display-safe identity only: no secret and no channel
// detail appear here.
type AlertEvent struct {
	Event        string
	AlertID      string
	RuleID       string
	RuleName     string
	TargetID     string
	TargetName   string
	Severity     string
	TriggerCount int
	OccurredAt   string
}

// AlertEventSink receives alert transition intents. Implementations must be
// non-blocking, must never perform network egress, and must never fail the
// alert write that called them.
type AlertEventSink interface {
	NotifyAlert(ctx context.Context, event AlertEvent)
}

// alertEvent builds a notification intent from an alert document.
func buildAlertEvent(event string, alert *Alert, occurredAt string) AlertEvent {
	if alert == nil {
		return AlertEvent{Event: event, OccurredAt: occurredAt}
	}
	return AlertEvent{
		Event:        event,
		AlertID:      alert.AlertID,
		RuleID:       alert.RuleID,
		RuleName:     alert.RuleName,
		TargetID:     alert.TargetID,
		TargetName:   alert.TargetName,
		Severity:     alert.Severity,
		TriggerCount: alert.TriggerCount,
		OccurredAt:   occurredAt,
	}
}
