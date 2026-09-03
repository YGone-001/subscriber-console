package approval

import (
	"encoding/json"
	"math"
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
	// pageSize || limit semantics: pageSize non-empty → pageSize, pageSize empty → limit, both absent → fallback
	// params.Has() distinguishes absent (no key) from present-but-empty (key exists with "")
	pageSizeVal, pageSizePresent := paramOrElse(params, "pageSize", "limit")

	q := ListQuery{
		Page:         boundedIntWithAbsent(params.Get("page"), !params.Has("page"), 1, 100000),
		PageSize:     boundedIntWithAbsent(pageSizeVal, !pageSizePresent, 20, 100),
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

// Approve handles POST /api/approvals/{id}/approve
// Thin HTTP adapter: permission → rate limit → parse body → workflow → response.
// Canonical field: comment. No legacy "note" fallback for explicit routes.
func (h *Handler) Approve(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "approvals.approve", h.writer) {
		return
	}

	if !h.limiter.Enforce(w, r, "approvals:approve:"+p.Username, 40, 60) {
		return
	}

	id := extractID(r.URL.Path, "/api/approvals/")
	id = strings.TrimSuffix(id, "/approve")
	if id == "" || len(id) > 128 {
		response.Error(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND")
		return
	}

	// Parse body — malformed JSON → {}
	var body map[string]interface{}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	// Canonical field only: comment. No note fallback for explicit routes.
	comment := toOptionalString(extractField(body, "comment"))

	approval, err := h.workflow.ApproveChange(r, id, p, comment)
	if err != nil {
		status, errResp := WorkflowErrorResponse(err)
		response.JSON(w, status, errResp)
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"message":  "Approval recorded; execution has not started",
		"approval": approval,
	})
}

// Reject handles POST /api/approvals/{id}/reject
// Thin HTTP adapter: permission → rate limit → parse body → workflow → response.
// Canonical field: reason. No legacy "note" fallback for explicit routes.
func (h *Handler) Reject(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "approvals.reject", h.writer) {
		return
	}

	if !h.limiter.Enforce(w, r, "approvals:reject:"+p.Username, 40, 60) {
		return
	}

	id := extractID(r.URL.Path, "/api/approvals/")
	id = strings.TrimSuffix(id, "/reject")
	if id == "" || len(id) > 128 {
		response.Error(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND")
		return
	}

	// Parse body — malformed JSON → {}
	var body map[string]interface{}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	// Canonical field only: reason. No note fallback for explicit routes.
	reason := toOptionalString(extractField(body, "reason"))

	approval, err := h.workflow.RejectChange(r, id, p, reason)
	if err != nil {
		status, errResp := WorkflowErrorResponse(err)
		response.JSON(w, status, errResp)
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"message":  "Approval rejected",
		"approval": approval,
	})
}

// Cancel handles POST /api/approvals/{id}/cancel
// Thin HTTP adapter: permission → rate limit → parse body → workflow → response.
// Canonical field: reason (optional). No legacy "note" fallback for explicit routes.
func (h *Handler) Cancel(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "approvals.cancel", h.writer) {
		return
	}

	if !h.limiter.Enforce(w, r, "approvals:cancel:"+p.Username, 40, 60) {
		return
	}

	id := extractID(r.URL.Path, "/api/approvals/")
	id = strings.TrimSuffix(id, "/cancel")
	if id == "" || len(id) > 128 {
		response.Error(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "APPROVAL_NOT_FOUND")
		return
	}

	// Parse body — malformed JSON → {}
	var body map[string]interface{}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}

	// Canonical field only: reason (optional). No note fallback for explicit routes.
	reason := toOptionalString(extractField(body, "reason"))

	approval, err := h.workflow.CancelChange(r, id, p, reason)
	if err != nil {
		status, errResp := WorkflowErrorResponse(err)
		response.JSON(w, status, errResp)
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"message":  "Approval cancelled",
		"approval": approval,
	})
}

