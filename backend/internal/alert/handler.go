package alert

import (
	"net/http"

	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

// Handler handles HTTP requests for alert endpoints.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
}

// NewHandler creates a new alert Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// List handles GET /api/alerts.
// Accessible by admin, operator, and viewer roles.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Rate limit: 120 req / 60s per user (alerts:list:<user>)
	if h.limiter != nil && !h.limiter.Enforce(w, r, "alerts:list:"+p.Username, 120, 60) {
		return
	}

	res, err := h.repo.ListAlerts(r.Context(), 101)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Alert fetch failed",
		})
		return
	}

	response.JSON(w, http.StatusOK, res)
}
