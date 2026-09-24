package auth

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"subscriber/internal/ratelimit"
)

// --- test helpers ---

type mockLookup struct {
	users            map[string]*AuthUser
	getUserErr       error
	recordFailedErr  error
	recordSuccessErr error
	recordSuccessNil bool
	countAdminsErr   error
}

func (m *mockLookup) GetUserByUsername(_ context.Context, username string) (*AuthUser, error) {
	if m.getUserErr != nil {
		return nil, m.getUserErr
	}
	return m.users[username], nil
}

func (m *mockLookup) RecordFailedLogin(ctx context.Context, username string) (bool, int, error) {
	if m.recordFailedErr != nil {
		return false, 0, m.recordFailedErr
	}
	u := m.users[username]
	if u == nil {
		return false, 0, nil
	}
	u.FailedLoginAttempts++
	if u.FailedLoginAttempts >= 10 {
		if NormalizeRole(u.Role) == "admin" {
			activeAdmins, err := m.CountActiveAdmins(ctx)
			if err != nil {
				return false, u.FailedLoginAttempts, err
			}
			if activeAdmins <= 1 {
				return false, u.FailedLoginAttempts, nil
			}
		}
		u.Locked = true
		u.Status = "locked"
		u.SessionVersion++
		return true, u.FailedLoginAttempts, nil
	}
	return false, u.FailedLoginAttempts, nil
}

func (m *mockLookup) RecordSuccessfulLogin(_ context.Context, user *AuthUser, _ string) (*AuthUser, error) {
	if m.recordSuccessErr != nil {
		return nil, m.recordSuccessErr
	}
	if m.recordSuccessNil {
		return nil, nil
	}
	u := m.users[user.Username]
	if u == nil {
		return nil, nil
	}
	u.FailedLoginAttempts = 0
	return u, nil
}

func (m *mockLookup) CountActiveAdmins(_ context.Context) (int64, error) {
	if m.countAdminsErr != nil {
		return 0, m.countAdminsErr
	}
	var count int64
	for _, u := range m.users {
		if NormalizeRole(u.Role) == "admin" && u.Status == "active" && !u.Locked {
			count++
		}
	}
	return count, nil
}

type mockLimiter struct {
	checkCalls []string
	peekCalls  []string
	allow      bool
}

func newMockLimiter() *mockLimiter {
	return &mockLimiter{allow: true}
}

func (m *mockLimiter) Check(_ context.Context, identifier string, limit int, _ int) (*ratelimit.Result, error) {
	m.checkCalls = append(m.checkCalls, identifier)
	return &ratelimit.Result{
		Allowed:   m.allow,
		Limit:     limit,
		Remaining: limit - len(m.checkCalls),
	}, nil
}

func (m *mockLimiter) Peek(_ context.Context, identifier string, limit int, _ int) (*ratelimit.Result, error) {
	m.peekCalls = append(m.peekCalls, identifier)
	return &ratelimit.Result{
		Allowed:   m.allow,
		Limit:     limit,
		Remaining: limit,
	}, nil
}

type auditEvent struct {
	action    string
	result    string
	actorType string
	username  string
	role      string
	metadata  map[string]interface{}
}

type mockAudit struct {
	events []auditEvent
}

func (a *mockAudit) RecordAuthEvent(action, result, actorType, username, role, ip, userAgent string, metadata map[string]interface{}) {
	a.events = append(a.events, auditEvent{
		action:    action,
		result:    result,
		actorType: actorType,
		username:  username,
		role:      role,
		metadata:  metadata,
	})
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
	h := NewHandler(lookup, nil, nil, testSecret, testLogger())

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
	if !resp.Success {
		t.Errorf("success = false, want true")
	}
	if resp.Username != "admin" {
		t.Errorf("username = %q, want admin", resp.Username)
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
	h := NewHandler(lookup, nil, nil, testSecret, testLogger())

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
	h := NewHandler(lookup, nil, nil, testSecret, testLogger())

	body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "correct-horse-battery"})
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Login(w, req)

	// In Phase 6.2+, disabled accounts return uniform 401 to preserve response privacy
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// --- Test 4: JWT expiration ---

