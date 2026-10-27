package profile

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
// domain; these names keep the template call sites reading as template code.
type (
	FreshActor     = governance.FreshActor
	ActorHTTPError = governance.HTTPError
)

// RevalidateFreshActor loads the actor's account and refuses the write when it
// is missing, disabled, locked, re-roled or session-revoked. It fails closed
// when the account store cannot be consulted.
func RevalidateFreshActor(ctx context.Context, userRepo UserRepository, p *auth.Principal) (*FreshActor, *ActorHTTPError) {
	return governance.RevalidateFreshActor(ctx, userRepo, p)
}
