package subscriber

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/approval"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
	"subscriber/internal/user"
)

// RateLimiter abstracts rate limiting for handler testing.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// WriteHandler provides HTTP handlers for subscriber write endpoints.
type WriteHandler struct {
	repo        *Repository
	limiter     RateLimiter
	userRepo    UserRepository
	approvalSvc ApprovalCreator
	approvalQry ApprovalQuerier
	auditWriter *audit.Writer
	// Test seams: when set, used instead of repo for batch update operations.
	batchStore BatchUpdateStore // nil → use repo
	findSub    SubscriberFinder // nil → use repo.FindSubscriberByImsi
	// Test seam for bulk delete: when set, used instead of repo for bulk delete operations.
	bulkDeleteRepo BulkDeleteRepository // nil → use repo
}

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// ApprovalCreator is the interface for creating approval requests.
type ApprovalCreator interface {
	Create(r *http.Request, actor approval.GovernanceActor, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error)
}

// ApprovalQuerier is the interface for querying approval requests.
type ApprovalQuerier interface {
	ListApprovals(ctx context.Context, q approval.ListQuery) (*approval.ListResult, error)
	ListActiveByAction(ctx context.Context, action string) ([]approval.ApprovalDocument, error)
}

// NewWriteHandler creates a new subscriber write handler.
func NewWriteHandler(repo *Repository, limiter RateLimiter, userRepo UserRepository, approvalSvc ApprovalCreator, approvalQry ApprovalQuerier, auditWriter *audit.Writer) *WriteHandler {
	return &WriteHandler{
		repo:        repo,
		limiter:     limiter,
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		approvalQry: approvalQry,
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

// effectiveBatchStore returns the batch update store (test seam or repo).
func (h *WriteHandler) effectiveBatchStore() BatchUpdateStore {
	if h.batchStore != nil {
		return h.batchStore
	}
	return h.repo
}

// effectiveFindSub returns the subscriber finder (test seam or repo).
func (h *WriteHandler) effectiveFindSub() SubscriberFinder {
	if h.findSub != nil {
		return h.findSub
	}
	return func(ctx context.Context, imsi string) (map[string]any, error) {
		return h.repo.FindSubscriberByImsi(ctx, imsi)
	}
}

// isExecutable checks if a governance result allows execution.
func isExecutable(result governance.Result) bool {
	return result.Decision != governance.Disabled && result.Decision != governance.RuntimeOnly
}

// handleBatchUpdateError maps batch update governance errors to HTTP responses.
// Section M: Error code separation — INVALID_BATCH_REQUEST for request validation,
// INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD for frozen integrity.
func (h *WriteHandler) handleBatchUpdateError(w http.ResponseWriter, err error) {
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		response.Error(w, http.StatusInternalServerError, "Internal Server Error", "INTERNAL_ERROR")
		return
	}
	statusMap := map[string]int{
		"SUBSCRIBER_NOT_FOUND":                  http.StatusNotFound,
		"ACTIVE_CHANGE_CONFLICT":                http.StatusConflict,
		"SUBSCRIBER_BATCH_PRECONDITION_CHANGED": http.StatusConflict,
		"SUBSCRIBER_BATCH_NO_EFFECT":            http.StatusBadRequest,
		ErrInvalidBatchRequest:                  http.StatusBadRequest,
		ErrUnsupportedSubscriberField:           http.StatusBadRequest,
		ErrInvalidFrozenBatchUpdate:             http.StatusBadRequest,
		ErrBatchSizeExceeded:                    http.StatusBadRequest,
		ErrApprovalSnapshotTooLarge:             http.StatusBadRequest,
		"AUDIT_UNAVAILABLE":                     http.StatusServiceUnavailable,
	}
	status, ok := statusMap[govErr.Code]
	if !ok {
		status = http.StatusBadRequest
	}
	resp := map[string]any{"error": govErr.Code, "code": govErr.Code}
	if govErr.Details != nil {
		resp["details"] = govErr.Details
	}
	response.JSON(w, status, resp)
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

// BatchCreate handles POST /api/subscribers/batch
// Creates multiple subscribers with governance: operator/ops_admin → APPROVAL, super_admin/root → DIRECT.
// Ordering: auth → capability → rate limit → validate → fresh actor → prepare frozen → governance → approve/execute
func (h *WriteHandler) BatchCreate(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Capability check with audit on denial
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
		return
	}

	// Rate limit: 10/60 per user
	if !h.limiter.Enforce(w, r, "subscribers:batch:"+p.Username, 10, 60) {
		return
	}

	// Decode and validate request
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	payload, err := ValidateBatchCreatePayload(body)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			response.Error(w, http.StatusBadRequest, govErr.Code, govErr.Code)
			return
		}
		response.Error(w, http.StatusBadRequest, err.Error(), "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD")
		return
	}

	// Fresh actor validation — mandatory, fail-closed
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Load profile data for preparation
	profileData := h.repo.loadProfileData(r.Context(), payload.ProfileName)

	// Validate tariff plan exists and is active
	if payload.PlanId != "" {
		plan, err := h.repo.getTariffPlan(r.Context(), payload.PlanId)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, "Failed to validate tariff plan", "INTERNAL_ERROR")
			return
		}
		if plan == nil {
			response.Error(w, http.StatusNotFound, "Tariff plan not found", "OCS_PLAN_NOT_FOUND")
			return
		}
		if status, _ := plan["status"].(string); status == "disabled" {
			response.Error(w, http.StatusConflict, "Tariff plan is disabled", "OCS_PLAN_DISABLED")
			return
		}
	}

	// Precheck: verify no target IMSIs already exist
	precheck, err := h.repo.precheckSubscriberRange(r.Context(), payload.StartImsi, payload.Count)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			if govErr.Code == "IMSI_RANGE_OVERFLOW" {
				response.Error(w, http.StatusBadRequest, "Generated IMSI range exceeds 15 digits", "IMSI_RANGE_OVERFLOW")
				return
			}
		}
		response.Error(w, http.StatusInternalServerError, "Precheck failed", "INTERNAL_ERROR")
		return
	}
	if precheck.ConflictCount > 0 {
		conflictImsis := precheck.ConflictImsis
		if len(conflictImsis) > 20 {
			conflictImsis = conflictImsis[:20]
		}
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":         "SUBSCRIBER_CREATE_PRECONDITION_CHANGED",
			"conflictCount": precheck.ConflictCount,
			"conflictImsis": conflictImsis,
		})
		return
	}

	// Prepare frozen v2 contract
	frozen, err := PrepareFrozenBatchCreate(r.Context(), *payload, profileData, profileData != nil)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			if govErr.Code == "IMSI_RANGE_OVERFLOW" {
				response.Error(w, http.StatusBadRequest, "Generated IMSI range exceeds 15 digits", "IMSI_RANGE_OVERFLOW")
				return
			}
		}
		response.Error(w, http.StatusInternalServerError, "Failed to prepare batch create", "INTERNAL_ERROR")
		return
	}

	// Evaluate governance with fresh role
	govResult := EvaluateOperation(OpBatchCreate, fresh.NormalizedRole)
	if !isExecutable(govResult) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// DIRECT path: super_admin/root
	if govResult.Decision == governance.Direct {
		h.executeDirectBatchCreate(w, r, frozen, fresh)
		return
	}

	// APPROVAL path: operator/ops_admin
	h.createBatchApproval(w, r, frozen, fresh)
}

