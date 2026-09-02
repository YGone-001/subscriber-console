package user

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

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
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	if !h.limiter.Enforce(w, r, "auth:me:"+p.Username, 120, 60) {
		return
	}

	user, err := h.repo.FindByUsername(r.Context(), p.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found", "code": "ACCOUNT_NOT_FOUND"})
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
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	normalizedRole := auth.NormalizeRole(p.Role)
	writeJSON(w, http.StatusOK, AuthPermissionsResponse{
		Username:       p.Username,
		Role:           p.Role,
		DatabaseRole:   p.Role,
		NormalizedRole: normalizedRole,
		Capabilities:   auth.CapabilitiesFor(normalizedRole),
		GovernanceRole: normalizedRole,
		Permissions:    auth.PermissionsFor(p),
	})
}

// UserList handles GET /api/auth/users and GET /api/users.
func (h *Handler) UserList(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized", "code": "UNAUTHORIZED"})
		return
	}
	if !auth.HasPermission(p, "users.read") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied", "code": "PERMISSION_DENIED"})
		return
	}

	if !h.limiter.Enforce(w, r, "users:list:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	hasQuery := q.Has("page") || q.Has("pageSize") || q.Has("search") || q.Has("q") ||
		q.Has("role") || q.Has("status") || q.Has("sort") || q.Has("order")

	if !hasQuery {
		// Legacy no-query mode: return all users + assignableRoles
		users, err := h.repo.FindAll(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"users":           users,
			"assignableRoles": assignableRoles(auth.NormalizeRole(p.Role)),
		})
		return
	}

	// Query mode
	query := parseUserQuery(q)
	result, err := h.repo.QueryUsers(r.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, UserListResponse{
		Items:           result.Items,
		Pagination:      &result.Pagination,
		Stats:           &result.Stats,
		AssignableRoles: assignableRoles(auth.NormalizeRole(p.Role)),
	})
}

// UserDetail handles GET /api/auth/users/{username} and GET /api/users/{username}.
func (h *Handler) UserDetail(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized", "code": "UNAUTHORIZED"})
		return
	}
	if !auth.HasPermission(p, "users.read") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied", "code": "PERMISSION_DENIED"})
		return
	}

	if !h.limiter.Enforce(w, r, "users:list:"+p.Username, 120, 60) {
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username required"})
		return
	}

	user, err := h.repo.FindByUsername(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found", "code": "USER_NOT_FOUND"})
		return
	}

	activity, err := h.repo.ListAuditLogsForUser(r.Context(), username)
	if err != nil {
		activity = []AuditLog{}
	}

	normalizedRole := auth.NormalizeRole(user.Role)
	actorRole := auth.NormalizeRole(p.Role)

	targetPrincipal := &auth.Principal{Username: user.Username, Role: user.Role}

	writeJSON(w, http.StatusOK, UserDetailResponse{
		User:            *user,
		NormalizedRole:  normalizedRole,
		Permissions:     auth.PermissionsFor(targetPrincipal),
		Actions:         userManagementActions(actorRole, normalizedRole, p.Username, user.Username),
		AssignableRoles: assignableRoles(actorRole),
		Activity:        activity,
	})
}

// parseUserQuery extracts and validates query parameters.
func parseUserQuery(q map[string][]string) UserQuery {
	uq := UserQuery{
		Page:     1,
		PageSize: 20,
		Sort:     "createdAt",
		Order:    "desc",
	}

	if v := first(q, "page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			uq.Page = n
		}
	}
	if v := first(q, "pageSize"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			uq.PageSize = n
		}
	}
	if v := first(q, "search"); v != "" {
		uq.Search = v
	} else if v := first(q, "q"); v != "" {
		uq.Search = v
	}
	if v := first(q, "role"); v != "" {
		uq.Role = v
	}
	if v := first(q, "status"); v != "" {
		uq.Status = v
	}
	if v := first(q, "sort"); v != "" {
		allowed := map[string]bool{
			"username": true, "displayName": true, "role": true,
			"status": true, "createdAt": true, "lastLoginAt": true,
		}
		if allowed[v] {
			uq.Sort = v
		}
	}
	if v := first(q, "order"); v != "" {
		lv := strings.ToLower(v)
		if lv == "asc" || lv == "desc" {
			uq.Order = lv
		}
	}

	return uq
}

func first(m map[string][]string, key string) string {
	if vals, ok := m[key]; ok && len(vals) > 0 {
		return vals[0]
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
