package ueinfo

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// RateLimiter is the shared rate-limiting surface.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

const (
	listRateLimit     = 120
	listRateWindowSec = 60
	maxSearchRunes    = 64
)

// Handler serves the read-only UE information surface.
type Handler struct {
	service *Service
	limiter RateLimiter
}

func NewHandler(service *Service, limiter RateLimiter) *Handler {
	return &Handler{service: service, limiter: limiter}
}

func allowedParams() map[string]bool {
	return map[string]bool{
		"summary": true,
		"q":       true,
		"domain":  true,
		"state":   true,
		"limit":   true,
		"offset":  true,
		"cursor":  true,
	}
}

// encodeCursor turns a result offset into the opaque page token. The token is
// only an offset; it carries no filter state, so a cursor from one filter set
// can never silently resume another.
func encodeCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func decodeCursor(raw string) (int, bool) {
	if len(raw) > 64 {
		return 0, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return 0, false
	}
	offset, err := strconv.Atoi(string(decoded))
	if err != nil || offset < 0 || offset > MaxOffset {
		return 0, false
	}
	return offset, true
}

// Get serves GET /api/ue-info.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "ue-info:"+p.Username, listRateLimit, listRateWindowSec) {
		return
	}

	q := r.URL.Query()
	allowed := allowedParams()
	for param := range q {
		if !allowed[param] {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}

	query := Query{Limit: DefaultLimit}
	if raw := strings.TrimSpace(q.Get("summary")); raw != "" {
		if raw != "1" && !strings.EqualFold(raw, "true") {
			response.BadRequest(w, "summary must be 1 or true", "INVALID_SUMMARY")
			return
		}
		query.SummaryOnly = true
	}

	search := strings.TrimSpace(q.Get("q"))
	if len([]rune(search)) > maxSearchRunes || strings.ContainsFunc(search, unicode.IsControl) {
		response.BadRequest(w, "q must be at most 64 characters without control characters", "INVALID_SEARCH")
		return
	}
	query.Search = search

	if raw := strings.TrimSpace(q.Get("domain")); raw != "" {
		domain := canonicalDomain(raw)
		if domain == "" {
			response.BadRequest(w, "domain must be EPS or 5GS", "INVALID_DOMAIN_FILTER")
			return
		}
		query.Domain = domain
	}

	if raw := strings.TrimSpace(q.Get("state")); raw != "" {
		state := strings.ToLower(raw)
		switch state {
		case "registered", "idle", "connected", "unknown":
			query.State = state
		default:
			response.BadRequest(w, "state must be registered, idle, connected or unknown", "INVALID_STATE_FILTER")
			return
		}
	}

	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > MaxLimit {
			response.BadRequest(w, "limit must be an integer between 1 and 200", "INVALID_LIMIT")
			return
		}
		query.Limit = value
	}

	cursorRaw := strings.TrimSpace(q.Get("cursor"))
	offsetRaw := strings.TrimSpace(q.Get("offset"))
	if cursorRaw != "" && offsetRaw != "" {
		response.BadRequest(w, "cursor and offset are mutually exclusive", "INVALID_CURSOR")
		return
	}
	if cursorRaw != "" {
		value, ok := decodeCursor(cursorRaw)
		if !ok {
			response.BadRequest(w, "cursor is not a valid page token", "INVALID_CURSOR")
			return
		}
		query.Offset = value
	} else if offsetRaw != "" {
		value, err := strconv.Atoi(offsetRaw)
		if err != nil || value < 0 || value > MaxOffset {
			response.BadRequest(w, "offset must be an integer between 0 and 100000", "INVALID_OFFSET")
			return
		}
		query.Offset = value
	}

	snapshot := h.service.Snapshot(r.Context())
	res := Response{
		GeneratedAt: snapshot.GeneratedAt,
		Configured:  snapshot.Configured,
		Complete:    snapshot.Complete,
		Summary:     snapshot.Summary,
		Sources:     snapshot.Sources,
		Items:       []UE{},
		Pagination:  Pagination{Limit: query.Limit, Total: snapshot.Summary.Total},
	}
	if !query.SummaryOnly {
		items, total := FilterAndPage(snapshot.Items, query)
		res.Items = items
		res.Pagination = Pagination{Limit: query.Limit, Offset: query.Offset, Total: total}
		nextOffset := query.Offset + len(items)
		if nextOffset < total && nextOffset <= MaxOffset {
			cursor := encodeCursor(nextOffset)
			res.Pagination.NextCursor = &cursor
			res.Pagination.HasMore = true
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	response.JSON(w, http.StatusOK, res)
}
