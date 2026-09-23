package user

import (
	"encoding/json"
	"errors"
	"net/http"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
)

// Handler serves auth/user read and write endpoints.
type Handler struct {
	repo    *Repository
	svc     *Service
	limiter *ratelimit.Limiter
	writer  *audit.Writer
}

// NewHandler creates a user handler.
func NewHandler(repo *Repository, limiter *ratelimit.Limiter, writer *audit.Writer) *Handler {
	return &Handler{repo: repo, svc: NewService(repo), limiter: limiter, writer: writer}
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

	// Check users.read capability with denial audit
	if !audit.RequireCapabilityWithAudit(w, r, p, "users.read", h.writer) {
		return
	}

	// Check users.read permission with denial audit
	if !audit.RequirePermissionWithAudit(w, r, p, "users.read", h.writer) {
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
func (h *Handler) UserDetail(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	// Check users.read capability with denial audit
	if !audit.RequireCapabilityWithAudit(w, r, p, "users.read", h.writer) {
		return
	}

	// Check users.read permission with denial audit
	if !audit.RequirePermissionWithAudit(w, r, p, "users.read", h.writer) {
		return
	}

	// Extract username from path
	username := extractUsername(r.URL.Path)
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_USERNAME", "code": "INVALID_USERNAME"})
		return
	}

	user, err := h.repo.FindByUsername(r.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "USER_QUERY_FAILED", "code": "USER_QUERY_FAILED"})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found", "code": "USER_NOT_FOUND"})
		return
	}

	// Get activity (best-effort — matching Node behavior)
	activity, _ := h.repo.ListAuditLogsForUser(r.Context(), username)
	if activity == nil {
		activity = []AuditLog{}
	}

	writeJSON(w, http.StatusOK, UserDetailResponse{
		User:            *user,
		NormalizedRole:  auth.NormalizeRole(user.Role),
		Permissions:     auth.PermissionsFor(p),
		Actions:         []string{},
		AssignableRoles: assignableRoles(auth.NormalizeRole(p.Role)),
		Activity:        activity,
	})
}

func extractUsername(path string) string {
	// /api/auth/users/{username} or /api/users/{username}
	prefixes := []string{"/api/auth/users/", "/api/users/"}
	for _, prefix := range prefixes {
		if len(path) > len(prefix) && path[:len(prefix)] == prefix {
			return path[len(prefix):]
		}
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// --- Write endpoints (admin only) ---

// CreateUser handles POST /api/users.
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "users.create", h.writer) {
		return
	}

	if !h.limiter.Enforce(w, r, "users:create:"+p.Username, 10, 60) {
		return
	}

	var req CreateUserRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body", "code": "INVALID_REQUEST"})
		return
	}

	user, err := h.svc.CreateUser(r.Context(), req, p)
	if err != nil {
		writeServiceError(w, err)
		return
	}

	h.logUserOperation(r, p, "user.create", user.Username, nil, user)
	writeJSON(w, http.StatusCreated, user)
}

// UpdateUser handles PATCH /api/users/{username}.
func (h *Handler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "users.update", h.writer) {
		return
	}

	if !h.limiter.Enforce(w, r, "users:update:"+p.Username, 30, 60) {
		return
	}

	username := extractUsername(r.URL.Path)
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_USERNAME", "code": "INVALID_USERNAME"})
		return
	}

	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body", "code": "INVALID_REQUEST"})
		return
	}

	before, _ := h.repo.FindByUsername(r.Context(), username)

	user, err := h.svc.UpdateUser(r.Context(), username, req, p)
	if err != nil {
		writeServiceError(w, err)
		return
	}

	h.logUserOperation(r, p, "user.update", username, before, user)
	writeJSON(w, http.StatusOK, user)
}

// DisableUser handles POST /api/users/{username}/disable.
func (h *Handler) DisableUser(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "users.disable", h.writer) {
		return
	}

	if !h.limiter.Enforce(w, r, "users:disable:"+p.Username, 10, 60) {
		return
	}

	username := extractUsernameFromAction(r.URL.Path, "/disable")
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_USERNAME", "code": "INVALID_USERNAME"})
		return
	}

	before, _ := h.repo.FindByUsername(r.Context(), username)

	user, err := h.svc.DisableUser(r.Context(), username, p)
	if err != nil {
		writeServiceError(w, err)
		return
	}

	h.logUserOperation(r, p, "user.disable", username, before, user)
	writeJSON(w, http.StatusOK, user)
}

// ResetPassword handles POST /api/users/{username}/password-reset.
func (h *Handler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized", "code": "UNAUTHORIZED"})
		return
	}

	if !audit.RequirePermissionWithAudit(w, r, p, "users.reset-password", h.writer) {
		return
	}

	if !h.limiter.Enforce(w, r, "users:reset-pw:"+p.Username, 10, 60) {
		return
	}

	username := extractUsernameFromAction(r.URL.Path, "/password-reset")
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_USERNAME", "code": "INVALID_USERNAME"})
		return
	}

	var req ResetPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body", "code": "INVALID_REQUEST"})
		return
	}

	if err := h.svc.ResetPassword(r.Context(), username, req); err != nil {
		writeServiceError(w, err)
		return
	}

	h.logUserOperation(r, p, "user.password.reset", username, nil, nil)
	writeJSON(w, http.StatusOK, map[string]string{"message": "password reset successful"})
}

// extractUsernameFromAction extracts the username from a path like
// /api/users/{username}/{action} by stripping the trailing action segment.
func extractUsernameFromAction(path, action string) string {
	// Strip the action suffix first
	if len(path) > len(action) && path[len(path)-len(action):] == action {
		path = path[:len(path)-len(action)]
	}
	return extractUsername(path)
}

// writeServiceError maps service errors to HTTP responses.
func writeServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUserNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found", "code": "USER_NOT_FOUND"})
	case errors.Is(err, ErrUsernameTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Username already exists", "code": "USERNAME_ALREADY_EXISTS"})
	case errors.Is(err, ErrSelfDisable):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Cannot disable your own account", "code": "SELF_OPERATION_FORBIDDEN"})
	case errors.Is(err, ErrSelfRoleChange):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Cannot change your own role", "code": "SELF_ROLE_CHANGE_FORBIDDEN"})
	default:
		code := err.Error()
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": code, "code": code})
	}
}

// logUserOperation writes an audit record for a user management operation.
func (h *Handler) logUserOperation(r *http.Request, p *auth.Principal, action, targetUsername string, before, after interface{}) {
	if h.writer == nil {
		return
	}
	source, request, reason := audit.AuditRequestContext(r)
	input := audit.WriteAuditInput{
		Action: action,
		Module: "user",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Resource: &audit.ResourceInput{
			Type: "user",
			ID:   targetUsername,
		},
		TargetID:  "SYS_USER:" + targetUsername,
		Source:    source,
		Request:   request,
		Reason:    reason,
		Before:    before,
		After:     after,
		RiskLevel: "medium",
		Result:    "success",
	}
	h.writer.WriteBestEffort(input)
}
