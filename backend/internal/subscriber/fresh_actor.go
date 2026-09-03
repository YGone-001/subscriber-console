package subscriber

import (
	"context"
	"fmt"
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
)

// FreshActor represents a fully validated fresh user state from the database.
// All mutation governance decisions MUST use this, never stale token claims.
type FreshActor struct {
	UserID         string
	Username       string
	RawRole        string
	NormalizedRole string
	SessionVersion int64
}

// FreshActorResult holds the result of fresh actor validation.
type FreshActorResult struct {
	Actor *FreshActor
	Error error
	// If non-nil, the handler should return this HTTP error immediately.
	HTTPError *HTTPError
}

// HTTPError represents an HTTP error response.
type HTTPError struct {
	Status  int
	Message string
	Code    string
}

// RevalidateFreshActor loads fresh user state from the DB and validates it
// against the token claims. Returns a complete FreshActor or an error.
// NEVER falls back to stale token role.
func RevalidateFreshActor(ctx context.Context, userRepo UserRepository, p *auth.Principal) (*FreshActor, *HTTPError) {
	if userRepo == nil {
		// Production: fail closed if user repo unavailable
		return nil, &HTTPError{
			Status:  http.StatusServiceUnavailable,
			Message: "User validation service unavailable",
			Code:    "AUTH_SERVICE_UNAVAILABLE",
		}
	}

	identity, err := userRepo.FindByUsernameIdentity(ctx, p.Username)
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

	// Check user is active
	if identity.SafeUser.Status != "active" {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is disabled",
			Code:    "AUTH_USER_DISABLED",
		}
	}

	// Check user is not locked
	if identity.SafeUser.Locked {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "User account is locked",
			Code:    "AUTH_USER_LOCKED",
		}
	}

	// Normalize the DB role
	dbRole := auth.NormalizeRole(identity.SafeUser.Role)
	if dbRole == "" {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "Unknown user role",
			Code:    "AUTH_UNKNOWN_ROLE",
		}
	}

	// Check role consistency: DB role must match token role
	if dbRole != p.NormalizedRole {
		return nil, &HTTPError{
			Status:  http.StatusForbidden,
			Message: "Session role mismatch",
			Code:    "AUTH_ROLE_MISMATCH",
		}
	}

	// Check session version: DB sessionVersion must match token
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

	// Build complete FreshActor
	actor := &FreshActor{
		UserID:         identity.MongoID,
		Username:       identity.SafeUser.Username,
		RawRole:        identity.SafeUser.Role,
		NormalizedRole: dbRole,
		SessionVersion: dbSessionVersion,
	}

	// Fallback: if MongoID is empty, use username (matches Node: String(account._id ?? account.username))
	if actor.UserID == "" {
		actor.UserID = actor.Username
	}

	return actor, nil
}

// FreshActorFromIdentity builds a FreshActor from a UserIdentity.
// Used when the identity is already loaded (e.g., in approval handler).
func FreshActorFromIdentity(identity *user.UserIdentity) *FreshActor {
	if identity == nil {
		return nil
	}
	dbRole := auth.NormalizeRole(identity.SafeUser.Role)
	if dbRole == "" {
		return nil
	}
	dbSessionVersion := int64(0)
	if identity.SafeUser.Security != nil {
		dbSessionVersion = int64(identity.SafeUser.Security.SessionVersion)
	}
	userID := identity.MongoID
	if userID == "" {
		userID = identity.SafeUser.Username
	}
	return &FreshActor{
		UserID:         userID,
		Username:       identity.SafeUser.Username,
		RawRole:        identity.SafeUser.Role,
		NormalizedRole: dbRole,
		SessionVersion: dbSessionVersion,
	}
}

// ValidateFreshActorSession checks if the fresh actor's session is still valid
// against the token claims. Returns an HTTPError if invalid.
func ValidateFreshActorSession(actor *FreshActor, p *auth.Principal) *HTTPError {
	if actor == nil {
		return &HTTPError{
			Status:  http.StatusForbidden,
			Message: "User account not found",
			Code:    "AUTH_USER_NOT_FOUND",
		}
	}
	if actor.NormalizedRole != p.NormalizedRole {
		return &HTTPError{
			Status:  http.StatusForbidden,
			Message: "Session role mismatch",
			Code:    "AUTH_ROLE_MISMATCH",
		}
	}
	if actor.SessionVersion != p.SessionVersion {
		return &HTTPError{
			Status:  http.StatusForbidden,
			Message: "Session has been revoked",
			Code:    "SESSION_REVOKED",
		}
	}
	return nil
}

// FormatFreshActorError returns a user-friendly error message for fresh actor validation failures.
func FormatFreshActorError(code string) string {
	switch code {
	case "AUTH_SERVICE_UNAVAILABLE":
		return "Unable to validate user session"
	case "AUTH_USER_NOT_FOUND":
		return "User account not found"
	case "AUTH_USER_DISABLED":
		return "User account is disabled"
	case "AUTH_USER_LOCKED":
		return "User account is locked"
	case "AUTH_UNKNOWN_ROLE":
		return "Unknown user role"
	case "AUTH_ROLE_MISMATCH":
		return "Session role mismatch"
	case "SESSION_REVOKED":
		return "Session has been revoked"
	default:
		return fmt.Sprintf("Authentication error: %s", code)
	}
}
