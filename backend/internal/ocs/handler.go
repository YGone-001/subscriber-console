package ocs

import (
	"net/http"
	"strings"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// Handler provides HTTP handlers for OCS read endpoints.
//
// The limiter is the package-level RateLimiter (shared with the write handlers),
// so read handlers can be exercised without a database-backed limiter.
type Handler struct {
	repo        *Repository
	limiter     RateLimiter
	auditWriter *audit.Writer
}

// NewHandler creates a new OCS Handler.
//
// Kept for compatibility: the original constructor had no denial auditor, and
// existing call sites keep working unchanged.
func NewHandler(repo *Repository, limiter RateLimiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// NewHandlerWithAudit creates an OCS read handler that records authorization
// denials as audit evidence, matching the other governed read surfaces.
func NewHandlerWithAudit(repo *Repository, limiter RateLimiter, auditWriter *audit.Writer) *Handler {
	return &Handler{repo: repo, limiter: limiter, auditWriter: auditWriter}
}

// Balances handles GET /api/ocs/balances
func (h *Handler) Balances(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:balances:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	opts := BalanceQueryOptions{
		Page:            intParam(q, "page", 1),
		Limit:           intParam(q, "limit", 20),
		IMSI:            q.Get("imsi"),
		PlanID:          q.Get("planId"),
		Status:          q.Get("status"),
		InvariantStatus: q.Get("invariant"),
		SortField:       firstNonEmpty(q.Get("sortField"), q.Get("sort")),
		SortOrder:       firstNonEmpty(q.Get("sortOrder"), q.Get("order")),
	}
	if opts.IMSI == "" {
		opts.IMSI = q.Get("q")
	}

	result, err := h.repo.ListBalances(r.Context(), opts)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// Sessions handles GET /api/ocs/sessions
func (h *Handler) Sessions(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:sessions:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	opts := SessionQueryOptions{
		Page:          intParam(q, "page", 1),
		Limit:         intParam(q, "limit", 20),
		IMSI:          firstNonEmpty(q.Get("imsi"), q.Get("q")),
		SessionID:     q.Get("sessionId"),
		APN:           q.Get("apn"),
		State:         q.Get("state"),
		InterfaceType: q.Get("interfaceType"),
		SortField:     firstNonEmpty(q.Get("sortField"), q.Get("sort")),
		SortOrder:     firstNonEmpty(q.Get("sortOrder"), q.Get("order")),
	}

	result, err := h.repo.ListSessions(r.Context(), opts)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// Usage handles GET /api/ocs/usage
func (h *Handler) Usage(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:usage:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	opts := UsageQueryOptions{
		Page:          intParam(q, "page", 1),
		Limit:         intParam(q, "limit", 20),
		IMSI:          firstNonEmpty(q.Get("imsi"), q.Get("q")),
		SessionID:     q.Get("sessionId"),
		APN:           q.Get("apn"),
		CCRequestType: q.Get("ccRequestType"),
		SortField:     firstNonEmpty(q.Get("sortField"), q.Get("sort")),
		SortOrder:     firstNonEmpty(q.Get("sortOrder"), q.Get("order")),
	}

	if chargedStr := q.Get("charged"); chargedStr == "true" {
		t := true
		opts.Charged = &t
	} else if chargedStr == "false" {
		f := false
		opts.Charged = &f
	}

	result, err := h.repo.ListUsageRecords(r.Context(), opts)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// Reservations handles GET /api/ocs/reservations
func (h *Handler) Reservations(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:reservations:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	opts := ReservationQueryOptions{
		Page:         intParam(q, "page", 1),
		Limit:        intParam(q, "limit", 20),
		IMSI:         firstNonEmpty(q.Get("imsi"), q.Get("q")),
		SessionID:    q.Get("sessionId"),
		State:        q.Get("state"),
		ChargingType: q.Get("chargingType"),
		SortField:    firstNonEmpty(q.Get("sortField"), q.Get("sort")),
		SortOrder:    firstNonEmpty(q.Get("sortOrder"), q.Get("order")),
	}

	result, err := h.repo.ListReservations(r.Context(), opts)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// Subscribers handles GET /api/ocs/subscribers
func (h *Handler) Subscribers(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:subscribers:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	opts := SubscriberQueryOptions{
		Page:      intParam(q, "page", 1),
		Limit:     intParam(q, "limit", 20),
		IMSI:      firstNonEmpty(q.Get("imsi"), q.Get("q")),
		MSISDN:    q.Get("msisdn"),
		PlanID:    q.Get("planId"),
		Status:    q.Get("status"),
		SortField: firstNonEmpty(q.Get("sortField"), q.Get("sort")),
		SortOrder: firstNonEmpty(q.Get("sortOrder"), q.Get("order")),
	}

	result, err := h.repo.ListSubscribers(r.Context(), opts)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// GetSubscriber handles GET /api/ocs/subscribers/{imsi}.
//
// It answers with exactly the requested contract, which is what allows the
// console to tell "this contract does not exist" apart from "this identifier was
// only a prefix of some other contract". A not-found answer is a 404, never a
// neighbouring record.
func (h *Handler) GetSubscriber(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "ocs.read", h.auditWriter) {
		return
	}

	if !h.limiter.Enforce(w, r, "ocs:subscribers:get:"+p.Username, 120, 60) {
		return
	}

	imsi := strings.TrimSpace(r.PathValue("imsi"))
	if !imsiRegex.MatchString(imsi) {
		response.Error(w, http.StatusBadRequest, "Valid IMSI is required", "OCS_INVALID_IMSI")
		return
	}

	record, err := h.repo.GetSubscriberRecord(r.Context(), imsi)
	if err != nil {
		response.InternalError(w)
		return
	}
	if record == nil {
		response.Error(w, http.StatusNotFound, "OCS subscriber contract not found", "OCS_SUBSCRIBER_NOT_FOUND")
		return
	}

	operations, operationsComplete, historyErr := h.repo.GetContractOperations(r.Context(), imsi, 20)
	if historyErr != nil {
		operations = []ContractOperation{}
		operationsComplete = false
	}

	response.JSON(w, http.StatusOK, map[string]any{
		"ok":                 true,
		"record":             record,
		"operations":         operations,
		"operationsComplete": operationsComplete,
	})
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func intParam(q map[string][]string, key string, fallback int) int {
	if vals, ok := q[key]; ok && len(vals) > 0 {
		if v := parseInt(vals[0]); v > 0 {
			return v
		}
	}
	return fallback
}

func parseInt(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
