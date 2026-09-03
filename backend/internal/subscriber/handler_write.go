package subscriber

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

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
// Creates a new subscriber. Super_admin only for now.
func (h *WriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Rate limit
	if !h.limiter.Enforce(w, r, "subscribers:create:"+p.Username, 30, 60) {
		return
	}

	// Fresh actor validation
	freshRole, err := h.validateFreshActor(r.Context(), p)
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, "Unable to validate user session", "AUTH_SERVICE_UNAVAILABLE")
		return
	}
	if freshRole == "" {
		response.Error(w, http.StatusForbidden, "User account is disabled or locked", "AUTH_USER_DISABLED")
		return
	}

	// Only super_admin can create subscribers directly
	if !governance.IsSuperAdminRole(freshRole) {
		response.Error(w, http.StatusForbidden, "Insufficient permissions", "AUTH_INSUFFICIENT_PERMISSIONS")
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

	// Check if subscriber already exists
	existing, err := h.repo.FindSubscriberByImsi(r.Context(), imsi)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Internal Server Error", "INTERNAL_ERROR")
		return
	}
	if existing != nil {
		response.Error(w, http.StatusConflict, "Subscriber already exists", "SUBSCRIBER_EXISTS")
		return
	}

	// TODO: Implement actual subscriber creation logic
	response.Error(w, http.StatusNotImplemented, "Subscriber creation not yet implemented", "NOT_IMPLEMENTED")
}

// Update handles PUT /api/subscribers/{imsi}
// Updates a subscriber with governance: super_admin→DIRECT, operator→APPROVAL.
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

	// Check governance policy
	result := EvaluateOperation(OpUpdate, p.NormalizedRole)
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

	// Fresh actor validation
	freshRole, err := h.validateFreshActor(r.Context(), p)
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, "Unable to validate user session", "AUTH_SERVICE_UNAVAILABLE")
		return
	}
	if freshRole == "" {
		response.Error(w, http.StatusForbidden, "User account is disabled or locked", "AUTH_USER_DISABLED")
		return
	}
	if freshRole != p.NormalizedRole {
		response.Error(w, http.StatusForbidden, "Session role mismatch", "AUTH_ROLE_MISMATCH")
		return
	}

	if result.Decision == governance.Direct {
		// Super Admin: DIRECT_GOVERNED — execute immediately
		execResult, err := ExecuteFrozenSubscriberUpdate(r.Context(), frozen, h.repo.FindSubscriberByImsi, h.repo.UpdateSubscriberFromLegacy)
		if err != nil {
			h.handleGovernanceError(w, err)
			return
		}

		// Audit: committed=true, never rollback on audit failure
		h.writeStrictAudit(r, audit.WriteAuditInput{
			Action:   "UPDATE",
			Module:   "subscriber",
			TargetID: imsi,
			Before:   frozen.Before,
			After:    execResult.After,
			Result:   "success",
		}, p, freshRole)

		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "Subscriber updated successfully",
			"imsi":    imsi,
		})
		return
	}

	// Normal operator: APPROVAL_GOVERNED — create approval
	reason := r.URL.Query().Get("reason")
	var reasonPtr *string
	if reason != "" {
		reasonPtr = &reason
	}

	actor := approval.GovernanceActor{
		Type:     "user",
		Username: p.Username,
		Role:     freshRole,
	}

	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:               "SUBSCRIBER_UPDATE",
		Requester:            p.Username,
		RequesterContext:     &actor,
		TargetID:             imsi,
		Summary:              fmt.Sprintf("Update governed subscriber configuration for %s", imsi),
		OperationFingerprint: frozen.OperationFingerprint,
		Reason:               reasonPtr,
		Before:               frozen.Before,
		After:                frozen.After,
		Payload:              frozenToMap(frozen),
	})
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to create approval request", "APPROVAL_CREATE_FAILED")
		return
	}

	// Audit the approval creation
	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "UPDATE",
		Module:   "approval",
		TargetID: "approval:" + approvalDoc.ChangeID,
		After:    approvalDoc,
		Result:   "success",
	}, p, freshRole)

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  "Approval required before subscriber update",
		"approval": approvalDoc,
	})
}

