package subscriber

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/middleware"
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
	auditWriter *audit.Writer
	// Test seams: when set, used instead of repo for batch update operations.
	batchStore BatchUpdateStore // nil → use repo
	findSub    SubscriberFinder // nil → use repo.FindSubscriberByImsi
	// Test seam for bulk delete: when set, used instead of repo for bulk delete operations.
	bulkDeleteRepo BulkDeleteRepository // nil → use repo
	// Test seam for import: when set, used instead of repo for import operations.
	importRepo ImportRepository // nil → use repo
}

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// NewWriteHandler creates a new subscriber write handler.
func NewWriteHandler(repo *Repository, limiter RateLimiter, userRepo UserRepository, auditWriter *audit.Writer) *WriteHandler {
	return &WriteHandler{
		repo:        repo,
		limiter:     limiter,
		userRepo:    userRepo,
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

	// Strict audit — uses SafeSnapshot (no security material), non-gating
	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "CREATE",
		Module:   "subscribers",
		TargetID: imsi,
		After:    SubscriberSafeSnapshot(created), // Safe — no k/op/opc/amf/sqn
		Result:   "success",
		Metadata: map[string]interface{}{
			"governanceMode": "DIRECT_GOVERNED",
			"operation":      string(OpCreate),
			"actorRole":      fresh.NormalizedRole,
		},
	}, fresh)

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

	// DIRECT_GOVERNED — execute immediately
	execResult, err := ExecuteFrozenSubscriberUpdate(r.Context(), frozen, h.repo.FindSubscriberByImsi, h.repo.UpdateSubscriberFromLegacy)
	if err != nil {
		h.handleGovernanceError(w, err)
		return
	}

	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "UPDATE",
		Module:   "subscribers",
		TargetID: imsi,
		Before:   frozen.Before,
		After:    execResult.After,
		Result:   "success",
		Metadata: map[string]interface{}{
			"governanceMode": "DIRECT_GOVERNED",
			"operation":      string(OpUpdate),
			"actorRole":      fresh.NormalizedRole,
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "executed",
		"message": "Subscriber updated successfully",
		"imsi":    imsi,
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

	// DIRECT_GOVERNED — execute immediately
	execResult, err := ExecuteFrozenSubscriberDelete(r.Context(), frozen, h.repo.FindSubscriberByImsi, h.repo.DeleteSubscriber)
	if err != nil {
		h.handleGovernanceError(w, err)
		return
	}

	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "DELETE",
		Module:   "subscribers",
		TargetID: imsi,
		Before:   frozen.Before,
		After:    map[string]any{"deleted": true, "imsi": imsi},
		Result:   "success",
		Metadata: map[string]interface{}{
			"governanceMode": "DIRECT_GOVERNED",
			"operation":      string(OpDelete),
			"actorRole":      fresh.NormalizedRole,
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "executed",
		"message": "Subscriber deleted successfully",
		"imsi":    imsi,
		"deleted": execResult.Deleted,
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

// writeStrictAudit writes an audit record using proper request context.
// Audit failures are logged with slog.Error and are strictly non-gating for business mutations.
func (h *WriteHandler) writeStrictAudit(r *http.Request, input audit.WriteAuditInput, fresh *FreshActor) {
	if h.auditWriter == nil {
		return
	}
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
	if err := h.auditWriter.WriteStrict(r.Context(), input); err != nil {
		slog.Error("subscriber_audit_write_failed", "action", input.Action, "target", input.TargetID, "error", err)
	}
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

	// DIRECT path: execute immediately
	h.executeDirectBatchCreate(w, r, frozen, fresh)
}

// executeDirectBatchCreate executes batch create directly.
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

	// Classify result FIRST, then write accurate audit
	auditResult := "success"
	if result.PartialMutation {
		auditResult = "partial"
	}

	// Strict audit — non-gating
	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "BATCH_CREATE",
		Module:   "subscribers",
		TargetID: fmt.Sprintf("%s~%s", frozen.ExpectedAbsentImsis[0], frozen.ExpectedAbsentImsis[len(frozen.ExpectedAbsentImsis)-1]),
		After: map[string]any{
			"startImsi":       frozen.StartImsi,
			"count":           frozen.Count,
			"createdCount":    result.CreatedCount,
			"failedCount":     result.FailedCount,
			"partialMutation": result.PartialMutation,
			"profileName":     frozen.Profile.RequestedName,
			"effectivePlanId": frozen.EffectiveOcs.PlanId,
			"trafficTotal":    frozen.EffectiveOcs.TrafficTotal,
			"smsTotal":        frozen.EffectiveOcs.SmsTotal,
			"fingerprint":     frozen.OperationFingerprint,
			"governanceMode":  "DIRECT_GOVERNED",
			"operation":       "SUBSCRIBER_BATCH_CREATE",
			"actorRole":       fresh.NormalizedRole,
		},
		Result: auditResult,
	}, fresh)

	// Check for partial write (after audit)
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
		"outcome": "executed",
		"message": "Subscribers created successfully",
		"result":  sanitizeBatchResult(result),
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
}

