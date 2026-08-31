package rating

import (
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// Handler provides HTTP handlers for rating endpoints.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
}

// NewHandler creates a new rating Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// List handles GET /api/ratings
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Rate limit: 90 req/60s per user (same as Node)
	if !h.limiter.Enforce(w, r, "ratings:list:"+p.Username, 90, 60) {
		return
	}

	planID := r.URL.Query().Get("planId")
	ratings, err := h.repo.ListRatings(r.Context(), planID)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, RatingListResponse{Ratings: ratings})
}

// Get handles GET /api/ratings/:id
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	// Rate limit
	if !h.limiter.Enforce(w, r, "ratings:get:"+p.Username, 90, 60) {
		return
	}

	// Extract ID from path: /api/ratings/:id
	id := r.PathValue("id")
	if id == "" {
		response.BadRequest(w, "Rating ID is required", "INVALID_QUERY")
		return
	}

	planID := r.URL.Query().Get("planId")
	rating, err := h.repo.GetRating(r.Context(), id, planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if rating == nil {
		response.NotFound(w)
		return
	}

	response.JSON(w, http.StatusOK, rating)
}
