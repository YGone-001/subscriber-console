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

// HasCapability checks if the principal's normalized role has the given capability.
// Must match the TypeScript capabilityDecision() + capabilityAllowed() exactly.
func HasCapability(p *Principal, capability string) bool {
	decision := capabilityDecision(p.NormalizedRole, capability)
	return decision == "allow"
}

// capabilityDecision returns the capability decision for a role.
// Matches TypeScript ROLE_CAPABILITIES exactly.
func capabilityDecision(role, capability string) string {
	// Legacy capabilities matrix (matching Node LEGACY_CAPABILITIES)
	matrix := map[string]map[string]string{
		"super_admin": {
			"subscriber_write": "allow",
			"policy_approve":   "allow",
			"balance_adjust":   "allow",
			"profile_rollback": "allow",
			"rating_publish":   "allow",
			"approval_review":  "allow",
			"approval_execute": "allow",
			"audit_view":       "allow",
			"audit_export":     "export",
			"system_heal":      "allow",
			"user_admin":       "allow",
		},
		"ops_admin": {
			"subscriber_write": "allow",
			"policy_approve":   "allow",
			"balance_adjust":   "allow",
			"profile_rollback": "allow",
			"rating_publish":   "allow",
			"approval_review":  "allow",
			"approval_execute": "allow",
			"audit_view":       "allow",
			"audit_export":     "export",
			"system_heal":      "allow",
			"user_admin":       "deny",
		},
		"operator": {
			"subscriber_write": "allow",
			"policy_approve":   "approval",
			"balance_adjust":   "approval",
			"profile_rollback": "approval",
			"rating_publish":   "approval",
			"approval_review":  "deny",
			"approval_execute": "deny",
			"audit_view":       "allow",
			"audit_export":     "deny",
			"system_heal":      "approval",
			"user_admin":       "deny",
		},
		"auditor": {
			"subscriber_write": "deny",
			"policy_approve":   "deny",
			"balance_adjust":   "deny",
			"profile_rollback": "deny",
			"rating_publish":   "deny",
			"approval_review":  "deny",
			"approval_execute": "deny",
			"audit_view":       "allow",
			"audit_export":     "export",
			"system_heal":      "deny",
			"user_admin":       "deny",
		},
		"viewer": {
			"subscriber_write": "deny",
			"policy_approve":   "deny",
			"balance_adjust":   "deny",
			"profile_rollback": "deny",
			"rating_publish":   "deny",
			"approval_review":  "deny",
			"approval_execute": "deny",
			"audit_view":       "allow",
			"audit_export":     "deny",
			"system_heal":      "deny",
			"user_admin":       "deny",
		},
	}

	if caps, ok := matrix[role]; ok {
		if decision, ok := caps[capability]; ok {
			return decision
		}
	}
	return "deny"
}
