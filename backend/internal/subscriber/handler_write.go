package subscriber

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/YGone-001/subscriber-console/backend/internal/approval"
	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/governance"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
)

// WriteHandler provides HTTP handlers for subscriber write endpoints.
type WriteHandler struct {
	repo        *Repository
	limiter     *ratelimit.Limiter
	userRepo    UserRepository
	approvalSvc ApprovalCreator
	auditWriter *audit.Writer
}

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// ApprovalCreator is the interface for creating approval requests.
type ApprovalCreator interface {
	Create(r *http.Request, actor approval.GovernanceActor, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error)
}

// NewWriteHandler creates a new subscriber write handler.
func NewWriteHandler(repo *Repository, limiter *ratelimit.Limiter, userRepo UserRepository, approvalSvc ApprovalCreator, auditWriter *audit.Writer) *WriteHandler {
	return &WriteHandler{
		repo:        repo,
		limiter:     limiter,
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: auditWriter,
	}
}

// Create handles POST /api/subscribers
// Creates a new subscriber with governance: all authorized roles → DIRECT.
// Ordering: auth → capability check → rate limit → request validation → fresh actor → governance → create
func (h *WriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Capability check with audit on denial
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
		return
	}

	// Rate limit
	if !h.limiter.Enforce(w, r, "subscribers:create:"+p.Username, 30, 60) {
		return
	}

	var body CreateSubscriberBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	// Validate IMSI
	imsi, err := ValidateImsi(body.Imsi)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "INVALID_IMSI")
		return
	}

	// Fresh actor validation — mandatory, fail-closed
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Evaluate governance with fresh role
	result := EvaluateOperation(OpCreate, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// MSISDN coercion — matches Node: undefined/null → "", otherwise String(value).trim()
	var msisdn *string
	if body.Msisdn != nil {
		trimmed := strings.TrimSpace(*body.Msisdn)
		msisdn = &trimmed
	}

	// Create subscriber (governance is DIRECT for CREATE for all authorized roles)
	created, err := h.repo.CreateSubscriberFromLegacy(r.Context(), imsi, body.ResolvedPlanId(), msisdn)
	if err != nil {
		h.handleCreateError(w, err)
		return
	}

	// Strict audit — uses SafeSnapshot (no security material), committed=true on failure
	auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "CREATE",
		Module:   "subscribers",
		TargetID: imsi,
		After:    SubscriberSafeSnapshot(created), // Safe — no k/op/opc/amf/sqn
		Result:   "success",
		Metadata: map[string]interface{}{
			"governanceMode":   "DIRECT_GOVERNED",
			"approvalRequired": false,
			"operation":        string(OpCreate),
			"actorRole":        fresh.NormalizedRole,
		},
	}, fresh)
	if auditErr != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "AUDIT_UNAVAILABLE",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": true,
		})
		return
	}

	response.JSON(w, http.StatusCreated, map[string]any{
		"outcome": "executed",
		"message": "Subscriber created successfully",
		"imsi":    imsi,
	})
}

// Update handles PUT /api/subscribers/{imsi}
// Updates a subscriber with governance: super_admin/root → DIRECT, operator/ops_admin → APPROVAL.
// Ordering: auth → capability check → rate limit → validate → fresh actor → governance → prepare/execute/create approval
func (h *WriteHandler) Update(w http.ResponseWriter, r *http.Request) {
	imsi := r.PathValue("imsi")
	if imsi == "" {
		response.Error(w, http.StatusBadRequest, "IMSI is required", "MISSING_IMSI")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Capability check with audit on denial
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
		return
	}

	// Rate limit
	if !h.limiter.Enforce(w, r, "subscribers:update:"+p.Username, 60, 60) {
		return
	}

	// Validate IMSI
	imsi, err := ValidateImsi(imsi)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "INVALID_IMSI")
		return
	}

	// Parse and validate payload
	var payload UpdatePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}
	if err := ValidateSubscriberUpdatePayload(payload); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}

	// Fresh actor validation — mandatory, fail-closed, BEFORE governance evaluation
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Evaluate governance with FRESH actor role (not token role)
	result := EvaluateOperation(OpUpdate, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// Prepare frozen state
	frozen, err := PrepareFrozenSubscriberUpdate(r.Context(), imsi, payload, h.repo.FindSubscriberByImsi)
	if err != nil {
		h.handleGovernanceError(w, err)
		return
	}

	if result.Decision == governance.Direct {
		// Super Admin/root: DIRECT_GOVERNED — execute immediately
		execResult, err := ExecuteFrozenSubscriberUpdate(r.Context(), frozen, h.repo.FindSubscriberByImsi, h.repo.UpdateSubscriberFromLegacy)
		if err != nil {
			h.handleGovernanceError(w, err)
			return
		}

		// Strict audit — committed=true on failure
		auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
			Action:   "UPDATE",
			Module:   "subscribers",
			TargetID: imsi,
			Before:   frozen.Before,
			After:    execResult.After,
			Result:   "success",
			Metadata: map[string]interface{}{
				"governanceMode":   "DIRECT_GOVERNED",
				"approvalRequired": false,
				"operation":        string(OpUpdate),
				"actorRole":        fresh.NormalizedRole,
			},
		}, fresh)
		if auditErr != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "AUDIT_UNAVAILABLE",
				"code":      "AUDIT_UNAVAILABLE",
				"committed": true,
			})
			return
		}

		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "Subscriber updated successfully",
			"imsi":    imsi,
		})
		return
	}

	// Normal operator/ops_admin: APPROVAL_GOVERNED — create approval
	reason := r.URL.Query().Get("reason")
	var reasonPtr *string
	if reason != "" {
		reasonPtr = &reason
	}

	actor := approval.GovernanceActor{
		Type:     "user",
		UserID:   fresh.UserID,
		Username: fresh.Username,
		Role:     fresh.RawRole,
	}

	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           "SUBSCRIBER_UPDATE",
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         imsi,
		Summary:          fmt.Sprintf("Update governed subscriber configuration for %s", imsi),
		Operation: &approval.ApprovalOperation{
			ResourceType: "subscriber",
			ResourceID:   imsi,
		},
		OperationFingerprint: frozen.OperationFingerprint,
		Reason:               reasonPtr,
		Before:               frozen.Before,
		After:                frozen.After,
		Payload:              frozenToMap(frozen),
	})
	if err != nil {
		// ApprovalCreator.Create already writes strict audit; check for committed=true
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create approval request", "APPROVAL_CREATE_FAILED")
		return
	}

	// NO duplicate audit here — ApprovalCreator.Create() already writes strict audit

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  "Approval required before subscriber update",
		"approval": approvalDoc,
	})
}

