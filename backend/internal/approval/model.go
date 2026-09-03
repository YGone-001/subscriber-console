// Package approval provides read-side approval governance foundation.
//
// This package implements approval models, risk policy, maker-checker policy,
// action eligibility, pure state machine, and read-only repository access
// for the approval governance system.
//
// IMPORTANT: This package contains NO approval write operations.
// Approval mutations (create, approve, reject, cancel, execute) remain with Node.
package approval

// ApprovalStatus represents the lifecycle status of an approval request.
// Matches Node ApprovalStatus exactly.
type ApprovalStatus string

const (
	StatusPending   ApprovalStatus = "pending"
	StatusApproved  ApprovalStatus = "approved"
	StatusRejected  ApprovalStatus = "rejected"
	StatusCancelled ApprovalStatus = "cancelled"
	StatusExecuting ApprovalStatus = "executing"
	StatusCompleted ApprovalStatus = "completed"
	StatusFailed    ApprovalStatus = "failed"
	StatusExpired   ApprovalStatus = "expired"
)

// AllApprovalStatuses is the set of valid approval statuses for validation.
var AllApprovalStatuses = map[ApprovalStatus]bool{
	StatusPending:   true,
	StatusApproved:  true,
	StatusRejected:  true,
	StatusCancelled: true,
	StatusExecuting: true,
	StatusCompleted: true,
	StatusFailed:    true,
	StatusExpired:   true,
}

// IsApprovalStatus returns true if the value is a valid approval status.
func IsApprovalStatus(value string) bool {
	return AllApprovalStatuses[ApprovalStatus(value)]
}

// RiskLevel represents the risk classification of an approval action.
type RiskLevel string

const (
	RiskLow      RiskLevel = "low"
	RiskMedium   RiskLevel = "medium"
	RiskHigh     RiskLevel = "high"
	RiskCritical RiskLevel = "critical"
)

// AllRiskLevels is the set of valid risk levels for validation.
var AllRiskLevels = map[RiskLevel]bool{
	RiskLow:      true,
	RiskMedium:   true,
	RiskHigh:     true,
	RiskCritical: true,
}

// IsRiskLevel returns true if the value is a valid risk level.
func IsRiskLevel(value string) bool {
	return AllRiskLevels[RiskLevel(value)]
}

// GovernanceActor represents who performed a governance action.
type GovernanceActor struct {
	Type        string `json:"type"`
	UserID      string `json:"userId,omitempty"`
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Role        string `json:"role,omitempty"`
}

// GovernanceEvent represents a lifecycle event on an approval.
type GovernanceEvent struct {
	ID        string `json:"id,omitempty"`
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Actor     string `json:"actor,omitempty"`
	Message   string `json:"message"`
}

// ApprovalOperation describes the resource being changed.
type ApprovalOperation struct {
	ResourceType string `json:"resourceType"`
	ResourceID   string `json:"resourceId"`
}

// ApprovalDecision records the reviewer's decision.
type ApprovalDecision struct {
	Outcome   string `json:"outcome"`
	Comment   string `json:"comment,omitempty"`
	DecidedAt string `json:"decidedAt"`
}

// ApprovalExecution records execution state.
type ApprovalExecution struct {
	ID          string          `json:"id,omitempty"`
	StartedAt   string          `json:"startedAt,omitempty"`
	CompletedAt string          `json:"completedAt,omitempty"`
	Success     *bool           `json:"success,omitempty"`
	Error       *ExecutionError `json:"error,omitempty"`
}

// ExecutionError is the error detail within an execution.
type ExecutionError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ApprovalMaintenanceWindow represents a maintenance window for an approval.
type ApprovalMaintenanceWindow struct {
	Start    string `json:"start"`
	End      string `json:"end"`
	TimeZone string `json:"timeZone,omitempty"`
}

// ApprovalDocument is the complete approval representation returned by the API.
// Matches Node ApprovalDocument shape exactly.
type ApprovalDocument struct {
	ID                   string                     `json:"id"`
	ChangeID             string                     `json:"changeId,omitempty"`
	Title                string                     `json:"title"`
	Description          string                     `json:"description,omitempty"`
	Action               string                     `json:"action"`
	Status               ApprovalStatus             `json:"status"`
	Operation            ApprovalOperation          `json:"operation"`
	OperationFingerprint string                     `json:"operationFingerprint,omitempty"`
	RiskLevel            RiskLevel                  `json:"riskLevel"`
	RiskAssessment       RiskAssessment             `json:"riskAssessment"`
	Requester            string                     `json:"requester"`
	RequesterContext     *GovernanceActor           `json:"requesterContext,omitempty"`
	Reviewer             string                     `json:"reviewer,omitempty"`
	ReviewerContext      *GovernanceActor           `json:"reviewerContext,omitempty"`
	TargetID             string                     `json:"targetId"`
	Summary              string                     `json:"summary"`
	Reason               string                     `json:"reason,omitempty"`
	Note                 string                     `json:"note,omitempty"`
	TicketID             string                     `json:"ticketId,omitempty"`
	MaintenanceWindow    *ApprovalMaintenanceWindow `json:"maintenanceWindow,omitempty"`
	Before               interface{}                `json:"before,omitempty"`
	After                interface{}                `json:"after,omitempty"`
	Payload              map[string]interface{}     `json:"payload"`
	Decision             *ApprovalDecision          `json:"decision,omitempty"`
	Execution            *ApprovalExecution         `json:"execution,omitempty"`
	Events               []GovernanceEvent          `json:"events"`
	Result               interface{}                `json:"result,omitempty"`
	Error                string                     `json:"error,omitempty"`
	CreatedAt            string                     `json:"createdAt"`
	ReviewedAt           string                     `json:"reviewedAt,omitempty"`
	ExecutedAt           string                     `json:"executedAt,omitempty"`
	UpdatedAt            string                     `json:"updatedAt"`
	ExpiresAt            string                     `json:"expiresAt,omitempty"`
	LegacyStatus         string                     `json:"legacyStatus,omitempty"`
}

// ApprovalActionEligibility represents what the current actor can do with an approval.
// Matches Node ApprovalActionEligibility exactly.
type ApprovalActionEligibility struct {
	CanApprove    bool   `json:"canApprove"`
	ApproveReason string `json:"approveReason,omitempty"`
	CanReject     bool   `json:"canReject"`
	RejectReason  string `json:"rejectReason,omitempty"`
	CanCancel     bool   `json:"canCancel"`
	CancelReason  string `json:"cancelReason,omitempty"`
	CanExecute    bool   `json:"canExecute"`
	ExecuteReason string `json:"executeReason,omitempty"`
}

// ApprovalWithActions is an approval document with action eligibility appended.
type ApprovalWithActions struct {
	ApprovalDocument
	Actions ApprovalActionEligibility `json:"actions"`
}