// Delete handles DELETE /api/subscribers/{imsi}
// Deletes a subscriber with governance: super_admin→DIRECT, operator→APPROVAL.
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

	// Check governance policy
	result := EvaluateOperation(OpDelete, p.NormalizedRole)
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

	// Fresh actor validation
	freshRole, err := h.validateFreshActor(r.Context(), p)
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, "Unable to validate user session", "AUTH_SERVICE_UNAVAILABLE")
		return
	}
	if freshRole == "" {
		response.Error(w, http.StatusForbidden, "User account is disabled or locked", "AUTH_USER_DISABLED")
		return
	}
	if freshRole != p.NormalizedRole {
		response.Error(w, http.StatusForbidden, "Session role mismatch", "AUTH_ROLE_MISMATCH")
		return
	}

	if result.Decision == governance.Direct {
		// Super Admin: DIRECT_GOVERNED — execute immediately
		execResult, err := ExecuteFrozenSubscriberDelete(r.Context(), frozen, h.repo.FindSubscriberByImsi, h.repo.DeleteSubscriber)
		if err != nil {
			h.handleGovernanceError(w, err)
			return
		}

		// Audit: committed=true, never rollback on audit failure
		h.writeStrictAudit(r, audit.WriteAuditInput{
			Action:   "DELETE",
			Module:   "subscriber",
			TargetID: imsi,
			Before:   frozen.Before,
			After:    map[string]any{"deleted": true, "imsi": imsi},
			Result:   "success",
		}, p, freshRole)

		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "Subscriber deleted successfully",
			"imsi":    imsi,
			"deleted": execResult.Deleted,
		})
		return
	}

	// Normal operator: APPROVAL_GOVERNED — create approval
	reason := r.URL.Query().Get("reason")
	var reasonPtr *string
	if reason != "" {
		reasonPtr = &reason
	}

	actor := approval.GovernanceActor{
		Type:     "user",
		Username: p.Username,
		Role:     freshRole,
	}

	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:               "SUBSCRIBER_DELETE",
		Requester:            p.Username,
		RequesterContext:     &actor,
		TargetID:             imsi,
		Summary:              fmt.Sprintf("Delete subscriber %s", imsi),
		OperationFingerprint: frozen.OperationFingerprint,
		Reason:               reasonPtr,
		Before:               frozen.Before,
		Payload:              frozenToMap(frozen),
	})
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to create approval request", "APPROVAL_CREATE_FAILED")
		return
	}

	// Audit the approval creation
	h.writeStrictAudit(r, audit.WriteAuditInput{
		Action:   "UPDATE",
		Module:   "approval",
		TargetID: "approval:" + approvalDoc.ChangeID,
		After:    approvalDoc,
		Result:   "success",
	}, p, freshRole)

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  "Approval required before subscriber deletion",
		"approval": approvalDoc,
	})
}

// validateFreshActor loads fresh user state from the DB and returns the normalized role.
// Returns empty string if user is disabled, locked, or not found.
func (h *WriteHandler) validateFreshActor(ctx context.Context, p *auth.Principal) (string, error) {
	if h.userRepo == nil {
		// No user repo available — fall back to token-only
		return p.NormalizedRole, nil
	}
	identity, err := h.userRepo.FindByUsernameIdentity(ctx, p.Username)
	if err != nil {
		return "", err
	}
	if identity == nil {
		return "", nil
	}
	// Check user is enabled and not locked
	if identity.SafeUser.Locked || identity.SafeUser.Status != "active" {
		return "", nil
	}
	// Normalize the DB role
	dbRole := auth.NormalizeRole(identity.SafeUser.Role)
	if dbRole == "" {
		return "", nil
	}
	return dbRole, nil
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
	default:
		response.Error(w, http.StatusConflict, govErr.Code, govErr.Code)
	}
}

// writeStrictAudit writes a strict audit record. Never rolls back on failure.
func (h *WriteHandler) writeStrictAudit(r *http.Request, input audit.WriteAuditInput, p *auth.Principal, freshRole string) {
	input.Actor = audit.ActorInput{
		Username: p.Username,
		Role:     freshRole,
	}
	input.Source = &audit.SourceInput{
		IP:        r.RemoteAddr,
		UserAgent: r.UserAgent(),
	}
	// Strict audit: committed=true on failure, never rollback
	_ = h.auditWriter.WriteStrict(r.Context(), input)
}

// frozenToMap converts a frozen state to a map for the approval payload.
func frozenToMap(v any) map[string]any {
	data, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	return m
}

// CreateSubscriberBody is the request body for POST /api/subscribers.
type CreateSubscriberBody struct {
	Imsi string `json:"imsi"`
	// Additional fields TBD
}
