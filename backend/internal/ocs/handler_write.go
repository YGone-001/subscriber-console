package ocs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/approval"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
	"subscriber/internal/user"
)

var imsiRegex = regexp.MustCompile(`^[0-9]{15}$`)

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// ApprovalCreator is the interface for creating approval requests.
type ApprovalCreator interface {
	Create(r *http.Request, actor approval.GovernanceActor, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error)
}

// RateLimiter abstracts rate limiting for handler testing.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// SubscriberWriteHandler provides HTTP handlers for OCS subscriber contract write endpoints.
type SubscriberWriteHandler struct {
	repo        *Repository
	limiter     RateLimiter
	userRepo    UserRepository
	approvalSvc ApprovalCreator
	auditWriter *audit.Writer
}

// NewSubscriberWriteHandler creates a new OCS subscriber write handler.
func NewSubscriberWriteHandler(repo *Repository, limiter RateLimiter, userRepo UserRepository, approvalSvc ApprovalCreator, auditWriter *audit.Writer) *SubscriberWriteHandler {
	return &SubscriberWriteHandler{
		repo:        repo,
		limiter:     limiter,
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: auditWriter,
	}
}

// ── Request bodies ─────────────────────────────────────────────────────────

type createContractBody struct {
	IMSI   string `json:"imsi"`
	MSISDN string `json:"msisdn"`
	PlanID string `json:"plan_id"`
	Status string `json:"status"`
}

type updateTariffBody struct {
	PlanID string `json:"plan_id"`
}

// ── Create ─────────────────────────────────────────────────────────────────

// Create handles POST /api/ocs/subscribers
// Creates an OCS subscriber contract with governance: super_admin/root → DIRECT, operator → APPROVAL.
func (h *SubscriberWriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.subscriber.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "ocs-subscribers:create:"+p.Username, 20, 60) {
		return
	}

	var body createContractBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	imsi := strings.TrimSpace(body.IMSI)
	if !imsiRegex.MatchString(imsi) {
		response.Error(w, http.StatusBadRequest, "Invalid IMSI format", "OCS_INVALID_IMSI")
		return
	}

	planID := strings.TrimSpace(body.PlanID)
	if planID == "" {
		planID = "plan_default_10gb"
	}

	// Validate tariff plan exists and is active
	tariffStatus, err := h.repo.GetTariffPlanStatus(r.Context(), planID)
	if err != nil {
		if err.Error() == "OCS_TARIFF_NOT_FOUND" {
			response.Error(w, http.StatusBadRequest, "Tariff plan not found", "OCS_TARIFF_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	if tariffStatus == "disabled" {
		response.Error(w, http.StatusBadRequest, "Cannot bind to disabled tariff plan", "OCS_TARIFF_DISABLED")
		return
	}

	fresh, httpErr := revalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateSubscriberOperation(OpContractCreate, fresh.NormalizedRole)
	if !isSubscriberOpExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	doc := bson.M{
		"imsi":    imsi,
		"msisdn":  strings.TrimSpace(body.MSISDN),
		"plan_id": planID,
		"status":  nonEmptyStr(body.Status, "active"),
	}

	if result.Decision == governance.Direct {
		if err := h.repo.CreateSubscriberContract(r.Context(), doc); err != nil {
			if err.Error() == "OCS_SUBSCRIBER_EXISTS" {
				response.Error(w, http.StatusConflict, "OCS subscriber contract already exists", "OCS_SUBSCRIBER_EXISTS")
				return
			}
			response.InternalError(w)
			return
		}

		h.writeSubscriberAudit(r, audit.WriteAuditInput{
			Action:   "CREATE",
			Module:   "ocs-subscribers",
			TargetID: fmt.Sprintf("ocs-subscriber:%s", imsi),
			After:    doc,
			Result:   "success",
			Metadata: map[string]interface{}{
				"governanceMode":   "DIRECT_GOVERNED",
				"approvalRequired": false,
				"operation":        string(OpContractCreate),
				"actorRole":        fresh.NormalizedRole,
			},
		}, fresh)

		response.JSON(w, http.StatusCreated, map[string]any{
			"outcome": "executed",
			"message": "OCS subscriber contract created successfully",
			"imsi":    imsi,
		})
		return
	}

	// APPROVAL
	actor := approval.GovernanceActor{
		Type: "user", UserID: fresh.UserID, Username: fresh.Username, Role: fresh.RawRole,
	}
	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           string(OpContractCreate),
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         fmt.Sprintf("ocs-subscriber:%s", imsi),
		Summary:          fmt.Sprintf("Create OCS subscriber contract for %s", imsi),
		Operation: &approval.ApprovalOperation{
			ResourceType: "ocs_subscriber", ResourceID: imsi,
		},
		Payload: map[string]interface{}{
			"schema":   "ocs-subscriber-v1",
			"contract": doc,
		},
	})
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create subscriber contract approval", "APPROVAL_CREATE_FAILED")
		return
	}

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  "Approval required before OCS subscriber contract creation",
		"approval": approvalDoc,
	})
}

