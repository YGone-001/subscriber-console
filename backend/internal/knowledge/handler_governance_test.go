package knowledge

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"subscriber/internal/response"
	"subscriber/internal/user"
)

// denyingLimiter mimics the real limiter, which writes the 429 response itself
// when it rejects a request.
type denyingLimiter struct{}

func (denyingLimiter) Enforce(w http.ResponseWriter, _ *http.Request, _ string, _ int, _ int) bool {
	response.Error(w, http.StatusTooManyRequests, "Too many requests", "RATE_LIMITED")
	return false
}

type stubActorRepo struct {
	identity *user.UserIdentity
	err      error
}

func (s stubActorRepo) FindByUsernameIdentity(context.Context, string) (*user.UserIdentity, error) {
	return s.identity, s.err
}

func operatorRequest() *http.Request {
	return knowledgeRequest(http.MethodPost, "/api/knowledge/entries", "operator", `{"title":"x"}`)
}

func TestWriteRateLimited(t *testing.T) {
	h := NewHandler(nil, nil, denyingLimiter{}, nil)
	h.UseActorRepository(fakeActorRepo{})
	rec := httptest.NewRecorder()
	h.Create(rec, operatorRequest())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFreshActorDenials(t *testing.T) {
	active := func() user.SafeUser {
		return user.SafeUser{Username: "operator", Role: "operator", Status: "active"}
	}
	cases := []struct {
		name     string
		identity *user.UserIdentity
		err      error
		status   int
		code     string
	}{
		{
			name:     "disabled account",
			identity: &user.UserIdentity{SafeUser: user.SafeUser{Username: "operator", Role: "operator", Status: "disabled"}},
			status:   http.StatusForbidden,
			code:     "AUTH_USER_DISABLED",
		},
		{
			name:     "locked account",
			identity: &user.UserIdentity{SafeUser: user.SafeUser{Username: "operator", Role: "operator", Status: "active", Locked: true}},
			status:   http.StatusForbidden,
			code:     "AUTH_USER_LOCKED",
		},
		{
			name:     "role mismatch",
			identity: &user.UserIdentity{SafeUser: user.SafeUser{Username: "operator", Role: "viewer", Status: "active"}},
			status:   http.StatusForbidden,
			code:     "AUTH_ROLE_MISMATCH",
		},
		{
			name:     "session revoked",
			identity: &user.UserIdentity{SafeUser: func() user.SafeUser { u := active(); u.Security = &user.UserSecurity{SessionVersion: 5}; return u }()},
			status:   http.StatusForbidden,
			code:     "SESSION_REVOKED",
		},
		{
			name:     "account not found",
			identity: nil,
			status:   http.StatusForbidden,
			code:     "AUTH_USER_NOT_FOUND",
		},
		{
			name:   "account store unavailable",
			err:    errors.New("mongo down"),
			status: http.StatusServiceUnavailable,
			code:   "AUTH_SERVICE_UNAVAILABLE",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHandler(nil, nil, noopLimiter{}, nil)
			h.UseActorRepository(stubActorRepo{identity: tc.identity, err: tc.err})
			rec := httptest.NewRecorder()
			h.Create(rec, operatorRequest())
			if rec.Code != tc.status || errorCode(t, rec) != tc.code {
				t.Fatalf("expected %d %s, got %d: %s", tc.status, tc.code, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestFreshActorFailsClosedWithoutRepository(t *testing.T) {
	h := NewHandler(nil, nil, noopLimiter{}, nil)
	rec := httptest.NewRecorder()
	h.Create(rec, operatorRequest())
	if rec.Code != http.StatusServiceUnavailable || errorCode(t, rec) != "AUTH_SERVICE_UNAVAILABLE" {
		t.Fatalf("expected 503 AUTH_SERVICE_UNAVAILABLE, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestFreshActorAllowsValidActor(t *testing.T) {
	h := NewHandler(nil, nil, noopLimiter{}, nil)
	h.UseActorRepository(fakeActorRepo{})
	rec := httptest.NewRecorder()
	// A valid actor passes governance and reaches body validation (empty title).
	h.Create(rec, knowledgeRequest(http.MethodPost, "/api/knowledge/entries", "operator", `{"title":"  "}`))
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "VALIDATION_FAILED" {
		t.Fatalf("valid actor must reach validation, got %d: %s", rec.Code, rec.Body.String())
	}
}
