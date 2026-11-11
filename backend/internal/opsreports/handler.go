package opsreports

import (
	"context"
	"net/http"
	"strings"
	"time"

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

func NewHandler(s *Service, l RateLimiter) *Handler { return &Handler{s, l} }
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, 401, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "ops-reports:"+p.Username, 30, 60) {
		return
	}
	q, e := ParseQuery(r.URL.Query(), time.Now().UTC())
	if e != nil {
		response.Error(w, 400, e.Error(), "OPS_REPORT_INVALID_QUERY")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	switch r.Pattern {
	case "GET /api/ops-reports/summary":
		response.JSON(w, 200, h.service.Generate(ctx, q, ""))
	case "GET /api/ops-reports/alerts", "GET /api/ops-reports/metrics":
		section := "alerts"
		if r.Pattern == "GET /api/ops-reports/metrics" {
			section = "metrics"
		}
		page, e := h.service.Page(ctx, q, section)
		if e != nil {
			if strings.Contains(e.Error(), "scope_changed") {
				response.Error(w, 409, "Group membership changed; restart the report", "GROUP_SCOPE_CHANGED")
				return
			}
			response.Error(w, 503, e.Error(), "OPS_REPORT_UNAVAILABLE")
			return
		}
		response.JSON(w, 200, page)
	case "GET /api/ops-reports/export":
		section := r.URL.Query().Get("section")
		if section != "alerts" && section != "metrics" && section != "config" {
			response.Error(w, 400, "Unsupported export section", "OPS_REPORT_INVALID_QUERY")
			return
		}
		data, e := h.service.Export(ctx, q, section)
		if e != nil {
			response.Error(w, 422, e.Error(), "OPS_REPORT_EXPORT_UNAVAILABLE")
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="xcloud-`+section+`.csv"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		_, _ = w.Write(data)
	default:
		response.NotFound(w)
	}
}