// ── Update Tariff Binding ──────────────────────────────────────────────────

// UpdateTariff handles PATCH /api/ocs/subscribers/{imsi}
// Updates the tariff plan binding for an OCS subscriber contract.
func (h *SubscriberWriteHandler) UpdateTariff(w http.ResponseWriter, r *http.Request) {
	imsi := r.PathValue("imsi")
	if imsi == "" || !imsiRegex.MatchString(imsi) {
		response.Error(w, http.StatusBadRequest, "Valid IMSI is required", "OCS_INVALID_IMSI")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.subscriber.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "ocs-subscribers:update:"+p.Username, 20, 60) {
		return
	}

	var body updateTariffBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	planID := strings.TrimSpace(body.PlanID)
	if planID == "" {
		response.Error(w, http.StatusBadRequest, "plan_id is required", "OCS_PLAN_ID_REQUIRED")
		return
	}

	// Validate tariff plan exists and is active
	tariffStatus, err := h.repo.GetTariffPlanStatus(r.Context(), planID)
	if err != nil {
		if err.Error() == "OCS_TARIFF_NOT_FOUND" {
			response.Error(w, http.StatusBadRequest, "Tariff plan not found", "OCS_TARIFF_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	if tariffStatus == "disabled" {
		response.Error(w, http.StatusBadRequest, "Cannot bind to disabled tariff plan", "OCS_TARIFF_DISABLED")
		return
	}

	fresh, httpErr := revalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateSubscriberOperation(OpContractUpdate, fresh.NormalizedRole)
	if !isSubscriberOpExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	before, err := h.repo.GetSubscriberRaw(r.Context(), imsi)
	if err != nil {
		response.InternalError(w)
		return
	}
	if before == nil {
		response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
		return
	}

	if result.Decision == governance.Direct {
		if err := h.repo.UpdateTariffBinding(r.Context(), imsi, planID); err != nil {
			if err.Error() == "OCS_SUBSCRIBER_NOT_FOUND" {
				response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
				return
			}
			response.InternalError(w)
			return
		}

		after := copyBson(before)
		after["plan_id"] = planID

		h.writeSubscriberAudit(r, audit.WriteAuditInput{
			Action:   "UPDATE",
			Module:   "ocs-subscribers",
			TargetID: fmt.Sprintf("ocs-subscriber:%s", imsi),
			Before:   before,
			After:    after,
			Result:   "success",
			Metadata: map[string]interface{}{
				"governanceMode":   "DIRECT_GOVERNED",
				"approvalRequired": false,
				"operation":        string(OpContractUpdate),
				"actorRole":        fresh.NormalizedRole,
			},
		}, fresh)

		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "Tariff binding updated successfully",
			"imsi":    imsi,
		})
		return
	}

	// APPROVAL
	actor := approval.GovernanceActor{
		Type: "user", UserID: fresh.UserID, Username: fresh.Username, Role: fresh.RawRole,
	}
	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           string(OpContractUpdate),
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         fmt.Sprintf("ocs-subscriber:%s", imsi),
		Summary:          fmt.Sprintf("Update tariff binding for OCS subscriber %s to %s", imsi, planID),
		Operation: &approval.ApprovalOperation{
			ResourceType: "ocs_subscriber", ResourceID: imsi,
		},
		Before: before,
		Payload: map[string]interface{}{
			"schema":  "ocs-subscriber-v1",
			"imsi":    imsi,
			"plan_id": planID,
		},
	})
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create tariff binding approval", "APPROVAL_CREATE_FAILED")
		return
	}

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  "Approval required before tariff binding update",
		"approval": approvalDoc,
	})
}

// ── Suspend ────────────────────────────────────────────────────────────────

// Suspend handles POST /api/ocs/subscribers/{imsi}/suspend
func (h *SubscriberWriteHandler) Suspend(w http.ResponseWriter, r *http.Request) {
	h.setContractStatus(w, r, "suspended")
}

// ── Resume ─────────────────────────────────────────────────────────────────

// Resume handles POST /api/ocs/subscribers/{imsi}/resume
func (h *SubscriberWriteHandler) Resume(w http.ResponseWriter, r *http.Request) {
	h.setContractStatus(w, r, "active")
}