func TestJWTExpiration(t *testing.T) {
	token, err := GenerateToken("admin", "admin", 0, testSecret)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	claims, err := VerifyJWT(token, testSecret)
	if err != nil {
		t.Fatalf("VerifyJWT valid token: %v", err)
	}
	if claims.Username != "admin" {
		t.Errorf("username = %q, want admin", claims.Username)
	}

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
		}{SessionVersion: int64Ptr(3)},
	}
	_, err := ValidateSessionMatch(claims, user)
	if err == nil {
		t.Fatal("sessionVersion mismatch must be rejected")
	}
}

// --- Test 7: /logout clears cookie ---

func TestLogoutClearsCookie(t *testing.T) {
	lookup := &mockLookup{users: map[string]*AuthUser{}}
	h := NewHandler(lookup, nil, nil, testSecret, testLogger())

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
	if !resp.Success {
		t.Errorf("success = false, want true")
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
	h := NewHandler(lookup, nil, nil, testSecret, testLogger())

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
	h := NewHandler(lookup, nil, nil, testSecret, testLogger())

	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// --- Test 10: Parameterized failure cases matching Section 12 ---

func TestLoginFailureCases_Parameterized(t *testing.T) {
	tests := []struct {
		name                   string
		username               string
		password               string
		setupLookup            func() *mockLookup
		expectedStatus         int
		expectedError          string
		expectAccountRateLimit bool
		expectLockAudit        bool
		expectLoginFailedAudit bool
	}{
		{
			name:     "user lookup infrastructure error",
			username: "admin",
			password: "password123",
			setupLookup: func() *mockLookup {
				return &mockLookup{
					users: map[string]*AuthUser{
						"admin": makeAuthUser("admin", "password123", "admin", "active", false, 1),
					},
					getUserErr: errors.New("mongodb connection timeout"),
				}
			},
			expectedStatus:         http.StatusInternalServerError,
			expectedError:          "Internal Server Error",
			expectAccountRateLimit: false,
			expectLockAudit:        false,
			expectLoginFailedAudit: false,
		},
		{
			name:     "failed-login persistence error",
			username: "admin",
			password: "wrong-password",
			setupLookup: func() *mockLookup {
				return &mockLookup{
					users: map[string]*AuthUser{
						"admin": makeAuthUser("admin", "password123", "admin", "active", false, 1),
					},
					recordFailedErr: errors.New("mongodb write concern timeout"),
				}
			},
			expectedStatus:         http.StatusInternalServerError,
			expectedError:          "Internal Server Error",
			expectAccountRateLimit: true, // consumed before recordFailedLogin (Node order)
			expectLockAudit:        false,
			expectLoginFailedAudit: false,
		},
		{
			name:     "active-admin count error during auto-lock evaluation",
			username: "admin",
			password: "wrong-password",
			setupLookup: func() *mockLookup {
				u := makeAuthUser("admin", "password123", "admin", "active", false, 1)
				u.FailedLoginAttempts = 9
				return &mockLookup{
					users:          map[string]*AuthUser{"admin": u},
					countAdminsErr: errors.New("mongodb count query failed"),
				}
			},
			expectedStatus:         http.StatusInternalServerError,
			expectedError:          "Internal Server Error",
			expectAccountRateLimit: true,
			expectLockAudit:        false,
			expectLoginFailedAudit: false,
		},
		{
			name:     "automatic lock transition persistence error",
			username: "operator",
			password: "wrong-password",
			setupLookup: func() *mockLookup {
				u := makeAuthUser("operator", "password123", "operator", "active", false, 1)
				u.FailedLoginAttempts = 9
				return &mockLookup{
					users:           map[string]*AuthUser{"operator": u},
					recordFailedErr: errors.New("mongodb lock transition update failed"),
				}
			},
			expectedStatus:         http.StatusInternalServerError,
			expectedError:          "Internal Server Error",
			expectAccountRateLimit: true,
			expectLockAudit:        false,
			expectLoginFailedAudit: false,
		},
		{
			name:     "successful-login concurrency guard miss",
			username: "admin",
			password: "password123",
			setupLookup: func() *mockLookup {
				return &mockLookup{
					users: map[string]*AuthUser{
						"admin": makeAuthUser("admin", "password123", "admin", "active", false, 1),
					},
					recordSuccessNil: true,
				}
			},
			expectedStatus:         http.StatusUnauthorized,
			expectedError:          "Invalid credentials",
			expectAccountRateLimit: true,
			expectLockAudit:        false,
			expectLoginFailedAudit: true,
		},
		{
			name:     "successful-login persistence error",
			username: "admin",
			password: "password123",
			setupLookup: func() *mockLookup {
				return &mockLookup{
					users: map[string]*AuthUser{
						"admin": makeAuthUser("admin", "password123", "admin", "active", false, 1),
					},
					recordSuccessErr: errors.New("mongodb connection lost"),
				}
			},
			expectedStatus:         http.StatusInternalServerError,
			expectedError:          "Internal Server Error",
			expectAccountRateLimit: false,
			expectLockAudit:        false,
			expectLoginFailedAudit: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			lookup := tc.setupLookup()
			limiter := newMockLimiter()
			audit := &mockAudit{}
			h := NewHandler(lookup, limiter, audit, testSecret, testLogger())

			body, _ := json.Marshal(LoginRequest{Username: tc.username, Password: tc.password})
			req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
			w := httptest.NewRecorder()

			h.Login(w, req)

			// 1. Verify status code
			if w.Code != tc.expectedStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.expectedStatus)
			}

			// 2. Verify Cache-Control header
			if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", cc)
			}

			// 3. Verify JSON body
			var resp map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("unmarshal error: %v", err)
			}
			if resp["error"] != tc.expectedError {
				t.Errorf("error = %v, want %q", resp["error"], tc.expectedError)
			}

			// 4. Verify no auth_token cookie is set
			for _, c := range w.Result().Cookies() {
				if c.Name == CookieName && c.Value != "" && c.MaxAge > 0 {
					t.Errorf("auth_token cookie should not be set on failure")
				}
			}

			// 5. Verify account-scoped failed-login rate limit mutation
			expectedKey := "login-user:" + tc.username
			accountRateLimitCalled := false
			for _, call := range limiter.checkCalls {
				if call == expectedKey {
					accountRateLimitCalled = true
					break
				}
			}
			if accountRateLimitCalled != tc.expectAccountRateLimit {
				t.Errorf("account rate limit consumed = %v, want %v", accountRateLimitCalled, tc.expectAccountRateLimit)
			}

			// 6. Verify audit logging
			hasLockAudit := false
			hasLoginFailedAudit := false
			for _, ev := range audit.events {
				if ev.action == "auth.account.locked" && ev.result == "success" {
					hasLockAudit = true
				}
				if ev.action == "auth.login" && ev.result == "failed" {
					hasLoginFailedAudit = true
				}
			}
			if hasLockAudit != tc.expectLockAudit {
				t.Errorf("lock audit emitted = %v, want %v", hasLockAudit, tc.expectLockAudit)
			}
			if hasLoginFailedAudit != tc.expectLoginFailedAudit {
				t.Errorf("login failed audit emitted = %v, want %v", hasLoginFailedAudit, tc.expectLoginFailedAudit)
			}
		})
	}
}

