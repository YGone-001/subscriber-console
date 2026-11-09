package agents

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

type RateLimiter interface {
	Enforce(http.ResponseWriter, *http.Request, string, int, int) bool
}
type Handler struct {
	service *Service
	limiter RateLimiter
	audit   AuditWriter
}

func NewHandler(service *Service, limiter RateLimiter, writer AuditWriter) *Handler {
	return &Handler{service, limiter, writer}
}
func (h *Handler) error(w http.ResponseWriter, err error) {
	status, code, message := statusFor(err)
	response.Error(w, status, message, code)
}
func (h *Handler) user(w http.ResponseWriter, r *http.Request, write bool) *auth.Principal {
	w.Header().Set("Cache-Control", "no-store")
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, 401, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	allowed := auth.HasPermission(p, "core.read")
	if write {
		allowed = allowed && auth.HasCapability(p, "user_admin")
	}
	if !allowed {
		if h.audit != nil {
			h.audit.WriteBestEffort(audit.WriteAuditInput{
				Action: "agents.denied", Module: "agents", Result: "denied", RiskLevel: "medium",
				Actor:   audit.ActorInput{Type: "user", Username: p.Username, Role: p.Role},
				Request: &audit.RequestInput{Method: r.Method, Path: r.URL.Path},
			})
		}
		response.Error(w, 403, "Forbidden", "PERMISSION_DENIED")
		return nil
	}
	limit := 120
	if write {
		limit = 20
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "agents:"+r.Method+":"+p.Username, limit, 60) {
		return nil
	}
	return p
}
func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		response.BadRequest(w, "Invalid bounded JSON request", "AGENT_INVALID_BODY")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		response.BadRequest(w, "Unexpected trailing JSON", "AGENT_INVALID_BODY")
		return false
	}
	return true
}
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	if h.user(w, r, false) == nil {
		return
	}
	q := r.URL.Query()
	for key, values := range q {
		if len(values) != 1 || (key != "q" && key != "cursor" && key != "limit") {
			response.BadRequest(w, "Unsupported list query", "AGENT_INVALID_QUERY")
			return
		}
	}
	limit := 50
	if q.Has("limit") {
		var err error
		limit, err = strconv.Atoi(q.Get("limit"))
		if err != nil {
			response.BadRequest(w, "Invalid limit", "AGENT_INVALID_QUERY")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out, err := h.service.List(ctx, ListQuery{Q: strings.TrimSpace(q.Get("q")), Cursor: q.Get("cursor"), Limit: limit})
	if err != nil {
		h.error(w, err)
		return
	}
	response.JSON(w, 200, out)
}
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	if h.user(w, r, false) == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out, err := h.service.Get(ctx, r.PathValue("agentId"))
	if err != nil {
		h.error(w, err)
		return
	}
	response.JSON(w, 200, out)
}
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	p := h.user(w, r, true)
	if p == nil {
		return
	}
	var req CreateRequest
	if !decode(w, r, &req) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out, err := h.service.Create(ctx, p, req)
	if err != nil {
		h.error(w, err)
		return
	}
	response.JSON(w, 201, out)
}
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	p := h.user(w, r, true)
	if p == nil {
		return
	}
	var req UpdateRequest
	if !decode(w, r, &req) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out, err := h.service.Update(ctx, p, r.PathValue("agentId"), req)
	if err != nil {
		h.error(w, err)
		return
	}
	response.JSON(w, 200, out)
}
func (h *Handler) Rotate(w http.ResponseWriter, r *http.Request) {
	p := h.user(w, r, true)
	if p == nil {
		return
	}
	var req CredentialRequest
	if !decode(w, r, &req) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	out, err := h.service.Rotate(ctx, p, r.PathValue("agentId"), req.ExpectedRevision)
	if err != nil {
		h.error(w, err)
		return
	}
	response.JSON(w, 200, out)
}

// Machine routes never use browser cookies or forwarded identity headers.
// Only a loopback peer can assert TLS termination by the existing public edge.
func secureMachineTransport(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	return proto == "https" || proto == ""
}
func (h *Handler) machine(w http.ResponseWriter, r *http.Request) (*Record, context.Context, context.CancelFunc) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	reject := func(status int, code, message string) (*Record, context.Context, context.CancelFunc) {
		cancel()
		response.Error(w, status, message, code)
		return nil, ctx, func() {}
	}
	if !secureMachineTransport(r) {
		return reject(400, "AGENT_TLS_REQUIRED", "Collectors require HTTPS except direct loopback connections")
	}
	if r.URL.RawQuery != "" {
		return reject(400, "AGENT_INVALID_QUERY", "Machine requests do not accept query parameters")
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Agent ") {
		return reject(401, "AGENT_AUTH_INVALID", "Collector credential is required")
	}
	rec, err := h.service.Authenticate(ctx, r.PathValue("agentId"), strings.TrimPrefix(header, "Agent "))
	if err != nil {
		cancel()
		h.error(w, err)
		return nil, ctx, func() {}
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "agent_ingest:"+rec.AgentID, 120, 60) {
		cancel()
		return nil, ctx, func() {}
	}
	return rec, ctx, cancel
}
func (h *Handler) Session(w http.ResponseWriter, r *http.Request) {
	rec, ctx, cancel := h.machine(w, r)
	defer cancel()
	if rec == nil {
		return
	}
	var req SessionRequest
	if !decode(w, r, &req) {
		return
	}
	out, err := h.service.StartSession(ctx, rec, req)
	if err != nil {
		h.error(w, err)
		return
	}
	response.JSON(w, 200, out)
}
func (h *Handler) Report(w http.ResponseWriter, r *http.Request) {
	rec, ctx, cancel := h.machine(w, r)
	defer cancel()
	if rec == nil {
		return
	}
	var req ReportRequest
	if !decode(w, r, &req) {
		return
	}
	duplicate, err := h.service.Accept(ctx, rec, req)
	if err != nil {
		h.error(w, err)
		return
	}
	response.JSON(w, 200, map[string]any{"accepted": true, "duplicate": duplicate})
}