func (h *SubscriberWriteHandler) setContractStatus(w http.ResponseWriter, r *http.Request, status string) {
	imsi := r.PathValue("imsi")
	if imsi == "" || !imsiRegex.MatchString(imsi) {
		response.Error(w, http.StatusBadRequest, "Valid IMSI is required", "OCS_INVALID_IMSI")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.subscriber.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "ocs-subscribers:status:"+p.Username, 20, 60) {
		return
	}

	fresh, httpErr := revalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Suspend uses SUSPEND governance, Resume uses RESUME governance
	op := OpContractSuspend
	if status == "active" {
		op = OpContractResume
	}

	result := EvaluateSubscriberOperation(op, fresh.NormalizedRole)
	if !isSubscriberOpExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	before, err := h.repo.GetSubscriberRaw(r.Context(), imsi)
	if err != nil {
		response.InternalError(w)
		return
	}
	if before == nil {
		response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
		return
	}

	// No-op if already in target status
	currentStatus, _ := before["status"].(string)
	if currentStatus == status {
		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": fmt.Sprintf("OCS subscriber contract already %s", status),
			"imsi":    imsi,
		})
		return
	}

	if result.Decision == governance.Direct {
		if err := h.repo.SetContractStatus(r.Context(), imsi, status); err != nil {
			if err.Error() == "OCS_SUBSCRIBER_NOT_FOUND" {
				response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
				return
			}
			response.InternalError(w)
			return
		}

		after := copyBson(before)
		after["status"] = status

		h.writeSubscriberAudit(r, audit.WriteAuditInput{
			Action:   "UPDATE",
			Module:   "ocs-subscribers",
			TargetID: fmt.Sprintf("ocs-subscriber:%s", imsi),
			Before:   before,
			After:    after,
			Result:   "success",
			Metadata: map[string]interface{}{
				"governanceMode":   "DIRECT_GOVERNED",
				"approvalRequired": false,
				"operation":        string(op),
				"actorRole":        fresh.NormalizedRole,
				"statusChange":     status,
			},
		}, fresh)

		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": fmt.Sprintf("OCS subscriber contract %sd successfully", status),
			"imsi":    imsi,
		})
		return
	}

	// APPROVAL
	actor := approval.GovernanceActor{
		Type: "user", UserID: fresh.UserID, Username: fresh.Username, Role: fresh.RawRole,
	}
	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           string(op),
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         fmt.Sprintf("ocs-subscriber:%s", imsi),
		Summary:          fmt.Sprintf("%s OCS subscriber contract %s", capitalizeStr(status), imsi),
		Operation: &approval.ApprovalOperation{
			ResourceType: "ocs_subscriber", ResourceID: imsi,
		},
		Before: before,
		Payload: map[string]interface{}{
			"schema":       "ocs-subscriber-v1",
			"imsi":         imsi,
			"statusChange": status,
		},
	})
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create subscriber contract approval", "APPROVAL_CREATE_FAILED")
		return
	}

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  fmt.Sprintf("Approval required before OCS subscriber contract %s", status),
		"approval": approvalDoc,
	})
}

// ── Terminate ──────────────────────────────────────────────────────────────

