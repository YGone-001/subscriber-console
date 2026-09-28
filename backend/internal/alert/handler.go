package alert

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"unicode/utf8"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

const (
	maxAckIDs     = 200
	maxTextLength = 80
)

// Handler handles HTTP requests for alert endpoints.
type Handler struct {
	repo        *Repository
	limiter     *ratelimit.Limiter
	auditWriter *audit.Writer
}

// NewHandler creates a new alert Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// NewHandlerWithAudit creates an alert Handler with audit writer support.
func NewHandlerWithAudit(repo *Repository, limiter *ratelimit.Limiter, auditWriter *audit.Writer) *Handler {
	return &Handler{repo: repo, limiter: limiter, auditWriter: auditWriter}
}

// List handles GET /api/alerts.
// Accessible by admin, operator, and viewer roles.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Rate limit: 120 req / 60s per user (alerts:list:<user>)
	if h.limiter != nil && !h.limiter.Enforce(w, r, "alerts:list:"+p.Username, 120, 60) {
		return
	}

	res, err := h.repo.ListAlerts(r.Context(), 101)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Alert fetch failed",
		})
		return
	}

	response.JSON(w, http.StatusOK, res)
}

// Acknowledge handles POST /api/alerts/acknowledge.
// Accessible by admin and operator roles (Node: ['root', 'operator']).
func (h *Handler) Acknowledge(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if p.NormalizedRole != "admin" && p.NormalizedRole != "operator" {
		if h.auditWriter != nil {
			audit.RecordPermissionDenied(h.auditWriter, r, p, audit.DenialMetadata{})
		}
		response.Error(w, http.StatusForbidden, "Forbidden: Insufficient permissions", "PERMISSION_DENIED")
		return
	}

	// Rate limit: 60 req / 60s per user (alerts:acknowledge:<user>)
	if h.limiter != nil && !h.limiter.Enforce(w, r, "alerts:acknowledge:"+p.Username, 60, 60) {
		return
	}

	var raw any
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to acknowledge alert",
		})
		return
	}

	body, ok := raw.(map[string]any)
	if !ok {
		if raw == nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{
				"error": "Failed to acknowledge alert",
			})
			return
		}
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "Alert ID(s) required",
		})
		return
	}

	var rawIds []any
	if idsVal, exists := body["ids"]; exists {
		if idsArr, isArr := idsVal.([]any); isArr {
			rawIds = idsArr
		} else {
			rawIds = []any{body["id"]}
		}
	} else {
		rawIds = []any{body["id"]}
	}

	seen := make(map[string]struct{})
	alertIds := make([]string, 0, len(rawIds))
	for _, item := range rawIds {
		str, isStr := item.(string)
		if !isStr {
			continue
		}
		trimmed := jsTrimSpace(str)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; !exists {
			seen[trimmed] = struct{}{}
			alertIds = append(alertIds, trimmed)
		}
	}

	if len(alertIds) == 0 {
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "Alert ID(s) required",
		})
		return
	}

	if len(alertIds) > maxAckIDs {
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("At most %d alerts can be acknowledged at once", maxAckIDs),
		})
		return
	}

	acknowledged, err := h.repo.AcknowledgeAlerts(r.Context(), alertIds)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to acknowledge alert",
		})
		return
	}

	targetID := "batch:" + strconv.Itoa(len(alertIds))
	if len(alertIds) == 1 {
		targetID = alertIds[0]
	}
	h.writeAudit(r, p, audit.WriteAuditInput{
		Module:   "alerts",
		Action:   "alert.acknowledge",
		TargetID: targetID,
		Resource: &audit.ResourceInput{
			Type: "alert",
			ID:   targetID,
		},
		Result: "success",
		Metadata: map[string]any{
			"requested":    len(alertIds),
			"acknowledged": acknowledged,
			"skipped":      int64(len(alertIds)) - acknowledged,
			"ids":          alertIds,
		},
	})

	response.JSON(w, http.StatusOK, AcknowledgeResponse{
		Success:      true,
		Acknowledged: acknowledged,
		Requested:    len(alertIds),
		Skipped:      int64(len(alertIds)) - acknowledged,
	})
}

