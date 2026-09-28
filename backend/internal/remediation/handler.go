package remediation

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

var imsiRegex = regexp.MustCompile(`^\d{15}$|^UNKNOWN$`)

// Handler handles HTTP requests for system self-healing endpoints.
type Handler struct {
	repo        *Repository
	limiter     *ratelimit.Limiter
	auditWriter *audit.Writer
}

// NewHandler creates a new remediation Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter, auditWriter *audit.Writer) *Handler {
	return &Handler{
		repo:        repo,
		limiter:     limiter,
		auditWriter: auditWriter,
	}
}

// RegisterRoutes registers controlled remediation shadow routes onto the mux.
func RegisterRoutes(mux *http.ServeMux, authMiddleware func(http.Handler) http.Handler, h *Handler) {
	mux.Handle("POST /api/system/audit/heal", authMiddleware(http.HandlerFunc(h.Heal)))
	mux.Handle("POST /api/system/audit/batch-heal", authMiddleware(http.HandlerFunc(h.BatchHeal)))
}

// Heal handles POST /api/system/audit/heal.
// Applies targeted self-healing for an individual subscriber.
func (h *Handler) Heal(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "system_heal", h.auditWriter) {
		return
	}

	// Rate limit: 20 req / 60s per user (system:audit-heal:<user>)
	if h.limiter != nil && !h.limiter.EnforceNodeParity(w, r, "system:audit-heal:"+p.Username, 20, 60) {
		return
	}

	var raw any
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Self-healing execution failed",
		})
		return
	}

	body, ok := raw.(map[string]any)
	if !ok || raw == nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Self-healing execution failed",
		})
		return
	}

	rawImsi := body["imsi"]
	rawType := body["type"]
	rawProfile := body["profileName"]

	if !isJSTruthy(rawImsi) || !isJSTruthy(rawType) {
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "imsi and type are required",
		})
		return
	}

	imsiStr := formatJSString(rawImsi)
	if !imsiRegex.MatchString(imsiStr) {
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "IMSI must be exactly 15 digits or UNKNOWN",
		})
		return
	}

	var profileName *string
	if isJSTruthy(rawProfile) {
		s := formatJSString(rawProfile)
		profileName = &s
	}

	typeStr := formatJSString(rawType)
	err := h.repo.HealSubscriberDocument(r.Context(), imsiStr, typeStr, profileName)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Self-healing execution failed",
		})
		return
	}

	h.writeAudit(r, p, audit.WriteAuditInput{
		Module:   "system",
		Action:   "HEAL",
		Level:    "warning",
		TargetID: imsiStr,
		Resource: &audit.ResourceInput{
			Type: "system",
			ID:   imsiStr,
		},
		Result: "success",
		After: map[string]any{
			"type":        rawType,
			"profileName": rawProfile,
		},
	})

	response.JSON(w, http.StatusOK, HealResponse{
		Message: "Successfully applied targeted self-healing for " + imsiStr,
	})
}

// BatchHeal handles POST /api/system/audit/batch-heal.
// Applies targeted self-healing sequentially across multiple anomalies.
func (h *Handler) BatchHeal(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "system_heal", h.auditWriter) {
		return
	}

	// Rate limit: 10 req / 60s per user (system:audit-batch-heal:<user>)
	if h.limiter != nil && !h.limiter.EnforceNodeParity(w, r, "system:audit-batch-heal:"+p.Username, 10, 60) {
		return
	}

	var raw any
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Batch self-healing execution failed",
		})
		return
	}

	body, ok := raw.(map[string]any)
	if !ok || raw == nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Batch self-healing execution failed",
		})
		return
	}

	rawAnomalies, hasAnomalies := body["anomalies"]
	anomalies, isSlice := rawAnomalies.([]any)
	if !hasAnomalies || !isSlice || len(anomalies) == 0 {
		response.JSON(w, http.StatusBadRequest, map[string]string{
			"error": "anomalies list is required and cannot be empty",
		})
		return
	}

	rawProfile := body["profileName"]
	var profileName *string
	if isJSTruthy(rawProfile) {
		s := formatJSString(rawProfile)
		profileName = &s
	}

	result, err := h.repo.BatchHealSubscriberDocuments(r.Context(), anomalies, profileName)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Batch self-healing execution failed",
		})
		return
	}

	h.writeAudit(r, p, audit.WriteAuditInput{
		Module:   "system",
		Action:   "HEAL",
		Level:    "warning",
		TargetID: fmt.Sprintf("batch:%d", len(anomalies)),
		Resource: &audit.ResourceInput{
			Type: "system",
			ID:   fmt.Sprintf("batch:%d", len(anomalies)),
		},
		Result: "success",
		After: map[string]any{
			"count":       len(anomalies),
			"result":      result,
			"profileName": rawProfile,
		},
	})

	response.JSON(w, http.StatusOK, result)
}

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
	h.auditWriter.WriteBestEffort(input)
}

func isJSTruthy(val any) bool {
	if val == nil {
		return false
	}
	switch v := val.(type) {
	case string:
		return v != ""
	case bool:
		return v
	case int:
		return v != 0
	case int32:
		return v != 0
	case int64:
		return v != 0
	case float64:
		return v != 0
	default:
		return true
	}
}

func formatJSString(val any) string {
	if val == nil {
		return ""
	}
	switch v := val.(type) {
	case float64:
		// Integers formatted without trailing .0
		if v == float64(int64(v)) {
			return fmt.Sprintf("%d", int64(v))
		}
		return fmt.Sprintf("%g", v)
	default:
		return fmt.Sprint(v)
	}
}
