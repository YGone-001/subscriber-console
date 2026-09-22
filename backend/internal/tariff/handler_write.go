package tariff

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
	"subscriber/internal/user"
)

var planIDRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,80}$`)

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// WriteHandler provides HTTP handlers for tariff plan write endpoints.
type WriteHandler struct {
	repo        *Repository
	limiter     RateLimiter
	userRepo    UserRepository
	auditWriter *audit.Writer
}

// RateLimiter abstracts rate limiting for handler testing.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// NewWriteHandler creates a new tariff write handler.
func NewWriteHandler(repo *Repository, limiter RateLimiter, userRepo UserRepository, auditWriter *audit.Writer) *WriteHandler {
	return &WriteHandler{
		repo:        repo,
		limiter:     limiter,
		userRepo:    userRepo,
		auditWriter: auditWriter,
	}
}

// ── Request bodies ─────────────────────────────────────────────────────────

type createPlanBody struct {
	PlanID          string `json:"plan_id"`
	Name            string `json:"name"`
	Description     string `json:"description"`
	Status          string `json:"status"`
	QuotaPerGrant   *int64 `json:"quota_per_grant"`
	ValidityTime    *int   `json:"validity_time"`
	VolumeThreshold *int64 `json:"volume_threshold"`
	Rules           []any  `json:"rules"`
	CloneFromPlanID string `json:"cloneFromPlanId"`
}

type updatePlanBody struct {
	Name            *string `json:"name"`
	Description     *string `json:"description"`
	Status          *string `json:"status"`
	QuotaPerGrant   *int64  `json:"quota_per_grant"`
	ValidityTime    *int    `json:"validity_time"`
	VolumeThreshold *int64  `json:"volume_threshold"`
	Rules           []any   `json:"rules"`
}

type clonePlanBody struct {
	TargetPlanID string `json:"targetPlanId"`
	TargetPlanId string `json:"target_plan_id"`
	NewPlanId    string `json:"newPlanId"`
	PlanID       string `json:"plan_id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
}

// ── Create ─────────────────────────────────────────────────────────────────

// Create handles POST /api/tariff-plans
// Creates a tariff plan with governance: super_admin/root → DIRECT, operator → APPROVAL.
func (h *WriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.tariff.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "tariff-plans:create:"+p.Username, 20, 60) {
		return
	}

	var body createPlanBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	planID := strings.TrimSpace(body.PlanID)
	if !planIDRegex.MatchString(planID) {
		response.Error(w, http.StatusBadRequest, "Invalid plan_id format", "INVALID_PLAN_ID")
		return
	}

	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateOperation(OpCreate, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// Build plan document
	doc := bson.M{
		"plan_id":          planID,
		"name":             nonEmpty(body.Name, planID),
		"description":      body.Description,
		"status":           nonEmpty(body.Status, "active"),
		"quota_per_grant":  int64OrDefault(body.QuotaPerGrant, 1073741824),
		"validity_time":    intOrDefault(body.ValidityTime, 86400),
		"volume_threshold": int64OrDefault(body.VolumeThreshold, 1048576),
		"rules":            body.Rules,
	}

	// Direct execution (Phase 5.7-A)
	if err := h.repo.CreatePlan(r.Context(), doc); err != nil {
		if err.Error() == "TARIFF_PLAN_EXISTS" {
			response.Error(w, http.StatusConflict, "Tariff plan already exists", "TARIFF_PLAN_EXISTS")
			return
		}
		response.InternalError(w)
		return
	}

	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "CREATE",
		Module:   "tariff-plans",
		TargetID: fmt.Sprintf("tariff-plan:%s", planID),
		After:    doc,
		Result:   "success",
		Metadata: map[string]interface{}{
			"operation": string(OpCreate),
			"actorRole": fresh.NormalizedRole,
		},
	}, fresh)

	response.JSON(w, http.StatusCreated, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"plan_id": planID,
	})
}

// ── Update ─────────────────────────────────────────────────────────────────

