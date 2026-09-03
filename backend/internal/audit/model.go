// Package audit provides read-only audit log API handlers.
package audit

// SourceInfo represents the source information in an audit log record.
type SourceInfo struct {
	IP        string `json:"ip,omitempty"`
	UserAgent string `json:"userAgent,omitempty"`
}

// AuditLogRecord matches the existing API response shape.
// Fields are kept compatible with the Node.js implementation.
type AuditLogRecord struct {
	ID            string      `json:"id"`
	EventID       string      `json:"eventId,omitempty"`
	Timestamp     string      `json:"timestamp"`
	Level         string      `json:"level,omitempty"`
	Action        string      `json:"action"`
	TargetID      string      `json:"targetId,omitempty"`
	Actor         interface{} `json:"actor,omitempty"`
	OperatorIP    string      `json:"operatorIp,omitempty"`
	CorrelationID string      `json:"correlationId,omitempty"`
	ApprovalID    string      `json:"approvalId,omitempty"`
	Reason        string      `json:"reason,omitempty"`
	ActorContext  interface{} `json:"actorContext,omitempty"`
	Module        string      `json:"module,omitempty"`
	Resource      interface{} `json:"resource,omitempty"`
	RiskLevel     string      `json:"riskLevel,omitempty"`
	Result        string      `json:"result,omitempty"`
	Source        *SourceInfo `json:"source,omitempty"`
	Request       interface{} `json:"request,omitempty"`
	Metadata      interface{} `json:"metadata,omitempty"`
	Error         interface{} `json:"error,omitempty"`
	OldData       interface{} `json:"oldData,omitempty"`
	NewData       interface{} `json:"newData,omitempty"`
}

// AuditListResponse matches the existing API response shape.
type AuditListResponse struct {
	Logs       []AuditLogRecord `json:"logs"`
	Pagination Pagination       `json:"pagination"`
	Summary    Summary          `json:"summary"`
}

// Pagination matches the existing pagination format.
type Pagination struct {
	Page       int `json:"page"`
	PageSize   int `json:"pageSize"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// Summary matches the existing audit summary format.
type Summary struct {
	Matched  int `json:"matched"`
	Failed   int `json:"failed"`
	Denied   int `json:"denied"`
	HighRisk int `json:"highRisk"`
}

// AuditQuery represents the parsed query parameters for audit log listing.
type AuditQuery struct {
	Page          int
	PageSize      int
	Q             string
	Action        string
	Module        string
	Result        string
	Risk          string
	Actor         string
	ResourceType  string
	ResourceID    string
	RequestID     string
	CorrelationID string
	ApprovalID    string
	SourceIP      string
	Level         string
	From          string
	To            string
}
