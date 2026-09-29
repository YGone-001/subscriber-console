package rating

import (
	"net/http"
	"regexp"

	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

// ratingIDPattern matches the Node.js isValidRatingId() check: digits only.
var ratingIDPattern = regexp.MustCompile(`^[0-9]+$`)

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

	// Rate limit: 120 req/60s per user (same as Node)
	if !h.limiter.Enforce(w, r, "ratings:detail:"+p.Username, 120, 60) {
		return
	}

	// Extract ID from path: /api/ratings/:id
	id := r.PathValue("id")
	if !ratingIDPattern.MatchString(id) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid rating ID format"})
		return
	}

	planID := r.URL.Query().Get("planId")
	rating, err := h.repo.GetRating(r.Context(), id, planID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if rating == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Rating not found"})
		return
	}

	response.JSON(w, http.StatusOK, map[string]any{"rating": rating})
}
