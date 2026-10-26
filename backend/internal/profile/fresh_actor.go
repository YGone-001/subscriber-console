package profile

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

// FreshActor is the validated actor state loaded from the database. Governance
// decisions on a template write MUST use it, never stale token claims: a
// disabled, locked or re-roled account still holds a valid signature until the
// token expires.
type FreshActor struct {
	Username       string
	RawRole        string
	NormalizedRole string
	SessionVersion int64
}

// ActorHTTPError is an error that must be answered immediately.
type ActorHTTPError struct {
	Status  int
	Message string
	Code    string
}

// RevalidateFreshActor loads the actor's account and refuses the write when it
// is missing, disabled, locked, re-roled or session-revoked. It fails closed
// when the account store cannot be consulted.
func RevalidateFreshActor(ctx context.Context, userRepo UserRepository, p *auth.Principal) (*FreshActor, *ActorHTTPError) {
	if userRepo == nil {
		return nil, &ActorHTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "User validation service unavailable",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}

	identity, err := userRepo.FindByUsernameIdentity(ctx, p.Username)
	if err != nil {
		return nil, &ActorHTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "Unable to validate user session",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}
	if identity == nil {
		return nil, &ActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account not found",
			Code:    "AUTH_USER_NOT_FOUND",
		}
	}
	if identity.SafeUser.Status != "active" {
		return nil, &ActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is disabled",
			Code:    "AUTH_USER_DISABLED",
		}
	}
	if identity.SafeUser.Locked {
		return nil, &ActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is locked",
			Code:    "AUTH_USER_LOCKED",
		}
	}

	dbRole := auth.NormalizeRole(identity.SafeUser.Role)
	if dbRole == "" {
		return nil, &ActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Unknown user role",
			Code:    "AUTH_UNKNOWN_ROLE",
		}
	}
	if dbRole != p.NormalizedRole {
		return nil, &ActorHTTPError{
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
		return nil, &ActorHTTPError{
			Status:  http.StatusForbidden,
			Message: "Session has been revoked",
			Code:    "SESSION_REVOKED",
		}
	}

	return &FreshActor{
		Username:       identity.SafeUser.Username,
		RawRole:        identity.SafeUser.Role,
		NormalizedRole: dbRole,
		SessionVersion: dbSessionVersion,
	}, nil
}
