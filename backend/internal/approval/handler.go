package approval

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// Handler provides HTTP handlers for approval endpoints.
type Handler struct {
	repo     *Repository
	limiter  *ratelimit.Limiter
	writer   *audit.Writer
	workflow *Workflow
}

// NewHandler creates a new approval Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter, writer *audit.Writer, workflow *Workflow) *Handler {
	return &Handler{repo: repo, limiter: limiter, writer: writer, workflow: workflow}
}

// List handles GET /api/approvals
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "approvals.read", h.writer) {
		return
	}

	// Rate limit: 80/60s per user (matches Node)
	if !h.limiter.Enforce(w, r, "approvals:list:"+p.Username, 80, 60) {
		return
	}

	params := r.URL.Query()

	// Validate status
	rawStatus := params.Get("status")
	if rawStatus != "" && rawStatus != "all" && !IsApprovalStatus(rawStatus) {
		response.BadRequest(w, "INVALID_STATUS", "INVALID_STATUS")
		return
	}

	// Validate risk
	rawRisk := params.Get("risk")
	if rawRisk != "" && !IsRiskLevel(rawRisk) {
		response.BadRequest(w, "INVALID_RISK", "INVALID_RISK")
		return
	}

	// Validate action
	rawAction := params.Get("action")
	if rawAction != "" && !IsSupportedApprovalAction(rawAction) {
		response.BadRequest(w, "INVALID_ACTION", "INVALID_ACTION")
		return
	}

	// Parse dates
	fromTime, fromOK := dateParam(params.Get("from"), false)
	toTime, toOK := dateParam(params.Get("to"), true)
	if (params.Get("from") != "" && !fromOK) || (params.Get("to") != "" && !toOK) {
		response.BadRequest(w, "INVALID_DATE_RANGE", "INVALID_DATE_RANGE")
		return
	}

	// Build query
	q := ListQuery{
		Page:         boundedInt(params.Get("page"), 1, 100000),
		PageSize:     boundedInt(firstNonEmpty(params.Get("pageSize"), params.Get("limit")), 20, 100),
		Q:            truncate(params.Get("q"), 200),
		Status:       rawStatus,
		Risk:         rawRisk,
		Action:       rawAction,
		ResourceType: truncate(params.Get("resourceType"), 100),
		ResourceID:   truncate(params.Get("resourceId"), 200),
		Requester:    truncate(params.Get("requester"), 100),
		Reviewer:     truncate(params.Get("reviewer"), 100),
		FromTime:     fromTime,
		ToTime:       toTime,
		ActorUser:    p.Username,
		ActorRole:    p.NormalizedRole,
		CanApprove:   auth.HasPermission(p, "approvals.approve"),
	}

	if q.Status == "" {
		q.Status = "all"
	}

	result, err := h.repo.ListApprovals(r.Context(), q)
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, "APPROVAL_QUERY_FAILED", "APPROVAL_QUERY_FAILED")
		return
	}

	// Ensure approvals is never null
	if result.Approvals == nil {
		result.Approvals = []ApprovalWithActions{}
	}

	response.JSON(w, http.StatusOK, result)
}

// Detail handles GET /api/approvals/{id}
func (h *Handler) Detail(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "approvals.read", h.writer) {
		return
	}

	// No additional rate limit for detail (matches Node — detail has no rate limit)

	id := extractID(r.URL.Path, "/api/approvals/")
	if id == "" || len(id) > 128 {
		response.Error(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND")
		return
	}

	approval, err := h.repo.GetApproval(r.Context(), id)
	if err != nil {
		response.InternalError(w)
		return
	}
	if approval == nil {
		response.Error(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND")
		return
	}

	actions := ComputeActionEligibility(*approval, p.Username, p.NormalizedRole)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"approval": ApprovalWithActions{
			ApprovalDocument: *approval,
			Actions:          actions,
		},
	})
}

// AuditTrail handles GET /api/approvals/{id}/audit
func (h *Handler) AuditTrail(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "approvals.read", h.writer) {
		return
	}

	// Extract approval ID from path: /api/approvals/{id}/audit
	id := extractID(r.URL.Path, "/api/approvals/")
	id = strings.TrimSuffix(id, "/audit")
	if id == "" || len(id) > 128 {
		response.Error(w, http.StatusNotFound, "Approval request not found", "APPROVAL_NOT_FOUND")
		return
	}

	// Check approval existence first
	approval, err := h.repo.GetApproval(r.Context(), id)
	if err != nil {
		response.InternalError(w)
		return
	}
	if approval == nil {
		// Matches Node: special 404 message for audit trail
		response.JSON(w, http.StatusNotFound, map[string]string{
			"error": "Approval request not found",
		})
		return
	}

	// Rate limit: 80/60s per user per approval (matches Node)
	if !h.limiter.Enforce(w, r, "approvals:audit:"+p.Username+":"+id, 80, 60) {
		return
	}

	revealSourceIP := auth.HasPermission(p, "audit.source-ip.read-full")

	logs, err := h.repo.ListAuditLogsForApproval(r.Context(), id, revealSourceIP)
	if err != nil {
		// Matches Node: { error: "Failed to fetch approval audit trail" } — no code field
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to fetch approval audit trail",
		})
		return
	}

	if logs == nil {
		logs = []audit.AuditLogRecord{}
	}

	// Calculate summary
	lifecycle := 0
	execution := 0
	for _, log := range logs {
		if log.TargetID == "approval:"+id {
			lifecycle++
		}
		if hasApprovalID(log, id) {
			execution++
		}
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"approvalId": id,
		"logs":       logs,
		"summary": map[string]int{
			"total":     len(logs),
			"lifecycle": lifecycle,
			"execution": execution,
		},
	})
}

