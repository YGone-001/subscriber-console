package configdrift

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/governance"
	"subscriber/internal/operationsview"
	"subscriber/internal/response"
	"time"
)

type RateLimiter interface {
	Enforce(http.ResponseWriter, *http.Request, string, int, int) bool
}
type Handler struct {
	service *Service
	limiter RateLimiter
}

func NewHandler(s *Service, l RateLimiter) *Handler { return &Handler{s, l} }
func query(r *http.Request, keys ...string) bool {
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
func body(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		response.Error(w, 400, "Invalid bounded JSON body", "CONFIG_DRIFT_INVALID_BODY")
		return false
	}
	return true
}
func reply(w http.ResponseWriter, e error) {
	var f *Failure
	var c *configsnapshots.Failure
	var g *governance.HTTPError
	switch {
	case errors.As(e, &f):
		response.Error(w, f.Status, f.Message, f.Code)
	case errors.As(e, &c):
		configsnapshots.ReplyError(w, e)
	case errors.As(e, &g):
		response.Error(w, g.Status, g.Message, g.Code)
	case errors.Is(e, ErrNotFound):
		response.Error(w, 404, "Configuration drift alert not found", "CONFIG_DRIFT_NOT_FOUND")
	case errors.Is(e, ErrConflict):
		response.Error(w, 409, "Configuration drift revision conflict", "CONFIG_DRIFT_REVISION_CONFLICT")
	case errors.Is(e, configsnapshots.ErrConflict), errors.Is(e, configsnapshots.ErrBusy), errors.Is(e, configsnapshots.ErrNotFound):
		configsnapshots.ReplyError(w, e)
	default:
		response.Error(w, 503, "Configuration drift storage or evidence is unavailable", "CONFIG_DRIFT_UNAVAILABLE")
	}
}
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, 401, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	write := r.Method == "PUT" || r.Method == "POST"
	permission := "core.read"
	limit := 120
	if write {
		permission = "core.configure"
		limit = 30
	}
	if !auth.HasPermission(p, permission) {
		if h.service.audit != nil {
			h.service.audit.WriteBestEffort(audit.WriteAuditInput{Action: "config_drift.denied", Module: "config_drift", Result: "denied", RiskLevel: "low", Actor: audit.ActorInput{Type: "user", Username: p.Username}})
		}
		response.Error(w, 403, "Forbidden", "PERMISSION_DENIED")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "config-drift:"+r.Pattern+":"+p.Username, limit, 60) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	q := r.URL.Query()
	var out any
	var e error
	if write && !query(r) {
		reply(w, fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Unsupported query"))
		return
	}
	switch r.Pattern {
	case "GET /api/config-drift/meta":
		if !query(r) {
			e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Unsupported query")
		} else {
			out = h.service.Meta()
		}
	case "GET /api/config-drift/sources/{sourceId}/policy":
		if !query(r) {
			e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Unsupported query")
		} else {
			out, e = h.service.Policy(ctx, r.PathValue("sourceId"))
		}
	case "PUT /api/config-drift/sources/{sourceId}/policy":
		var req struct {
			ExpectedRevision *int64 `json:"expectedRevision"`
			Enabled          *bool  `json:"enabled"`
			Severity         string `json:"severity"`
		}
		if !body(w, r, &req) {
			return
		}
		if req.ExpectedRevision == nil {
			e = fail(400, "CONFIG_DRIFT_INVALID_REVISION", "Explicit expectedRevision is required")
			break
		}
		out, e = h.service.SetPolicy(ctx, p, r.PathValue("sourceId"), configsnapshots.DriftPolicyRequest{ExpectedRevision: *req.ExpectedRevision, Enabled: req.Enabled, Severity: req.Severity})
	case "GET /api/config-drift/alerts":
		if !query(r, "state", "severity", "sourceId", "resourceId", "cursor", "limit", "networkKey", "siteResourceId", "hostResourceId", "operatorName", "plmn", "domain", "includeRetired") {
			e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Unsupported query")
			break
		}
		var g operationsview.GroupFilter
		g, e = operationsview.ParseGroupFilter(q)
		if e != nil {
			e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Invalid group selector")
			break
		}
		n := 50
		if q.Has("limit") {
			n, e = strconv.Atoi(q.Get("limit"))
			if e != nil {
				e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Invalid limit")
				break
			}
		}
		out, e = h.service.List(ctx, ListQuery{State: q.Get("state"), Severity: q.Get("severity"), SourceID: q.Get("sourceId"), ResourceID: q.Get("resourceId"), Cursor: q.Get("cursor"), Limit: n}, g)
	case "GET /api/config-drift/alerts/{driftAlertId}":
		if !query(r) {
			e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Unsupported query")
		} else {
			out, e = h.service.Alert(ctx, r.PathValue("driftAlertId"))
		}
	case "POST /api/config-drift/alerts/{driftAlertId}/acknowledge":
		var req AckRequest
		if !body(w, r, &req) {
			return
		}
		out, e = h.service.Acknowledge(ctx, p, r.PathValue("driftAlertId"), req)
	case "GET /api/config-drift/alerts/{driftAlertId}/events":
		if !query(r, "cursor", "limit") {
			e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Unsupported query")
			break
		}
		n := 50
		if q.Has("limit") {
			n, e = strconv.Atoi(q.Get("limit"))
			if e != nil {
				e = fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Invalid limit")
				break
			}
		}
		out, e = h.service.Events(ctx, r.PathValue("driftAlertId"), q.Get("cursor"), n)
	default:
		response.NotFound(w)
		return
	}
	if e != nil {
		reply(w, e)
		return
	}
	response.JSON(w, 200, out)
}
