package balance

import (
	"context"

	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/user"
)

// UserRepository is the interface for looking up fresh user state.
type UserRepository interface {
	FindByUsernameIdentity(ctx context.Context, username string) (*user.UserIdentity, error)
}

// Fresh actor revalidation is a single governance primitive shared by every write
// domain; these names keep the balance call sites reading as balance code.
type (
	FreshActor          = governance.FreshActor
	FreshActorHTTPError = governance.HTTPError
)

// RevalidateFreshActor loads fresh user state from the DB and validates it
// against the token claims. Returns a complete FreshActor or an error.
// NEVER falls back to stale token role.
func RevalidateFreshActor(ctx context.Context, userRepo UserRepository, p *auth.Principal) (*FreshActor, *FreshActorHTTPError) {
	return governance.RevalidateFreshActor(ctx, userRepo, p)
}
