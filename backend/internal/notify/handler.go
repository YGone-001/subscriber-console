package notify

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// RateLimiter mirrors the platform request limiter.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// AuditWriter records configuration writes and denials best-effort.
type AuditWriter interface {
	WriteBestEffort(input audit.WriteAuditInput)
}

// Handler serves the notification configuration and ledger surface.
//
// Reads require core.read; every configuration write requires core.configure
// and inherits the fresh-session re-validation performed by the auth
// middleware on the request path.
type Handler struct {
	repo        *Repository
	limiter     RateLimiter
	auditWriter AuditWriter
}

// NewHandler constructs the notification HTTP handler.
func NewHandler(repo *Repository, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{repo: repo, limiter: limiter, auditWriter: auditWriter}
}

const maxBodyBytes = 32 << 10

func decodeStrictJSON(r io.Reader, dst any) error {
	limited := io.LimitReader(r, maxBodyBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("failed to read request body: %w", err)
	}
	if int64(len(data)) > maxBodyBytes {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return errors.New("request body is empty")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("unexpected trailing content after JSON")
	}
	return nil
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "nf_notify.denied",
		Module: "nf_notify",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Request:   &audit.RequestInput{Method: method, Path: path},
		Result:    "denied",
		RiskLevel: "low",
	})
}

func (h *Handler) auditWrite(p *auth.Principal, method, path, resourceID string, result string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "nf_notify.configure",
		Module: "nf_notify",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Request:   &audit.RequestInput{Method: method, Path: path},
		TargetID:  resourceID,
		Result:    result,
		RiskLevel: "medium",
	})
}

func (h *Handler) requireRead(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

func (h *Handler) requireConfigure(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

func writeValidation(w http.ResponseWriter, err error) {
	if errors.Is(err, errRevisionConflict) {
		response.Error(w, http.StatusConflict, "Revision conflict", "NOTIFY_REVISION_CONFLICT")
		return
	}
	if errors.Is(err, errNotFound) {
		response.Error(w, http.StatusNotFound, "Not found", "NOTIFY_NOT_FOUND")
		return
	}
	code, message := AsMapValidationError(err)
	response.BadRequest(w, message, code)
}

/* ----------------------------------------------------------------- channels -- */

// ListChannels handles GET /api/nf-notifications/channels.
func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-notifications/channels")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-notify:channels:"+p.Username, 120, 60) {
		return
	}
	channels, err := h.repo.ListChannels(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to list channels", "NOTIFY_CHANNELS_UNAVAILABLE")
		return
	}
	response.JSON(w, http.StatusOK, map[string]any{"channels": channels})
}

// CreateChannel handles POST /api/nf-notifications/channels.
func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-notifications/channels")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-notify:channels:write:"+p.Username, 30, 60) {
		return
	}
	var req CreateChannelRequest
	if err := decodeStrictJSON(r.Body, &req); err != nil {
		response.BadRequest(w, err.Error(), "NOTIFY_INVALID_REQUEST")
		return
	}
	if err := ValidateChannel(req.Name, req.Kind, req.URL, req.Secret); err != nil {
		writeValidation(w, err)
		return
	}
	channel, err := h.repo.CreateChannel(r.Context(), &req, p.Username)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to create channel", "NOTIFY_CHANNEL_WRITE_FAILED")
		return
	}
	h.auditWrite(p, "POST", "/api/nf-notifications/channels", channel.ID, "created")
	response.JSON(w, http.StatusCreated, channel)
}

// UpdateChannel handles PUT /api/nf-notifications/channels/{channelId}.
func (h *Handler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "PUT", "/api/nf-notifications/channels/{channelId}")
	if p == nil {
		return
	}
	id := r.PathValue("channelId")
	if id == "" {
		response.BadRequest(w, "channelId is required", "NOTIFY_INVALID_REQUEST")
		return
	}
	var req UpdateChannelRequest
	if err := decodeStrictJSON(r.Body, &req); err != nil {
		response.BadRequest(w, err.Error(), "NOTIFY_INVALID_REQUEST")
		return
	}
	if req.ExpectedRevision < 1 {
		response.BadRequest(w, "expectedRevision must be positive", "NOTIFY_INVALID_REVISION")
		return
	}
	if err := ValidateChannel(req.Channel.Name, ChannelKindWebhook, req.Channel.URL, req.Channel.Secret); err != nil {
		writeValidation(w, err)
		return
	}
	updated, _, err := h.repo.UpdateChannel(r.Context(), id, &req, p.Username)
	if err != nil {
		writeValidation(w, err)
		return
	}
	h.auditWrite(p, "PUT", "/api/nf-notifications/channels/{channelId}", id, "updated")
	response.JSON(w, http.StatusOK, updated)
}

// DeleteChannel handles DELETE /api/nf-notifications/channels/{channelId}.
func (h *Handler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "DELETE", "/api/nf-notifications/channels/{channelId}")
	if p == nil {
		return
	}
	id := r.PathValue("channelId")
	if err := h.repo.DeleteChannel(r.Context(), id); err != nil {
		writeValidation(w, err)
		return
	}
	h.auditWrite(p, "DELETE", "/api/nf-notifications/channels/{channelId}", id, "deleted")
	response.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

