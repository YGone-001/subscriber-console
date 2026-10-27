package subscriber

import (
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/credential"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

// Handler provides HTTP handlers for subscriber read endpoints.
type Handler struct {
	repo        *Repository
	limiter     *ratelimit.Limiter
	auditWriter *audit.Writer
}

// NewHandler creates a new subscriber Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter, auditWriter *audit.Writer) *Handler {
	return &Handler{repo: repo, limiter: limiter, auditWriter: auditWriter}
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

	listFilters := parseSubscriberListFilters(q)

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
		result, err := h.repo.ListSubscriberRowsFiltered(r.Context(), page, limit, query, listFilters, sortField, sortDirection)
		if err != nil {
			response.InternalError(w)
			return
		}
		response.JSON(w, http.StatusOK, result)
	} else {
		result, err := h.repo.ListSubscriberImsisFiltered(r.Context(), page, limit, query, listFilters.SearchBy, sortDirection)
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

	projectAuthMaterial(state, auth.HasCapability(p, "subscriber_write"))

	response.JSON(w, http.StatusOK, state)
}

// parseSubscriberListFilters normalizes the additive list filters. Unknown
// values are ignored so the existing lenient query contract is preserved.
func parseSubscriberListFilters(q url.Values) SubscriberListFilters {
	filters := SubscriberListFilters{
		SearchBy: "imsi",
		Status:   "all",
	}
	if q.Get("searchBy") == "auto" {
		filters.SearchBy = "auto"
	}

	switch q.Get("status") {
	case "active", "restricted":
		filters.Status = q.Get("status")
	case "lowTraffic":
		filters.BalanceStatus = "exhausted"
	}

	switch q.Get("contractStatus") {
	case "active", "suspended", "terminated", "none":
		filters.ContractStatus = q.Get("contractStatus")
	}

	switch q.Get("provisioning") {
	case "complete", "incomplete", "missing_contract", "missing_balance", "missing_plan":
		filters.Provisioning = q.Get("provisioning")
	}

	switch q.Get("balanceStatus") {
	case "exhausted", "low", "normal", "available", "missing":
		filters.BalanceStatus = q.Get("balanceStatus")
	}

	filters.PlanID = q.Get("planId")
	// Drill-down by template binding; the value is a profile name, not a query.
	filters.ProfileFilter = strings.TrimSpace(q.Get("profile"))
	return filters
}

// projectAuthMaterial withholds the permanent subscriber keys from roles that
// cannot provision authentication material, and states the condition of every
// key in their place. Deleting the keys alone would leave a reader unable to
// tell "this subscriber has no OPc" from "you may not see the OPc"; the same
// projection governs the template surface.
func projectAuthMaterial(state *LegacySubscriberState, canProvision bool) {
	if state == nil || state.Auth4G == nil {
		return
	}

	visibility := credential.VisibilityMasked
	if canProvision {
		visibility = credential.VisibilityPlaintext
	}
	state.Auth4G[credential.StateKey] = credential.Describe(state.Auth4G, visibility)

	if canProvision {
		return
	}
	for _, key := range credential.Keys {
		delete(state.Auth4G, string(key))
	}
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
	if !audit.RequireCapabilityWithAudit(w, r, p, "subscriber_write", h.auditWriter) {
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
