package auth

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// --- test helpers ---

type mockLookup struct {
	users map[string]*AuthUser
	err   error
}

func (m *mockLookup) GetUserByUsername(_ context.Context, username string) (*AuthUser, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.users[username], nil
}

var testSecret = []byte("test-secret-with-at-least-32-bytes-long!!")

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func makeAuthUser(username, password, role, status string, locked bool, sv int64) *AuthUser {
	hash, _ := HashPassword(password)
	return &AuthUser{
		Username:       username,
		PasswordHash:   hash,
		Role:           role,
		Status:         status,
		Locked:         locked,
		SessionVersion: sv,
	}
}

// --- Test 1: Valid login ---

func TestLoginValid(t *testing.T) {
	lookup := &mockLookup{users: map[string]*AuthUser{
		"admin": makeAuthUser("admin", "correct-horse-battery", "admin", "active", false, 5),
	}}
	h := NewHandler(lookup, testSecret, testLogger())

	body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "correct-horse-battery"})
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Login(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp LoginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Username != "admin" {
		t.Errorf("username = %q, want admin", resp.Username)
	}
	if resp.Role != "admin" {
		t.Errorf("role = %q, want admin", resp.Role)
	}
	if resp.Message != "login successful" {
		t.Errorf("message = %q, want login successful", resp.Message)
	}

	cookies := w.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == CookieName {
			found = true
			if !c.HttpOnly {
				t.Error("cookie must be HttpOnly")
			}
			if c.MaxAge != 86400 {
				t.Errorf("MaxAge = %d, want 86400", c.MaxAge)
			}
			if c.Value == "" {
				t.Error("cookie value must not be empty")
			}
		}
	}
	if !found {
		t.Fatal("auth_token cookie not set")
	}
}

// --- Test 2: Invalid password ---

func TestLoginInvalidPassword(t *testing.T) {
	lookup := &mockLookup{users: map[string]*AuthUser{
		"admin": makeAuthUser("admin", "correct-horse-battery", "admin", "active", false, 0),
	}}
	h := NewHandler(lookup, testSecret, testLogger())

	body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "wrong-password"})
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Login(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// --- Test 3: Disabled account ---

func TestLoginDisabledAccount(t *testing.T) {
	lookup := &mockLookup{users: map[string]*AuthUser{
		"admin": makeAuthUser("admin", "correct-horse-battery", "admin", "disabled", false, 0),
	}}
	h := NewHandler(lookup, testSecret, testLogger())

	body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "correct-horse-battery"})
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Login(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

// --- Test 4: JWT expiration ---

func TestJWTExpiration(t *testing.T) {
	// GenerateToken always creates 24h tokens; craft an expired one manually.
	// An expired token must be rejected by VerifyJWT.
	// We generate a token and verify it is valid first, then test with
	// a tampered exp by signing an expired claim set.
	token, err := GenerateToken("admin", "admin", 0, testSecret)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	// Valid token passes
	claims, err := VerifyJWT(token, testSecret)
	if err != nil {
		t.Fatalf("VerifyJWT valid token: %v", err)
	}
	if claims.Username != "admin" {
		t.Errorf("username = %q, want admin", claims.Username)
	}

	// Build an expired token by re-signing with exp=0
	// Use GenerateToken then manually check expiry path in VerifyJWT.
	// Since GenerateToken always sets future exp, create raw expired claims.
	headerB64 := base64RawURL(`{"alg":"HS256","typ":"JWT"}`)
	claimsB64 := base64RawURL(`{"username":"admin","role":"admin","sv":0,"exp":1}`)
	unsigned := headerB64 + "." + claimsB64
	sig := signHS256(unsigned, testSecret)
	expiredToken := unsigned + "." + sig

	_, err = VerifyJWT(expiredToken, testSecret)
	if err == nil {
		t.Fatal("expired token must be rejected")
	}
}

// --- Test 5: Invalid signature ---

func TestJWTInvalidSignature(t *testing.T) {
	token, err := GenerateToken("admin", "admin", 0, testSecret)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	wrongSecret := []byte("wrong-secret-with-at-least-32-bytes-long!!")
	_, err = VerifyJWT(token, wrongSecret)
	if err == nil {
		t.Fatal("token signed with wrong secret must be rejected")
	}
}

// --- Test 6: sessionVersion mismatch ---

func TestSessionVersionMismatch(t *testing.T) {
	claims := &Claims{Username: "admin", Role: "admin", SV: 5, Exp: 9999999999}
	user := &UserDocument{
		Username: "admin",
		Role:     "admin",
		Status:   "active",
		Security: &struct {
			SessionVersion *int64 `bson:"sessionVersion,omitempty"`
		}{SessionVersion: int64Ptr(3)}, // mismatch: 5 != 3
	}
	_, err := ValidateSessionMatch(claims, user)
	if err == nil {
		t.Fatal("sessionVersion mismatch must be rejected")
	}
}

// --- Test 7: /logout clears cookie ---

func TestLogoutClearsCookie(t *testing.T) {
	lookup := &mockLookup{users: map[string]*AuthUser{}}
	h := NewHandler(lookup, testSecret, testLogger())

	req := httptest.NewRequest("POST", "/api/auth/logout", nil)
	w := httptest.NewRecorder()

	h.Logout(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp LogoutResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Message != "logout successful" {
		t.Errorf("message = %q, want logout successful", resp.Message)
	}

	cookies := w.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == CookieName {
			found = true
			if c.MaxAge >= 0 {
				t.Errorf("MaxAge = %d, want negative (cookie cleared)", c.MaxAge)
			}
		}
	}
	if !found {
		t.Fatal("auth_token cookie not cleared")
	}
}

// --- Test 8: /api/auth/me success ---

func TestMeSuccess(t *testing.T) {
	lookup := &mockLookup{users: map[string]*AuthUser{
		"admin": {Username: "admin", Role: "admin", Status: "active", SessionVersion: 1},
	}}
	h := NewHandler(lookup, testSecret, testLogger())

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	ctx := ContextWithPrincipal(req.Context(), &Principal{
		Username: "admin",
		Role:     "admin",
	})
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp MeResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Username != "admin" {
		t.Errorf("username = %q, want admin", resp.Username)
	}
	if resp.Role != "admin" {
		t.Errorf("role = %q, want admin", resp.Role)
	}
	if resp.Status != "active" {
		t.Errorf("status = %q, want active", resp.Status)
	}
}

// --- Test 9: /api/auth/me without token returns 401 ---

func TestMeWithoutToken(t *testing.T) {
	lookup := &mockLookup{users: map[string]*AuthUser{}}
	h := NewHandler(lookup, testSecret, testLogger())

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// --- helpers ---

func base64RawURL(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func signHS256(unsigned string, secret []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(unsigned))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func int64Ptr(v int64) *int64 {
	return &v
}