// executeDirectBatchUpdate executes batch update directly.
func (h *WriteHandler) executeDirectBatchUpdate(
	w http.ResponseWriter,
	r *http.Request,
	frozen *FrozenBatchUpdateV2,
	fresh *FreshActor,
) {
	// Execute via reusable executor
	result, err := ExecuteFrozenSubscriberBatchUpdate(r.Context(), frozen, h.effectiveBatchStore())
	if err != nil {
		h.handleBatchUpdateError(w, err)
		return
	}

	// Classify result
	classification := ClassifyBatchUpdateResult(result.ModifiedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis))
	auditResult := "success"
	if classification != "SUCCESS" {
		auditResult = "failed"
	}

	// Strict audit — non-gating
	h.writeStrictAudit(r, audit.WriteAuditInput{
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
			"governanceMode":  "DIRECT_GOVERNED",
			"operation":       "SUBSCRIBER_BATCH_UPDATE",
			"actorRole":       fresh.NormalizedRole,
			"targetCount":     frozen.TargetCount,
			"fieldNames":      frozen.FieldNames,
			"modifiedCount":   result.ModifiedCount,
			"conflictCount":   len(result.ConflictImsis),
			"failedCount":     len(result.FailedImsis),
			"classification":  classification,
			"partialMutation": result.PartialMutation,
			"fingerprint":     frozen.OperationFingerprint,
		},
	}, fresh)

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
	})
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

	// Evaluate governance with fresh role
	result := EvaluateOperation(OpBulkDelete, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	h.executeDirectBulkDelete(w, r, frozen, fresh)
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

	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "subscriber.batch.delete",
		Module:   "subscribers",
		TargetID: "subscriber:bulk-delete",
		Result:   auditResult,
		Metadata: map[string]any{
			"governanceMode":         "DIRECT_GOVERNED",
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

// Import handles POST /api/subscribers/import
// Supports ?mode=precheck (semantic read) and ?mode=import (governed mutation).
func (h *WriteHandler) Import(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Capability check
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
		return
	}

	// Rate limit: 12 requests / 60 seconds / username
	if !h.limiter.Enforce(w, r, "subscribers:import:"+p.Username, 12, 60) {
		return
	}

	// Parse mode
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "precheck"
	}

	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	if mode == "precheck" {
		h.handleImportPrecheck(w, r, body)
		return
	}

	if mode == "import" {
		h.handleImportMutation(w, r, body, p)
		return
	}

	response.Error(w, http.StatusBadRequest, "Invalid mode parameter", "INVALID_MODE")
}

