// Package auth provides JWT verification and session validation compatible with
// the existing Node.js-issued auth_token cookie.
//
// The Node backend issues HS256 JWTs with claims: { username, role, sv, exp }.
// The Go backend must verify these tokens and validate the session against MongoDB
// before allowing access to any protected endpoint.
package auth

// Claims represents the JWT payload from the existing Node.js auth system.
// These claims are issued by Next.js and must be verified by Go.
type Claims struct {
	Username string `json:"username"`
	Role     string `json:"role"`
	SV       int64  `json:"sv"`  // sessionVersion — must match MongoDB
	Exp      int64  `json:"exp"` // expiry timestamp
}

// Principal is the authenticated user context passed to handlers.
// It is populated after JWT verification and MongoDB session validation.
type Principal struct {
	Username       string
	Role           string // original role from JWT (may be "root")
	NormalizedRole string // governance-normalized role (e.g., "super_admin")
	SessionVersion int64
	UserID         string
}