// executeDirectBatchCreate executes batch create directly for super_admin/root.
// Uses the reusable ExecuteFrozenSubscriberBatchCreate executor.
func (h *WriteHandler) executeDirectBatchCreate(
	w http.ResponseWriter,
	r *http.Request,
	frozen *FrozenBatchCreateV2,
	fresh *FreshActor,
) {
	// Execute via reusable executor (assert frozen → profile drift → absence → insert → OCS)
	result, err := ExecuteFrozenSubscriberBatchCreate(r.Context(), frozen, h.repo)
	if err != nil {
		// Typed errors from executor
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			switch govErr.Code {
			case "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD":
				response.Error(w, http.StatusBadRequest, govErr.Code, govErr.Code)
				return
			case "SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED":
				response.Error(w, http.StatusConflict, govErr.Code, govErr.Code)
				return
			case "SUBSCRIBER_CREATE_PRECONDITION_CHANGED":
				response.JSON(w, http.StatusConflict, map[string]any{
					"error":         govErr.Code,
					"code":          govErr.Code,
					"conflictCount": govErr.Details["conflictCount"],
					"conflictImsis": govErr.Details["conflictImsis"],
				})
				return
			}
		}
		response.Error(w, http.StatusInternalServerError, "Batch creation failed", "BATCH_CREATE_FAILED")
		return
	}

	// PART P: Audit ordering — classify result FIRST, then write accurate audit
	auditResult := "success"
	if result.PartialMutation {
		auditResult = "partial"
	}

	// Strict audit — committed=true on failure
	auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "BATCH_CREATE",
		Module:   "subscribers",
		TargetID: fmt.Sprintf("%s~%s", frozen.ExpectedAbsentImsis[0], frozen.ExpectedAbsentImsis[len(frozen.ExpectedAbsentImsis)-1]),
		After: map[string]any{
			"startImsi":        frozen.StartImsi,
			"count":            frozen.Count,
			"createdCount":     result.CreatedCount,
			"failedCount":      result.FailedCount,
			"partialMutation":  result.PartialMutation,
			"profileName":      frozen.Profile.RequestedName,
			"effectivePlanId":  frozen.EffectiveOcs.PlanId,
			"trafficTotal":     frozen.EffectiveOcs.TrafficTotal,
			"smsTotal":         frozen.EffectiveOcs.SmsTotal,
			"fingerprint":      frozen.OperationFingerprint,
			"governanceMode":   "DIRECT_GOVERNED",
			"approvalRequired": false,
			"operation":        "SUBSCRIBER_BATCH_CREATE",
			"actorRole":        fresh.NormalizedRole,
		},
		Result: auditResult,
	}, fresh)
	if auditErr != nil {
		// PART Q: If partial mutation occurred and audit fails, return 503 with committed=true
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "AUDIT_UNAVAILABLE",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": result.PartialMutation,
		})
		return
	}

	// Check for partial write (PART P: after audit)
	if result.PartialMutation {
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":           "SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE",
			"code":            "SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE",
			"partialMutation": result.PartialMutation,
			"result":          sanitizeBatchResult(result),
		})
		return
	}

	response.JSON(w, http.StatusCreated, map[string]any{
		"outcome":          "executed",
		"message":          "Subscribers created successfully",
		"result":           sanitizeBatchResult(result),
		"requiresApproval": false,
	})
}

