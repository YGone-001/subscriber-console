package ocs

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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

var imsiRegex = regexp.MustCompile(`^[0-9]{15}$`)

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// RateLimiter abstracts rate limiting for handler testing.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// ContractProvisioner provisions a billing contract and balance account for a
// subscriber identity that already exists. The implementation lives with the
// subscriber repository so the OCS collections have one provisioning writer.
type ContractProvisioner interface {
	ProvisionContractForExistingSubscriber(ctx context.Context, imsi, planID, requestedMsisdn string, ocsTraffic map[string]any) (contract bson.M, balanceAdopted bool, err error)
}

// SubscriberWriteHandler provides HTTP handlers for OCS subscriber contract write endpoints.
type SubscriberWriteHandler struct {
	repo                *Repository
	limiter             RateLimiter
	userRepo            UserRepository
	auditWriter         *audit.Writer
	contractProvisioner ContractProvisioner
}

// NewSubscriberWriteHandler creates a new OCS subscriber write handler.
func NewSubscriberWriteHandler(repo *Repository, limiter RateLimiter, userRepo UserRepository, auditWriter *audit.Writer) *SubscriberWriteHandler {
	return &SubscriberWriteHandler{
		repo:        repo,
		limiter:     limiter,
		userRepo:    userRepo,
		auditWriter: auditWriter,
	}
}

// UseContractProvisioner wires the shared subscriber/OCS provisioning writer.
// Without it the create endpoint fails closed instead of falling back to the
// historical upsert.
func (h *SubscriberWriteHandler) UseContractProvisioner(provisioner ContractProvisioner) {
	h.contractProvisioner = provisioner
}

// ── Request bodies ─────────────────────────────────────────────────────────

type createContractBody struct {
	IMSI        string         `json:"imsi"`
	MSISDN      string         `json:"msisdn"`
	PlanID      string         `json:"plan_id"`
	PlanIDAlias string         `json:"planId"`
	Status      string         `json:"status"`
	OcsTraffic  map[string]any `json:"ocsTraffic"`
	Reason      string         `json:"reason"`
}

type updateTariffBody struct {
	PlanID string `json:"plan_id"`
	Status string `json:"status"`
}

// ── Create ─────────────────────────────────────────────────────────────────

// Create handles POST /api/ocs/subscribers
// Provisions a contract and its balance account for a subscriber identity that
// already exists. Governance is DIRECT for every authorized role.
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
		planID = strings.TrimSpace(body.PlanIDAlias)
	}
	if planID == "" {
		response.Error(w, http.StatusBadRequest, "plan_id is required", "OCS_PLAN_ID_REQUIRED")
		return
	}

	/* Creation always yields an active contract. Lifecycle changes have their
	 * own governed transitions; accepting a status here would bypass them. */
	if requestedStatus := strings.TrimSpace(body.Status); requestedStatus != "" && requestedStatus != "active" {
		response.Error(w, http.StatusBadRequest, "Contracts are created active; use suspend or terminate to change lifecycle", "OCS_INVALID_STATUS")
		return
	}

	if h.contractProvisioner == nil {
		response.InternalError(w)
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

	contract, balanceAdopted, err := h.contractProvisioner.ProvisionContractForExistingSubscriber(
		r.Context(), imsi, planID, strings.TrimSpace(body.MSISDN), body.OcsTraffic,
	)
	if err != nil {
		writeProvisionFailure(w, err)
		return
	}

	h.writeSubscriberAudit(r, audit.WriteAuditInput{
		Action:   "CREATE",
		Module:   "ocs-subscribers",
		TargetID: fmt.Sprintf("ocs-subscriber:%s", imsi),
		Reason:   strings.TrimSpace(body.Reason),
		After:    contract,
		Result:   "success",
		Metadata: map[string]interface{}{
			"operation":       string(OpContractCreate),
			"actorRole":       fresh.NormalizedRole,
			"planId":          planID,
			"balanceAdopted":  balanceAdopted,
			"provisionSource": "subscriber_contract",
		},
	}, fresh)

	response.JSON(w, http.StatusCreated, map[string]any{
		"outcome":        "success",
		"message":        "operation completed",
		"imsi":           imsi,
		"plan_id":        planID,
		"balanceAdopted": balanceAdopted,
	})
}

// codedProvisionError is implemented by the subscriber provisioning writer.
// The interface keeps the OCS package independent of that package's error type.
type codedProvisionError interface {
	ErrorCode() string
	ErrorDetails() map[string]any
}

