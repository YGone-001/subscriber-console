package balance

import (
	"context"
	"net/http"

	"subscriber/internal/auth"
	"subscriber/internal/user"
)

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// FreshActor represents a fully validated fresh user state from the database.
// All mutation governance decisions MUST use this, never stale token claims.
type FreshActor struct {
	UserID         string
	Username       string
	RawRole        string
	NormalizedRole string
	SessionVersion int64
}

// FreshActorHTTPError represents an HTTP error during fresh actor validation.
type FreshActorHTTPError struct {
	Status  int
	Message string
	Code    string
}

// RevalidateFreshActor loads fresh user state from the DB and validates it
// against the token claims. Returns a complete FreshActor or an error.
// NEVER falls back to stale token role.
func RevalidateFreshActor(ctx context.Context, userRepo UserRepository, p *auth.Principal) (*FreshActor, *FreshActorHTTPError) {
	if userRepo == nil {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "User validation service unavailable",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}

	identity, err := userRepo.FindByUsernameIdentity(ctx, p.Username)
	if err != nil {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "Unable to validate user session",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}
	if identity == nil {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account not found",
			Code:    "AUTH_USER_NOT_FOUND",
		}
	}

	if identity.SafeUser.Status != "active" {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is disabled",
			Code:    "AUTH_USER_DISABLED",
		}
	}

	if identity.SafeUser.Locked {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is locked",
			Code:    "AUTH_USER_LOCKED",
		}
	}

	dbRole := auth.NormalizeRole(identity.SafeUser.Role)
	if dbRole == "" {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Unknown user role",
			Code:    "AUTH_UNKNOWN_ROLE",
		}
	}

	if dbRole != p.NormalizedRole {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Session role mismatch",
			Code:    "AUTH_ROLE_MISMATCH",
		}
	}

	dbSessionVersion := int64(0)
	if identity.SafeUser.Security != nil {
		dbSessionVersion = int64(identity.SafeUser.Security.SessionVersion)
	}
	if dbSessionVersion != p.SessionVersion {
		return nil, &FreshActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Session has been revoked",
			Code:    "SESSION_REVOKED",
		}
	}

	actor := &FreshActor{
		UserID:         identity.MongoID,
		Username:       identity.SafeUser.Username,
		RawRole:        identity.SafeUser.Role,
		NormalizedRole: dbRole,
		SessionVersion: dbSessionVersion,
	}
	if actor.UserID == "" {
		actor.UserID = actor.Username
	}

	return actor, nil
}
