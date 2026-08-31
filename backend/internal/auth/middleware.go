package auth

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/YGone-001/subscriber-console/backend/internal/response"
)

// CookieName is the name of the auth cookie issued by Next.js.
const CookieName = "auth_token"

// Middleware creates an HTTP middleware that verifies the auth_token cookie,
// validates the JWT, and checks the session against MongoDB.
//
// On success, it adds the Principal to the request context.
// On failure, it returns 401 with the appropriate error code.
func Middleware(secret []byte, validator *SessionValidator, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract token from cookie
			cookie, err := r.Cookie(CookieName)
			if err != nil || cookie.Value == "" {
				response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
				return
			}
			tokenStr := strings.TrimSpace(cookie.Value)
			if tokenStr == "" {
				response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
				return
			}

			// Verify JWT
			claims, err := VerifyJWT(tokenStr, secret)
			if err != nil {
				code := extractErrorCode(err.Error())
				if code == "AUTH_UNAVAILABLE" {
					response.Error(w, http.StatusServiceUnavailable, "Authentication temporarily unavailable", "AUTH_UNAVAILABLE")
					return
				}
				response.Error(w, http.StatusUnauthorized, "Unauthorized", code)
				return
			}

			// Validate session against MongoDB
			principal, err := validator.ValidateSession(r.Context(), claims)
			if err != nil {
				code := extractErrorCode(err.Error())
				if code == "AUTH_UNAVAILABLE" {
					response.Error(w, http.StatusServiceUnavailable, "Authentication temporarily unavailable", "AUTH_UNAVAILABLE")
					return
				}
				logger.Warn("session validation failed",
					"error", code,
					"username", claims.Username,
					"request_id", r.Header.Get("X-Request-ID"),
				)
				response.Error(w, http.StatusUnauthorized, "Unauthorized", code)
				return
			}

			// Add principal to context
			ctx := ContextWithPrincipal(r.Context(), principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// extractErrorCode extracts the error code from the error message.
// The verifier and session validator use "CODE: message" format.
func extractErrorCode(errMsg string) string {
	// Check for known error codes
	codes := []string{
		"AUTH_INVALID_TOKEN",
		"ACCOUNT_NOT_FOUND",
		"ACCOUNT_LOCKED",
		"ACCOUNT_DISABLED",
		"SESSION_REVOKED",
		"AUTH_UNAVAILABLE",
	}
	for _, code := range codes {
		if strings.HasPrefix(errMsg, code) {
			return code
		}
	}
	return "AUTH_INVALID_TOKEN"
}
