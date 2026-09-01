package profile

import (
	"net/http"
	"regexp"
	"strconv"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
	"github.com/YGone-001/subscriber-console/backend/internal/response"
	"go.mongodb.org/mongo-driver/v2/bson"
)

var validProfileName = regexp.MustCompile(`^[a-zA-Z0-9_\s-]+$`)

// Handler provides HTTP handlers for profile read endpoints.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
}

// NewHandler creates a new profile Handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// List handles GET /api/profiles
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:list:"+p.Username, 90, 60) {
		return
	}

	profiles, summary, err := h.repo.ListProfiles(r.Context())
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileListResponse{
		Profiles: profiles,
		Summary:  summary,
	})
}

// Get handles GET /api/profiles/:name
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:detail:"+p.Username, 120, 60) {
		return
	}

	profile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}
	if profile == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile not found"})
		return
	}

	stats, err := h.repo.GetProfileStats(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileDetailResponse{
		Profile: profile,
		Stats:   &stats,
	})
}

// Stats handles GET /api/profiles/:name/stats
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:stats:"+p.Username, 120, 60) {
		return
	}

	// Check profile exists
	profile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}
	if profile == nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "Profile not found"})
		return
	}

	stats, err := h.repo.GetProfileStats(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileStatsResponse{Stats: stats})
}

// Versions handles GET /api/profiles/:name/versions
func (h *Handler) Versions(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	name := r.PathValue("name")
	if !validProfileName.MatchString(name) {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid profile name format"})
		return
	}

	if !h.limiter.Enforce(w, r, "profiles:versions:"+p.Username, 120, 60) {
		return
	}

	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	// Get current profile summary
	currentProfile, err := h.repo.GetProfile(r.Context(), name)
	if err != nil {
		response.InternalError(w)
		return
	}

	var currentSummary *ProfileCurrentSummary
	if currentProfile != nil {
		cs := ProfileCurrentSummary{
			Title: name,
		}
		if t, ok := currentProfile["title"].(string); ok && t != "" {
			cs.Title = t
		}
		if u, ok := currentProfile["updatedAt"].(string); ok {
			cs.UpdatedAt = u
		} else if c, ok := currentProfile["createdAt"].(string); ok {
			cs.UpdatedAt = c
		}
		if u, ok := currentProfile["updatedBy"].(string); ok {
			cs.UpdatedBy = u
		} else if c, ok := currentProfile["createdBy"].(string); ok {
			cs.UpdatedBy = c
		}
		if sl, ok := currentProfile["sliceList"].(bson.A); ok {
			cs.SliceCount = len(sl)
		}
		currentSummary = &cs
	}

	versions, err := h.repo.ListProfileVersions(r.Context(), name, limit)
	if err != nil {
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ProfileVersionsResponse{
		Versions: versions,
		Current:  currentSummary,
	})
}
