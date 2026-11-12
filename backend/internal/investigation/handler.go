package investigation

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
)

type RateLimiter interface {
	Enforce(http.ResponseWriter, *http.Request, string, int, int) bool
}
type Handler struct {
	service *Service
	limiter RateLimiter
}

func NewHandler(s *Service, l RateLimiter) *Handler { return &Handler{s, l} }
func queryAllowed(r *http.Request, keys ...string) bool {
	allowed := map[string]bool{}
	for _, k := range keys {
		allowed[k] = true
	}
	for k, v := range r.URL.Query() {
		if !allowed[k] || len(v) != 1 {
			return false
		}
	}
	return true
}
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		response.Error(w, 400, "Invalid bounded JSON body", "INVESTIGATION_INVALID_BODY")
		return false
	}
	return true
}
func replyError(w http.ResponseWriter, e error) {
	var f *Failure
	var g *governance.HTTPError
	switch {
	case errors.As(e, &f):
		response.Error(w, f.Status, f.Message, f.Code)
	case errors.As(e, &g):
		response.Error(w, g.Status, g.Message, g.Code)
	case errors.Is(e, ErrNotFound):
		response.Error(w, 404, "Investigation or anchor alert not found", "INVESTIGATION_NOT_FOUND")
	case errors.Is(e, ErrConflict):
		response.Error(w, 409, "Investigation revision or idempotency conflict", "INVESTIGATION_CONFLICT")
	default:
		response.Error(w, 503, "Investigation storage or evidence is unavailable", "INVESTIGATION_UNAVAILABLE")
	}
}
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, 401, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	write := r.Method == "POST" || r.Method == "PATCH"
	permission := "core.read"
	limit := 120
	if write {
		permission = "core.configure"
		limit = 30
	}
	if !auth.HasPermission(p, permission) {
		if h.service.audit != nil {
			h.service.audit.WriteBestEffort(audit.WriteAuditInput{Action: "investigation.denied", Module: "investigation", Result: "denied", RiskLevel: "low", Actor: audit.ActorInput{Type: "user", Username: p.Username, Role: p.Role}})
		}
		response.Error(w, 403, "Forbidden", "PERMISSION_DENIED")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "investigations:"+r.Pattern+":"+p.Username, limit, 60) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	q := r.URL.Query()
	var out any
	var err error
	status := 200
	switch r.Pattern {
	case "GET /api/investigations/context":
		if !queryAllowed(r, "alertId", "from", "to", "investigationId") {
			err = fail(400, "INVESTIGATION_INVALID_QUERY", "Unsupported query")
			break
		}
		out, err = h.service.Context(ctx, ContextQuery{q.Get("alertId"), q.Get("from"), q.Get("to"), q.Get("investigationId")})
	case "GET /api/investigations":
		if !queryAllowed(r, "q", "status", "alertId", "resourceId", "cursor", "limit") {
			err = fail(400, "INVESTIGATION_INVALID_QUERY", "Unsupported query")
			break
		}
		n := 50
		if q.Has("limit") {
			n, err = strconv.Atoi(q.Get("limit"))
			if err != nil || n < 1 {
				err = fail(400, "INVESTIGATION_INVALID_QUERY", "Invalid limit")
				break
			}
		}
		out, err = h.service.List(ctx, ListQuery{q.Get("q"), q.Get("status"), q.Get("alertId"), q.Get("resourceId"), q.Get("cursor"), n})
	case "GET /api/investigations/{investigationId}":
		if !queryAllowed(r) {
			err = fail(400, "INVESTIGATION_INVALID_QUERY", "Unsupported query")
			break
		}
		out, err = h.service.Get(ctx, r.PathValue("investigationId"))
	case "POST /api/investigations":
		if !queryAllowed(r) {
			err = fail(400, "INVESTIGATION_INVALID_QUERY", "Unsupported query")
			break
		}
		var req CreateRequest
		if !decodeBody(w, r, &req) {
			return
		}
		out, err = h.service.Create(ctx, p, req)
		status = 201
	case "PATCH /api/investigations/{investigationId}":
		if !queryAllowed(r) {
			err = fail(400, "INVESTIGATION_INVALID_QUERY", "Unsupported query")
			break
		}
		var req UpdateRequest
		if !decodeBody(w, r, &req) {
			return
		}
		out, err = h.service.Update(ctx, p, r.PathValue("investigationId"), req)
	default:
		response.NotFound(w)
		return
	}
	if err != nil {
		replyError(w, err)
		return
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		response.InternalError(w)
		return
	}
	if len(encoded) > 2<<20 {
		response.Error(w, 503, "Evidence projection exceeds its response budget", "INVESTIGATION_RESPONSE_LIMIT")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}