// Terminate handles DELETE /api/ocs/subscribers/{imsi}
func (h *SubscriberWriteHandler) Terminate(w http.ResponseWriter, r *http.Request) {
	imsi := r.PathValue("imsi")
	if imsi == "" || !imsiRegex.MatchString(imsi) {
		response.Error(w, http.StatusBadRequest, "Valid IMSI is required", "OCS_INVALID_IMSI")
		return
	}

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequireCapabilityWithAudit(w, r, p, "ocs.subscriber.write", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "ocs-subscribers:terminate:"+p.Username, 20, 60) {
		return
	}

	fresh, httpErr := revalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	result := EvaluateSubscriberOperation(OpContractTerminate, fresh.NormalizedRole)
	if !isSubscriberOpExecutable(result) {
		response.Error(w, http.StatusConflict, "Operation not executable", "OPERATION_NOT_EXECUTABLE")
		return
	}

	before, err := h.repo.GetSubscriberRaw(r.Context(), imsi)
	if err != nil {
		response.InternalError(w)
		return
	}
	if before == nil {
		response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
		return
	}

	if result.Decision == governance.Direct {
		if err := h.repo.TerminateContract(r.Context(), imsi); err != nil {
			if err.Error() == "OCS_SUBSCRIBER_NOT_FOUND" {
				response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
				return
			}
			response.InternalError(w)
			return
		}

		h.writeSubscriberAudit(r, audit.WriteAuditInput{
			Action:   "DELETE",
			Module:   "ocs-subscribers",
			TargetID: fmt.Sprintf("ocs-subscriber:%s", imsi),
			Before:   before,
			Result:   "success",
			Metadata: map[string]interface{}{
				"governanceMode":   "DIRECT_GOVERNED",
				"approvalRequired": false,
				"operation":        string(OpContractTerminate),
				"actorRole":        fresh.NormalizedRole,
			},
		}, fresh)

		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "OCS subscriber contract terminated successfully",
			"imsi":    imsi,
		})
		return
	}

	// APPROVAL
	actor := approval.GovernanceActor{
		Type: "user", UserID: fresh.UserID, Username: fresh.Username, Role: fresh.RawRole,
	}
	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           string(OpContractTerminate),
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         fmt.Sprintf("ocs-subscriber:%s", imsi),
		Summary:          fmt.Sprintf("Terminate OCS subscriber contract %s", imsi),
		Operation: &approval.ApprovalOperation{
			ResourceType: "ocs_subscriber", ResourceID: imsi,
		},
		Before: before,
		Payload: map[string]interface{}{
			"schema": "ocs-subscriber-v1",
			"imsi":   imsi,
		},
	})
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.Error(w, http.StatusInternalServerError, "Failed to create subscriber termination approval", "APPROVAL_CREATE_FAILED")
		return
	}

	response.JSON(w, http.StatusAccepted, map[string]any{
		"outcome":  "approval_required",
		"message":  "Approval required before OCS subscriber contract termination",
		"approval": approvalDoc,
	})
}

// ── Helpers ────────────────────────────────────────────────────────────────

func (h *SubscriberWriteHandler) writeSubscriberAudit(r *http.Request, input audit.WriteAuditInput, actor *freshActor) {
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

func isSubscriberOpExecutable(result governance.Result) bool {
	return result.Decision != governance.Disabled && result.Decision != governance.RuntimeOnly
}

func nonEmptyStr(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}

func capitalizeStr(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func copyBson(src bson.M) bson.M {
	dst := make(bson.M, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

// freshActor is local to the OCS write handler.
// It mirrors tariff.FreshActor to avoid circular imports.
type freshActor struct {
	UserID         string
	Username       string
	RawRole        string
	NormalizedRole string
	SessionVersion int64
}

// freshActorHTTPError represents an HTTP error during fresh actor validation.
type freshActorHTTPError struct {
	Status  int
	Message string
	Code    string
}

// revalidateFreshActor loads fresh user state from the DB and validates it.
func revalidateFreshActor(ctx context.Context, userRepo UserRepository, p *auth.Principal) (*freshActor, *freshActorHTTPError) {
	if userRepo == nil {
		return nil, &freshActorHTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "User validation service unavailable",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}

	identity, err := userRepo.FindByUsernameIdentity(ctx, p.Username)
	if err != nil {
		return nil, &freshActorHTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "Unable to validate user session",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}
	if identity == nil {
		return nil, &freshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account not found",
			Code:    "AUTH_USER_NOT_FOUND",
		}
	}

	if identity.SafeUser.Status != "active" {
		return nil, &freshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is disabled",
			Code:    "AUTH_USER_DISABLED",
		}
	}

	if identity.SafeUser.Locked {
		return nil, &freshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is locked",
			Code:    "AUTH_USER_LOCKED",
		}
	}

	dbRole := auth.NormalizeRole(identity.SafeUser.Role)
	if dbRole == "" {
		return nil, &freshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Unknown user role",
			Code:    "AUTH_UNKNOWN_ROLE",
		}
	}

	if dbRole != p.NormalizedRole {
		return nil, &freshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Session role mismatch",
			Code:    "AUTH_ROLE_MISMATCH",
		}
	}

	dbSessionVersion := int64(0)
	if identity.SafeUser.Security != nil {
		dbSessionVersion = int64(identity.SafeUser.Security.SessionVersion)
	}
	if dbSessionVersion != p.SessionVersion {
		return nil, &freshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Session has been revoked",
			Code:    "SESSION_REVOKED",
		}
	}

	actor := &freshActor{
		UserID:         identity.MongoID,
		Username:       identity.SafeUser.Username,
		RawRole:        identity.SafeUser.Role,
		NormalizedRole: dbRole,
		SessionVersion: dbSessionVersion,
	}
	if actor.UserID == "" {
		actor.UserID = actor.Username
	}

	return actor, nil
}