// Workflow handles POST /api/alerts/workflow.
// Accessible by admin and operator roles (Node: ['root', 'operator']).
func (h *Handler) Workflow(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if p.NormalizedRole != "admin" && p.NormalizedRole != "operator" {
		if h.auditWriter != nil {
			audit.RecordPermissionDenied(h.auditWriter, r, p, audit.DenialMetadata{})
		}
		response.Error(w, http.StatusForbidden, "Forbidden: Insufficient permissions", "PERMISSION_DENIED")
		return
	}

	// Rate limit: 120 req / 60s per user (alerts:workflow:<user>)
	if h.limiter != nil && !h.limiter.Enforce(w, r, "alerts:workflow:"+p.Username, 120, 60) {
		return
	}

	var raw any
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to update alert workflow",
		})
		return
	}

	body, ok := raw.(map[string]any)
	if !ok {
		if raw == nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{
				"error": "Failed to update alert workflow",
			})
			return
		}
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "Alert ID required",
		})
		return
	}

	idPtr := cleanText(body["id"])
	statusStr, _ := body["status"].(string)

	if idPtr == nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "Alert ID required",
		})
		return
	}

	if !isValidWorkflowStatus(statusStr) {
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "Invalid alert workflow status",
		})
		return
	}

	id := *idPtr
	assignedTo := cleanText(body["assignedTo"])
	note := cleanText(body["note"])

	result, err := h.repo.UpdateWorkflow(r.Context(), id, AlertWorkflowUpdate{
		Status:     statusStr,
		AssignedTo: assignedTo,
		Note:       note,
	})
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to update alert workflow",
		})
		return
	}

	if result.Matched == 0 {
		response.JSON(w, http.StatusNotFound, map[string]string{
			"error": "Alert not found",
		})
		return
	}

	meta := map[string]any{
		"workflowStatus": statusStr,
		"matched":        result.Matched,
		"modified":       result.Modified,
	}
	if assignedTo != nil {
		meta["assignedTo"] = *assignedTo
	}
	if note != nil {
		meta["note"] = *note
	}

	h.writeAudit(r, p, audit.WriteAuditInput{
		Module:   "alerts",
		Action:   "alert.workflow",
		TargetID: id,
		Resource: &audit.ResourceInput{
			Type: "alert",
			ID:   id,
		},
		Result:   "success",
		Metadata: meta,
	})

	response.JSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"matched":  result.Matched,
		"modified": result.Modified,
	})
}

// -- Helpers ----------------------------------------------------------------

func (h *Handler) writeAudit(r *http.Request, p *auth.Principal, input audit.WriteAuditInput) {
	if h.auditWriter == nil {
		return
	}
	source, reqInfo, reason := audit.AuditRequestContext(r)
	input.Actor = audit.ActorInput{
		Type:     "user",
		Username: p.Username,
		Role:     p.Role,
	}
	input.Source = source
	input.Request = reqInfo
	if input.Reason == "" {
		input.Reason = reason
	}
	// Direct Execution governance: operation logging is best-effort. An audit
	// persistence failure must not roll back the committed business mutation nor
	// alter the success response the caller already earned.
	h.auditWriter.WriteBestEffort(input)
}

// cleanText mirrors the Node route cleaner: reject non-strings, apply the
// ECMAScript String.prototype.trim() character set, then truncate to
// maxTextLength UTF-16 code units exactly as String.prototype.slice does.
func cleanText(val any) *string {
	str, ok := val.(string)
	if !ok {
		return nil
	}
	trimmed := jsTrimSpace(str)
	if trimmed == "" {
		return nil
	}
	trimmed = truncateUTF16(trimmed, maxTextLength)
	return &trimmed
}

// truncateUTF16 truncates s to at most maxUnits UTF-16 code units, matching
// JavaScript String.prototype.slice(0, maxUnits) semantics. JavaScript indexes
// by UTF-16 code unit, so a supplementary code point counts as two units.
//
// When maxUnits lands inside a surrogate pair, String.prototype.slice returns a
// lone high surrogate. That code unit has no UTF-8 encoding, and the Node
// MongoDB driver stores U+FFFD for it when writing a BSON string. Emitting
// U+FFFD here keeps Go's HTTP and MongoDB strings byte-identical to Node's
// observable result while remaining valid UTF-8.
func truncateUTF16(s string, maxUnits int) string {
	if maxUnits <= 0 {
		return ""
	}
	units := 0
	for i, r := range s {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width <= maxUnits {
			units += width
			continue
		}
		if width == 2 && units == maxUnits-1 {
			return s[:i] + string(rune(0xFFFD))
		}
		return s[:i]
	}
	return s
}

// jsTrimSpace trims the ECMAScript WhiteSpace + LineTerminator set consumed by
// String.prototype.trim. It deliberately does not use strings.TrimSpace: Go also
// trims U+0085 and leaves U+FEFF in place, both of which diverge from Node.
func jsTrimSpace(s string) string {
	start := 0
	for start < len(s) {
		r, size := utf8.DecodeRuneInString(s[start:])
		if !isJSTrimSpace(r) {
			break
		}
		start += size
	}
	end := len(s)
	for end > start {
		r, size := utf8.DecodeLastRuneInString(s[:end])
		if !isJSTrimSpace(r) {
			break
		}
		end -= size
	}
	return s[start:end]
}

func isJSTrimSpace(r rune) bool {
	switch r {
	case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D,
		0x0020, 0x00A0, 0x1680,
		0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
		0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func isValidWorkflowStatus(s string) bool {
	switch s {
	case string(WorkflowStatusAcknowledged),
		string(WorkflowStatusAssigned),
		string(WorkflowStatusRecovering),
		string(WorkflowStatusResolved):
		return true
	default:
		return false
	}
}