func writeProvisionFailure(w http.ResponseWriter, err error) {
	if coded, ok := err.(codedProvisionError); ok {
		details := coded.ErrorDetails()
		switch coded.ErrorCode() {
		case "VALIDATION_ERROR":
			message := "Invalid request body"
			if detail, ok := details["message"].(string); ok && detail != "" {
				message = detail
			}
			response.Error(w, http.StatusBadRequest, message, "VALIDATION_ERROR")
		case "SUBSCRIBER_NOT_FOUND":
			response.Error(w, http.StatusNotFound, "Subscriber identity not found", "SUBSCRIBER_NOT_FOUND")
		case "OCS_CONTRACT_EXISTS":
			response.Error(w, http.StatusConflict, "OCS subscriber contract already exists", "OCS_CONTRACT_EXISTS")
		case "OCS_CONTRACT_RETAINED":
			response.Error(w, http.StatusConflict, "IMSI still has terminated OCS contract history; purge it through retention before reuse", "OCS_CONTRACT_RETAINED")
		case "OCS_PLAN_ID_REQUIRED":
			response.Error(w, http.StatusBadRequest, "plan_id is required", "OCS_PLAN_ID_REQUIRED")
		case "OCS_PLAN_NOT_FOUND":
			response.Error(w, http.StatusBadRequest, "Tariff plan not found", "OCS_TARIFF_NOT_FOUND")
		case "OCS_PLAN_DISABLED":
			response.Error(w, http.StatusBadRequest, "Cannot bind to disabled tariff plan", "OCS_TARIFF_DISABLED")
		case "OCS_PLAN_MISMATCH":
			response.Error(w, http.StatusBadRequest, "ocsTraffic plan must match plan_id", "OCS_PLAN_MISMATCH")
		case "MSISDN_MISMATCH":
			response.Error(w, http.StatusBadRequest, "msisdn must match the subscriber primary number", "MSISDN_MISMATCH")
		case "INVALID_MSISDN":
			response.Error(w, http.StatusBadRequest, "MSISDN must contain digits only", "INVALID_MSISDN")
		case "OCS_BALANCE_PLAN_MISMATCH":
			response.Error(w, http.StatusConflict, "Existing balance account belongs to another tariff plan", "OCS_BALANCE_PLAN_MISMATCH")
		case "OCS_BALANCE_STATUS_INCONSISTENT":
			response.Error(w, http.StatusConflict, "Existing balance account is not active; reconcile it before creating a contract", "OCS_BALANCE_STATUS_INCONSISTENT")
		case "OCS_BALANCE_EXISTS":
			response.Error(w, http.StatusConflict, "A balance account already exists for this IMSI", "OCS_BALANCE_EXISTS")
		case "OCS_CONTRACT_CREATE_PARTIAL_WRITE":
			response.Error(w, http.StatusInternalServerError, "Contract provisioning failed and could not be rolled back", "OCS_CONTRACT_CREATE_PARTIAL_WRITE")
		case "OCS_CONTRACT_CREATE_FAILED":
			response.Error(w, http.StatusInternalServerError, "Contract provisioning failed; no contract was created", "OCS_CONTRACT_CREATE_FAILED")
		default:
			response.InternalError(w)
		}
		return
	}
	response.InternalError(w)
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
	status := strings.TrimSpace(body.Status)
	if status != "" {
		if planID != "" {
			response.Error(w, http.StatusBadRequest, "Cannot update plan_id and status in one request", "OCS_MIXED_UPDATE_NOT_SUPPORTED")
			return
		}
		if status != "terminated" {
			response.Error(w, http.StatusBadRequest, "Only the terminated status is accepted here", "OCS_INVALID_STATUS")
			return
		}
		h.terminateContract(w, r)
		return
	}
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

	/* Mirror the binding into the account before changing the contract. If the
	 * contract write then fails, put the account back so the two do not drift. */
	previousPlan, _ := before["plan_id"].(string)
	if err := h.repo.SyncBalancePlan(r.Context(), imsi, planID); err != nil {
		response.InternalError(w)
		return
	}

	// Direct execution
	if err := h.repo.UpdateTariffBinding(r.Context(), imsi, planID); err != nil {
		if revertErr := h.repo.SyncBalancePlan(r.Context(), imsi, previousPlan); revertErr != nil {
			slog.Error("failed to revert balance plan after contract update failure", "imsi", imsi, "error", revertErr)
		}
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
			"operation": string(OpContractUpdate),
			"actorRole": fresh.NormalizedRole,
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"imsi":    imsi,
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

	// No-op if already in target status. Repair a stale account while here.
	currentStatus, _ := before["status"].(string)
	if currentStatus == status {
		if err := h.repo.SyncBalanceStatus(r.Context(), imsi, status); err != nil {
			slog.Error("failed to sync balance status while contract was already in target state", "imsi", imsi, "status", status, "error", err)
		}
		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": fmt.Sprintf("OCS subscriber contract already %s", status),
			"imsi":    imsi,
		})
		return
	}

	if code, message, errorCode := contractTransitionError(currentStatus, status); code != 0 {
		response.Error(w, code, message, errorCode)
		return
	}

	if err := h.repo.SyncBalanceStatus(r.Context(), imsi, status); err != nil {
		response.InternalError(w)
		return
	}
	if err := h.repo.SetContractStatus(r.Context(), imsi, status); err != nil {
		if currentStatus != "" {
			if revertErr := h.repo.SyncBalanceStatus(r.Context(), imsi, currentStatus); revertErr != nil {
				slog.Error("failed to revert balance status after contract update failure", "imsi", imsi, "error", revertErr)
			}
		}
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
			"operation":    string(op),
			"actorRole":    fresh.NormalizedRole,
			"statusChange": status,
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"imsi":    imsi,
	})
}

