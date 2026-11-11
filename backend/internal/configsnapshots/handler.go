package configsnapshots

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
	"subscriber/internal/response"
)

type RateLimiter interface {
	Enforce(http.ResponseWriter, *http.Request, string, int, int) bool
}
type Handler struct {
	service *Service
	limiter RateLimiter
}

func NewHandler(service *Service, limiter RateLimiter) *Handler { return &Handler{service, limiter} }
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, write bool) *auth.Principal {
	w.Header().Set("Cache-Control", "no-store")
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, 401, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	permission := "core.read"
	limit := 120
	if write {
		permission = "core.configure"
		limit = 20
	}
	if !auth.HasPermission(p, permission) {
		if h.service.audit != nil {
			h.service.audit.WriteBestEffort(audit.WriteAuditInput{Action: "config_snapshot.denied", Module: "config_snapshots", Result: "denied", RiskLevel: "medium", Actor: audit.ActorInput{Type: "user", Username: p.Username, Role: p.Role}, Request: &audit.RequestInput{Method: r.Method, Path: r.URL.Path}})
		}
		response.Error(w, 403, "Forbidden", "PERMISSION_DENIED")
		return nil
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "config-snapshots:"+r.Method+":"+p.Username, limit, 60) {
		return nil
	}
	return p
}
func ReplyError(w http.ResponseWriter, err error) {
	var f *Failure
	switch {
	case errors.As(err, &f):
		response.Error(w, f.Status, f.Message, f.Code)
	case errors.Is(err, ErrNotFound):
		response.Error(w, 404, "Configuration record not found", "CONFIG_NOT_FOUND")
	case errors.Is(err, ErrConflict):
		response.Error(w, 409, "Configuration revision or request conflict", "CONFIG_REVISION_CONFLICT")
	case errors.Is(err, ErrBusy):
		response.Error(w, 409, "Configuration source is already being processed", "CONFIG_SOURCE_BUSY")
	default:
		response.Error(w, 503, "Configuration observation storage is unavailable", "CONFIG_STORAGE_UNAVAILABLE")
	}
}
func body(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(target) != nil || d.Decode(new(any)) != io.EOF {
		response.Error(w, 400, "Invalid bounded JSON body", "CONFIG_INVALID_BODY")
		return false
	}
	return true
}
func query(r *http.Request, allowed ...string) bool {
	m := map[string]bool{}
	for _, v := range allowed {
		m[v] = true
	}
	for key, values := range r.URL.Query() {
		if !m[key] || len(values) != 1 {
			return false
		}
	}
	return true
}
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	write := r.Method == http.MethodPost || r.Method == http.MethodPut
	p := h.authorize(w, r, write)
	if p == nil {
		return
	}
	if write && !query(r) {
		response.Error(w, 400, "Unsupported query", "CONFIG_INVALID_QUERY")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	id := r.PathValue("sourceId")
	var out any
	var err error
	switch r.Pattern {
	case "GET /api/config-snapshots/meta":
		if !query(r) {
			err = fail(400, "CONFIG_INVALID_QUERY", "Unsupported query")
			break
		}
		out = h.service.Meta()
	case "GET /api/config-snapshots/sources":
		if !query(r, "q", "cursor", "limit", "resourceId", "status") {
			err = fail(400, "CONFIG_INVALID_QUERY", "Unsupported query")
			break
		}
		q := r.URL.Query()
		limit := 50
		if q.Has("limit") {
			limit, err = strconv.Atoi(q.Get("limit"))
			if err != nil {
				err = fail(400, "CONFIG_INVALID_QUERY", "Invalid limit")
				break
			}
		}
		out, err = h.service.List(ctx, ListQuery{Q: q.Get("q"), Cursor: q.Get("cursor"), ResourceID: q.Get("resourceId"), Status: q.Get("status"), Limit: limit})
	case "GET /api/config-snapshots/sources/{sourceId}":
		if !query(r) {
			err = fail(400, "CONFIG_INVALID_QUERY", "Unsupported query")
			break
		}
		out, err = h.service.Get(ctx, id)
	case "POST /api/config-snapshots/sources/{sourceId}/captures":
		var req CaptureRequest
		if !query(r) || !body(w, r, &req) {
			return
		}
		out, err = h.service.Capture(ctx, p, id, req)
	case "PUT /api/config-snapshots/sources/{sourceId}/baseline":
		var req BaselineRequest
		if !query(r) || !body(w, r, &req) {
			return
		}
		out, err = h.service.Baseline(ctx, p, id, req)
	case "GET /api/config-snapshots/sources/{sourceId}/snapshots/{snapshotId}":
		if !query(r) {
			err = fail(400, "CONFIG_INVALID_QUERY", "Unsupported query")
			break
		}
		out, err = h.service.Snapshot(ctx, id, r.PathValue("snapshotId"))
	case "GET /api/config-snapshots/sources/{sourceId}/diff":
		if !query(r, "left", "right") {
			err = fail(400, "CONFIG_INVALID_QUERY", "Unsupported query")
			break
		}
		out, err = h.service.Diff(ctx, id, r.URL.Query().Get("left"), r.URL.Query().Get("right"))
	case "GET /api/config-snapshots/sources/{sourceId}/snapshots", "GET /api/config-snapshots/sources/{sourceId}/observations":
		if !query(r, "cursor", "limit") {
			err = fail(400, "CONFIG_INVALID_QUERY", "Unsupported query")
			break
		}
		limit := 50
		if r.URL.Query().Has("limit") {
			limit, err = strconv.Atoi(r.URL.Query().Get("limit"))
			if err != nil {
				err = fail(400, "CONFIG_INVALID_QUERY", "Invalid limit")
				break
			}
		}
		out, err = h.service.History(ctx, id, r.URL.Query().Get("cursor"), limit, r.Pattern == "GET /api/config-snapshots/sources/{sourceId}/observations")
	default:
		response.NotFound(w)
		return
	}
	if err != nil {
		ReplyError(w, err)
		return
	}
	response.JSON(w, 200, out)
}