// createBatchApproval creates an approval for operator/ops_admin.
func (h *WriteHandler) createBatchApproval(
	w http.ResponseWriter,
	r *http.Request,
	frozen *FrozenBatchCreateV2,
	fresh *FreshActor,
) {
	actor := approval.GovernanceActor{
		Type:     "user",
		UserID:   fresh.UserID,
		Username: fresh.Username,
		Role:     fresh.RawRole,
	}

	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           "SUBSCRIBER_BATCH_CREATE",
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         fmt.Sprintf("subscriber:batch:%s", frozen.StartImsi),
		Summary:          fmt.Sprintf("Batch create %d subscriber(s) from %s", frozen.Count, frozen.StartImsi),
		Operation: &approval.ApprovalOperation{
			ResourceType: "subscriber_batch",
			ResourceID:   frozen.StartImsi,
		},
		OperationFingerprint: frozen.OperationFingerprint,
		Payload:              frozenToMap(frozen),
	})
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create approval request", "APPROVAL_CREATE_FAILED")
		return
	}

	// Strict audit for approval creation
	auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "BATCH_CREATE",
		Module:   "subscribers",
		TargetID: fmt.Sprintf("subscriber:batch:%s", frozen.StartImsi),
		Result:   "approval_required",
		Metadata: map[string]any{
			"approvalId":       approvalDoc.ID,
			"governanceMode":   "APPROVAL_GOVERNED",
			"approvalRequired": true,
			"operation":        "SUBSCRIBER_BATCH_CREATE",
			"actorRole":        fresh.NormalizedRole,
		},
	}, fresh)
	if auditErr != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "AUDIT_UNAVAILABLE",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": true,
			"approval":  approvalDoc,
		})
		return
	}

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":          "approval_required",
		"message":          "Approval required before batch subscriber creation",
		"approval":         approvalDoc,
		"requiresApproval": true,
	})
}

// precheckSubscriberRange checks for existing IMSIs in the target range.
type precheckResult struct {
	ConflictCount int
	ConflictImsis []string
	TotalCount    int
}

func (r *Repository) precheckSubscriberRange(ctx context.Context, startImsi string, count int) (*precheckResult, error) {
	targets, err := GenerateImsiRange(startImsi, count)
	if err != nil {
		return nil, err
	}

	// Query for existing IMSIs
	cursor, err := r.subscribers.Find(ctx, bson.M{
		"imsi": bson.M{"$in": targets},
	}, options.Find().SetProjection(bson.M{"imsi": 1}))
	if err != nil {
		return nil, fmt.Errorf("precheck query: %w", err)
	}
	defer cursor.Close(ctx)

	var existing []bson.M
	if err := cursor.All(ctx, &existing); err != nil {
		return nil, fmt.Errorf("precheck decode: %w", err)
	}

	existingSet := make(map[string]bool, len(existing))
	for _, doc := range existing {
		if imsi, ok := doc["imsi"].(string); ok {
			existingSet[imsi] = true
		}
	}

	var conflicts []string
	for _, imsi := range targets {
		if existingSet[imsi] {
			conflicts = append(conflicts, imsi)
		}
	}

	return &precheckResult{
		ConflictCount: len(conflicts),
		ConflictImsis: conflicts,
		TotalCount:    count,
	}, nil
}