// Update handles PUT /api/tariff-plans/{planId}
func (h *WriteHandler) Update(w http.ResponseWriter, r *http.Request) {
	planID := r.PathValue("planId")
	if planID == "" {
		response.Error(w, http.StatusBadRequest, "planId is required", "MISSING_PLAN_ID")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.tariff.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "tariff-plans:update:"+p.Username, 30, 60) {
		return
	}

	var body updatePlanBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateOperation(OpUpdate, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// Get before snapshot
	before, err := h.repo.GetPlanRaw(r.Context(), planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if before == nil {
		response.Error(w, http.StatusNotFound, "Tariff plan not found", "NOT_FOUND")
		return
	}

	// Build updated document from before + changes
	after := copyBsonM(before)
	if body.Name != nil {
		after["name"] = *body.Name
	}
	if body.Description != nil {
		after["description"] = *body.Description
	}
	if body.Status != nil {
		nextStatus := *body.Status
		// Block disable if plan has subscribers
		if before["status"] != nextStatus && nextStatus == "disabled" {
			count, _ := h.repo.CountSubscribersByPlan(r.Context(), planID)
			if count > 0 {
				response.Error(w, http.StatusConflict, "Cannot disable: tariff plan is currently used by subscribers", "TARIFF_PLAN_DISABLE_IN_USE")
				return
			}
		}
		after["status"] = nextStatus
	}
	if body.QuotaPerGrant != nil {
		after["quota_per_grant"] = *body.QuotaPerGrant
	}
	if body.ValidityTime != nil {
		after["validity_time"] = *body.ValidityTime
	}
	if body.VolumeThreshold != nil {
		after["volume_threshold"] = *body.VolumeThreshold
	}
	if body.Rules != nil {
		after["rules"] = body.Rules
	}

	// Direct execution (Phase 5.7-A)
	if err := h.repo.UpdatePlan(r.Context(), planID, after); err != nil {
		if err.Error() == "TARIFF_PLAN_NOT_FOUND" {
			response.Error(w, http.StatusNotFound, "Tariff plan not found", "NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "UPDATE",
		Module:   "tariff-plans",
		TargetID: fmt.Sprintf("tariff-plan:%s", planID),
		Before:   before,
		After:    after,
		Result:   "success",
		Metadata: map[string]interface{}{
			"operation": string(OpUpdate),
			"actorRole": fresh.NormalizedRole,
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"plan_id": planID,
	})
}

// ── Delete ─────────────────────────────────────────────────────────────────

// Delete handles DELETE /api/tariff-plans/{planId}
func (h *WriteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	planID := r.PathValue("planId")
	if planID == "" {
		response.Error(w, http.StatusBadRequest, "planId is required", "MISSING_PLAN_ID")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.tariff.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "tariff-plans:delete:"+p.Username, 20, 60) {
		return
	}

	if planID == defaultPlanID {
		response.Error(w, http.StatusConflict, "Default tariff plan cannot be deleted", "DEFAULT_TARIFF_PLAN_PROTECTED")
		return
	}

	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateOperation(OpDelete, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	before, err := h.repo.GetPlanRaw(r.Context(), planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if before == nil {
		response.Error(w, http.StatusNotFound, "Tariff plan not found", "NOT_FOUND")
		return
	}

	// Direct execution (Phase 5.7-A)
	if err := h.repo.DeletePlan(r.Context(), planID); err != nil {
		if err.Error() == "DEFAULT_TARIFF_PLAN_PROTECTED" {
			response.Error(w, http.StatusConflict, "Default tariff plan cannot be deleted", "DEFAULT_TARIFF_PLAN_PROTECTED")
			return
		}
		if err.Error() == "TARIFF_PLAN_NOT_FOUND" {
			response.Error(w, http.StatusNotFound, "Tariff plan not found", "NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "DELETE",
		Module:   "tariff-plans",
		TargetID: fmt.Sprintf("tariff-plan:%s", planID),
		Before:   before,
		Result:   "success",
		Metadata: map[string]interface{}{
			"operation": string(OpDelete),
			"actorRole": fresh.NormalizedRole,
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"plan_id": planID,
	})
}

// ── Clone ──────────────────────────────────────────────────────────────────

// Clone handles POST /api/tariff-plans/{planId}/clone
func (h *WriteHandler) Clone(w http.ResponseWriter, r *http.Request) {
	sourcePlanID := r.PathValue("planId")
	if sourcePlanID == "" {
		response.Error(w, http.StatusBadRequest, "planId is required", "MISSING_PLAN_ID")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.tariff.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "tariff-plans:clone:"+p.Username, 20, 60) {
		return
	}

	var body clonePlanBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	// Resolve target plan_id from multiple field names (matches Node)
	targetPlanID := strings.TrimSpace(firstNonEmpty(body.TargetPlanID, body.TargetPlanId, body.NewPlanId, body.PlanID))
	if !planIDRegex.MatchString(targetPlanID) {
		response.Error(w, http.StatusBadRequest, "Invalid target plan_id format", "INVALID_PLAN_ID")
		return
	}

	// Get source plan
	sourcePlan, err := h.repo.GetPlanRaw(r.Context(), sourcePlanID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if sourcePlan == nil {
		response.Error(w, http.StatusNotFound, "Source tariff plan not found", "NOT_FOUND")
		return
	}

	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateOperation(OpCreate, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// Build cloned document
	name := body.Name
	if name == "" {
		name = fmt.Sprintf("%s Copy", strField(sourcePlan, "name"))
		if name == " Copy" {
			name = fmt.Sprintf("%s Copy", sourcePlanID)
		}
	}
	description := body.Description
	if description == "" {
		description = strField(sourcePlan, "description")
	}

	// Clone rules from source
	var clonedRules []any
	if rules, ok := sourcePlan["rules"]; ok && rules != nil {
		if arr, ok := rules.(bson.A); ok {
			clonedRules = make([]any, len(arr))
			copy(clonedRules, arr)
		}
	}

	cloned := bson.M{
		"plan_id":          targetPlanID,
		"name":             name,
		"description":      description,
		"status":           "active",
		"quota_per_grant":  sourcePlan["quota_per_grant"],
		"validity_time":    sourcePlan["validity_time"],
		"volume_threshold": sourcePlan["volume_threshold"],
		"rules":            clonedRules,
	}

	// Direct execution (Phase 5.7-A)
	if err := h.repo.CreatePlan(r.Context(), cloned); err != nil {
		if err.Error() == "TARIFF_PLAN_EXISTS" {
			response.Error(w, http.StatusConflict, "Tariff plan already exists", "TARIFF_PLAN_EXISTS")
			return
		}
		response.InternalError(w)
		return
	}

	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "CREATE",
		Module:   "tariff-plans",
		TargetID: fmt.Sprintf("tariff-plan:%s", targetPlanID),
		Before:   map[string]any{"sourcePlan": sourcePlan},
		After:    cloned,
		Result:   "success",
		Metadata: map[string]interface{}{
			"operation":       string(OpCreate),
			"actorRole":       fresh.NormalizedRole,
			"cloneFromPlanId": sourcePlanID,
		},
	}, fresh)

	response.JSON(w, http.StatusCreated, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"plan_id": targetPlanID,
	})
}

// ── Enable / Disable ───────────────────────────────────────────────────────

// Enable handles POST /api/tariff-plans/{planId}/enable
func (h *WriteHandler) Enable(w http.ResponseWriter, r *http.Request) {
	h.setStatus(w, r, "active")
}

// Disable handles POST /api/tariff-plans/{planId}/disable
func (h *WriteHandler) Disable(w http.ResponseWriter, r *http.Request) {
	h.setStatus(w, r, "disabled")
}

func (h *WriteHandler) setStatus(w http.ResponseWriter, r *http.Request, status string) {
	planID := r.PathValue("planId")
	if planID == "" {
		response.Error(w, http.StatusBadRequest, "planId is required", "MISSING_PLAN_ID")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.tariff.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "tariff-plans:status:"+p.Username, 20, 60) {
		return
	}

	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateOperation(OpUpdate, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	before, err := h.repo.GetPlanRaw(r.Context(), planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if before == nil {
		response.Error(w, http.StatusNotFound, "Tariff plan not found", "NOT_FOUND")
		return
	}

	// Block disable if plan has subscribers
	if status == "disabled" {
		count, _ := h.repo.CountSubscribersByPlan(r.Context(), planID)
		if count > 0 {
			response.Error(w, http.StatusConflict, "Cannot disable: tariff plan is currently used by subscribers", "TARIFF_PLAN_DISABLE_IN_USE")
			return
		}
	}

	// No-op if already in target status
	if strField(before, "status") == status {
		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": fmt.Sprintf("Tariff plan already %s", status),
			"plan_id": planID,
		})
		return
	}

	// Direct execution (Phase 5.7-A)
	if err := h.repo.SetPlanStatus(r.Context(), planID, status); err != nil {
		if err.Error() == "TARIFF_PLAN_NOT_FOUND" {
			response.Error(w, http.StatusNotFound, "Tariff plan not found", "NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	after := copyBsonM(before)
	after["status"] = status

	action := "UPDATE"
	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   action,
		Module:   "tariff-plans",
		TargetID: fmt.Sprintf("tariff-plan:%s", planID),
		Before:   before,
		After:    after,
		Result:   "success",
		Metadata: map[string]interface{}{
			"operation":    string(OpUpdate),
			"actorRole":    fresh.NormalizedRole,
			"statusChange": status,
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"plan_id": planID,
	})
}

// ── Helpers ────────────────────────────────────────────────────────────────

func (h *WriteHandler) writeStrictAudit(r *http.Request, input audit.WriteAuditInput, actor *FreshActor) {
	source, request, reason := audit.AuditRequestContext(r)
	input.Actor = audit.ActorInput{
		Type:     "user",
		UserID:   actor.UserID,
		Username: actor.Username,
		Role:     actor.RawRole,
	}
	input.Source = source
	input.Request = request
	if input.Reason == "" {
		input.Reason = reason
	}
	_ = h.auditWriter.WriteStrict(r.Context(), input)
}

func isExecutable(result governance.Result) bool {
	return result.Decision != governance.Disabled && result.Decision != governance.RuntimeOnly
}

func nonEmpty(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}

func int64OrDefault(v *int64, d int64) int64 {
	if v != nil {
		return *v
	}
	return d
}

func intOrDefault(v *int, d int) int {
	if v != nil {
		return *v
	}
	return d
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func copyBsonM(src bson.M) bson.M {
	dst := make(bson.M, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
