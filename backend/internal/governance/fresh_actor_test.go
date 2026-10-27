package governance

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"subscriber/internal/auth"
	"subscriber/internal/user"
)

type identityRepo struct {
	identity *user.UserIdentity
	err      error
	calls    int
}

func (r *identityRepo) FindByUsernameIdentity(_ context.Context, _ string) (*user.UserIdentity, error) {
	r.calls++
	return r.identity, r.err
}

func account(role string, status string, locked bool, sessionVersion int) *user.UserIdentity {
	return &user.UserIdentity{
		SafeUser: user.SafeUser{
			Username: "admin",
			Role:     role,
			Status:   status,
			Locked:   locked,
			Security: &user.UserSecurity{SessionVersion: sessionVersion},
		},
		MongoID: "507f1f77bcf86cd799439011",
	}
}

func actorPrincipal(sessionVersion int64) *auth.Principal {
	return &auth.Principal{
		Username:       "admin",
		Role:           "root",
		NormalizedRole: "admin",
		SessionVersion: sessionVersion,
	}
}

func TestRevalidateFreshActorProjectsStoredIdentity(t *testing.T) {
	repo := &identityRepo{identity: account("root", "active", false, 3)}

	fresh, httpErr := RevalidateFreshActor(context.Background(), repo, actorPrincipal(3))
	if httpErr != nil {
		t.Fatalf("an active, matching account must validate, got %+v", httpErr)
	}
	if repo.calls != 1 {
		t.Errorf("the account store must be consulted exactly once, got %d", repo.calls)
	}
	if fresh.UserID != "507f1f77bcf86cd799439011" || fresh.Username != "admin" {
		t.Errorf("unexpected identity projection: %+v", fresh)
	}
	// The legacy role is recorded raw and governed through its normalized form.
	if fresh.RawRole != "root" || fresh.NormalizedRole != "admin" {
		t.Errorf("role projection = %q/%q, want root/admin", fresh.RawRole, fresh.NormalizedRole)
	}
	if fresh.SessionVersion != 3 {
		t.Errorf("SessionVersion = %d, want 3", fresh.SessionVersion)
	}
}

func TestRevalidateFreshActorFallsBackToUsernameWithoutMongoID(t *testing.T) {
	identity := account("admin", "active", false, 0)
	identity.MongoID = ""
	identity.SafeUser.Security = nil

	fresh, httpErr := RevalidateFreshActor(context.Background(), &identityRepo{identity: identity}, actorPrincipal(0))
	if httpErr != nil {
		t.Fatalf("unexpected rejection: %+v", httpErr)
	}
	if fresh.UserID != "admin" {
		t.Errorf("UserID = %q, want the username fallback", fresh.UserID)
	}
	if fresh.SessionVersion != 0 {
		t.Errorf("a missing security block must read as session version 0, got %d", fresh.SessionVersion)
	}
}

func TestRevalidateFreshActorRefusals(t *testing.T) {
	unreachable := errors.New("account store down")

	tests := []struct {
		name       string
		repo       ActorRepository
		principal  *auth.Principal
		wantStatus int
		wantCode   string
		wantMsg    string
	}{
		{
			name:       "nil repository fails closed",
			repo:       nil,
			principal:  actorPrincipal(3),
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "AUTH_SERVICE_UNAVAILABLE",
			wantMsg:    "User validation service unavailable",
		},
		{
			name:       "account store error fails closed",
			repo:       &identityRepo{err: unreachable},
			principal:  actorPrincipal(3),
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "AUTH_SERVICE_UNAVAILABLE",
			wantMsg:    "Unable to validate user session",
		},
		{
			name:       "missing account",
			repo:       &identityRepo{},
			principal:  actorPrincipal(3),
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_USER_NOT_FOUND",
			wantMsg:    "User account not found",
		},
		{
			name:       "disabled account",
			repo:       &identityRepo{identity: account("admin", "disabled", false, 3)},
			principal:  actorPrincipal(3),
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_USER_DISABLED",
			wantMsg:    "User account is disabled",
		},
		{
			name:       "locked account",
			repo:       &identityRepo{identity: account("admin", "active", true, 3)},
			principal:  actorPrincipal(3),
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_USER_LOCKED",
			wantMsg:    "User account is locked",
		},
		{
			name:       "unrecognised stored role",
			repo:       &identityRepo{identity: account("guest_admin", "active", false, 3)},
			principal:  actorPrincipal(3),
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_UNKNOWN_ROLE",
			wantMsg:    "Unknown user role",
		},
		{
			name:       "role changed after the token was issued",
			repo:       &identityRepo{identity: account("viewer", "active", false, 3)},
			principal:  actorPrincipal(3),
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_ROLE_MISMATCH",
			wantMsg:    "Session role mismatch",
		},
		{
			name:       "session revoked",
			repo:       &identityRepo{identity: account("admin", "active", false, 4)},
			principal:  actorPrincipal(3),
			wantStatus: http.StatusForbidden,
			wantCode:   "SESSION_REVOKED",
			wantMsg:    "Session has been revoked",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fresh, httpErr := RevalidateFreshActor(context.Background(), tc.repo, tc.principal)
			if fresh != nil {
				t.Errorf("a refused revalidation must return no actor, got %+v", fresh)
			}
			if httpErr == nil {
				t.Fatalf("expected an immediate HTTP error")
			}
			if httpErr.Status != tc.wantStatus || httpErr.Code != tc.wantCode || httpErr.Message != tc.wantMsg {
				t.Errorf("got %d/%s/%q, want %d/%s/%q",
					httpErr.Status, httpErr.Code, httpErr.Message,
					tc.wantStatus, tc.wantCode, tc.wantMsg)
			}
		})
	}
}
