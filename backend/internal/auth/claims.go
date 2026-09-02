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

// rolePermissions returns the permission list for a governance role.
// Matches TypeScript ROLE_PERMISSIONS exactly.
func rolePermissions(role string) []string {
	// All permissions in the catalog
	allPerms := []string{
		"users.read", "users.create", "users.update", "users.disable", "users.delete",
		"users.role.change", "users.reset-password", "users.unlock",
		"approvals.read", "approvals.create", "approvals.approve", "approvals.reject",
		"approvals.cancel", "approvals.execute",
		"audit.read", "audit.export", "audit.source-ip.read-full",
		"subscribers.read", "subscribers.write", "subscribers.delete",
		"ocs.read", "ocs.balance.adjust", "ocs.balance.reset", "ocs.tariff.write", "ocs.plan.assign", "ocs.rating.write", "ocs.runtime.execute",
		"profiles.read", "profiles.write",
		"core.read", "core.operate", "core.configure",
	}

	// Read permissions (end with .read)
	readPerms := []string{
		"users.read", "approvals.read", "audit.read",
		"subscribers.read", "ocs.read", "profiles.read", "core.read",
	}

	matrix := map[string][]string{
		"super_admin": allPerms,
		"ops_admin": {
			"users.create", "users.update", "users.disable", "users.delete", "users.role.change", "users.reset-password", "users.unlock",
			"users.read", "approvals.read", "audit.read",
			"subscribers.read", "ocs.read", "profiles.read", "core.read",
			"approvals.create", "approvals.approve", "approvals.reject",
			"approvals.cancel", "approvals.execute", "audit.export",
			"subscribers.write", "subscribers.delete", "profiles.write", "core.operate", "core.configure",
			"ocs.balance.adjust", "ocs.tariff.write", "ocs.plan.assign", "ocs.rating.write",
		},
		"operator": {
			"subscribers.read", "subscribers.write", "subscribers.delete",
			"profiles.read", "core.read", "core.operate", "audit.read",
			"ocs.read", "ocs.balance.adjust", "ocs.tariff.write", "ocs.plan.assign", "ocs.rating.write",
			"approvals.read", "approvals.create", "approvals.cancel",
		},
		"auditor": {"users.read", "approvals.read", "audit.read", "audit.export", "audit.source-ip.read-full"},
		"viewer":  {"subscribers.read", "profiles.read", "ocs.read", "core.read", "approvals.read", "audit.read"},
	}

	if perms, ok := matrix[role]; ok {
		return perms
	}
	// Suppress unused variable warning
	_ = readPerms
	return nil
}

// capabilityDecision returns the capability decision for a role.
// Matches TypeScript ROLE_CAPABILITIES exactly.
func capabilityDecision(role, capability string) string {
	// Legacy capabilities matrix (matching Node LEGACY_CAPABILITIES)
	matrix := map[string]map[string]string{
		"root": {
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

// CapabilitiesFor returns the full capability map for a normalized role.
// Returns nil for unknown roles.
func CapabilitiesFor(role string) map[string]string {
	matrix := map[string]map[string]string{
		"root": {
			"subscriber_write": "allow", "policy_approve": "allow", "balance_adjust": "allow",
			"profile_rollback": "allow", "rating_publish": "allow", "approval_review": "allow",
			"approval_execute": "allow", "audit_view": "allow", "audit_export": "export",
			"system_heal": "allow", "user_admin": "allow",
		},
		"super_admin": {
			"subscriber_write": "allow", "policy_approve": "allow", "balance_adjust": "allow",
			"profile_rollback": "allow", "rating_publish": "allow", "approval_review": "allow",
			"approval_execute": "allow", "audit_view": "allow", "audit_export": "export",
			"system_heal": "allow", "user_admin": "allow",
		},
		"ops_admin": {
			"subscriber_write": "allow", "policy_approve": "allow", "balance_adjust": "allow",
			"profile_rollback": "allow", "rating_publish": "allow", "approval_review": "allow",
			"approval_execute": "allow", "audit_view": "allow", "audit_export": "export",
			"system_heal": "allow", "user_admin": "deny",
		},
		"operator": {
			"subscriber_write": "allow", "policy_approve": "approval", "balance_adjust": "approval",
			"profile_rollback": "approval", "rating_publish": "approval", "approval_review": "deny",
			"approval_execute": "deny", "audit_view": "allow", "audit_export": "deny",
			"system_heal": "approval", "user_admin": "deny",
		},
		"auditor": {
			"subscriber_write": "deny", "policy_approve": "deny", "balance_adjust": "deny",
			"profile_rollback": "deny", "rating_publish": "deny", "approval_review": "deny",
			"approval_execute": "deny", "audit_view": "allow", "audit_export": "export",
			"system_heal": "deny", "user_admin": "deny",
		},
		"viewer": {
			"subscriber_write": "deny", "policy_approve": "deny", "balance_adjust": "deny",
			"profile_rollback": "deny", "rating_publish": "deny", "approval_review": "deny",
			"approval_execute": "deny", "audit_view": "allow", "audit_export": "deny",
			"system_heal": "deny", "user_admin": "deny",
		},
	}
	if caps, ok := matrix[role]; ok {
		return caps
	}
	return nil
}
