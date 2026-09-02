package audit

import (
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// WriteMode controls how the audit writer handles persistence failures.
type WriteMode int

const (
	// BestEffort silently drops records that fail to persist.
	// Used for authorization.denied — failure must not alter the 403 response.
	BestEffort WriteMode = iota
	// Strict returns a typed error with eventId on persistence failure.
	// Foundation for future governance writes.
	Strict
)

// WriteAuditInput is the caller-facing input for creating an audit record.
// Matches Node WriteAuditInput shape.
type WriteAuditInput struct {
	Action     string                 `json:"action"`
	Module     string                 `json:"module"`
	Actor      ActorInput             `json:"actor"`
	Resource   *ResourceInput         `json:"resource,omitempty"`
	TargetID   string                 `json:"targetId,omitempty"`
	Source     *SourceInput           `json:"source,omitempty"`
	Request    *RequestInput          `json:"request,omitempty"`
	ApprovalID string                 `json:"approvalId,omitempty"`
	Reason     string                 `json:"reason,omitempty"`
	Before     interface{}            `json:"before,omitempty"`
	After      interface{}            `json:"after,omitempty"`
	RiskLevel  string                 `json:"riskLevel,omitempty"`
	Result     string                 `json:"result,omitempty"`
	Level      string                 `json:"level,omitempty"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
	Error      *ErrorInput            `json:"error,omitempty"`
}

// ActorInput describes who performed the action.
type ActorInput struct {
	Type        string `json:"type"`
	UserID      string `json:"userId,omitempty"`
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Role        string `json:"role,omitempty"`
}

// ResourceInput describes the target resource.
type ResourceInput struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

// SourceInput describes the network source.
type SourceInput struct {
	IP        string `json:"ip,omitempty"`
	UserAgent string `json:"userAgent,omitempty"`
}

// RequestInput describes the HTTP request context.
type RequestInput struct {
	Method        string `json:"method,omitempty"`
	Path          string `json:"path,omitempty"`
	RequestID     string `json:"requestId,omitempty"`
	CorrelationID string `json:"correlationId,omitempty"`
}

// ErrorInput describes an error that occurred.
type ErrorInput struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// AuditWriteRecord is the complete record persisted to MongoDB.
// Uses the same _id = id convention as Node for idempotent inserts.
type AuditWriteRecord struct {
	ID            string                 `bson:"_id" json:"id"`
	EventID       string                 `bson:"eventId" json:"eventId"`
	Timestamp     string                 `bson:"timestamp" json:"timestamp"`
	Level         string                 `bson:"level" json:"level"`
	Action        string                 `bson:"action" json:"action"`
	Module        string                 `bson:"module,omitempty" json:"module,omitempty"`
	Actor         string                 `bson:"actor,omitempty" json:"actor,omitempty"`
	ActorContext  *ActorInput            `bson:"actorContext,omitempty" json:"actorContext,omitempty"`
	TargetID      string                 `bson:"targetId,omitempty" json:"targetId,omitempty"`
	Resource      *ResourceInput         `bson:"resource,omitempty" json:"resource,omitempty"`
	OperatorIP    string                 `bson:"operatorIp,omitempty" json:"operatorIp,omitempty"`
	Source        *SourceInput           `bson:"source,omitempty" json:"source,omitempty"`
	Request       *RequestInput          `bson:"request,omitempty" json:"request,omitempty"`
	CorrelationID string                 `bson:"correlationId,omitempty" json:"correlationId,omitempty"`
	ApprovalID    string                 `bson:"approvalId,omitempty" json:"approvalId,omitempty"`
	Reason        string                 `bson:"reason,omitempty" json:"reason,omitempty"`
	OldData       interface{}            `bson:"oldData,omitempty" json:"oldData,omitempty"`
	NewData       interface{}            `bson:"newData,omitempty" json:"newData,omitempty"`
	RiskLevel     string                 `bson:"riskLevel,omitempty" json:"riskLevel,omitempty"`
	Result        string                 `bson:"result,omitempty" json:"result,omitempty"`
	Metadata      map[string]interface{} `bson:"metadata,omitempty" json:"metadata,omitempty"`
	Error         *ErrorInput            `bson:"error,omitempty" json:"error,omitempty"`
}

// BuildRecord converts a WriteAuditInput into a sanitized, complete
// AuditWriteRecord ready for MongoDB insertion.
func BuildRecord(input WriteAuditInput) AuditWriteRecord {
	id := uuid.New().String()
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	level := input.Level
	if level == "" {
		if input.Result != "success" || input.RiskLevel == "high" || input.RiskLevel == "critical" {
			level = "warning"
		} else {
			level = "info"
		}
	}

	// Actor display string: username > system > userId
	actor := input.Actor.Username
	if actor == "" {
		if input.Actor.Type == "system" {
			actor = "system"
		} else {
			actor = input.Actor.UserID
		}
	}

	// TargetID fallback chain
	targetID := input.TargetID
	if targetID == "" && input.Resource != nil {
		if input.Resource.ID != "" {
			targetID = input.Resource.ID
		} else if input.Resource.Name != "" {
			targetID = input.Resource.Name
		}
	}
	if targetID == "" {
		targetID = input.Module
	}

	// OperatorIP fallback
	operatorIP := "unknown"
	if input.Source != nil && input.Source.IP != "" {
		operatorIP = input.Source.IP
	}

	// CorrelationID: prefer request.correlationId, then request.requestId
	correlationID := ""
	if input.Request != nil {
		correlationID = input.Request.CorrelationID
		if correlationID == "" {
			correlationID = input.Request.RequestID
		}
	}

	// Sanitize metadata
	var sanitizedMeta map[string]interface{}
	if input.Metadata != nil {
		if v, ok := sanitizeAuditPayload(input.Metadata).(map[string]interface{}); ok {
			sanitizedMeta = v
		}
	}

	// Sanitize old/new data
	var oldData, newData interface{}
	if input.Before != nil {
		oldData = sanitizeAuditPayload(input.Before)
	}
	if input.After != nil {
		newData = sanitizeAuditPayload(input.After)
	}

	// Sanitize text fields
	sanitizedActor := sanitizeAuditText(actor)
	sanitizedTargetID := sanitizeAuditText(targetID)
	sanitizedOperatorIP := sanitizeAuditText(operatorIP)
	sanitizedReason := ""
	if input.Reason != "" {
		sanitizedReason = sanitizeAuditText(input.Reason)
	}

	// Sanitize actor context
	var actorCtx *ActorInput
	if input.Actor.Username != "" || input.Actor.UserID != "" || input.Actor.Type != "" {
		actorCtx = &ActorInput{
			Type:        sanitizeAuditText(input.Actor.Type),
			UserID:      sanitizeAuditText(input.Actor.UserID),
			Username:    sanitizeAuditText(input.Actor.Username),
			DisplayName: sanitizeAuditText(input.Actor.DisplayName),
			Role:        sanitizeAuditText(input.Actor.Role),
		}
	}

	// Sanitize resource
	var resource *ResourceInput
	if input.Resource != nil {
		resource = &ResourceInput{
			Type: sanitizeAuditText(input.Resource.Type),
			ID:   sanitizeAuditText(input.Resource.ID),
			Name: sanitizeAuditText(input.Resource.Name),
		}
	}

	// Sanitize source
	var source *SourceInput
	if input.Source != nil {
		source = &SourceInput{
			IP:        sanitizeAuditText(input.Source.IP),
			UserAgent: sanitizeAuditText(input.Source.UserAgent),
		}
	}

	// Sanitize request
	var request *RequestInput
	if input.Request != nil {
		request = &RequestInput{
			Method:        sanitizeAuditText(input.Request.Method),
			Path:          sanitizeAuditText(input.Request.Path),
			RequestID:     sanitizeAuditText(input.Request.RequestID),
			CorrelationID: sanitizeAuditText(input.Request.CorrelationID),
		}
	}

	return AuditWriteRecord{
		ID:            id,
		EventID:       "EVT-" + id,
		Timestamp:     now,
		Level:         level,
		Action:        sanitizeAuditText(input.Action),
		Module:        sanitizeAuditText(input.Module),
		Actor:         sanitizedActor,
		ActorContext:  actorCtx,
		TargetID:      sanitizedTargetID,
		Resource:      resource,
		OperatorIP:    sanitizedOperatorIP,
		Source:        source,
		Request:       request,
		CorrelationID: correlationID,
		ApprovalID:    sanitizeAuditText(input.ApprovalID),
		Reason:        sanitizedReason,
		OldData:       oldData,
		NewData:       newData,
		RiskLevel:     input.RiskLevel,
		Result:        input.Result,
		Metadata:      sanitizedMeta,
		Error:         input.Error,
	}
}

// NormalizeIP validates and normalizes an IP address string.
// Returns "unknown" for invalid inputs. Matches Node normalizeAuditSourceIp().
func NormalizeIP(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	if len(value) > 128 {
		value = value[:128]
	}

	// Strip IPv6 brackets
	candidate := value
	if strings.HasPrefix(candidate, "[") {
		if close := strings.Index(candidate, "]"); close > 1 {
			candidate = candidate[1:close]
		}
	} else if colonIdx := strings.LastIndex(candidate, ":"); colonIdx > 0 {
		// Check for IPv4:port — strip port
		beforeColon := candidate[:colonIdx]
		if parts := strings.Split(beforeColon, "."); len(parts) == 4 {
			isIPv4 := true
			for _, p := range parts {
				if len(p) == 0 || len(p) > 3 {
					isIPv4 = false
					break
				}
				for _, c := range p {
					if c < '0' || c > '9' {
						isIPv4 = false
						break
					}
				}
			}
			if isIPv4 {
				candidate = beforeColon
			}
		}
	}

	// Strip IPv6 zone ID
	if idx := strings.Index(candidate, "%"); idx >= 0 {
		candidate = candidate[:idx]
	}

	if ip := net.ParseIP(candidate); ip != nil {
		return strings.ToLower(candidate)
	}
	return "unknown"
}

// AuditRequestContext extracts safe request context from an HTTP request.
// Matches Node auditRequestContext() semantics: source IP from proxy headers,
// correlation/request IDs, method, path (no query), user-agent.
func AuditRequestContext(r *http.Request) (source *SourceInput, request *RequestInput, reason string) {
	if r == nil {
		return nil, nil, ""
	}

	// Source IP: x-forwarded-for first, then x-real-ip
	rawIP := ""
	if xff := r.Header.Get("x-forwarded-for"); xff != "" {
		if parts := strings.SplitN(xff, ",", 2); len(parts) > 0 {
			rawIP = strings.TrimSpace(parts[0])
		}
	}
	if rawIP == "" {
		rawIP = r.Header.Get("x-real-ip")
	}
	ip := NormalizeIP(rawIP)

	// User-agent (capped at 512)
	ua := r.Header.Get("user-agent")
	if len(ua) > 512 {
		ua = ua[:512]
	}

	source = &SourceInput{IP: ip}
	if ua != "" {
		source.UserAgent = ua
	}

	// Request ID: x-request-id or generate UUID
	requestID := strings.TrimSpace(r.Header.Get("x-request-id"))
	if requestID == "" {
		requestID = uuid.New().String()
	} else if len(requestID) > 128 {
		requestID = requestID[:128]
	}

	// Correlation ID: x-correlation-id or fallback to requestId
	correlationID := strings.TrimSpace(r.Header.Get("x-correlation-id"))
	if correlationID == "" {
		correlationID = requestID
	} else if len(correlationID) > 128 {
		correlationID = correlationID[:128]
	}

	// Path: use URL path only, no query string
	path := ""
	if r.URL != nil {
		path = r.URL.Path
	}

	request = &RequestInput{
		Method:        r.Method,
		Path:          path,
		RequestID:     requestID,
		CorrelationID: correlationID,
	}

	// Operation reason header
	if opReason := strings.TrimSpace(r.Header.Get("x-operation-reason")); opReason != "" {
		if len(opReason) > 1000 {
			opReason = opReason[:1000]
		}
		reason = opReason
	}

	return source, request, reason
}