/* -------------------------------------------------------------- escalations -- */

// ListEscalations handles GET /api/nf-notifications/escalations.
func (h *Handler) ListEscalations(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-notifications/escalations")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-notify:escalations:"+p.Username, 120, 60) {
		return
	}
	escalations, err := h.repo.ListEscalations(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to list escalations", "NOTIFY_ESCALATIONS_UNAVAILABLE")
		return
	}
	response.JSON(w, http.StatusOK, map[string]any{"escalations": escalations})
}

// CreateEscalation handles POST /api/nf-notifications/escalations.
func (h *Handler) CreateEscalation(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-notifications/escalations")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-notify:escalations:write:"+p.Username, 30, 60) {
		return
	}
	var req CreateEscalationRequest
	if err := decodeStrictJSON(r.Body, &req); err != nil {
		response.BadRequest(w, err.Error(), "NOTIFY_INVALID_REQUEST")
		return
	}
	if err := ValidateEscalation(req); err != nil {
		writeValidation(w, err)
		return
	}
	escalation, err := h.repo.CreateEscalation(r.Context(), &req, p.Username)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to create escalation", "NOTIFY_ESCALATION_WRITE_FAILED")
		return
	}
	h.auditWrite(p, "POST", "/api/nf-notifications/escalations", escalation.ID, "created")
	response.JSON(w, http.StatusCreated, escalation)
}

// UpdateEscalation handles PUT /api/nf-notifications/escalations/{escalationId}.
func (h *Handler) UpdateEscalation(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "PUT", "/api/nf-notifications/escalations/{escalationId}")
	if p == nil {
		return
	}
	id := r.PathValue("escalationId")
	if id == "" {
		response.BadRequest(w, "escalationId is required", "NOTIFY_INVALID_REQUEST")
		return
	}
	var req UpdateEscalationRequest
	if err := decodeStrictJSON(r.Body, &req); err != nil {
		response.BadRequest(w, err.Error(), "NOTIFY_INVALID_REQUEST")
		return
	}
	if req.ExpectedRevision < 1 {
		response.BadRequest(w, "expectedRevision must be positive", "NOTIFY_INVALID_REVISION")
		return
	}
	if err := ValidateEscalation(CreateEscalationRequest{
		Name:                 req.Escalation.Name,
		Severities:           req.Escalation.Severities,
		RuleIDs:              req.Escalation.RuleIDs,
		ChannelIDs:           req.Escalation.ChannelIDs,
		EscalateAfterSeconds: req.Escalation.EscalateAfterSeconds,
		EscalateChannelIDs:   req.Escalation.EscalateChannelIDs,
	}); err != nil {
		writeValidation(w, err)
		return
	}
	updated, _, err := h.repo.UpdateEscalation(r.Context(), id, &req, p.Username)
	if err != nil {
		writeValidation(w, err)
		return
	}
	h.auditWrite(p, "PUT", "/api/nf-notifications/escalations/{escalationId}", id, "updated")
	response.JSON(w, http.StatusOK, updated)
}

// DeleteEscalation handles DELETE /api/nf-notifications/escalations/{escalationId}.
func (h *Handler) DeleteEscalation(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "DELETE", "/api/nf-notifications/escalations/{escalationId}")
	if p == nil {
		return
	}
	id := r.PathValue("escalationId")
	if err := h.repo.DeleteEscalation(r.Context(), id); err != nil {
		writeValidation(w, err)
		return
	}
	h.auditWrite(p, "DELETE", "/api/nf-notifications/escalations/{escalationId}", id, "deleted")
	response.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

/* --------------------------------------------------------------- deliveries -- */

// ListDeliveries handles GET /api/nf-notifications/deliveries.
func (h *Handler) ListDeliveries(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-notifications/deliveries")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-notify:deliveries:"+p.Username, 120, 60) {
		return
	}
	query := r.URL.Query()
	for param := range query {
		switch param {
		case "alertId", "status", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	limit := 50
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &limit); err != nil || limit < 1 || limit > 200 {
			response.BadRequest(w, "limit must be between 1 and 200", "INVALID_LIMIT")
			return
		}
	}
	status := strings.TrimSpace(query.Get("status"))
	if status != "" {
		switch status {
		case DeliveryPending, DeliverySending, DeliverySent, DeliverySkipped, DeliveryFailed, DeliveryDead:
		default:
			response.BadRequest(w, "status must be a delivery status", "INVALID_QUERY_PARAMETER")
			return
		}
	}
	deliveries, next, hasMore, err := h.repo.ListDeliveries(r.Context(), DeliveryListFilter{
		AlertID: strings.TrimSpace(query.Get("alertId")),
		Status:  status,
		Limit:   limit,
		Cursor:  strings.TrimSpace(query.Get("cursor")),
	})
	if err != nil {
		writeValidation(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]any{
		"deliveries": deliveries,
		"page":       PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}