// handleImportPrecheck handles the precheck mode (semantic read).
func (h *WriteHandler) handleImportPrecheck(w http.ResponseWriter, r *http.Request, body map[string]any) {
	imsiListRaw, ok := body["imsiList"].([]any)
	if !ok {
		response.Error(w, http.StatusBadRequest, "imsiList array is required", "INVALID_REQUEST")
		return
	}

	var imsis []string
	for _, v := range imsiListRaw {
		s, ok := v.(string)
		if !ok {
			response.Error(w, http.StatusBadRequest, "Invalid IMSI in list", "INVALID_REQUEST")
			return
		}
		imsi, err := ValidateImsi(s)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "Invalid IMSI in list: "+s, "INVALID_REQUEST")
			return
		}
		imsis = append(imsis, imsi)
	}

	if len(imsis) > maxImportRows {
		response.Error(w, http.StatusBadRequest, "imsiList cannot contain more than 5000 entries", "INVALID_REQUEST")
		return
	}

	existsMap, err := h.effectiveImportRepo().FindSubscribersForImport(r.Context(), imsis)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Precheck failed", "INTERNAL_ERROR")
		return
	}

	conflicts := make([]map[string]any, 0, len(imsis))
	for _, imsi := range imsis {
		conflicts = append(conflicts, map[string]any{
			"imsi":   imsi,
			"exists": existsMap[imsi],
		})
	}

	existing := 0
	for _, c := range conflicts {
		if exists, _ := c["exists"].(bool); exists {
			existing++
		}
	}

	response.JSON(w, http.StatusOK, map[string]any{
		"total":     len(conflicts),
		"existing":  existing,
		"newCount":  len(conflicts) - existing,
		"conflicts": conflicts,
	})
}

// handleImportMutation handles the import mode (governed mutation).
func (h *WriteHandler) handleImportMutation(w http.ResponseWriter, r *http.Request, body map[string]any, p *auth.Principal) {
	// Validate request
	records, err := ValidateImportRequest(body)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			code := govErr.Code
			status := http.StatusBadRequest
			if code == ErrSensitiveChangeNotSupported || code == ErrImportOverwriteNotSupported {
				status = http.StatusUnprocessableEntity
			}
			response.Error(w, status, code, code)
		} else {
			response.Error(w, http.StatusBadRequest, "Invalid request", "INVALID_REQUEST")
		}
		return
	}

	// Tariff validation
	repo := h.effectiveImportRepo()
	for _, rec := range records {
		planId := defaultPlanId
		if v, ok := rec["plan_id"].(string); ok && v != "" {
			planId = v
		}
		if err := repo.ValidateTariffPlan(r.Context(), planId); err != nil {
			if govErr, ok := err.(*SubscriberGovernanceError); ok {
				code := govErr.Code
				status := http.StatusNotFound
				if code == "OCS_PLAN_DISABLED" {
					status = http.StatusConflict
				}
				response.Error(w, status, code, code)
			} else {
				response.Error(w, http.StatusInternalServerError, "Tariff validation failed", "INTERNAL_ERROR")
			}
			return
		}
	}

	// Fresh actor validation
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Prepare frozen v2
	frozen, err := PrepareFrozenImport(r.Context(), records, repo)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			code := govErr.Code
			status := http.StatusBadRequest
			if code == ErrApprovalSnapshotTooLarge {
				status = http.StatusRequestEntityTooLarge
			}
			response.Error(w, status, code, code)
		} else {
			response.Error(w, http.StatusInternalServerError, "Failed to prepare import", "INTERNAL_ERROR")
		}
		return
	}

	// Snapshot size check
	if frozen.SnapshotBytes > maxImportSnapshotBytes {
		response.Error(w, http.StatusBadRequest, ErrApprovalSnapshotTooLarge, ErrApprovalSnapshotTooLarge)
		return
	}

	// Evaluate governance with fresh role
	result := EvaluateOperation(OpImport, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	h.executeDirectImport(w, r, frozen, fresh)
}

// effectiveImportRepo returns the test seam or the real repository.
func (h *WriteHandler) effectiveImportRepo() ImportRepository {
	if h.importRepo != nil {
		return h.importRepo
	}
	return h.repo
}