// Delete handles DELETE /api/subscribers/{imsi}
// Deletes a subscriber with governance: super_admin/root → DIRECT, operator/ops_admin → APPROVAL.
// Ordering: auth → capability check → rate limit → validate → fresh actor → governance → prepare/execute/create approval
func (h *WriteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	imsi := r.PathValue("imsi")
	if imsi == "" {
		response.Error(w, http.StatusBadRequest, "IMSI is required", "MISSING_IMSI")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Capability check with audit on denial
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
		return
	}

	// Rate limit
	if !h.limiter.Enforce(w, r, "subscribers:delete:"+p.Username, 30, 60) {
		return
	}

	// Validate IMSI
	imsi, err := ValidateImsi(imsi)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "INVALID_IMSI")
		return
	}

	// Fresh actor validation — mandatory, fail-closed, BEFORE governance evaluation
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Evaluate governance with FRESH actor role (not token role)
	result := EvaluateOperation(OpDelete, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// Prepare frozen state
	frozen, err := PrepareFrozenSubscriberDelete(r.Context(), imsi, h.repo.FindSubscriberByImsi)
	if err != nil {
		h.handleGovernanceError(w, err)
		return
	}

	if result.Decision == governance.Direct {
		// Super Admin/root: DIRECT_GOVERNED — execute immediately
		execResult, err := ExecuteFrozenSubscriberDelete(r.Context(), frozen, h.repo.FindSubscriberByImsi, h.repo.DeleteSubscriber)
		if err != nil {
			h.handleGovernanceError(w, err)
			return
		}

		// Strict audit — committed=true on failure
		auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
			Action:   "DELETE",
			Module:   "subscribers",
			TargetID: imsi,
			Before:   frozen.Before,
			After:    map[string]any{"deleted": true, "imsi": imsi},
			Result:   "success",
			Metadata: map[string]interface{}{
				"governanceMode":   "DIRECT_GOVERNED",
				"approvalRequired": false,
				"operation":        string(OpDelete),
				"actorRole":        fresh.NormalizedRole,
			},
		}, fresh)
		if auditErr != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "AUDIT_UNAVAILABLE",
				"code":      "AUDIT_UNAVAILABLE",
				"committed": true,
			})
			return
		}

		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "Subscriber deleted successfully",
			"imsi":    imsi,
			"deleted": execResult.Deleted,
		})
		return
	}

	// Normal operator/ops_admin: APPROVAL_GOVERNED — create approval
	reason := r.URL.Query().Get("reason")
	var reasonPtr *string
	if reason != "" {
		reasonPtr = &reason
	}

	actor := approval.GovernanceActor{
		Type:     "user",
		UserID:   fresh.UserID,
		Username: fresh.Username,
		Role:     fresh.RawRole,
	}

	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           "SUBSCRIBER_DELETE",
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         imsi,
		Summary:          fmt.Sprintf("Delete subscriber %s", imsi),
		Operation: &approval.ApprovalOperation{
			ResourceType: "subscriber",
			ResourceID:   imsi,
		},
		OperationFingerprint: frozen.OperationFingerprint,
		Reason:               reasonPtr,
		Before:               frozen.Before,
		Payload:              frozenToMap(frozen),
	})
	if err != nil {
		// ApprovalCreator.Create already writes strict audit; check for committed=true
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create approval request", "APPROVAL_CREATE_FAILED")
		return
	}

	// NO duplicate audit here — ApprovalCreator.Create() already writes strict audit

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  "Approval required before subscriber deletion",
		"approval": approvalDoc,
	})
}

