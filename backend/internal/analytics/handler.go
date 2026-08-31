package analytics

import (
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// Handler provides HTTP handlers for analytics endpoints.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
}

// NewHandler creates a new analytics Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// Metrics handles GET /api/analytics/metrics
func (h *Handler) Metrics(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Rate limit: 120 req/60s per user (same as Node)
	if !h.limiter.Enforce(w, r, "analytics:metrics:"+p.Username, 120, 60) {
		return
	}

	metrics, err := h.repo.ComputeMetrics(r.Context())
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, metrics)
}

// Sparkline handles GET /api/analytics/sparkline
func (h *Handler) Sparkline(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Rate limit
	if !h.limiter.Enforce(w, r, "analytics:sparkline:"+p.Username, 120, 60) {
		return
	}

	result, err := h.repo.ComputeSparkline(r.Context())
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, result)
}
