package subscriber

import (
	"context"

	"subscriber/internal/auth"
	"subscriber/internal/governance"
)

// Fresh actor revalidation is a single governance primitive shared by every write
// domain; these names keep the subscriber call sites reading as subscriber code.
type (
	FreshActor = governance.FreshActor
	HTTPError  = governance.HTTPError
)

// RevalidateFreshActor loads fresh user state from the DB and validates it against
// the token claims. Returns a complete FreshActor or an error to answer immediately.
// NEVER falls back to a stale token role.
func RevalidateFreshActor(ctx context.Context, userRepo UserRepository, p *auth.Principal) (*FreshActor, *HTTPError) {
	return governance.RevalidateFreshActor(ctx, userRepo, p)
}