// ── Terminate ──────────────────────────────────────────────────────────────

// Terminate handles DELETE /api/ocs/subscribers/{imsi}
func (h *SubscriberWriteHandler) Terminate(w http.ResponseWriter, r *http.Request) {
	h.terminateContract(w, r)
}

// terminateContract moves a contract into the terminal state without deleting
// the contract or its balance. DELETE keeps this route for compatibility; the
// console uses PATCH {"status":"terminated"}.
func (h *SubscriberWriteHandler) terminateContract(w http.ResponseWriter, r *http.Request) {
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

	currentStatus, _ := before["status"].(string)
	if currentStatus == "terminated" {
		if err := h.repo.SyncBalanceStatus(r.Context(), imsi, "terminated"); err != nil {
			slog.Error("failed to sync balance status while contract was already terminated", "imsi", imsi, "error", err)
		}
		response.JSON(w, http.StatusOK, map[string]any{
			"outcome": "executed",
			"message": "OCS subscriber contract already terminated",
			"imsi":    imsi,
		})
		return
	}
	if code, message, errorCode := contractTransitionError(currentStatus, "terminated"); code != 0 {
		response.Error(w, code, message, errorCode)
		return
	}

	if err := h.repo.SyncBalanceStatus(r.Context(), imsi, "terminated"); err != nil {
		response.InternalError(w)
		return
	}
	if err := h.repo.SetContractStatus(r.Context(), imsi, "terminated"); err != nil {
		if currentStatus != "" {
			if revertErr := h.repo.SyncBalanceStatus(r.Context(), imsi, currentStatus); revertErr != nil {
				slog.Error("failed to revert balance status after termination failure", "imsi", imsi, "error", revertErr)
			}
		}
		if err.Error() == "OCS_SUBSCRIBER_NOT_FOUND" {
			response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	after := copyBson(before)
	after["status"] = "terminated"

	h.writeSubscriberAudit(r, audit.WriteAuditInput{
		Action:   "UPDATE",
		Module:   "ocs-subscribers",
		TargetID: fmt.Sprintf("ocs-subscriber:%s", imsi),
		Before:   before,
		After:    after,
		Result:   "success",
		Metadata: map[string]interface{}{
			"operation":    string(OpContractTerminate),
			"actorRole":    fresh.NormalizedRole,
			"statusChange": "terminated",
		},
	}, fresh)

	response.JSON(w, http.StatusOK, map[string]any{
		"outcome": "success",
		"message": "operation completed",
		"imsi":    imsi,
	})
}

// contractTransitionError returns a deterministic refusal for lifecycle moves
// that would resurrect a terminated contract or skip a defined state.
func contractTransitionError(current, target string) (int, string, string) {
	switch target {
	case "terminated":
		if current == "terminated" {
			return 0, "", ""
		}
		if current != "active" && current != "suspended" {
			return http.StatusConflict, "Contract cannot be terminated from its current status", "CONTRACT_NOT_TERMINATABLE"
		}
	case "active":
		if current == "terminated" {
			return http.StatusConflict, "Terminated contracts cannot be resumed", "CONTRACT_TERMINATED"
		}
		if current != "suspended" {
			return http.StatusConflict, "Contract can only be resumed from suspended", "CONTRACT_NOT_SUSPENDED"
		}
	case "suspended":
		if current == "terminated" {
			return http.StatusConflict, "Terminated contracts cannot be suspended", "CONTRACT_TERMINATED"
		}
		if current != "active" {
			return http.StatusConflict, "Contract can only be suspended from active", "CONTRACT_NOT_ACTIVE"
		}
	}
	return 0, "", ""
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
