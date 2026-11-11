package imsreg

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/operationsview"
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
func ParseQuery(v url.Values, summary bool) (Query, error) {
	q := Query{SourceID: v.Get("sourceId"), Search: strings.TrimSpace(v.Get("q")), State: v.Get("state"), Cursor: v.Get("cursor"), Limit: 50, Summary: summary}
	for key, values := range v {
		if len(values) != 1 {
			return q, &ReadError{"invalid_query"}
		}
		switch key {
		case "sourceId", "q", "state", "cursor", "limit", "networkKey", "siteResourceId", "hostResourceId", "operatorName", "plmn":
		default:
			return q, &ReadError{"invalid_query"}
		}
	}
	if summary && (v.Has("cursor") || v.Has("limit")) {
		return q, &ReadError{"invalid_query"}
	}
	f, e := operationsview.ParseGroupFilter(v)
	if e != nil {
		return q, &ReadError{"invalid_query"}
	}
	q.Filter = f
	if q.SourceID != "" && !keyPattern.MatchString(q.SourceID) || !safeText(q.Search, 128) || len(q.Cursor) > 1024 {
		return q, &ReadError{"invalid_query"}
	}
	if q.State != "" && q.State != "active_binding_observed" && q.State != "no_active_binding_observed" && q.State != "unknown" {
		return q, &ReadError{"invalid_query"}
	}
	if v.Has("limit") {
		q.Limit, e = strconv.Atoi(v.Get("limit"))
		if e != nil || q.Limit < 1 || q.Limit > 200 {
			return q, &ReadError{"invalid_query"}
		}
	}
	return q, nil
}
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
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
	if h.limiter != nil && !h.limiter.Enforce(w, r, "ims:registrations:"+r.URL.Path+":"+p.Username, 120, 60) {
		return
	}
	q, e := ParseQuery(r.URL.Query(), r.URL.Path == "/api/ims/registrations/summary")
	if e != nil {
		response.BadRequest(w, "Invalid IMS observation query", "IMS_INVALID_QUERY")
		return
	}
	out, e := h.service.Read(r.Context(), q)
	if e != nil {
		var governed *governance.HTTPError
		if errors.As(e, &governed) {
			response.Error(w, governed.Status, governed.Message, governed.Code)
			return
		}
		if reason(e) == "cursor_changed" {
			response.Error(w, 409, "The observation context changed; restart pagination", "IMS_CURSOR_CHANGED")
			return
		}
		response.BadRequest(w, "Invalid IMS observation query", "IMS_INVALID_QUERY")
		return
	}
	b, e := json.Marshal(out)
	if e != nil {
		response.Error(w, 500, "Observation encoding failed", "IMS_UNAVAILABLE")
		return
	}
	if len(b) > MaxBody {
		response.Error(w, 503, "Observation response exceeded its bound", "IMS_RESPONSE_LIMIT")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}
