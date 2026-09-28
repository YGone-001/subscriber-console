package alert

// AlertDocument represents an operational alert stored in MongoDB.
// Maps to TypeScript AlertDocument from alertRepository.ts.
type AlertDocument struct {
	ID                string `json:"id" bson:"id"`
	Timestamp         string `json:"timestamp" bson:"timestamp"`
	Level             string `json:"level" bson:"level"`
	IMSI              string `json:"imsi" bson:"imsi"`
	Reason            string `json:"reason" bson:"reason"`
	IsAcknowledged    bool   `json:"is_acknowledged" bson:"is_acknowledged"`
	WorkflowStatus    string `json:"workflow_status,omitempty" bson:"workflow_status,omitempty"`
	AssignedTo        string `json:"assigned_to,omitempty" bson:"assigned_to,omitempty"`
	HandlingNote      string `json:"handling_note,omitempty" bson:"handling_note,omitempty"`
	WorkflowUpdatedAt string `json:"workflow_updated_at,omitempty" bson:"workflow_updated_at,omitempty"`
}

// ListAlertsResponse represents the payload returned by GET /api/alerts.
type ListAlertsResponse struct {
	Alerts              []AlertDocument `json:"alerts"`
	ActiveCriticalCount int64           `json:"activeCriticalCount"`
	ActiveWarningCount  int64           `json:"activeWarningCount"`
	ActiveCount         int64           `json:"activeCount"`
}

// AcknowledgeResponse represents the payload returned by POST /api/alerts/acknowledge.
type AcknowledgeResponse struct {
	Success      bool  `json:"success"`
	Acknowledged int64 `json:"acknowledged"`
	Requested    int   `json:"requested"`
	Skipped      int64 `json:"skipped"`
}

// AlertWorkflowStatus represents valid alert workflow status strings.
type AlertWorkflowStatus string

const (
	WorkflowStatusAcknowledged AlertWorkflowStatus = "acknowledged"
	WorkflowStatusAssigned     AlertWorkflowStatus = "assigned"
	WorkflowStatusRecovering   AlertWorkflowStatus = "recovering"
	WorkflowStatusResolved     AlertWorkflowStatus = "resolved"
)

// AlertWorkflowUpdate contains workflow fields to update on an alert document.
type AlertWorkflowUpdate struct {
	Status     string
	AssignedTo *string
	Note       *string
}

// WorkflowResponse represents the payload returned by POST /api/alerts/workflow.
type WorkflowResponse struct {
	Success  bool  `json:"success"`
	Matched  int64 `json:"matched"`
	Modified int64 `json:"modified"`
}