// extractField extracts a single field from a body map.
// Returns nil if body is nil or field is missing.
// Unlike extractNullish, does NOT fall back to a secondary field.
func extractField(body map[string]interface{}, key string) interface{} {
	if body == nil {
		return nil
	}
	if val, ok := body[key]; ok {
		return val
	}
	return nil
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
		// Node: approveChange(request, id, auth, { comment: body.comment ?? body.note })
		// Nullish semantics: comment missing/null → note, comment "" → ""
		comment := toOptionalString(extractNullish(body, "comment", "note"))
		approval, err = h.workflow.ApproveChange(r, id, p, comment)
	} else {
		// Node: rejectChange(request, id, auth, { reason: body.reason ?? body.note })
		reason := toOptionalString(extractNullish(body, "reason", "note"))
		approval, err = h.workflow.RejectChange(r, id, p, reason)
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
// Matches Node boundedInt() exactly:
//
//	const number = Number(value ?? fallback);
//	return Number.isSafeInteger(number) ? Math.min(Math.max(number, 1), max) : fallback;
//
// Handles whitespace, leading "+", scientific notation, hex/octal/binary prefixes,
// NaN, Infinity, and unsafe integers — matching JavaScript Number() semantics.
func boundedInt(value string, fallback, maxVal int) int {
	// Trim whitespace (Number(" 2 ") === 2)
	value = strings.TrimSpace(value)

	// Empty string: Number("") === 0, then clamp → 1
	if value == "" {
		return 1
	}

	return parseBoundedNumber(value, fallback, maxVal)
}

// boundedIntWithAbsent handles the case where the caller knows whether
// the parameter was actually present in the URL.
// When absent is true, returns fallback directly (matching Number(undefined ?? fallback) = fallback).
// When absent is false, applies Number() semantics via boundedInt.
func boundedIntWithAbsent(value string, absent bool, fallback, maxVal int) int {
	if absent {
		return fallback
	}
	return boundedInt(value, fallback, maxVal)
}

// parseBoundedNumber applies JavaScript Number() + isSafeInteger + clamp semantics.
func parseBoundedNumber(value string, fallback, maxVal int) int {
	// Explicit non-numeric: NaN, Infinity, etc. → fallback
	lower := strings.ToLower(value)
	if lower == "nan" || lower == "infinity" || lower == "+infinity" || lower == "-infinity" {
		return fallback
	}

	// Try integer parse (handles "+2", "-1", "42", etc.)
	if n, err := strconv.ParseInt(value, 10, 64); err == nil {
		// JavaScript Number.isSafeInteger check: must be within ±(2^53 - 1)
		if n >= -9007199254740991 && n <= 9007199254740991 {
			return clampBoundedInt(int(n), maxVal)
		}
		return fallback
	}

	// Try hex: 0x10 → 16
	if len(value) > 2 && (value[:2] == "0x" || value[:2] == "0X") {
		if n, err := strconv.ParseInt(value[2:], 16, 64); err == nil {
			return clampBoundedInt(int(n), maxVal)
		}
		return fallback
	}

	// Try octal: 0o10 → 8
	if len(value) > 2 && (value[:2] == "0o" || value[:2] == "0O") {
		if n, err := strconv.ParseInt(value[2:], 8, 64); err == nil {
			return clampBoundedInt(int(n), maxVal)
		}
		return fallback
	}

	// Try binary: 0b10 → 2
	if len(value) > 2 && (value[:2] == "0b" || value[:2] == "0B") {
		if n, err := strconv.ParseInt(value[2:], 2, 64); err == nil {
			return clampBoundedInt(int(n), maxVal)
		}
		return fallback
	}

	// Try float parse for scientific notation (e.g., "2e2" → 200, "1.5" → 1.5)
	if f, err := strconv.ParseFloat(value, 64); err == nil {
		// JavaScript Number.isSafeInteger check
		if !math.IsInf(f, 0) && f >= -9007199254740991 && f <= 9007199254740991 && f == math.Trunc(f) {
			return clampBoundedInt(int(f), maxVal)
		}
		// Not a safe integer (fractional, too large, ±Inf) → fallback
		return fallback
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

// paramOrElse implements the Node `params.get(primary) || params.get(secondary)` semantics.
// JavaScript `||` treats empty string as falsy, so an explicitly empty primary
// value falls through to the secondary key (unlike `??` which only treats null/undefined).
//
// Returns the selected value and whether any non-empty parameter was found.
// When both are empty or absent, returns ("", false).
func paramOrElse(params map[string][]string, primary, secondary string) (string, bool) {
	if vs, ok := params[primary]; ok && len(vs) > 0 && vs[0] != "" {
		return vs[0], true
	}
	if vs, ok := params[secondary]; ok && len(vs) > 0 && vs[0] != "" {
		return vs[0], true
	}
	return "", false
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

// extractNullish implements JavaScript nullish coalescing (??) for body fields.
// Returns the value of the primary key if present and not nil,
// otherwise falls back to the secondary key, then to nil.
//
// Matches Node: body.comment ?? body.note
//
// Examples:
//
//	{comment: "hello"} → "hello"
//	{comment: null} → note value
//	{comment: ""} → "" (empty string is NOT nullish)
//	{comment: 0} → 0
//	{comment: false} → false
//	{} → note value
func extractNullish(body map[string]interface{}, primary, secondary string) interface{} {
	if body == nil {
		return nil
	}
	if val, ok := body[primary]; ok && val != nil {
		return val
	}
	if val, ok := body[secondary]; ok && val != nil {
		return val
	}
	return nil
}

// toOptionalString converts an interface{} to a string.
// Non-string values (including nil) return empty string.
// Then cleanOptionalText handles validation and trimming.
func toOptionalString(val interface{}) string {
	if val == nil {
		return ""
	}
	if s, ok := val.(string); ok {
		return s
	}
	// Non-string values (number, bool, etc.) → empty string
	// Matches Node cleanOptionalText which does typeof value === 'string' check
	return ""
}
