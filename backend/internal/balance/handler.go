package balance

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"subscriber/internal/approval"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
)

var imsiRegex = regexp.MustCompile(`^[0-9]{10,18}$`)

// ApprovalCreator abstracts approval request creation.
type ApprovalCreator interface {
	Create(r *http.Request, actor approval.GovernanceActor, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error)
}

// RateLimiter abstracts rate limiting for testing.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// Handler provides HTTP handlers for balance read and governance write endpoints.
type Handler struct {
	repo        *Repository
	limiter     RateLimiter
	userRepo    UserRepository
	approvalSvc ApprovalCreator
	auditWriter *audit.Writer
}

// NewHandler creates a new balance Handler.
func NewHandler(repo *Repository, limiter RateLimiter, userRepo UserRepository, approvalSvc ApprovalCreator, auditWriter *audit.Writer) *Handler {
	return &Handler{
		repo:        repo,
		limiter:     limiter,
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: auditWriter,
	}
}

// ── GET /api/ocs/balances ──────────────────────────────────────────────────

// List handles GET /api/ocs/balances.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:balances:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	opts := BalanceQueryOptions{
		Page:            intParam(q.Get("page"), 1),
		Limit:           intParam(q.Get("limit"), 20),
		IMSI:            firstNonEmpty(q.Get("imsi"), q.Get("q")),
		PlanID:          q.Get("planId"),
		Status:          q.Get("status"),
		InvariantStatus: q.Get("invariant"),
		SortField:       firstNonEmpty(q.Get("sortField"), q.Get("sort")),
		SortOrder:       firstNonEmpty(q.Get("sortOrder"), q.Get("order")),
	}

	result, err := h.repo.ListBalances(r.Context(), opts)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// ── GET /api/ocs/balances/{imsi} ───────────────────────────────────────────

// Get handles GET /api/ocs/balances/{imsi}.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:balances:detail:"+p.Username, 120, 60) {
		return
	}

	imsi := strings.TrimSpace(r.PathValue("imsi"))
	if !imsiRegex.MatchString(imsi) {
		response.Error(w, http.StatusBadRequest, "Invalid IMSI format", "INVALID_IMSI")
		return
	}

	rec, err := h.repo.GetBalanceByIMSI(r.Context(), imsi)
	if err != nil {
		response.InternalError(w)
		return
	}
	if rec == nil {
		response.Error(w, http.StatusNotFound, "Balance record not found", "BALANCE_NOT_FOUND")
		return
	}

	response.JSON(w, http.StatusOK, BalanceDetailResponse{
		OK:      true,
		Balance: *rec,
	})
}

// ── POST /api/ocs/balances/{imsi}/adjust ───────────────────────────────────

