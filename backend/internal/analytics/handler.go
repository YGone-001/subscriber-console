package analytics

import (
	"net/http"

	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
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

// InitResponse represents the response body for POST /api/analytics/init.
type InitResponse struct {
	Message string            `json:"message"`
	Metrics *AnalyticsMetrics `json:"metrics"`
}

// Init handles POST /api/analytics/init.
// Accessible by admin and operator roles; viewer is denied.
func (h *Handler) Init(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	normRole := auth.NormalizeRole(p.Role)
	if normRole != "admin" && normRole != "operator" {
		response.Error(w, http.StatusForbidden, "Forbidden: Insufficient permissions", "PERMISSION_DENIED")
		return
	}

	// Rate limit: 3 req / 300s per user (analytics:init:<user>)
	if h.limiter != nil && !h.limiter.Enforce(w, r, "analytics:init:"+p.Username, 3, 300) {
		return
	}

	metrics, err := h.repo.ComputeMetrics(r.Context())
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("Internal Server Error"))
		return
	}

	response.JSON(w, http.StatusOK, InitResponse{
		Message: "MongoDB analytics are computed from subscriber documents on demand.",
		Metrics: metrics,
	})
}