// --- Test 11: Section 13 Not-Found vs Infrastructure Failure distinction ---

func TestLoginNotFoundVsInfrastructureFailure(t *testing.T) {
	t.Run("not-found returns 401 generic invalid credentials", func(t *testing.T) {
		lookup := &mockLookup{users: map[string]*AuthUser{}}
		limiter := newMockLimiter()
		audit := &mockAudit{}
		h := NewHandler(lookup, limiter, audit, testSecret, testLogger())

		body, _ := json.Marshal(LoginRequest{Username: "unknownuser", Password: "any-password"})
		req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
		w := httptest.NewRecorder()

		h.Login(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
		}
		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["error"] != "Invalid credentials" {
			t.Errorf("error = %v, want 'Invalid credentials'", resp["error"])
		}

		// Account rate limit must be consumed for unknown user
		foundKey := false
		for _, call := range limiter.checkCalls {
			if call == "login-user:unknownuser" {
				foundKey = true
				break
			}
		}
		if !foundKey {
			t.Errorf("account rate limit must be consumed on not-found")
		}

		// auth.login failed audit must be emitted
		foundAudit := false
		for _, ev := range audit.events {
			if ev.action == "auth.login" && ev.result == "failed" && ev.username == "unknownuser" {
				foundAudit = true
				break
			}
		}
		if !foundAudit {
			t.Errorf("auth.login failed audit must be emitted on not-found")
		}
	})

	t.Run("infrastructure-error returns 500 without consuming quota or auditing failed credentials", func(t *testing.T) {
		lookup := &mockLookup{
			users:      map[string]*AuthUser{},
			getUserErr: errors.New("mongodb cluster offline"),
		}
		limiter := newMockLimiter()
		audit := &mockAudit{}
		h := NewHandler(lookup, limiter, audit, testSecret, testLogger())

		body, _ := json.Marshal(LoginRequest{Username: "unknownuser", Password: "any-password"})
		req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
		w := httptest.NewRecorder()

		h.Login(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", w.Code)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
		}
		var resp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &resp)
		if resp["error"] != "Internal Server Error" {
			t.Errorf("error = %v, want 'Internal Server Error'", resp["error"])
		}

		// Account rate limit must NOT be consumed
		for _, call := range limiter.checkCalls {
			if call == "login-user:unknownuser" {
				t.Errorf("account rate limit must NOT be consumed on infrastructure error")
			}
		}

		// No failed credential audit
		for _, ev := range audit.events {
			if ev.action == "auth.login" {
				t.Errorf("auth.login audit must NOT be emitted on infrastructure error")
			}
		}
	})
}

