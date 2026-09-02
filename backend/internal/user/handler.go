package user

import (
	"encoding/json"
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/ratelimit"
)

// Handler serves auth/user read endpoints.
type Handler struct {
	repo    *Repository
	limiter *ratelimit.Limiter
}

// NewHandler creates a user handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter) *Handler {
	return &Handler{repo: repo, limiter: limiter}
}

// AuthMe handles GET /api/auth/me.
func (h *Handler) AuthMe(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	if !h.limiter.Enforce(w, r, "auth:me:"+p.Username, 120, 60) {
		return
	}

	user, err := h.repo.FindByUsername(r.Context(), p.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal Server Error"})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "ACCOUNT_NOT_FOUND"})
		return
	}

	writeJSON(w, http.StatusOK, AuthMeResponse{
		Username:       user.Username,
		Role:           user.Role,
		DatabaseRole:   user.Role,
		NormalizedRole: auth.NormalizeRole(user.Role),
		Permissions:    auth.PermissionsFor(p),
		CreatedAt:      user.CreatedAt,
		Status:         user.Status,
	})
}

// AuthPermissions handles GET /api/auth/permissions.
func (h *Handler) AuthPermissions(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	normalizedRole := auth.NormalizeRole(p.Role)
	writeJSON(w, http.StatusOK, AuthPermissionsResponse{
		Username:       p.Username,
		Role:           p.Role,
		DatabaseRole:   p.Role,
		NormalizedRole: normalizedRole,
		Capabilities:   auth.CapabilitiesFor(p.Role),
		GovernanceRole: normalizedRole,
		Permissions:    auth.PermissionsFor(p),
	})
}

// UserList handles GET /api/auth/users and GET /api/users.
func (h *Handler) UserList(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}
	if !auth.HasPermission(p, "users.read") {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error":      "Forbidden: Insufficient permissions",
			"code":       "PERMISSION_DENIED",
			"permission": "users.read",
		})
		return
	}

	if !h.limiter.Enforce(w, r, "users:list:"+p.Username, 120, 60) {
		return
	}

	// Legacy mode: only /api/auth/users with no query string at all
	if r.URL.Path == "/api/auth/users" && r.URL.RawQuery == "" {
		users, err := h.repo.FindAll(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "USER_QUERY_FAILED", "code": "USER_QUERY_FAILED"})
			return
		}
		assignable := assignableRoles(auth.NormalizeRole(p.Role))
		if assignable == nil {
			assignable = []string{}
		}
		writeJSON(w, http.StatusOK, UserLegacyListResponse{
			Users:           users,
			AssignableRoles: assignable,
		})
		return
	}

	// Query mode: strict parser
	query, err := parseUserQueryStrict(r.URL.Query())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_QUERY", "code": "INVALID_QUERY"})
		return
	}

	result, err := h.repo.QueryUsers(r.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "USER_QUERY_FAILED", "code": "USER_QUERY_FAILED"})
		return
	}

	assignable := assignableRoles(auth.NormalizeRole(p.Role))
	if assignable == nil {
		assignable = []string{}
	}

	writeJSON(w, http.StatusOK, UserListResponse{
		Items:           result.Items,
		Pagination:      &result.Pagination,
		Stats:           &result.Stats,
		AssignableRoles: assignable,
	})
}

// UserDetail handles GET /api/auth/users/{username} and GET /api/users/{username}.
// No rate limit — Node does not enforce rate limit on user detail GET.
func (h *Handler) UserDetail(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}
	if !auth.HasPermission(p, "users.read") {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error":      "Forbidden: Insufficient permissions",
			"code":       "PERMISSION_DENIED",
			"permission": "users.read",
		})
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_QUERY", "code": "INVALID_QUERY"})
		return
	}

	user, err := h.repo.FindByUsername(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "USER_QUERY_FAILED", "code": "USER_QUERY_FAILED"})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "USER_NOT_FOUND", "code": "USER_NOT_FOUND"})
		return
	}

	// Activity — failure propagates as 503 (Node: entire try/catch)
	activity, err := h.repo.ListAuditLogsForUser(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "USER_QUERY_FAILED", "code": "USER_QUERY_FAILED"})
		return
	}

	normalizedRole := auth.NormalizeRole(user.Role)
	actorRole := auth.NormalizeRole(p.Role)

	targetPrincipal := &auth.Principal{Username: user.Username, Role: user.Role}

	actions := userManagementActions(actorRole, normalizedRole, p.Username, user.Username)
	if actions == nil {
		actions = []string{}
	}
	assignable := assignableRoles(actorRole)
	if assignable == nil {
		assignable = []string{}
	}

	writeJSON(w, http.StatusOK, UserDetailResponse{
		User:            *user,
		NormalizedRole:  normalizedRole,
		Permissions:     auth.PermissionsFor(targetPrincipal),
		Actions:         actions,
		AssignableRoles: assignable,
		Activity:        activity,
	})
}

// writeJSON writes a JSON response.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
