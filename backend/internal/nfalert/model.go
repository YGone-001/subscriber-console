package nfalert

import "subscriber/internal/nfhealth"

// SchemaVersion defines the authoritative schema version for alert documents.
const SchemaVersion = 1

// Alert lifecycle states. An alert is opened by the evaluation engine when a
// rule triggers, may be acknowledged by an operator, and is closed either by
// the engine (recovery) or by an operator (manual resolve).
const (
	AlertStateActive       = "active"
	AlertStateAcknowledged = "acknowledged"
	AlertStateResolved     = "resolved"
)

// Alert severities are operator-authored classifications carried from the
// triggering rule. Severity never changes after an alert is opened.
const (
	SeverityCritical = "critical"
	SeverityWarning  = "warning"
	SeverityInfo     = "info"
)

// Condition types. Every condition is evaluated against explicit measurement
// evidence from NF Health: a state condition requires an accepted sample, and
// a run_failed condition requires the run outcome. No condition infers health
// from absence of evidence.
const (
	ConditionTypeState     = "state"
	ConditionTypeRunFailed = "run_failed"
)

// Condition scopes for state conditions.
const (
	ScopeOverall   = "overall"
	ScopeProcess   = "process"
	ScopeInterface = "interface"
	ScopeService   = "service"
)

// Resolve reasons recorded on closed alerts.
const (
	ResolveReasonRecovery    = "recovery"
	ResolveReasonManual      = "manual"
	ResolveReasonRuleDeleted = "rule_deleted"
)

// Cooldown bounds. The cooldown is the dedupe window: repeated triggers inside
// the window only increment the counter, they never re-arm the alert.
const (
	MinCooldownSeconds     = 60
	MaxCooldownSeconds     = 86400
	DefaultCooldownSeconds = 300
)

// Pagination defaults shared with the other operations-domain listings.
const (
	DefaultPageLimit = 50
	MaxPageLimit     = 200
)