// BatchUpdate handles POST /api/subscribers/batch-update
// Updates multiple subscribers with governance: operator/ops_admin → APPROVAL, super_admin/root → DIRECT.
// Ordering: auth → capability → rate limit → validate → fresh actor → prepare frozen → governance → approve/execute
func (h *WriteHandler) BatchUpdate(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Capability check with audit on denial
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
		return
	}

	// Rate limit: 12/60 per user
	if !h.limiter.Enforce(w, r, "subscribers:batch-update:"+p.Username, 12, 60) {
		return
	}

	// Decode and validate request
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	req, err := ValidateBatchUpdateRequest(body)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			response.Error(w, http.StatusBadRequest, govErr.Code, govErr.Code)
			return
		}
		response.Error(w, http.StatusBadRequest, err.Error(), "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD")
		return
	}

	// Fresh actor validation — mandatory, fail-closed
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Evaluate governance with fresh role
	govResult := EvaluateOperation(OpBatchUpdate, fresh.NormalizedRole)
	if !isExecutable(govResult) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	// Prepare frozen v2 contract
	frozen, err := PrepareFrozenBatchUpdate(r.Context(), req.Imsis, req.Patch, h.effectiveFindSub())
	if err != nil {
		h.handleBatchUpdateError(w, err)
		return
	}

	// Active approval conflict check
	activeMatch, err := h.findExistingBatchChange(r.Context(), frozen.OperationFingerprint, req.Imsis, frozen.FieldNames)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to check existing approvals", "INTERNAL_ERROR")
		return
	}

	if govResult.Decision == governance.Direct {
		// super_admin/root: ANY active duplicate OR overlap → 409
		if activeMatch != nil {
			response.JSON(w, http.StatusConflict, map[string]any{
				"error": "ACTIVE_CHANGE_CONFLICT",
				"code":  "ACTIVE_CHANGE_CONFLICT",
			})
			return
		}
		// Maintenance window check for direct path
		if req.MaintenanceWindow != nil {
			now := time.Now()
			start, _ := time.Parse(time.RFC3339, req.MaintenanceWindow.Start)
			end, _ := time.Parse(time.RFC3339, req.MaintenanceWindow.End)
			if now.Before(start) || now.After(end) {
				response.JSON(w, http.StatusConflict, map[string]any{
					"error": "OUTSIDE_MAINTENANCE_WINDOW",
					"code":  "OUTSIDE_MAINTENANCE_WINDOW",
				})
				return
			}
		}
		// DIRECT_GOVERNED — execute immediately
		h.executeDirectBatchUpdate(w, r, frozen, fresh)
		return
	}

	// operator/ops_admin: APPROVAL_GOVERNED
	if activeMatch != nil {
		if activeMatch.Type == "duplicate" {
			// Exact duplicate → 202 idempotent
			response.JSON(w, http.StatusAccepted, map[string]any{
				"approval":         activeMatch.Approval,
				"requiresApproval": true,
				"idempotent":       true,
			})
			return
		}
		// Overlap → 409
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":    "ACTIVE_CHANGE_CONFLICT",
			"code":     "ACTIVE_CHANGE_CONFLICT",
			"approval": activeMatch.Approval,
		})
		return
	}

	// Create new approval
	h.createBatchUpdateApproval(w, r, frozen, fresh, req.Reason, req.TicketId, req.MaintenanceWindow)
}

// executeDirectBatchUpdate executes batch update directly for super_admin/root.
func (h *WriteHandler) executeDirectBatchUpdate(
	w http.ResponseWriter,
	r *http.Request,
	frozen *FrozenBatchUpdateV2,
	fresh *FreshActor,
) {
	// Execute via reusable executor
	result, err := ExecuteFrozenSubscriberBatchUpdate(r.Context(), frozen, h.effectiveBatchStore())
	if err != nil {
		h.handleGovernanceError(w, err)
		return
	}

	// Classify result
	classification := ClassifyBatchUpdateResult(result.ModifiedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis))
	auditResult := "success"
	if classification != "SUCCESS" {
		auditResult = "failed"
	}

	// Strict audit — always executed after executor invocation
	auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "BATCH_UPDATE",
		Module:   "subscribers",
		TargetID: fmt.Sprintf("subscriber-batch:%s", frozen.OperationFingerprint),
		Before: map[string]any{
			"targetCount": frozen.TargetCount,
			"fields":      frozen.FieldNames,
		},
		After: map[string]any{
			"targetCount":    frozen.TargetCount,
			"fields":         frozen.FieldNames,
			"modifiedCount":  result.ModifiedCount,
			"classification": classification,
		},
		Result: auditResult,
		Metadata: map[string]any{
			"governanceMode":   "DIRECT_GOVERNED",
			"approvalRequired": false,
			"operation":        "SUBSCRIBER_BATCH_UPDATE",
			"actorRole":        fresh.NormalizedRole,
			"targetCount":      frozen.TargetCount,
			"fieldNames":       frozen.FieldNames,
			"modifiedCount":    result.ModifiedCount,
			"conflictCount":    len(result.ConflictImsis),
			"failedCount":      len(result.FailedImsis),
			"classification":   classification,
			"partialMutation":  result.PartialMutation,
			"fingerprint":      frozen.OperationFingerprint,
		},
	}, fresh)
	if auditErr != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "AUDIT_UNAVAILABLE",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": result.MutationCommitted,
		})
		return
	}

	if classification == "FAILED_NO_MUTATION" {
		if len(result.ConflictImsis) > 0 {
			response.JSON(w, http.StatusConflict, map[string]any{
				"error":           "SUBSCRIBER_BATCH_PRECONDITION_CHANGED",
				"code":            "SUBSCRIBER_BATCH_PRECONDITION_CHANGED",
				"partialMutation": false,
			})
		} else {
			response.Error(w, http.StatusInternalServerError, "Batch update failed", "SUBSCRIBER_BATCH_UPDATE_FAILED")
		}
		return
	}

	if classification == "PARTIAL_WRITE" {
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":           "SUBSCRIBER_BATCH_PARTIAL_WRITE",
			"code":            "SUBSCRIBER_BATCH_PARTIAL_WRITE",
			"partialMutation": true,
			"result": map[string]any{
				"modifiedImsis": result.ModifiedImsis,
				"conflictImsis": result.ConflictImsis,
				"failedImsis":   result.FailedImsis,
			},
		})
		return
	}

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "executed",
		"message": "Subscribers updated successfully",
		"result": map[string]any{
			"requested":  result.Requested,
			"modified":   result.ModifiedCount,
			"fieldNames": result.FieldNames,
		},
		"requiresApproval": false,
	})
}

