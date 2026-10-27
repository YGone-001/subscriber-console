package governance

import (
	"context"
	"net/http"

	"subscriber/internal/auth"
	"subscriber/internal/user"
)

// ActorRepository is the account-store view the revalidation needs: only the
// fresh identity lookup, never the password hash or any other secret.
type ActorRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// FreshActor is the fully validated actor state read back from the database.
// Every mutation governance decision MUST use this, never stale token claims:
// a disabled, locked or re-roled account still holds a valid signature until the
// token expires.
type FreshActor struct {
	UserID         string
	Username       string
	RawRole        string
	NormalizedRole string
	SessionVersion int64
}

// HTTPError is a validation failure that must be answered immediately with the
// carried status and code.
type HTTPError struct {
	Status  int
	Message string
	Code    string
}

// RevalidateFreshActor loads the actor's account and refuses the write when it is
// missing, disabled, locked, carries an unrecognised role, no longer matches the
// role the token asserts, or has had its session revoked. It fails closed when
// the account store cannot be consulted, and never falls back to a stale token role.
func RevalidateFreshActor(ctx context.Context, repo ActorRepository, p *auth.Principal) (*FreshActor, *HTTPError) {
	if repo == nil {
		return nil, &HTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "User validation service unavailable",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}

	identity, err := repo.FindByUsernameIdentity(ctx, p.Username)
	if err != nil {
		return nil, &HTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "Unable to validate user session",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}
	if identity == nil {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "User account not found",
			Code:    "AUTH_USER_NOT_FOUND",
		}
	}

	if identity.SafeUser.Status != "active" {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is disabled",
			Code:    "AUTH_USER_DISABLED",
		}
	}

	if identity.SafeUser.Locked {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is locked",
			Code:    "AUTH_USER_LOCKED",
		}
	}

	dbRole := auth.NormalizeRole(identity.SafeUser.Role)
	if dbRole == "" {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "Unknown user role",
			Code:    "AUTH_UNKNOWN_ROLE",
		}
	}

	if dbRole != p.NormalizedRole {
		return nil, &HTTPError{
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
		return nil, &HTTPError{
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

	// Accounts without a stored Mongo identifier are addressed by username,
	// matching the operator identity the legacy runtime recorded.
	if actor.UserID == "" {
		actor.UserID = actor.Username
	}

	return actor, nil
}