// --- Test 12: Section 14 Failed-login error ordering ---

func TestLoginFailedLoginErrorOrdering(t *testing.T) {
	lookup := &mockLookup{
		users: map[string]*AuthUser{
			"operator": makeAuthUser("operator", "secretpass", "operator", "active", false, 1),
		},
		recordFailedErr: errors.New("mongodb primary stepdown during recordFailedLogin"),
	}
	limiter := newMockLimiter()
	audit := &mockAudit{}
	h := NewHandler(lookup, limiter, audit, testSecret, testLogger())

	body, _ := json.Marshal(LoginRequest{Username: "operator", Password: "wrong-password"})
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.Login(w, req)

	// Account rate-limit was consumed before RecordFailedLogin call (matching Node)
	consumed := false
	for _, call := range limiter.checkCalls {
		if call == "login-user:operator" {
			consumed = true
			break
		}
	}
	if !consumed {
		t.Errorf("account rate limit should be consumed before recordFailedLogin per Node order")
	}

	// But response must be 500 Internal Server Error
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
	}

	// No lock audit emitted
	for _, ev := range audit.events {
		if ev.action == "auth.account.locked" {
			t.Errorf("auth.account.locked must not be emitted when lock transition fails")
		}
	}
}

// --- Test 13: Section 15 Successful-login error ordering ---

func TestLoginSuccessfulLoginErrorOrdering(t *testing.T) {
	t.Run("concurrency guard miss returns 401 and consumes account limiter", func(t *testing.T) {
		lookup := &mockLookup{
			users: map[string]*AuthUser{
				"admin": makeAuthUser("admin", "goodpassword", "admin", "active", false, 1),
			},
			recordSuccessNil: true,
		}
		limiter := newMockLimiter()
		audit := &mockAudit{}
		h := NewHandler(lookup, limiter, audit, testSecret, testLogger())

		body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "goodpassword"})
		req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
		w := httptest.NewRecorder()

		h.Login(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
		}

		consumed := false
		for _, call := range limiter.checkCalls {
			if call == "login-user:admin" {
				consumed = true
				break
			}
		}
		if !consumed {
			t.Errorf("account rate limit must be consumed on concurrency guard miss")
		}

		for _, c := range w.Result().Cookies() {
			if c.Name == CookieName && c.Value != "" && c.MaxAge > 0 {
				t.Errorf("cookie must not be set on concurrency guard miss")
			}
		}
	})

	t.Run("persistence error returns 500 without consuming account limiter or setting cookie", func(t *testing.T) {
		lookup := &mockLookup{
			users: map[string]*AuthUser{
				"admin": makeAuthUser("admin", "goodpassword", "admin", "active", false, 1),
			},
			recordSuccessErr: errors.New("mongodb write concern timeout during recordSuccessfulLogin"),
		}
		limiter := newMockLimiter()
		audit := &mockAudit{}
		h := NewHandler(lookup, limiter, audit, testSecret, testLogger())

		body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "goodpassword"})
		req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
		w := httptest.NewRecorder()

		h.Login(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", w.Code)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
		}

		for _, call := range limiter.checkCalls {
			if call == "login-user:admin" {
				t.Errorf("account rate limit must NOT be consumed on persistence error")
			}
		}

		for _, c := range w.Result().Cookies() {
			if c.Name == CookieName && c.Value != "" && c.MaxAge > 0 {
				t.Errorf("cookie must not be set on persistence error")
			}
		}
	})
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