// createBatchUpdateApproval creates an approval for operator/ops_admin.
func (h *WriteHandler) createBatchUpdateApproval(
	w http.ResponseWriter,
	r *http.Request,
	frozen *FrozenBatchUpdateV2,
	fresh *FreshActor,
	reason string,
	ticketId string,
	maintenanceWindow *MaintenanceWindow,
) {
	actor := approval.GovernanceActor{
		Type:     "user",
		UserID:   fresh.UserID,
		Username: fresh.Username,
		Role:     fresh.RawRole,
	}

	reasonPtr := &reason
	var mw *approval.ApprovalMaintenanceWindow
	if maintenanceWindow != nil {
		mw = &approval.ApprovalMaintenanceWindow{
			Start:    maintenanceWindow.Start,
			End:      maintenanceWindow.End,
			TimeZone: maintenanceWindow.TimeZone,
		}
	}

	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           "SUBSCRIBER_BATCH_UPDATE",
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         fmt.Sprintf("subscriber-batch:%s", frozen.OperationFingerprint),
		Summary:          fmt.Sprintf("Batch update %d subscriber(s)", frozen.TargetCount),
		Operation: &approval.ApprovalOperation{
			ResourceType: "subscriber_batch",
			ResourceID:   frozen.OperationFingerprint,
		},
		OperationFingerprint: frozen.OperationFingerprint,
		Reason:               reasonPtr,
		TicketID:             ticketId,
		MaintenanceWindow:    mw,
		Payload:              frozenToMap(frozen),
	})
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create approval request", "APPROVAL_CREATE_FAILED")
		return
	}

	// NO duplicate audit here — ApprovalCreator.Create() already writes strict audit

	// Section 14: New Approval response — match Node production (no outcome/message)
	response.JSON(w, http.StatusAccepted, map[string]any{
		"approval":         approvalDoc,
		"requiresApproval": true,
	})
}

// ActiveApprovalMatch represents the result of checking for active approvals.
type ActiveApprovalMatch struct {
	Type     string // "duplicate" or "conflict"
	Approval *approval.ApprovalDocument
}

// findExistingBatchChange checks for active approvals with the same fingerprint or overlapping targets+fields.
// Returns: duplicate (exact fingerprint), conflict (overlapping targets+fields), or nil (no match).
// Uses dedicated ListActiveByAction query — no pagination blind spots.
func (h *WriteHandler) findExistingBatchChange(ctx context.Context, fingerprint string, imsis []string, fields []string) (*ActiveApprovalMatch, error) {
	// Dedicated query: ALL active SUBSCRIBER_BATCH_UPDATE approvals (no pagination limit)
	allApprovals, err := h.approvalQry.ListActiveByAction(ctx, "SUBSCRIBER_BATCH_UPDATE")
	if err != nil {
		return nil, err
	}

	requestedImsis := make(map[string]bool, len(imsis))
	for _, imsi := range imsis {
		requestedImsis[imsi] = true
	}
	requestedFields := make(map[string]bool, len(fields))
	for _, f := range fields {
		requestedFields[f] = true
	}

	for i := range allApprovals {
		a := &allApprovals[i]
		// Duplicate check: same fingerprint
		if a.OperationFingerprint == fingerprint {
			return &ActiveApprovalMatch{Type: "duplicate", Approval: a}, nil
		}

		// Conflict check: overlapping targets and fields
		payloadTargets := extractApprovalTargets(a)
		payloadFields := extractApprovalFields(a)

		targetOverlap := false
		for _, t := range payloadTargets {
			if requestedImsis[t] {
				targetOverlap = true
				break
			}
		}
		if !targetOverlap {
			continue
		}

		fieldOverlap := false
		for _, f := range payloadFields {
			if requestedFields[f] {
				fieldOverlap = true
				break
			}
		}
		if fieldOverlap {
			return &ActiveApprovalMatch{Type: "conflict", Approval: a}, nil
		}
	}

	return nil, nil
}

// extractApprovalTargets extracts IMSI targets from an approval payload.
// Section P: asAnySlice converts bson.A or []any to []any for safe extraction.
func asAnySlice(v any) ([]any, bool) {
	switch slice := v.(type) {
	case []any:
		return slice, true
	case bson.A:
		return []any(slice), true
	default:
		return nil, false
	}
}

// Section P: asStringAnyMap converts bson.M, bson.D, or map[string]any to map[string]any for safe extraction.
func asStringAnyMap(v any) (map[string]any, bool) {
	switch m := v.(type) {
	case map[string]any:
		return m, true
	case bson.M:
		return map[string]any(m), true
	case bson.D:
		result := make(map[string]any, len(m))
		for _, elem := range m {
			result[elem.Key] = elem.Value
		}
		return result, true
	default:
		return nil, false
	}
}

