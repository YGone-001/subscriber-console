package auth

import "context"

type contextKey string

const principalKey contextKey = "principal"

// ContextWithPrincipal adds a Principal to the context.
func ContextWithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey, p)
}

// PrincipalFromContext extracts the Principal from the context.
// Returns nil if no Principal is present (unauthenticated request).
func PrincipalFromContext(ctx context.Context) *Principal {
	if p, ok := ctx.Value(principalKey).(*Principal); ok {
		return p
	}
	return nil
}