// Decision handles POST /api/approvals/{id}
// Legacy compatibility wrapper. New clients use explicit approve/reject endpoints.
// Matches Node POST handler exactly.
func (h *Handler) Decision(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Parse body
	var body map[string]interface{}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	decision, _ := body["decision"].(string)
	if decision != "approve" && decision != "reject" {
		response.Error(w, http.StatusBadRequest, "INVALID_DECISION", "INVALID_DECISION")
		return
	}

	// Check permission based on decision
	required := "approvals.approve"
	if decision == "reject" {
		required = "approvals.reject"
	}
	if !audit.RequirePermissionWithAudit(w, r, p, required, h.writer) {
		return
	}

	// Rate limit: 40/60s per user (matches Node legacy-review rate)
	if !h.limiter.Enforce(w, r, "approvals:legacy-review:"+p.Username, 40, 60) {
		return
	}

	id := extractID(r.URL.Path, "/api/approvals/")
	if id == "" || len(id) > 128 {
		response.Error(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND")
		return
	}

	var approval *ApprovalDocument
	var err error

	if decision == "approve" {
		approval, err = h.workflow.ApproveChange(r, id, p, body)
	} else {
		approval, err = h.workflow.RejectChange(r, id, p, body)
	}

	if err != nil {
		status, errResp := WorkflowErrorResponse(err)
		response.JSON(w, status, errResp)
		return
	}

	message := "Approval recorded; execution has not started"
	if decision == "reject" {
		message = "Approval rejected"
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"message":  message,
		"approval": approval,
	})
}

// hasApprovalID checks if an audit record has approvalId matching the given ID
// in oldData or newData.
func hasApprovalID(log audit.AuditLogRecord, id string) bool {
	if oldData, ok := log.OldData.(map[string]interface{}); ok {
		if aid, ok := oldData["approvalId"].(string); ok && aid == id {
			return true
		}
	}
	if newData, ok := log.NewData.(map[string]interface{}); ok {
		if aid, ok := newData["approvalId"].(string); ok && aid == id {
			return true
		}
	}
	return false
}

// extractID extracts the ID from a URL path given a prefix.
func extractID(path, prefix string) string {
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(path, prefix)
	// Take everything before the next slash (or all of it)
	if idx := strings.Index(rest, "/"); idx >= 0 {
		return rest[:idx]
	}
	return rest
}

// boundedInt parses a string as an integer clamped to [1, max].
// Matches Node boundedInt() exactly: Number(value), safe integer, clamp [1,max].
// Handles whitespace, leading "+", scientific notation, hex/octal/binary prefixes,
// NaN, Infinity, and unsafe integers — matching JavaScript Number() semantics.
func boundedInt(value string, fallback, maxVal int) int {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}

	// Handle explicit non-numeric values
	lower := strings.ToLower(value)
	if lower == "nan" || lower == "infinity" || lower == "+infinity" || lower == "-infinity" {
		return fallback
	}

	// Strip leading "+" (JavaScript Number("+2") === 2)
	if len(value) > 1 && value[0] == '+' {
		value = value[1:]
	}

	// Try integer parse first (fast path)
	if n, err := strconv.Atoi(value); err == nil {
		return clampBoundedInt(n, maxVal)
	}

	// Try float parse for scientific notation (e.g., "2e2" → 200)
	if f, err := strconv.ParseFloat(value, 64); err == nil {
		// JavaScript Number.isSafeInteger check
		if f >= -9007199254740991 && f <= 9007199254740991 && f == float64(int(f)) {
			return clampBoundedInt(int(f), maxVal)
		}
		return maxVal
	}

	return fallback
}

func clampBoundedInt(n, maxVal int) int {
	if n < 1 {
		return 1
	}
	if n > maxVal {
		return maxVal
	}
	return n
}

// dateParam parses a date string. Accepts YYYY-MM-DD or parseable datetime.
// For endOfDay, converts end date to 23:59:59.999.
// Matches Node dateParam() — new Date() semantics for datetime parsing.
// Output uses .000Z millisecond UTC format for Mongo lexicographic comparison.
func dateParam(value string, endOfDay bool) (*time.Time, bool) {
	if value == "" {
		return nil, true
	}

	var t time.Time
	var err error

	// Check YYYY-MM-DD format
	if len(value) == 10 && value[4] == '-' && value[7] == '-' {
		suffix := "T00:00:00.000"
		if endOfDay {
			suffix = "T23:59:59.999"
		}
		t, err = time.Parse("2006-01-02T15:04:05.000", value+suffix)
	} else {
		// Try formats in order of specificity, matching Node new Date() flexibility.
		// .000Z is the canonical storage format (millisecond UTC).
		formats := []string{
			time.RFC3339Nano,
			time.RFC3339,
			"2006-01-02T15:04:05.000Z",
			"2006-01-02T15:04:05.000",
			"2006-01-02T15:04:05",
		}
		for _, format := range formats {
			t, err = time.Parse(format, value)
			if err == nil {
				break
			}
		}
	}

	if err != nil {
		return nil, false
	}
	return &t, true
}

// truncate trims and truncates a string to maxLen.
func truncate(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	if len(s) > maxLen {
		return s[:maxLen]
	}
	return s
}

// firstNonEmpty returns the first non-empty string.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
