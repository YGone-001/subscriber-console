package audit

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// Handler provides HTTP handlers for audit log endpoints.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
	writer  *Writer
}

// NewHandler creates a new audit Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter, writer *Writer) *Handler {
	return &Handler{repo: repo, limiter: limiter, writer: writer}
}

// List handles GET /api/audit
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Check audit_view capability with denial audit (matching Node requireCapability + recordPermissionDenied)
	if !RequireCapabilityWithAudit(w, r, p, "audit_view", h.writer) {
		return
	}

	// Check audit.read permission with denial audit (matching Node requirePermission + recordPermissionDenied)
	if !RequirePermissionWithAudit(w, r, p, "audit.read", h.writer) {
		return
	}

	// Rate limit: 60 req/60s per user (same as Node)
	if !h.limiter.Enforce(w, r, "audit:list:"+p.Username, 60, 60) {
		return
	}

	query, err := parseAuditQuery(r.URL.Query())
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_QUERY")
		return
	}

	// Check source IP permission (matching Node requirePermission('audit.source-ip.read-full'))
	revealSourceIP := auth.HasPermission(p, "audit.source-ip.read-full")
	if query.SourceIP != "" && !revealSourceIP {
		if !RequirePermissionWithAudit(w, r, p, "audit.source-ip.read-full", h.writer) {
			return
		}
	}

	result, err := h.repo.ListAuditLogs(r.Context(), query, revealSourceIP)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// Get handles GET /api/audit/:id
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Check audit_view capability with denial audit
	if !RequireCapabilityWithAudit(w, r, p, "audit_view", h.writer) {
		return
	}

	// Check audit.read permission with denial audit
	if !RequirePermissionWithAudit(w, r, p, "audit.read", h.writer) {
		return
	}

	// Rate limit (Node uses 120/60s for audit detail)
	if !h.limiter.Enforce(w, r, "audit:detail:"+p.Username, 120, 60) {
		return
	}

	// Extract ID from path: /api/audit/:id
	id := strings.TrimPrefix(r.URL.Path, "/api/audit/")
	if id == "" || len(id) > 128 || !validIDPattern.MatchString(id) {
		response.BadRequest(w, "audit id has an invalid format", "INVALID_QUERY")
		return
	}

	revealSourceIP := auth.HasPermission(p, "audit.source-ip.read-full")

	rec, err := h.repo.GetAuditLog(r.Context(), id, revealSourceIP)
	if err != nil {
		response.InternalError(w)
		return
	}
	if rec == nil {
		response.NotFound(w)
		return
	}

	response.JSON(w, http.StatusOK, rec)
}

var validIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)

// NOTE: GET /api/audit/export remains with Next.js.
// It performs stateful audit evidence persistence (writeAuditLog with
// action=audit.export) on both success and failure paths, which requires
// Go Audit Writer — deferred to a future phase.

func parseAuditQuery(params map[string][]string) (AuditQuery, error) {
	q := AuditQuery{
		Page:     1,
		PageSize: 20,
	}

	if v := getParam(params, "page"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return q, &QueryError{"page must be a positive integer"}
		}
		q.Page = n
	}

	if v := getParam(params, "pageSize"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return q, &QueryError{"pageSize must be a positive integer"}
		}
		if n != 20 && n != 50 && n != 100 {
			return q, &QueryError{"pageSize must be one of 20, 50, or 100"}
		}
		q.PageSize = n
	} else if v := getParam(params, "limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return q, &QueryError{"limit must be a positive integer"}
		}
		if n > 100 {
			return q, &QueryError{"limit cannot exceed 100"}
		}
		q.PageSize = n
	}

	q.Q = trimmed(params, "q", 256)
	q.Action = trimmed(params, "action", 64)
	q.Module = enumValue(trimmed(params, "module", 64), auditModules, "module")
	q.Result = enumValue(trimmed(params, "result", 32), auditResults, "result")
	q.Risk = enumValue(trimmed(params, "risk", 32), auditRisks, "risk")
	q.Actor = trimmed(params, "actor", 128)
	if q.Actor == "" {
		q.Actor = trimmed(params, "operator", 128)
	}
	q.ResourceType = trimmed(params, "resourceType", 64)
	q.ResourceID = trimmed(params, "resourceId", 128)
	if q.ResourceID == "" {
		q.ResourceID = trimmed(params, "target", 128)
	}
	q.RequestID = trimmed(params, "requestId", 128)
	q.CorrelationID = trimmed(params, "correlationId", 128)
	q.ApprovalID = trimmed(params, "approvalId", 128)
	q.SourceIP = trimmed(params, "sourceIp", 64)
	q.Level = enumValue(trimmed(params, "level", 32), auditLevels, "level")
	q.From = trimmed(params, "from", 40)
	q.To = trimmed(params, "to", 40)

	return q, nil
}

var (
	auditModules = []string{"audit", "users", "subscribers", "profiles", "approvals", "ocs", "rating", "system", "security", "legacy"}
	auditResults = []string{"success", "failed", "denied"}
	auditRisks   = []string{"low", "medium", "high", "critical"}
	auditLevels  = []string{"info", "warning"}
)

// QueryError represents an invalid audit query parameter.
type QueryError struct {
	msg string
}

func (e *QueryError) Error() string { return e.msg }

func getParam(params map[string][]string, key string) string {
	v, ok := params[key]
	if !ok || len(v) == 0 {
		return ""
	}
	return v[0]
}

func trimmed(params map[string][]string, key string, maxLen int) string {
	v := getParam(params, key)
	v = strings.TrimSpace(v)
	if v == "" || strings.ToLower(v) == "all" {
		return ""
	}
	if len(v) > maxLen {
		return v[:maxLen]
	}
	return v
}

func enumValue(value string, allowed []string, name string) string {
	if value == "" {
		return ""
	}
	for _, a := range allowed {
		if a == value {
			return value
		}
	}
	return ""
}