// Adjust handles POST /api/ocs/balances/{imsi}/adjust.
// Enforces CAS precondition checks and maker-checker governance.
// - super_admin / root -> DIRECT_GOVERNED
// - ops_admin / operator -> APPROVAL_GOVERNED
func (h *Handler) Adjust(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "ocs.balance.adjust", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:balances:adjust:"+p.Username, 30, 60) {
		return
	}

	imsi := strings.TrimSpace(r.PathValue("imsi"))
	if !imsiRegex.MatchString(imsi) {
		response.Error(w, http.StatusBadRequest, "Invalid IMSI format", "INVALID_IMSI")
		return
	}

	var body AdjustBalanceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}

	body.Operation = strings.TrimSpace(body.Operation)
	if body.Operation != "credit" && body.Operation != "debit" {
		response.Error(w, http.StatusBadRequest, "Invalid operation: must be 'credit' or 'debit'", "INVALID_OPERATION")
		return
	}

	body.Bucket = strings.TrimSpace(body.Bucket)
	if body.Bucket != "data" && body.Bucket != "voice" && body.Bucket != "sms" {
		response.Error(w, http.StatusBadRequest, "Invalid bucket: must be 'data', 'voice', or 'sms'", "INVALID_BUCKET")
		return
	}

	if body.Amount <= 0 {
		response.Error(w, http.StatusBadRequest, "Amount must be greater than 0", "INVALID_AMOUNT")
		return
	}

	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" || len(body.Reason) > 200 {
		response.Error(w, http.StatusBadRequest, "Reason is required (max 200 characters)", "REASON_REQUIRED")
		return
	}

	body.TicketID = strings.TrimSpace(body.TicketID)
	if len(body.TicketID) > 100 {
		response.Error(w, http.StatusBadRequest, "Ticket ID must not exceed 100 characters", "INVALID_TICKET_ID")
		return
	}

	// Revalidate fresh actor from database
	fresh, httpErr := RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}

	// Governance policy evaluation
	eval := EvaluateOperation(OpAdjust, fresh.NormalizedRole)
	if eval.Decision == governance.Disabled {
		response.Error(w, http.StatusConflict, "Balance adjustment is disabled", "OPERATION_DISABLED")
		return
	}

	// Read current balance document to establish baseline & CAS snapshot
	current, err := h.repo.GetBalanceByIMSI(r.Context(), imsi)
	if err != nil {
		response.InternalError(w)
		return
	}
	if current == nil {
		response.Error(w, http.StatusNotFound, "Balance record not found", "BALANCE_NOT_FOUND")
		return
	}

	if !current.InvariantOk {
		response.Error(w, http.StatusConflict, "Balance record has broken invariants", "BALANCE_INVARIANT_VIOLATION")
		return
	}

	// Capacity check for debit operations
	if body.Operation == "debit" {
		switch body.Bucket {
		case "data":
			if current.DataAvailable < body.Amount || (current.DataTotal-body.Amount) < (current.DataUsed+current.DataReserved) {
				response.Error(w, http.StatusBadRequest, "Insufficient data balance for debit", "INSUFFICIENT_BALANCE")
				return
			}
		case "voice":
			if current.VoiceAvailable < body.Amount || (current.VoiceTotal-body.Amount) < (current.VoiceUsed+current.VoiceReserved) {
				response.Error(w, http.StatusBadRequest, "Insufficient voice balance for debit", "INSUFFICIENT_BALANCE")
				return
			}
		case "sms":
			if current.SmsAvailable < body.Amount || (current.SmsTotal-body.Amount) < current.SmsUsed {
				response.Error(w, http.StatusBadRequest, "Insufficient SMS balance for debit", "INSUFFICIENT_BALANCE")
				return
			}
		}
	}

	// CAS version precondition check if provided by client
	expectedVersion := current.Version
	if body.Version != nil {
		expectedVersion = *body.Version
		if expectedVersion != current.Version {
			response.Error(w, http.StatusConflict, "Balance was modified concurrently; please retry", "BALANCE_PRECONDITION_CHANGED")
			return
		}
	}

	// Compute target after state for payload/audit
	delta := body.Amount
	if body.Operation == "debit" {
		delta = -body.Amount
	}
	after := *current
	switch body.Bucket {
	case "data":
		after.DataTotal += delta
		after.DataAvailable += delta
	case "voice":
		after.VoiceTotal += delta
		after.VoiceAvailable += delta
	case "sms":
		after.SmsTotal += delta
		after.SmsAvailable += delta
	}
	after.Version = current.Version + 1

	// ── DIRECT GOVERNANCE (root, super_admin) ────────────────────────────────
	if eval.Decision == governance.Direct {
		res, err := h.repo.AdjustBalanceCAS(r.Context(), imsi, expectedVersion, body.Bucket, body.Operation, body.Amount)
		if err != nil {
			if err == ErrPreconditionChanged {
				response.Error(w, http.StatusConflict, "Balance was modified concurrently; please retry", "BALANCE_PRECONDITION_CHANGED")
				return
			}
			if err == ErrInsufficientBalance {
				response.Error(w, http.StatusBadRequest, "Insufficient balance", "INSUFFICIENT_BALANCE")
				return
			}
			if err == ErrInvariantViolation {
				response.Error(w, http.StatusConflict, "Balance record violates invariants", "BALANCE_INVARIANT_VIOLATION")
				return
			}
			response.InternalError(w)
			return
		}

		auditErr := h.writeStrictAudit(r, audit.WriteAuditInput{
			Action:   "BALANCE_ADJUST",
			Module:   "ocs",
			TargetID: fmt.Sprintf("balance:%s", imsi),
			Resource: &audit.ResourceInput{
				Type: "ocs_balance",
				ID:   imsi,
				Name: imsi,
			},
			Before: res.Before,
			After:  res.After,
			Result: "success",
			Reason: body.Reason,
			Metadata: map[string]interface{}{
				"governanceMode":   "DIRECT_GOVERNED",
				"approvalRequired": false,
				"operation":        body.Operation,
				"bucket":           body.Bucket,
				"amount":           body.Amount,
				"ticketId":         body.TicketID,
				"imsi":             imsi,
				"beforeVersion":    res.Before.Version,
				"afterVersion":     res.After.Version,
				"actorRole":        fresh.NormalizedRole,
			},
		}, fresh)
		if auditErr != nil {
			response.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":     "AUDIT_UNAVAILABLE",
				"code":      "AUDIT_UNAVAILABLE",
				"message":   "Balance adjustment committed but strict audit persistence failed",
				"committed": true,
				"imsi":      imsi,
				"version":   res.After.Version,
			})
			return
		}

		response.JSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"outcome": "executed",
			"message": "Balance adjusted successfully",
			"imsi":    imsi,
			"balance": res.After,
		})
		return
	}

	// ── APPROVAL GOVERNANCE (ops_admin, operator) ────────────────────────────
	actor := approval.GovernanceActor{
		Type:     "user",
		UserID:   fresh.UserID,
		Username: fresh.Username,
		Role:     fresh.RawRole,
	}

	beforeSnap := current.SnapshotForBucket(body.Bucket)
	expectedAfterSnap := ExpectedAfterForSnapshot(beforeSnap, body.Operation, body.Amount)
	adjID := audit.GenerateUUID()

	intentMap := map[string]interface{}{
		"bucket":    body.Bucket,
		"operation": body.Operation,
		"amount":    body.Amount,
		"reason":    body.Reason,
	}
	if body.TicketID != "" {
		intentMap["ticketId"] = body.TicketID
	}

	beforeMap := map[string]interface{}{
		"imsi":           beforeSnap.IMSI,
		"bucket":         beforeSnap.Bucket,
		"total":          beforeSnap.Total,
		"used":           beforeSnap.Used,
		"reserved":       beforeSnap.Reserved,
		"available":      beforeSnap.Available,
		"version":        beforeSnap.Version,
		"versionPresent": beforeSnap.VersionPresent,
	}

	expectedAfterMap := map[string]interface{}{
		"imsi":      expectedAfterSnap.IMSI,
		"bucket":    expectedAfterSnap.Bucket,
		"total":     expectedAfterSnap.Total,
		"used":      expectedAfterSnap.Used,
		"reserved":  expectedAfterSnap.Reserved,
		"available": expectedAfterSnap.Available,
	}

	frozenPayload := map[string]interface{}{
		"schema":        "ocs-balance-adjustment-v1",
		"adjustmentId":  adjID,
		"imsi":          imsi,
		"intent":        intentMap,
		"before":        beforeMap,
		"expectedAfter": expectedAfterMap,
	}

	summary := fmt.Sprintf("Adjust %s balance for %s: %s %d", body.Bucket, imsi, body.Operation, body.Amount)
	approvalDoc, err := h.approvalSvc.Create(r, actor, approval.CreateApprovalInput{
		Action:           "TRAFFIC_ADJUSTMENT",
		Requester:        fresh.Username,
		RequesterContext: &actor,
		TargetID:         fmt.Sprintf("balance:%s", imsi),
		Summary:          summary,
		Title:            summary,
		Reason:           &body.Reason,
		TicketID:         body.TicketID,
		Operation: &approval.ApprovalOperation{
			ResourceType: "ocs_balance",
			ResourceID:   imsi,
		},
		Before:  beforeMap,
		After:   expectedAfterMap,
		Payload: frozenPayload,
	})
	if err != nil {
		if awe, ok := err.(*approval.ApprovalWorkflowError); ok && awe.Committed {
			response.JSON(w, awe.Status, awe.ErrorResponse())
			return
		}
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusAccepted, map[string]any{
		"ok":          true,
		"outcome":     "approval_required",
		"approvalId":  approvalDoc.ID,
		"approval_id": approvalDoc.ID,
		"message":     "Approval request created",
		"imsi":        imsi,
	})
}

// ── POST /api/ocs/balances/{imsi}/reset ────────────────────────────────────

// Reset handles POST /api/ocs/balances/{imsi}/reset.
// Balance reset is permanently disabled by policy.
// Always returns BALANCE_RESET_DISABLED with no Mongo write.
func (h *Handler) Reset(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:balances:reset:"+p.Username, 10, 60) {
		return
	}

	// Return error immediately. Zero write.
	response.JSON(w, http.StatusBadRequest, map[string]any{
		"error": "BALANCE_RESET_DISABLED",
	})
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func (h *Handler) writeStrictAudit(r *http.Request, input audit.WriteAuditInput, actor *FreshActor) error {
	if h.auditWriter == nil {
		return nil
	}
	source, req, reason := audit.AuditRequestContext(r)
	input.Source = source
	input.Request = req
	if input.Reason == "" {
		input.Reason = reason
	}
	if actor != nil {
		input.Actor = audit.ActorInput{
			Type:     "user",
			UserID:   actor.UserID,
			Username: actor.Username,
			Role:     actor.RawRole,
		}
	}
	return h.auditWriter.WriteStrict(r.Context(), input)
}

func intParam(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < 1 {
		return fallback
	}
	return v
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