// Section P: BSON-safe target extraction from approval payload.
// extractApprovalTargets extracts target IMSIs from an approval document.
// Action-aware: SUBSCRIBER_UPDATE/DELETE use payload.imsi,
// SUBSCRIBER_BATCH_UPDATE/BULK_DELETE use payload.targets[].imsi.
func extractApprovalTargets(a *approval.ApprovalDocument) []string {
	if a.Payload == nil {
		return nil
	}

	// SUBSCRIBER_UPDATE / SUBSCRIBER_DELETE: payload.imsi
	if a.Action == "SUBSCRIBER_UPDATE" || a.Action == "SUBSCRIBER_DELETE" {
		if imsi, ok := a.Payload["imsi"].(string); ok && len(imsi) == 15 {
			return []string{imsi}
		}
		// Legacy fallback: targetId might contain IMSI
		if a.TargetID != "" && len(a.TargetID) >= 15 {
			// Extract IMSI from "subscriber:IMSI" format
			parts := strings.Split(a.TargetID, ":")
			for _, part := range parts {
				if len(part) == 15 {
					allDigits := true
					for _, c := range part {
						if c < '0' || c > '9' {
							allDigits = false
							break
						}
					}
					if allDigits {
						return []string{part}
					}
				}
			}
		}
		return nil
	}

	// SUBSCRIBER_BATCH_UPDATE / SUBSCRIBER_BULK_DELETE: payload.targets[].imsi
	targetsRaw, ok := asAnySlice(a.Payload["targets"])
	if !ok {
		return nil
	}
	var imsis []string
	for _, t := range targetsRaw {
		if target, ok := asStringAnyMap(t); ok {
			if imsi, ok := target["imsi"].(string); ok {
				imsis = append(imsis, imsi)
			}
		}
	}
	return imsis
}

// Section P: BSON-safe field name extraction from approval payload.
func extractApprovalFields(a *approval.ApprovalDocument) []string {
	if a.Payload == nil {
		return nil
	}
	fieldsRaw, ok := asAnySlice(a.Payload["fieldNames"])
	if !ok {
		return nil
	}
	var fields []string
	for _, f := range fieldsRaw {
		if field, ok := f.(string); ok {
			fields = append(fields, field)
		}
	}
	return fields
}

// sanitizeBatchResult removes sensitive data from batch result for HTTP response.
func sanitizeBatchResult(result *BatchCreateResult) map[string]any {
	return map[string]any{
		"createdImsis":    result.CreatedImsis,
		"failedImsis":     result.FailedImsis,
		"createdCount":    result.CreatedCount,
		"failedCount":     result.FailedCount,
		"partialMutation": result.PartialMutation,
		"metrics":         result.Metrics,
	}
}

// BulkDelete handles POST /api/subscribers/bulk-delete
// Deletes multiple subscribers with governance: operator/ops_admin → Approval, super_admin/root → Direct.
// Ordering: auth → subscriber_write → rate limit → request validation → fresh actor → prepare v2 → active conflicts → actor governance → Approval / Direct
func (h *WriteHandler) BulkDelete(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Capability check
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
		return
	}

	// Rate limit: 10 requests / 60 seconds / username
	if !h.limiter.Enforce(w, r, "subscribers:bulk-delete:"+p.Username, 10, 60) {
		return
	}

	// Decode and validate request
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	req, err := ValidateBulkDeleteRequest(body)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			response.Error(w, http.StatusBadRequest, govErr.Code, govErr.Code)
		} else {
			response.Error(w, http.StatusBadRequest, "Invalid request", "INVALID_REQUEST")
		}
		return
	}

	// Fresh actor validation
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Prepare frozen v2
	// Use test seam if available, otherwise use repo
	var bulkRepo BulkDeleteRepository = h.repo
	if h.bulkDeleteRepo != nil {
		bulkRepo = h.bulkDeleteRepo
	}
	frozen, err := PrepareFrozenBulkDelete(r.Context(), req.ImsiList, bulkRepo)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			code := govErr.Code
			status := http.StatusBadRequest
			if code == "SUBSCRIBER_NOT_FOUND" {
				status = http.StatusNotFound
			}
			response.Error(w, status, code, code)
		} else {
			response.Error(w, http.StatusInternalServerError, "Failed to prepare bulk delete", "INTERNAL_ERROR")
		}
		return
	}

	// Snapshot size check
	if frozen.SnapshotBytes > maxBulkDeleteSnapshotBytes {
		response.Error(w, http.StatusBadRequest, ErrApprovalSnapshotTooLarge, ErrApprovalSnapshotTooLarge)
		return
	}

	// Active change protection - check for conflicting active approvals
	activeMatch, err := h.findExistingBulkDeleteChange(r.Context(), frozen.OperationFingerprint, req.ImsiList)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to check active changes", "INTERNAL_ERROR")
		return
	}

	// Evaluate governance with fresh role
	result := EvaluateOperation(OpBulkDelete, fresh.NormalizedRole)

	if result.Decision == governance.Direct {
		// super_admin/root: Direct execution
		// Check for ANY active conflict
		if activeMatch != nil {
			response.Error(w, http.StatusConflict, "ACTIVE_CHANGE_CONFLICT", "ACTIVE_CHANGE_CONFLICT")
			return
		}

		h.executeDirectBulkDelete(w, r, frozen, fresh)
		return
	}

	// operator/ops_admin: Approval path
	if activeMatch != nil {
		if activeMatch.Type == "duplicate" {
			// Exact duplicate → 202 idempotent
			response.JSON(w, http.StatusAccepted, map[string]any{
				"approval":         activeMatch.Approval,
				"requiresApproval": true,
				"idempotent":       true,
			})
			return
		}
		// Overlap → 409
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":    "ACTIVE_CHANGE_CONFLICT",
			"code":     "ACTIVE_CHANGE_CONFLICT",
			"approval": activeMatch.Approval,
		})
		return
	}

	// Create approval
	actor := approval.GovernanceActor{
		Type:     "user",
		UserID:   fresh.UserID,
		Username: fresh.Username,
		Role:     fresh.NormalizedRole,
	}
	input := approval.CreateApprovalInput{
		Action:               "SUBSCRIBER_BULK_DELETE",
		Requester:            fresh.Username,
		RequesterContext:     &actor,
		TargetID:             "subscriber:bulk-delete",
		Summary:              fmt.Sprintf("Delete %d subscriber(s)", frozen.TargetCount),
		Operation:            &approval.ApprovalOperation{ResourceType: "subscriber_batch", ResourceID: "bulk-delete"},
		OperationFingerprint: frozen.OperationFingerprint,
		Before:               map[string]any{"targetCount": frozen.TargetCount, "targets": frozen.Targets},
		Payload:              frozenBulkDeleteToMap(frozen),
	}

	approvalDoc, err := h.approvalSvc.Create(r, actor, input)
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create approval request", "APPROVAL_CREATE_FAILED")
		return
	}

	// New Approval response — match Node production (no outcome/message)
	response.JSON(w, http.StatusAccepted, map[string]any{
		"approval":         approvalDoc,
		"requiresApproval": true,
	})
}

