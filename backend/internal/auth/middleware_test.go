package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// mockSessionValidator provides a test double for session validation.
type mockSessionValidator struct {
	validateFn func(ctx context.Context, claims *Claims) (*Principal, error)
}

func (m *mockSessionValidator) ValidateSession(ctx context.Context, claims *Claims) (*Principal, error) {
	if m.validateFn != nil {
		return m.validateFn(ctx, claims)
	}
	return &Principal{
		Username:       claims.Username,
		Role:           claims.Role,
		NormalizedRole: normalizeGovernanceRole(claims.Role),
		SessionVersion: claims.SV,
		UserID:         claims.Username,
	}, nil
}

// testMiddleware creates a test middleware instance using a custom validate function.
func testMiddleware(secret []byte, validateFn func(ctx context.Context, claims *Claims) (*Principal, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(CookieName)
			if err != nil || cookie.Value == "" {
				w.Header().Set("Cache-Control", "no-store")
				writeJSONError(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
				return
			}
			tokenStr := strings.TrimSpace(cookie.Value)
			if tokenStr == "" {
				w.Header().Set("Cache-Control", "no-store")
				writeJSONError(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
				return
			}

			claims, err := VerifyJWT(tokenStr, secret)
			if err != nil {
				code := extractErrorCode(err.Error())
				if code == "AUTH_UNAVAILABLE" {
					w.Header().Set("Cache-Control", "no-store")
					writeJSONError(w, http.StatusServiceUnavailable, "Authentication temporarily unavailable", "AUTH_UNAVAILABLE")
					return
				}
				clearAuthCookie(w, r)
				w.Header().Set("Cache-Control", "no-store")
				writeJSONError(w, http.StatusUnauthorized, "Unauthorized", code)
				return
			}

			principal, err := validateFn(r.Context(), claims)
			if err != nil {
				code := extractErrorCode(err.Error())
				if code == "AUTH_UNAVAILABLE" {
					w.Header().Set("Cache-Control", "no-store")
					writeJSONError(w, http.StatusServiceUnavailable, "Authentication temporarily unavailable", "AUTH_UNAVAILABLE")
					return
				}
				clearAuthCookie(w, r)
				w.Header().Set("Cache-Control", "no-store")
				writeJSONError(w, http.StatusUnauthorized, "Unauthorized", code)
				return
			}

			ctx := ContextWithPrincipal(r.Context(), principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeJSONError(w http.ResponseWriter, status int, message, code string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{
		"error": message,
		"code":  code,
	})
}

func TestMiddleware_MissingCookie(t *testing.T) {
	mw := testMiddleware(testSecret, nil)
	nextCalled := false
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
	}))

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if nextCalled {
		t.Fatal("next handler must not be called when cookie is missing")
	}
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == CookieName {
			t.Errorf("cookie must not be cleared when no cookie was sent")
		}
	}
}

func TestMiddleware_InvalidJWT(t *testing.T) {
	mw := testMiddleware(testSecret, nil)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: "malformed.jwt.token"})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
	}
	cookieCleared := false
	for _, c := range w.Result().Cookies() {
		if c.Name == CookieName && c.MaxAge <= 0 {
			cookieCleared = true
		}
	}
	if !cookieCleared {
		t.Error("cookie must be cleared on invalid JWT")
	}
}

func TestMiddleware_ExpiredJWT(t *testing.T) {
	headerB64 := base64RawURL(`{"alg":"HS256","typ":"JWT"}`)
	claimsB64 := base64RawURL(fmt.Sprintf(`{"username":"admin","role":"admin","sv":1,"exp":%d}`, time.Now().Unix()-100))
	unsigned := headerB64 + "." + claimsB64
	sig := signHS256(unsigned, testSecret)
	expiredToken := unsigned + "." + sig

	mw := testMiddleware(testSecret, nil)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: expiredToken})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
	}
	cookieCleared := false
	for _, c := range w.Result().Cookies() {
		if c.Name == CookieName && c.MaxAge <= 0 {
			cookieCleared = true
		}
	}
	if !cookieCleared {
		t.Error("cookie must be cleared on expired JWT")
	}
}

func TestMiddleware_SessionErrors(t *testing.T) {
	validToken, _ := GenerateToken("testuser", "admin", 1, testSecret)

	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		wantClear  bool
	}{
		{
			name:       "SESSION_REVOKED",
			err:        fmt.Errorf("SESSION_REVOKED"),
			wantStatus: http.StatusUnauthorized,
			wantCode:   "SESSION_REVOKED",
			wantClear:  true,
		},
		{
			name:       "ACCOUNT_DISABLED",
			err:        fmt.Errorf("ACCOUNT_DISABLED"),
			wantStatus: http.StatusUnauthorized,
			wantCode:   "ACCOUNT_DISABLED",
			wantClear:  true,
		},
		{
			name:       "ACCOUNT_LOCKED",
			err:        fmt.Errorf("ACCOUNT_LOCKED"),
			wantStatus: http.StatusUnauthorized,
			wantCode:   "ACCOUNT_LOCKED",
			wantClear:  true,
		},
		{
			name:       "ACCOUNT_NOT_FOUND",
			err:        fmt.Errorf("ACCOUNT_NOT_FOUND"),
			wantStatus: http.StatusUnauthorized,
			wantCode:   "ACCOUNT_NOT_FOUND",
			wantClear:  true,
		},
		{
			name:       "AUTH_UNAVAILABLE",
			err:        fmt.Errorf("AUTH_UNAVAILABLE: mongo pool closed"),
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "AUTH_UNAVAILABLE",
			wantClear:  false, // temporary error, do not clear cookie
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mw := testMiddleware(testSecret, func(_ context.Context, _ *Claims) (*Principal, error) {
				return nil, tc.err
			})
			handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

			req := httptest.NewRequest("GET", "/api/auth/me", nil)
			req.AddCookie(&http.Cookie{Name: CookieName, Value: validToken})
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.wantStatus)
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
			}

			var body map[string]string
			json.Unmarshal(w.Body.Bytes(), &body)
			if body["code"] != tc.wantCode {
				t.Errorf("code = %q, want %q", body["code"], tc.wantCode)
			}

			cookieCleared := false
			for _, c := range w.Result().Cookies() {
				if c.Name == CookieName && c.MaxAge <= 0 {
					cookieCleared = true
				}
			}
			if cookieCleared != tc.wantClear {
				t.Errorf("cookie cleared = %v, want %v", cookieCleared, tc.wantClear)
			}
		})
	}
}

func TestMiddleware_ValidSession(t *testing.T) {
	validToken, _ := GenerateToken("admin1", "admin", 1, testSecret)
	nextCalled := false

	mw := testMiddleware(testSecret, func(_ context.Context, claims *Claims) (*Principal, error) {
		return &Principal{
			Username:       claims.Username,
			Role:           claims.Role,
			NormalizedRole: "admin",
			SessionVersion: claims.SV,
			UserID:         "user-admin1",
		}, nil
	})

	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		p := PrincipalFromContext(r.Context())
		if p == nil {
			t.Fatal("principal must be in request context")
		}
		if p.Username != "admin1" {
			t.Errorf("username = %q, want admin1", p.Username)
		}
		if p.NormalizedRole != "admin" {
			t.Errorf("role = %q, want admin", p.NormalizedRole)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: validToken})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if !nextCalled {
		t.Fatal("next handler must be called on valid session")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}
