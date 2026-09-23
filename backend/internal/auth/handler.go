package auth

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

const (
	rateLimitIPMax        = 5
	rateLimitIPWindow     = 60
	rateLimitUserMax      = 10
	rateLimitUserWindow   = 300
	rateLimitLogoutMax    = 30
	rateLimitLogoutWindow = 60
	dummyBcryptHash       = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"
)

// AuditRecorder defines the interface for recording authentication audit events.
type AuditRecorder interface {
	RecordAuthEvent(action, result, actorType, username, role, ip, userAgent string, metadata map[string]interface{})
}

// Handler serves authentication endpoints: Login, Logout, Me.
type Handler struct {
	lookup  UserLookup
	limiter *ratelimit.Limiter
	audit   AuditRecorder
	secret  []byte
	logger  *slog.Logger
}

// NewHandler creates an authentication handler with rate limiting and audit logging.
func NewHandler(lookup UserLookup, limiter *ratelimit.Limiter, audit AuditRecorder, secret []byte, logger *slog.Logger) *Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return &Handler{
		lookup:  lookup,
		limiter: limiter,
		audit:   audit,
		secret:  secret,
		logger:  logger,
	}
}

// clientIP extracts the client IP address matching Node precedence:
// 1. x-real-ip
// 2. first x-forwarded-for entry
// 3. "unknown"
func clientIP(r *http.Request) string {
	if realIP := strings.TrimSpace(r.Header.Get("x-real-ip")); realIP != "" {
		return realIP
	}
	if fwd := r.Header.Get("x-forwarded-for"); fwd != "" {
		parts := strings.Split(fwd, ",")
		if first := strings.TrimSpace(parts[0]); first != "" {
			return first
		}
	}
	return "unknown"
}

func writeBadRequest(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusBadRequest)
	w.Write([]byte(`{"error":"Username and password required"}`))
}

func writeInvalidCredentials(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	w.Write([]byte(`{"error":"Invalid credentials"}`))
}

