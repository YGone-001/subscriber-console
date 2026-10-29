package retention

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
	"subscriber/internal/user"
)

type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

type Handler struct {
	service     *Service
	limiter     RateLimiter
	userRepo    UserRepository
	auditWriter *audit.Writer
}

func NewHandler(service *Service, limiter RateLimiter, userRepo UserRepository, auditWriter *audit.Writer) *Handler {
	return &Handler{service: service, limiter: limiter, userRepo: userRepo, auditWriter: auditWriter}
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.requireAdmin(w, r, p) {
		return
	}
	if !h.limiter.Enforce(w, r, "system:retention:list:"+p.Username, 60, 60) {
		return
	}
	preview, err := h.service.Preview(r.Context(), 20)
	if err != nil {
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, preview)
}

type purgeBody struct {
	Apply        bool   `json:"apply"`
	Reason       string `json:"reason"`
	Confirmation string `json:"confirmation"`
	IMSI         string `json:"imsi"`
	Limit        int    `json:"limit"`
}

func (h *Handler) Purge(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !h.requireAdmin(w, r, p) {
		return
	}
	if !h.limiter.Enforce(w, r, "system:retention:purge:"+p.Username, 10, 60) {
		return
	}

	var body purgeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "Invalid request body", "INVALID_REQUEST")
		return
	}
	body.Reason = strings.TrimSpace(body.Reason)
	body.IMSI = strings.TrimSpace(body.IMSI)
	if body.IMSI != "" {
		response.Error(w, http.StatusBadRequest, "Targeted purge is available only through the CLI maintenance command", "TARGETED_PURGE_CLI_ONLY")
		return
	}

	if !body.Apply {
		preview, err := h.service.Preview(r.Context(), body.Limit)
		if err != nil {
			response.InternalError(w)
			return
		}
		response.JSON(w, http.StatusOK, map[string]any{"dryRun": true, "preview": preview})
		return
	}

	fresh, httpErr := governance.RevalidateFreshActor(r.Context(), h.userRepo, p)
	if httpErr != nil {
		response.Error(w, httpErr.Status, httpErr.Message, httpErr.Code)
		return
	}
	opts := PurgeOptions{
		Apply:        true,
		Reason:       body.Reason,
		Confirmation: body.Confirmation,
		Limit:        body.Limit,
		Actor: audit.ActorInput{
			Type:     "user",
			UserID:   fresh.UserID,
			Username: fresh.Username,
			Role:     fresh.RawRole,
		},
	}
	result, err := h.service.Purge(r.Context(), opts)
	if err != nil {
		h.writeError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]any{"dryRun": false, "result": result})
}

func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request, p *auth.Principal) bool {
	if !audit.RequirePermissionWithAudit(w, r, p, "core.configure", h.auditWriter) {
		return false
	}
	if p.NormalizedRole != "admin" {
		response.Error(w, http.StatusForbidden, "Administrator role required", "ADMIN_REQUIRED")
		return false
	}
	return true
}

func (h *Handler) writeError(w http.ResponseWriter, err error) {
	switch err {
	case ErrRetentionDisabled:
		response.Error(w, http.StatusConflict, "Terminated-contract retention is disabled", "RETENTION_DISABLED")
	case ErrConfirmationNeeded:
		response.Error(w, http.StatusBadRequest, "Confirmation phrase is required", "RETENTION_CONFIRMATION_REQUIRED")
	case ErrReasonRequired:
		response.Error(w, http.StatusBadRequest, "Reason is required", "RETENTION_REASON_REQUIRED")
	case ErrNotTerminated:
		response.Error(w, http.StatusConflict, "Only terminated contracts are eligible", "CONTRACT_NOT_TERMINATED")
	case ErrContractNotFound:
		response.Error(w, http.StatusNotFound, "Terminated contract not found", "CONTRACT_NOT_FOUND")
	default:
		response.InternalError(w)
	}
}
