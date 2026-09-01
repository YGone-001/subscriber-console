package subscriber

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// Handler provides HTTP handlers for subscriber read endpoints.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
}

// NewHandler creates a new subscriber Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// List handles GET /api/subscribers
//
// Two modes:
//   - detail=false (default): returns paginated IMSI list
//   - detail=true: returns enriched rows with OCS data
//   - msisdn query param: returns MSISDN lookup result
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "subscribers:list:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	detail := q.Get("detail") == "true"
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit < 1 {
		limit = 50
	}
	query := q.Get("q")
	status := q.Get("status")
	sortField := q.Get("sortField")
	if sortField == "" {
		sortField = q.Get("sort")
	}
	if sortField == "" {
		sortField = "imsi"
	}
	sortDirection := q.Get("sortDirection")
	if sortDirection == "" {
		sortDirection = q.Get("sortDir")
	}
	if sortDirection == "" {
		sortDirection = q.Get("order")
	}
	if sortDirection != "desc" {
		sortDirection = "asc"
	}
	msisdn := q.Get("msisdn")
	excludeImsi := q.Get("excludeImsi")

	// Normalize status filter
	statusFilter := "all"
	if status == "active" || status == "restricted" || status == "lowTraffic" {
		statusFilter = status
	}

	// MSISDN lookup mode
	if msisdn != "" {
		result, err := h.repo.FindSubscriberByMsisdn(r.Context(), msisdn, excludeImsi)
		if err != nil {
			response.InternalError(w)
			return
		}
		response.JSON(w, http.StatusOK, result)
		return
	}

	if detail {
		result, err := h.repo.ListSubscriberRows(r.Context(), page, limit, query, statusFilter, sortField, sortDirection)
		if err != nil {
			response.InternalError(w)
			return
		}
		response.JSON(w, http.StatusOK, result)
	} else {
		result, err := h.repo.ListSubscriberImsis(r.Context(), page, limit, query, sortDirection)
		if err != nil {
			response.InternalError(w)
			return
		}
		response.JSON(w, http.StatusOK, result)
	}
}

// Detail handles GET /api/subscribers/{imsi}
func (h *Handler) Detail(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	imsi := r.PathValue("imsi")
	if _, err := validateImsi(imsi, "IMSI"); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if !h.limiter.Enforce(w, r, "subscribers:detail:"+p.Username, 180, 60) {
		return
	}

	state, err := h.repo.FindSubscriberLegacyState(r.Context(), imsi)
	if err != nil {
		response.InternalError(w)
		return
	}
	if state == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Subscriber not found"})
		return
	}

	response.JSON(w, http.StatusOK, state)
}

// Search handles GET /api/search
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "search:"+p.Username, 60, 60) {
		return
	}

	q := r.URL.Query()
	query := q.Get("q")
	limit := clampSearchLimit(q.Get("limit"))

	// Min query length: 2 (return empty, not 400)
	if len(query) < 2 {
		response.JSON(w, http.StatusOK, SearchResponse{Results: []SearchResult{}})
		return
	}

	subscriberLimit := int(math.Ceil(float64(limit) / 2))
	profileLimit := limit - subscriberLimit

	subscribers := h.repo.SearchSubscribers(r.Context(), query, subscriberLimit)
	profiles := h.repo.SearchProfiles(r.Context(), query, profileLimit)

	// Merge: subscribers first, then profiles, cap at limit
	results := make([]SearchResult, 0, limit)
	results = append(results, subscribers...)
	results = append(results, profiles...)
	if len(results) > limit {
		results = results[:limit]
	}
	if results == nil {
		results = []SearchResult{}
	}

	response.JSON(w, http.StatusOK, SearchResponse{Results: results})
}

// BatchPrecheck handles POST /api/subscribers/batch/precheck
//
// This is a semantic read (POST body but no writes). Uses subscriber_write capability
// to match Node behavior.
func (h *Handler) BatchPrecheck(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Requires subscriber_write capability (matching Node requireCapability)
	if !auth.HasCapability(p, "subscriber_write") {
		response.Forbidden(w, "Subscriber write capability required")
		return
	}

	if !h.limiter.Enforce(w, r, "subscribers:batch-precheck:"+p.Username, 30, 60) {
		return
	}

	var body struct {
		StartImsi string `json:"startImsi"`
		Count     int    `json:"count"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	startImsi, err := validateImsi(body.StartImsi, "startImsi")
	if err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	count, err := validateBatchCount(body.Count)
	if err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	result, err := h.repo.PrecheckSubscriberRange(r.Context(), startImsi, count)
	if err != nil {
		if err.Error() == "IMSI_RANGE_OVERFLOW" {
			response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Generated IMSI range exceeds 15 digits"})
			return
		}
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// clampSearchLimit clamps the search limit to [1, 12], default 8.
func clampSearchLimit(value string) int {
	n, err := strconv.Atoi(value)
	if err != nil {
		return 8
	}
	if n < 1 {
		return 1
	}
	if n > 12 {
		return 12
	}
	return n
}