// AlertRule is an operator-authored alerting configuration. A rule never
// modifies the network and never issues collections of its own: it is a pure
// observer over NF Health measurement evidence.
//
// Target matching is explicit and bounded:
//   - targetId set    : the rule applies to exactly that monitoring target.
//   - resourceId set  : the rule applies to every target of that resource.
//   - both empty      : the rule applies to all targets.
//   - both set        : invalid, rejected on write.
type AlertRule struct {
	RuleID          string        `json:"ruleId" bson:"_id"`
	SchemaVersion   int           `json:"schemaVersion" bson:"schemaVersion"`
	Name            string        `json:"name" bson:"name"`
	Description     string        `json:"description,omitempty" bson:"description,omitempty"`
	Enabled         bool          `json:"enabled" bson:"enabled"`
	TargetID        string        `json:"targetId,omitempty" bson:"targetId,omitempty"`
	ResourceID      string        `json:"resourceId,omitempty" bson:"resourceId,omitempty"`
	ConditionType   string        `json:"conditionType" bson:"conditionType"`
	Condition       RuleCondition `json:"condition,omitempty" bson:"condition,omitempty"`
	Severity        string        `json:"severity" bson:"severity"`
	CooldownSeconds int           `json:"cooldownSeconds" bson:"cooldownSeconds"`
	Revision        int64         `json:"revision" bson:"revision"`
	CreatedAt       string        `json:"createdAt" bson:"createdAt"`
	CreatedBy       string        `json:"createdBy" bson:"createdBy"`
	UpdatedAt       string        `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy       string        `json:"updatedBy" bson:"updatedBy"`
}

// RuleCondition is the state predicate for state-type rules. RunFailed rules
// carry no condition payload.
type RuleCondition struct {
	Scope string `json:"scope" bson:"scope"`
	State string `json:"state" bson:"state"`
}

// AlertEvidence is the immutable snapshot of the measurement evidence that
// opened or re-armed the alert. It records exactly what was observed, never a
// derived summary beyond the evaluated states.
type AlertEvidence struct {
	RunStatus    string             `json:"runStatus" bson:"runStatus"`
	SampleID     string             `json:"sampleId,omitempty" bson:"sampleId,omitempty"`
	CollectedAt  string             `json:"collectedAt,omitempty" bson:"collectedAt,omitempty"`
	Layers       *nfhealth.LayerSet `json:"layers,omitempty" bson:"layers,omitempty"`
	OverallState string             `json:"overallState,omitempty" bson:"overallState,omitempty"`
}

// Alert is one open, acknowledged or resolved alert instance for a
// (rule, target) pair. At most one non-resolved alert exists per pair; the
// evaluation engine maintains that invariant.
type Alert struct {
	AlertID          string        `json:"alertId" bson:"_id"`
	SchemaVersion    int           `json:"schemaVersion" bson:"schemaVersion"`
	RuleID           string        `json:"ruleId" bson:"ruleId"`
	RuleName         string        `json:"ruleName" bson:"ruleName"`
	TargetID         string        `json:"targetId" bson:"targetId"`
	ResourceID       string        `json:"resourceId,omitempty" bson:"resourceId,omitempty"`
	TargetName       string        `json:"targetName" bson:"targetName"`
	Severity         string        `json:"severity" bson:"severity"`
	State            string        `json:"state" bson:"state"`
	ConditionType    string        `json:"conditionType" bson:"conditionType"`
	Condition        RuleCondition `json:"condition,omitempty" bson:"condition,omitempty"`
	TriggerCount     int           `json:"triggerCount" bson:"triggerCount"`
	FirstTriggeredAt string        `json:"firstTriggeredAt" bson:"firstTriggeredAt"`
	LastTriggeredAt  string        `json:"lastTriggeredAt" bson:"lastTriggeredAt"`
	Evidence         AlertEvidence `json:"evidence" bson:"evidence"`
	AcknowledgedAt   string        `json:"acknowledgedAt,omitempty" bson:"acknowledgedAt,omitempty"`
	AcknowledgedBy   string        `json:"acknowledgedBy,omitempty" bson:"acknowledgedBy,omitempty"`
	ResolvedAt       string        `json:"resolvedAt,omitempty" bson:"resolvedAt,omitempty"`
	ResolvedReason   string        `json:"resolvedReason,omitempty" bson:"resolvedReason,omitempty"`
	UpdatedAt        string        `json:"updatedAt" bson:"updatedAt"`
}

// CreateRuleRequest is the body for POST /api/nf-alerts/rules.
type CreateRuleRequest struct {
	Name            string         `json:"name"`
	Description     string         `json:"description,omitempty"`
	Enabled         *bool          `json:"enabled,omitempty"`
	TargetID        string         `json:"targetId,omitempty"`
	ResourceID      string         `json:"resourceId,omitempty"`
	ConditionType   string         `json:"conditionType"`
	Condition       *RuleCondition `json:"condition,omitempty"`
	Severity        string         `json:"severity"`
	CooldownSeconds int            `json:"cooldownSeconds"`
}

// UpdateRuleRequest is the body for PUT /api/nf-alerts/rules/{ruleId}.
// Immutable identity fields (ruleId, targetId, resourceId) cannot be changed:
// retargeting a rule would silently move its open alerts to another subject.
type UpdateRuleRequest struct {
	ExpectedRevision int64             `json:"expectedRevision"`
	Rule             MutableRuleFields `json:"rule"`
}

// MutableRuleFields is the operator-mutable projection of an alert rule.
type MutableRuleFields struct {
	Name            string         `json:"name"`
	Description     string         `json:"description,omitempty"`
	Enabled         bool           `json:"enabled"`
	ConditionType   string         `json:"conditionType"`
	Condition       *RuleCondition `json:"condition,omitempty"`
	Severity        string         `json:"severity"`
	CooldownSeconds int            `json:"cooldownSeconds"`
}

// RuleListFilter filters rule listings.
type RuleListFilter struct {
	Query   string
	Enabled string // "", "true", "false"
	Limit   int
	Cursor  string
}

// AlertListFilter filters alert listings.
type AlertListFilter struct {
	State    string // "", active, acknowledged, resolved
	Severity string
	Query    string
	Limit    int
	Cursor   string
}

// PageInfo mirrors the operations-domain pagination envelope.
type PageInfo struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}

// Canonical vocabularies exposed by GET /api/nf-alerts/meta.
var (
	CanonicalAlertStates     = []string{AlertStateActive, AlertStateAcknowledged, AlertStateResolved}
	CanonicalSeverities      = []string{SeverityCritical, SeverityWarning, SeverityInfo}
	CanonicalConditionTypes  = []string{ConditionTypeState, ConditionTypeRunFailed}
	CanonicalConditionScopes = []string{ScopeOverall, ScopeProcess, ScopeInterface, ScopeService}
	// CanonicalStateConditionValues lists the layer states a state condition
	// may select. NotConfigured is excluded: it describes a configured absence
	// of measurement, which is target configuration, not an alarmable state.
	// Stale is excluded: it is a freshness projection the evaluation engine
	// never derives from a just-accepted sample, so it can never satisfy a
	// condition. The vocabulary must match ScopeAllowedStates exactly.
	CanonicalStateConditionValues = []string{
		nfhealth.StateUnhealthy,
		nfhealth.StateDegraded,
		nfhealth.StateUnknown,
	}
	CanonicalResolveReasons = []string{ResolveReasonRecovery, ResolveReasonManual, ResolveReasonRuleDeleted}
)

// ScopeAllowedStates returns the states a given condition scope may select.
func ScopeAllowedStates(scope string) []string {
	switch scope {
	case ScopeOverall:
		// Overall is the strongest-wins projection of measured layers. Stale
		// is a freshness projection that the engine never derives from a
		// just-accepted sample, so it is not selectable for overall either.
		return []string{nfhealth.StateUnhealthy, nfhealth.StateDegraded, nfhealth.StateUnknown}
	case ScopeProcess, ScopeInterface, ScopeService:
		return []string{nfhealth.StateUnhealthy, nfhealth.StateDegraded, nfhealth.StateUnknown}
	default:
		return nil
	}
}

// StateSelectable reports whether a state value is selectable for the scope.
func StateSelectable(scope, state string) bool {
	for _, s := range ScopeAllowedStates(scope) {
		if s == state {
			return true
		}
	}
	return false
}
