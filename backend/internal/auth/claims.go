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
	if p == nil {
		return false
	}
	decision := capabilityDecision(p.NormalizedRole, capability)
	return decision == "allow"
}

// CapabilityDecision returns the raw capability decision string and whether it allows access.
// Returns (decision, allowed) where decision is one of: "allow", "deny", "approval", "export".
func CapabilityDecision(p *Principal, capability string) (string, bool) {
	if p == nil {
		return "deny", false
	}
	decision := capabilityDecision(p.NormalizedRole, capability)
	return decision, decision == "allow"
}

// HasPermission checks if the principal's normalized role has the given permission.
// Must match the TypeScript hasPermission() exactly.
func HasPermission(p *Principal, permission string) bool {
	if p == nil {
		return false
	}
	perms := rolePermissions(p.NormalizedRole)
	for _, perm := range perms {
		if perm == permission {
			return true
		}
	}
	return false
}

// PermissionsFor returns all permissions for the principal's normalized role.
// Must match the TypeScript permissionsFor() exactly.
func PermissionsFor(p *Principal) []string {
	if p == nil {
		return nil
	}
	return rolePermissions(p.NormalizedRole)
}

// canonicalRolePermissions defines permissions for the three canonical roles.
var canonicalRolePermissions = map[string][]string{
	"admin": {
		"users.read", "users.create", "users.update", "users.disable", "users.delete",
		"users.role.change", "users.reset-password", "users.unlock",
		"subscribers.read", "subscribers.write", "subscribers.delete",
		"ocs.read", "ocs.balance.adjust", "ocs.balance.reset", "ocs.tariff.write", "ocs.plan.assign", "ocs.rating.write", "ocs.runtime.execute",
		"profiles.read", "profiles.write",
		"core.read", "core.operate", "core.configure",
	},
	"operator": {
		"subscribers.read", "subscribers.write", "subscribers.delete",
		"profiles.read", "profiles.write",
		"core.read", "core.operate", "core.configure",
		"ocs.read", "ocs.balance.adjust", "ocs.tariff.write", "ocs.plan.assign", "ocs.rating.write",
	},
	"viewer": {
		"subscribers.read", "profiles.read", "ocs.read", "core.read",
	},
}

// canonicalCapabilities defines capabilities for the three canonical roles.
// Active mutations for operator resolve to "allow" (direct execution, no approval).
var canonicalCapabilities = map[string]map[string]string{
	"admin": {
		"subscriber_write": "allow",
		"policy_approve":   "allow",
		"balance_adjust":   "allow",
		"profile_rollback": "allow",
		"rating_publish":   "allow",
		"system_heal":      "allow",
		"user_admin":       "allow",
	},
	"operator": {
		"subscriber_write": "allow",
		"policy_approve":   "allow",
		"balance_adjust":   "allow",
		"profile_rollback": "allow",
		"rating_publish":   "allow",
		"system_heal":      "allow",
		"user_admin":       "deny",
	},
	"viewer": {
		"subscriber_write": "deny",
		"policy_approve":   "deny",
		"balance_adjust":   "deny",
		"profile_rollback": "deny",
		"rating_publish":   "deny",
		"system_heal":      "deny",
		"user_admin":       "deny",
	},
}

// rolePermissions returns the permission list for a governance role.
// Matches TypeScript ROLE_PERMISSIONS exactly.
func rolePermissions(role string) []string {
	canonical := normalizeGovernanceRole(role)
	if canonical == "" {
		return nil
	}
	return canonicalRolePermissions[canonical]
}

// capabilityDecision returns the capability decision for a role.
// Matches TypeScript ROLE_CAPABILITIES exactly.
func capabilityDecision(role, capability string) string {
	canonical := normalizeGovernanceRole(role)
	if canonical == "" {
		return "deny"
	}
	if caps, ok := canonicalCapabilities[canonical]; ok {
		if decision, ok := caps[capability]; ok {
			return decision
		}
	}
	return "deny"
}

// CapabilitiesFor returns the full capability map for a normalized role.
// Returns nil for unknown roles.
func CapabilitiesFor(role string) map[string]string {
	canonical := normalizeGovernanceRole(role)
	if canonical == "" {
		return nil
	}
	if caps, ok := canonicalCapabilities[canonical]; ok {
		res := make(map[string]string, len(caps))
		for k, v := range caps {
			res[k] = v
		}
		return res
	}
	return nil
}