// executeDirectImport executes import directly for super_admin/root.
func (h *WriteHandler) executeDirectImport(w http.ResponseWriter, r *http.Request, frozen *FrozenImportV2, fresh *FreshActor) {
	repo := h.effectiveImportRepo()

	execResult, err := ExecuteFrozenImport(r.Context(), frozen, repo)

	// Build result evidence for audit even on error
	if err != nil {
		if execResult == nil {
			execResult = &ImportExecutionResult{
				Requested:                  frozen.TargetCount,
				IntendedCreateCount:        frozen.Summary.CreateCount,
				OperationFingerprint:       frozen.OperationFingerprint,
				CreatedImsis:               []string{},
				SkippedImsis:               []string{},
				ConflictImsis:              []string{},
				FailedImsis:                []string{},
				OcsProvisionedImsis:        []string{},
				OcsProvisioningFailedImsis: []string{},
			}
		}
	}

	// Classification
	classification := ClassifyImportResult(
		execResult.CreatedCount,
		execResult.IntendedCreateCount,
		len(execResult.ConflictImsis),
		len(execResult.FailedImsis),
		len(execResult.OcsProvisioningFailedImsis),
	)

	// Business audit
	auditResult := "success"
	if classification != "SUCCESS" {
		auditResult = "failed"
	}
	if h.auditWriter != nil {
		if auditErr := h.auditWriter.WriteStrict(r.Context(), audit.WriteAuditInput{
			Action: "subscriber.import",
			Module: "subscribers",
			Actor: audit.ActorInput{
				Type:     "user",
				UserID:   fresh.UserID,
				Username: fresh.Username,
				Role:     fresh.NormalizedRole,
			},
			Resource:  &audit.ResourceInput{Type: "subscriber_import", ID: "csv-import"},
			TargetID:  "subscriber:csv-import",
			Result:    auditResult,
			RiskLevel: "high",
			Metadata: map[string]any{
				"governanceMode":              "DIRECT_GOVERNED",
				"actorRole":                   fresh.NormalizedRole,
				"risk":                        "high",
				"requested":                   execResult.Requested,
				"intendedCreateCount":         execResult.IntendedCreateCount,
				"createdCount":                execResult.CreatedCount,
				"skipCount":                   len(execResult.SkippedImsis),
				"conflictCount":               len(execResult.ConflictImsis),
				"failedCount":                 len(execResult.FailedImsis),
				"ocsProvisioningFailureCount": len(execResult.OcsProvisioningFailedImsis),
				"fileHash":                    frozen.Summary.FileHash,
				"operationFingerprint":        frozen.OperationFingerprint,
				"classification":              classification,
				"partialMutation":             execResult.PartialMutation,
				"mutationCommitted":           execResult.MutationCommitted,
			},
		}); auditErr != nil {
			slog.Error("subscriber_import_audit_failed", "error", auditErr)
		}
	}

	// Handle errors from execution
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok {
			switch govErr.Code {
			case ErrImportPreconditionChanged:
				response.Error(w, http.StatusConflict, govErr.Code, govErr.Code)
			case ErrImportFailed:
				response.Error(w, http.StatusInternalServerError, govErr.Code, govErr.Code)
			default:
				response.Error(w, http.StatusInternalServerError, govErr.Code, govErr.Code)
			}
		} else {
			response.Error(w, http.StatusInternalServerError, "Import failed", "INTERNAL_ERROR")
		}
		return
	}

	// Handle partial write
	if classification == "PARTIAL_WRITE" {
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":                      ErrImportPartialWrite,
			"code":                       ErrImportPartialWrite,
			"requested":                  execResult.Requested,
			"imported":                   execResult.CreatedCount,
			"skipped":                    len(execResult.SkippedImsis),
			"failed":                     len(execResult.FailedImsis),
			"importedImsis":              execResult.CreatedImsis,
			"failedImsis":                execResult.FailedImsis,
			"ocsProvisioningFailedImsis": execResult.OcsProvisioningFailedImsis,
			"partialMutation":            true,
			"mutationCommitted":          true,
		})
		return
	}

	// Handle FAILED_NO_MUTATION: distinguish precondition from storage failure
	if classification == "FAILED_NO_MUTATION" {
		if len(execResult.ConflictImsis) > 0 {
			response.JSON(w, http.StatusConflict, map[string]any{
				"error":             ErrImportPreconditionChanged,
				"code":              ErrImportPreconditionChanged,
				"requested":         execResult.Requested,
				"imported":          execResult.CreatedCount,
				"skipped":           len(execResult.SkippedImsis),
				"conflictImsis":     execResult.ConflictImsis,
				"partialMutation":   false,
				"mutationCommitted": false,
			})
		} else {
			response.JSON(w, http.StatusInternalServerError, map[string]any{
				"error":             ErrImportFailed,
				"code":              ErrImportFailed,
				"requested":         execResult.Requested,
				"imported":          execResult.CreatedCount,
				"partialMutation":   false,
				"mutationCommitted": false,
			})
		}
		return
	}

	// SUCCESS
	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "executed",
		"message": "Subscribers imported successfully",
		"result": map[string]any{
			"requested":                  execResult.Requested,
			"imported":                   execResult.CreatedCount,
			"skipped":                    len(execResult.SkippedImsis),
			"failed":                     len(execResult.FailedImsis),
			"importedImsis":              execResult.CreatedImsis,
			"failedImsis":                execResult.FailedImsis,
			"ocsProvisioningFailedImsis": execResult.OcsProvisioningFailedImsis,
		},
	})
}