// executeDirectBulkDelete executes bulk delete directly for super_admin/root.
// Section 7: All terminal outcomes generate strict audit.
func (h *WriteHandler) executeDirectBulkDelete(w http.ResponseWriter, r *http.Request, frozen *FrozenBulkDeleteV2, fresh *FreshActor) {
	// Use test seam if available, otherwise use repo
	var bulkRepo BulkDeleteRepository = h.repo
	if h.bulkDeleteRepo != nil {
		bulkRepo = h.bulkDeleteRepo
	}

	// Execute with CAS and OCS cleanup separation
	// Use test seam if available for OCS cleanup
	ocsCleanup := func(ctx context.Context, imsi string) error {
		if h.bulkDeleteRepo != nil {
			if ocsRepo, ok := h.bulkDeleteRepo.(interface {
				DeleteOcsProvisioning(ctx context.Context, imsi string) error
			}); ok {
				return ocsRepo.DeleteOcsProvisioning(ctx, imsi)
			}
		}
		return h.repo.DeleteOcsProvisioning(ctx, imsi)
	}

	execResult, err := ExecuteFrozenBulkDelete(r.Context(), frozen, bulkRepo, ocsCleanup)

	// Section 7: Build result evidence for audit even on error
	if err != nil {
		// Build zero-write result for audit
		if execResult == nil {
			execResult = &BulkDeleteExecutionResult{
				Requested:             frozen.TargetCount,
				OperationFingerprint:  frozen.OperationFingerprint,
				DeletedImsis:          []string{},
				ConflictImsis:         []string{},
				FailedImsis:           []string{},
				OcsCleanedImsis:       []string{},
				OcsCleanupFailedImsis: []string{},
			}
			// Classify error type for conflict/failed distinction
			if govErr, ok := err.(*SubscriberGovernanceError); ok && govErr.Code == ErrBulkDeletePreconditionChanged {
				// Preflight conflict
				for _, t := range frozen.Targets {
					execResult.ConflictImsis = append(execResult.ConflictImsis, t.Imsi)
				}
			} else {
				// Storage failure
				for _, t := range frozen.Targets {
					execResult.FailedImsis = append(execResult.FailedImsis, t.Imsi)
				}
			}
		}
	}

	// Classify result
	classification := ClassifyBulkDeleteResult(
		execResult.DeletedCount,
		execResult.Requested,
		len(execResult.ConflictImsis),
		len(execResult.FailedImsis),
		len(execResult.OcsCleanupFailedImsis),
	)

	// Section 7: Strict audit for ALL terminal outcomes
	auditResult := "success"
	if classification != "SUCCESS" {
		auditResult = "failed"
	}

	auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "subscriber.batch.delete",
		Module:   "subscribers",
		TargetID: "subscriber:bulk-delete",
		Result:   auditResult,
		Metadata: map[string]any{
			"governanceMode":         "DIRECT_GOVERNED",
			"approvalRequired":       false,
			"actorRole":              fresh.NormalizedRole,
			"risk":                   "critical",
			"targetCount":            execResult.Requested,
			"deletedCount":           execResult.DeletedCount,
			"conflictCount":          len(execResult.ConflictImsis),
			"failedCount":            len(execResult.FailedImsis),
			"ocsCleanupFailureCount": len(execResult.OcsCleanupFailedImsis),
			"operationFingerprint":   execResult.OperationFingerprint,
			"classification":         classification,
			"partialMutation":        execResult.PartialMutation,
		},
	}, fresh)
	if auditErr != nil {
		response.JSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "AUDIT_UNAVAILABLE",
			"code":      "AUDIT_UNAVAILABLE",
			"committed": execResult.MutationCommitted,
		})
		return
	}

	// Section 18: Classification-based HTTP mapping
	switch classification {
	case "SUCCESS":
		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "Subscribers deleted successfully",
			"result": map[string]any{
				"requested":             execResult.Requested,
				"deleted":               execResult.DeletedCount,
				"deletedImsis":          execResult.DeletedImsis,
				"ocsCleanupFailedImsis": execResult.OcsCleanupFailedImsis,
			},
			"requiresApproval": false,
		})
	case "PARTIAL_WRITE":
		response.JSON(w, http.StatusConflict, map[string]any{
			"code":            ErrBulkDeletePartialWrite,
			"error":           ErrBulkDeletePartialWrite,
			"committed":       true,
			"partialMutation": true,
			"result":          sanitizeBulkDeleteResult(execResult),
		})
	case "FAILED_NO_MUTATION":
		if len(execResult.ConflictImsis) > 0 {
			response.JSON(w, http.StatusConflict, map[string]any{
				"code":            ErrBulkDeletePreconditionChanged,
				"error":           ErrBulkDeletePreconditionChanged,
				"committed":       false,
				"partialMutation": false,
				"result":          sanitizeBulkDeleteResult(execResult),
			})
		} else {
			response.JSON(w, http.StatusInternalServerError, map[string]any{
				"code":            ErrBulkDeleteFailed,
				"error":           ErrBulkDeleteFailed,
				"committed":       false,
				"partialMutation": false,
				"result":          sanitizeBulkDeleteResult(execResult),
			})
		}
	}
}

