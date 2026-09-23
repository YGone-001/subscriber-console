package auth

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"subscriber/internal/response"
)

// Handler serves authentication endpoints: Login, Logout, Me.
type Handler struct {
	lookup UserLookup
	secret []byte
	logger *slog.Logger
}

// NewHandler creates an authentication handler.
func NewHandler(lookup UserLookup, secret []byte, logger *slog.Logger) *Handler {
	return &Handler{lookup: lookup, secret: secret, logger: logger}
}

// Login handles POST /api/auth/login.
// Verifies credentials against app_users and issues a JWT auth_token cookie.
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.BadRequest(w, "Invalid request body", "INVALID_REQUEST")
		return
	}
	if req.Username == "" || len(req.Username) > 100 || req.Password == "" {
		response.Error(w, http.StatusUnauthorized, "Invalid credentials", "AUTH_INVALID_TOKEN")
		return
	}

	user, err := h.lookup.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, "Authentication temporarily unavailable", "AUTH_UNAVAILABLE")
		return
	}
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "Invalid credentials", "AUTH_INVALID_TOKEN")
		return
	}
	if !VerifyPassword(user.PasswordHash, req.Password) {
		response.Error(w, http.StatusUnauthorized, "Invalid credentials", "AUTH_INVALID_TOKEN")
		return
	}
	if user.Status != "active" {
		response.Error(w, http.StatusForbidden, "Account disabled", "ACCOUNT_DISABLED")
		return
	}
	if user.Locked {
		response.Error(w, http.StatusForbidden, "Account locked", "ACCOUNT_LOCKED")
		return
	}

	token, err := GenerateToken(user.Username, user.Role, user.SessionVersion, h.secret)
	if err != nil {
		h.logger.Error("token generation failed", "username", user.Username, "error", err)
		response.InternalError(w)
		return
	}

	isSecure := r.Header.Get("x-forwarded-proto") == "https" || r.TLS != nil
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
		Path:     "/",
		MaxAge:   86400, // 24 hours
	})

	w.Header().Set("Cache-Control", "no-store")
	response.JSON(w, http.StatusOK, LoginResponse{
		Username: user.Username,
		Role:     user.Role,
		Message:  "login successful",
	})
}

// Logout handles POST /api/auth/logout.
// Clears the auth_token cookie with aligned security attributes. No database write required.
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	isSecure := r.Header.Get("x-forwarded-proto") == "https" || r.TLS != nil
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
	w.Header().Set("Cache-Control", "no-store")
	response.JSON(w, http.StatusOK, LogoutResponse{Message: "logout successful"})
}

// Me handles GET /api/auth/me.
// Requires a valid auth_token (enforced by middleware or manual check).
func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	p := PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	user, err := h.lookup.GetUserByUsername(r.Context(), p.Username)
	if err != nil {
		response.Error(w, http.StatusServiceUnavailable, "Authentication temporarily unavailable", "AUTH_UNAVAILABLE")
		return
	}
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "ACCOUNT_NOT_FOUND")
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	response.JSON(w, http.StatusOK, MeResponse{
		Username: user.Username,
		Role:     user.Role,
		Status:   user.Status,
	})
}