// ProfileApply handles POST /api/subscribers/{imsi}/profile
// Applies profile auth/AMBR/slices to subscriber with governance:
// Canonical admin/operator roles execute directly; viewer is denied.
// Ordering: auth → capability check → rate limit → body validation → fresh actor → prepare → governance → execute/approve
func (h *WriteHandler) ProfileApply(w http.ResponseWriter, r *http.Request) {
	imsi := r.PathValue("imsi")
	if imsi == "" {
		response.Error(w, http.StatusBadRequest, "Missing IMSI", "INVALID_IMSI")
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
	if !h.limiter.Enforce(w, r, "subscribers:profile-apply:"+p.Username, 30, 60) {
		return
	}

	// Parse body
	var body struct {
		ProfileName string `json:"profileName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}
	if body.ProfileName == "" {
		response.Error(w, http.StatusBadRequest, "profileName is required", "INVALID_PROFILE_NAME")
		return
	}

	// Fresh actor validation — mandatory, fail-closed
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Prepare frozen intent
	intent, err := PrepareFrozenSubscriberProfileApply(
		r.Context(), imsi, strings.TrimSpace(body.ProfileName),
		h.repo.FindSubscriberByImsi, h.repo.FindProfileByName,
	)
	if err != nil {
		h.handleProfileApplyError(w, err)
		return
	}

	// Evaluate governance with fresh role
	result := EvaluateOperation(OpProfileApply, fresh.NormalizedRole)
	if !isExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	reqID := middleware.RequestIDFromContext(r.Context())

	slog.Info("profile_apply_start",
		"operation", "SUBSCRIBER_PROFILE_APPLY",
		"request_id", reqID,
		"principal", fresh.Username,
		"role", fresh.NormalizedRole,
		"governance_mode", "DIRECT_GOVERNED",
		"imsi", imsi,
		"profile", strings.TrimSpace(body.ProfileName),
	)
	h.executeDirectProfileApply(w, r, intent, fresh)
}

// executeDirectProfileApply handles DIRECT_GOVERNED profile apply execution.
func (h *WriteHandler) executeDirectProfileApply(w http.ResponseWriter, r *http.Request, intent *FrozenSubscriberProfileApplyV1, fresh *FreshActor) {
	// Re-assert current state
	assertion, err := AssertFrozenSubscriberProfileApply(
		r.Context(), *intent,
		h.repo.FindSubscriberByImsi, h.repo.FindProfileByName,
	)
	if err != nil {
		h.handleProfileApplyError(w, err)
		return
	}
	if assertion == nil {
		// Drift detected
		slog.Warn("profile_apply_drift",
			"operation", "SUBSCRIBER_PROFILE_APPLY",
			"request_id", middleware.RequestIDFromContext(r.Context()),
			"principal", fresh.Username,
			"governance_mode", "DIRECT_GOVERNED",
			"imsi", intent.Imsi,
			"profile", intent.ProfileName,
			"result", "PRECONDITION_CHANGED",
		)
		h.writeProfileApplyAudit(r, intent, fresh, "failed", "DIRECT_GOVERNED", "PRECONDITION_CHANGED", false, false)
		response.JSON(w, http.StatusConflict, map[string]any{
			"error":     "Subscriber or Profile changed since preparation",
			"code":      "SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED",
			"committed": false,
		})
		return
	}

	// Execute CAS
	execResult, err := ExecuteFrozenSubscriberProfileApply(
		r.Context(), assertion, fresh.Username,
		h.repo.ReplaceSubscriberCAS,
	)
	if err != nil {
		if govErr, ok := err.(*SubscriberGovernanceError); ok && govErr.Code == "SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED" {
			h.writeProfileApplyAudit(r, intent, fresh, "failed", "DIRECT_GOVERNED", "PRECONDITION_CHANGED", false, false)
			response.JSON(w, http.StatusConflict, map[string]any{
				"error":     "Subscriber changed during execution",
				"code":      "SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED",
				"committed": false,
			})
			return
		}
		h.writeProfileApplyAudit(r, intent, fresh, "failed", "DIRECT_GOVERNED", "FAILED_NO_MUTATION", false, false)
		response.Error(w, http.StatusInternalServerError, "Profile apply failed", "SUBSCRIBER_PROFILE_APPLY_FAILED")
		return
	}

	// Non-gating audit log
	h.writeProfileApplyAudit(r, intent, fresh, "success", "DIRECT_GOVERNED", execResult.Classification, execResult.Committed, execResult.SecurityChanged)

	slog.Info("profile_apply_success",
		"operation", "SUBSCRIBER_PROFILE_APPLY",
		"request_id", middleware.RequestIDFromContext(r.Context()),
		"principal", fresh.Username,
		"governance_mode", "DIRECT_GOVERNED",
		"imsi", intent.Imsi,
		"profile", intent.ProfileName,
		"result", "success",
	)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome":     "executed",
		"message":     "Profile applied successfully",
		"imsi":        intent.Imsi,
		"profileName": intent.ProfileName,
	})
}

// writeProfileApplyAudit writes an audit entry for profile apply.
func (h *WriteHandler) writeProfileApplyAudit(r *http.Request, intent *FrozenSubscriberProfileApplyV1, fresh *FreshActor, result, governanceMode, classification string, committed, securityChanged bool) {
	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "SUBSCRIBER_PROFILE_APPLY",
		Module:   "subscribers",
		TargetID: intent.Imsi,
		Before:   intent.Before,
		After:    intent.AfterPreview,
		Result:   result,
		Metadata: map[string]any{
			"governanceMode":             governanceMode,
			"profileName":                intent.ProfileName,
			"subscriberPreconditionHash": intent.SubscriberPreconditionHash,
			"profilePreconditionHash":    intent.ProfilePreconditionHash,
			"operationFingerprint":       intent.OperationFingerprint,
			"classification":             classification,
			"mutationCommitted":          committed,
			"securityChanged":            securityChanged,
			"actorRole":                  fresh.NormalizedRole,
		},
	}, fresh)
}

// handleProfileApplyError handles errors from profile apply operations.
func (h *WriteHandler) handleProfileApplyError(w http.ResponseWriter, err error) {
	if govErr, ok := err.(*SubscriberGovernanceError); ok {
		switch govErr.Code {
		case "SUBSCRIBER_NOT_FOUND":
			response.Error(w, http.StatusNotFound, "Subscriber not found", govErr.Code)
		case "PROFILE_NOT_FOUND":
			response.Error(w, http.StatusNotFound, "Profile not found", govErr.Code)
		case "INVALID_PROFILE_NAME":
			response.Error(w, http.StatusBadRequest, "profileName is required", govErr.Code)
		case "SUBSCRIBER_PROFILE_APPLY_NO_EFFECT":
			response.JSON(w, http.StatusOK, map[string]any{
				"outcome":        "no_effect",
				"classification": "NO_EFFECT",
				"message":        "Profile is already applied",
			})
		default:
			response.Error(w, http.StatusInternalServerError, "Profile apply error", govErr.Code)
		}
		return
	}
	response.Error(w, http.StatusInternalServerError, "Internal server error", "INTERNAL_ERROR")
}