// Login handles POST /api/auth/login.
// Verifies credentials against app_users and issues a JWT auth_token cookie.
// Matches Node login contract, rate limiting, and failure accounting exactly.
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	// 1. IP rate limiting (5 attempts per 60 seconds)
	ip := clientIP(r)
	var rateCheck *ratelimit.Result
	if h.limiter != nil {
		var err error
		rateCheck, err = h.limiter.Check(r.Context(), "login:"+ip, rateLimitIPMax, rateLimitIPWindow)
		if err == nil && !rateCheck.Allowed {
			w.Header().Set("Retry-After", strconv.Itoa(rateCheck.RetryAfter))
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(rateLimitIPMax))
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"Too many login attempts. Please try again later."}`))
			return
		}
	}

	// 2. Request body validation
	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 65536))
	if err != nil {
		writeBadRequest(w)
		return
	}

	var rawBody interface{}
	if err := json.Unmarshal(bodyBytes, &rawBody); err != nil {
		writeBadRequest(w)
		return
	}

	bodyMap, ok := rawBody.(map[string]interface{})
	if !ok || bodyMap == nil {
		writeBadRequest(w)
		return
	}

	rawUsername, hasUsername := bodyMap["username"]
	rawPassword, hasPassword := bodyMap["password"]
	if !hasUsername || !hasPassword {
		writeBadRequest(w)
		return
	}

	username, okUser := rawUsername.(string)
	password, okPass := rawPassword.(string)
	if !okUser || !okPass || username == "" || password == "" || len(username) > 100 || len([]byte(password)) > 72 {
		writeBadRequest(w)
		return
	}

	// 3. Pre-auth account-scoped failed login rate check (10 failed attempts per 300 seconds)
	normalizedUsername := strings.ToLower(strings.TrimSpace(username))
	if h.limiter != nil {
		userRateCheck, err := h.limiter.Peek(r.Context(), "login-user:"+normalizedUsername, rateLimitUserMax, rateLimitUserWindow)
		if err == nil && !userRateCheck.Allowed {
			w.Header().Set("Retry-After", strconv.Itoa(userRateCheck.RetryAfter))
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(rateLimitUserMax))
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"Too many login attempts. Please try again later."}`))
			return
		}
	}

	// 4. Credential verification with constant-shape bcrypt work
	storedUser, _ := h.lookup.GetUserByUsername(r.Context(), username)
	hashToVerify := dummyBcryptHash
	if storedUser != nil && storedUser.PasswordHash != "" {
		hashToVerify = storedUser.PasswordHash
	}
	isValid := VerifyPassword(hashToVerify, password)

	// 5. Generic invalid credentials on any verification or state mismatch
	if storedUser == nil || !isValid || storedUser.Status != "active" || storedUser.Locked || NormalizeRole(storedUser.Role) == "" {
		// Consume one failed authentication attempt for this account
		if h.limiter != nil {
			_, _ = h.limiter.Check(r.Context(), "login-user:"+normalizedUsername, rateLimitUserMax, rateLimitUserWindow)
		}

		if storedUser != nil && storedUser.Status == "active" && !storedUser.Locked {
			locked, attempts, _ := h.lookup.RecordFailedLogin(r.Context(), username)
			if locked && h.audit != nil {
				h.audit.RecordAuthEvent(
					"auth.account.locked",
					"success",
					"system",
					username,
					"",
					ip,
					r.UserAgent(),
					map[string]interface{}{"reason": "excessive_failed_logins", "attempts": attempts},
				)
			}
		}

		if h.audit != nil {
			h.audit.RecordAuthEvent("auth.login", "failed", "user", username, "", ip, r.UserAgent(), nil)
		}

		writeInvalidCredentials(w)
		return
	}

	// 6. Record successful login with race-safe atomic state check
	current, err := h.lookup.RecordSuccessfulLogin(r.Context(), storedUser, ip)
	if err != nil || current == nil {
		if h.limiter != nil {
			_, _ = h.limiter.Check(r.Context(), "login-user:"+normalizedUsername, rateLimitUserMax, rateLimitUserWindow)
		}
		if h.audit != nil {
			h.audit.RecordAuthEvent("auth.login", "failed", "user", username, "", ip, r.UserAgent(), nil)
		}
		writeInvalidCredentials(w)
		return
	}

	// 7. Issue HS256 JWT auth_token cookie
	token, err := GenerateToken(current.Username, current.Role, current.SessionVersion, h.secret)
	if err != nil {
		h.logger.Error("token generation failed", "username", current.Username, "error", err)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"Internal Server Error"}`))
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
	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(rateLimitIPMax))
	remaining := 0
	if rateCheck != nil {
		remaining = rateCheck.Remaining
	}
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")

	if h.audit != nil {
		h.audit.RecordAuthEvent("auth.login", "success", "user", current.Username, current.Role, ip, r.UserAgent(), nil)
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(LoginResponse{
		Success:  true,
		Username: current.Username,
	})
}

// Logout handles POST /api/auth/logout.
// Clears the auth_token cookie with aligned security attributes.
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if h.limiter != nil {
		result, err := h.limiter.Check(r.Context(), "auth:logout:"+ip, rateLimitLogoutMax, rateLimitLogoutWindow)
		if err == nil && !result.Allowed {
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(result.Limit))
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(result.Remaining))
			w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(result.ResetAt, 10))
			w.Header().Set("Retry-After", strconv.Itoa(result.RetryAfter))
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"Too many requests"}`))
			return
		}
	}

	isSecure := r.Header.Get("x-forwarded-proto") == "https" || r.TLS != nil
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
		Path:     "/",
		MaxAge:   -1,
	})
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"success":true}`))
}

// Me handles GET /api/auth/me (direct handler in auth package).
// Requires a valid auth_token (enforced by middleware or manual check).
func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	p := PrincipalFromContext(r.Context())
	if p == nil {
		w.Header().Set("Cache-Control", "no-store")
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	user, err := h.lookup.GetUserByUsername(r.Context(), p.Username)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		response.Error(w, http.StatusServiceUnavailable, "Authentication temporarily unavailable", "AUTH_UNAVAILABLE")
		return
	}
	if user == nil {
		w.Header().Set("Cache-Control", "no-store")
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