// sanitizeBulkDeleteResult removes sensitive data from bulk delete result for HTTP response.
func sanitizeBulkDeleteResult(result *BulkDeleteExecutionResult) map[string]any {
	if result == nil {
		return nil
	}
	return map[string]any{
		"requested":             result.Requested,
		"deletedImsis":          result.DeletedImsis,
		"conflictImsis":         result.ConflictImsis,
		"failedImsis":           result.FailedImsis,
		"ocsCleanedImsis":       result.OcsCleanedImsis,
		"ocsCleanupFailedImsis": result.OcsCleanupFailedImsis,
		"deletedCount":          result.DeletedCount,
		"partialMutation":       result.PartialMutation,
		"mutationCommitted":     result.MutationCommitted,
	}
}

// findExistingBulkDeleteChange checks for active approvals with the same fingerprint or overlapping targets.
func (h *WriteHandler) findExistingBulkDeleteChange(ctx context.Context, fingerprint string, imsis []string) (*ActiveApprovalMatch, error) {
	// Check all relevant active subscriber changes
	actions := []string{"SUBSCRIBER_UPDATE", "SUBSCRIBER_DELETE", "SUBSCRIBER_BATCH_UPDATE", "SUBSCRIBER_BULK_DELETE"}
	for _, action := range actions {
		approvals, err := h.approvalQry.ListActiveByAction(ctx, action)
		if err != nil {
			return nil, err
		}

		for _, a := range approvals {
			// Duplicate check: same fingerprint for BULK_DELETE
			if action == "SUBSCRIBER_BULK_DELETE" && a.OperationFingerprint == fingerprint {
				return &ActiveApprovalMatch{Type: "duplicate", Approval: &a}, nil
			}

			// Overlap check: any active change targeting same IMSIs
			targetOverlap := false
			existingTargets := extractApprovalTargets(&a)
			requestedSet := make(map[string]bool)
			for _, imsi := range imsis {
				requestedSet[imsi] = true
			}
			for _, existing := range existingTargets {
				if requestedSet[existing] {
					targetOverlap = true
					break
				}
			}
			if targetOverlap {
				return &ActiveApprovalMatch{Type: "conflict", Approval: &a}, nil
			}
		}
	}
	return nil, nil
}

// frozenBulkDeleteToMap converts FrozenBulkDeleteV2 to map for storage.
func frozenBulkDeleteToMap(frozen *FrozenBulkDeleteV2) map[string]any {
	return map[string]any{
		"version":              frozen.Version,
		"targets":              frozen.Targets,
		"targetCount":          frozen.TargetCount,
		"snapshotBytes":        frozen.SnapshotBytes,
		"strategy":             frozen.Strategy,
		"operationFingerprint": frozen.OperationFingerprint,
	}
}