// isExecutable checks if a governance result allows execution.
func isExecutable(result governance.Result) bool {
	return result.Decision != governance.Disabled && result.Decision != governance.RuntimeOnly
}

// handleGovernanceError maps governance errors to HTTP responses.
func (h *WriteHandler) handleGovernanceError(w http.ResponseWriter, err error) {
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		response.Error(w, http.StatusInternalServerError, "Internal Server Error", "INTERNAL_ERROR")
		return
	}
	switch govErr.Code {
	case "SUBSCRIBER_NOT_FOUND":
		response.Error(w, http.StatusNotFound, "Subscriber not found", govErr.Code)
	case "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED":
		response.Error(w, http.StatusUnprocessableEntity, "Sensitive subscriber change not supported", govErr.Code)
	case "SUBSCRIBER_UPDATE_NO_EFFECT":
		response.Error(w, http.StatusConflict, "Subscriber update has no effect", govErr.Code)
	case "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED", "SUBSCRIBER_DELETE_PRECONDITION_CHANGED":
		response.Error(w, http.StatusConflict, "Subscriber state changed since governance check", govErr.Code)
	case "SUBSCRIBER_UPDATE_PARTIAL_WRITE":
		response.Error(w, http.StatusInternalServerError, "Subscriber updated but OCS provisioning failed", govErr.Code)
	case "SUBSCRIBER_DELETE_PARTIAL_WRITE":
		response.Error(w, http.StatusInternalServerError, "Subscriber deleted but OCS cleanup failed", govErr.Code)
	default:
		response.Error(w, http.StatusConflict, govErr.Code, govErr.Code)
	}
}

// handleCreateError maps create errors to HTTP responses.
// Error text matches Node exactly.
func (h *WriteHandler) handleCreateError(w http.ResponseWriter, err error) {
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		response.Error(w, http.StatusInternalServerError, "Failed to create subscriber", "INTERNAL_ERROR")
		return
	}
	switch govErr.Code {
	case "SUBSCRIBER_EXISTS":
		response.Error(w, http.StatusConflict, "Subscriber already exists", govErr.Code)
	case "MSISDN_EXISTS":
		response.Error(w, http.StatusConflict, "MSISDN already exists", govErr.Code)
	case "INVALID_PLAN_ID":
		response.Error(w, http.StatusBadRequest, "Invalid plan_id format", govErr.Code)
	case "OCS_PLAN_NOT_FOUND":
		response.Error(w, http.StatusNotFound, "Tariff plan not found", govErr.Code)
	case "OCS_PLAN_DISABLED":
		response.Error(w, http.StatusConflict, "Tariff plan is disabled", govErr.Code)
	case "SUBSCRIBER_CREATE_PARTIAL_WRITE":
		response.Error(w, http.StatusInternalServerError, "Subscriber created but OCS provisioning failed", govErr.Code)
	default:
		response.Error(w, http.StatusInternalServerError, "Failed to create subscriber", govErr.Code)
	}
}

// writeStrictAudit writes a strict audit record using proper request context.
// Uses AuditRequestContext for IP/user-agent extraction (matches Node auditRequestContext).
// Returns error — caller must handle as 503 committed=true.
func (h *WriteHandler) writeStrictAudit(r *http.Request, input audit.WriteAuditInput, fresh *FreshActor) error {
	input.Actor = audit.ActorInput{
		Type:     "user",
		UserID:   fresh.UserID,
		Username: fresh.Username,
		Role:     fresh.NormalizedRole,
	}
	source, request, reason := audit.AuditRequestContext(r)
	input.Source = source
	input.Request = request
	if input.Reason == "" {
		input.Reason = reason
	}
	return h.auditWriter.WriteStrict(r.Context(), input)
}

// frozenToMap converts a frozen state to a map for the approval payload.
func frozenToMap(v any) map[string]any {
	data, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}

// CreateSubscriberBody is the request body for POST /api/subscribers.
// Supports both planId and plan_id aliases (Node precedence: planId || plan_id).
type CreateSubscriberBody struct {
	Imsi    string  `json:"imsi"`
	PlanId  *string `json:"planId,omitempty"`
	PlanId2 *string `json:"plan_id,omitempty"` // alias
	Msisdn  *string `json:"msisdn,omitempty"`
}

// ResolvedPlanId returns planId || plan_id (Node precedence).
func (b *CreateSubscriberBody) ResolvedPlanId() *string {
	if b.PlanId != nil && *b.PlanId != "" {
		return b.PlanId
	}
	return b.PlanId2
}
