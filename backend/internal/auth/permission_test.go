package auth

import "testing"

// TestHasPermissionAuditRead verifies audit.read permission matches Node ROLE_PERMISSIONS.
func TestHasPermissionAuditRead(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"ops_admin", true},
		{"operator", true},
		{"auditor", true},
		{"viewer", true},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasPermission(p, "audit.read")
		if got != tt.want {
			t.Errorf("HasPermission(%q, audit.read) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestHasPermissionAuditSourceIP verifies audit.source-ip.read-full permission.
func TestHasPermissionAuditSourceIP(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"ops_admin", false}, // ops_admin does NOT have audit.source-ip.read-full
		{"operator", false},
		{"auditor", true},
		{"viewer", false},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasPermission(p, "audit.source-ip.read-full")
		if got != tt.want {
			t.Errorf("HasPermission(%q, audit.source-ip.read-full) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestHasPermissionUsersRead verifies users.read permission.
func TestHasPermissionUsersRead(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"ops_admin", true},
		{"operator", false}, // operator does NOT have users.read
		{"auditor", true},
		{"viewer", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasPermission(p, "users.read")
		if got != tt.want {
			t.Errorf("HasPermission(%q, users.read) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestHasPermissionNilPrincipal verifies nil principal returns false.
func TestHasPermissionNilPrincipal(t *testing.T) {
	if HasPermission(nil, "audit.read") {
		t.Error("HasPermission(nil, audit.read) should be false")
	}
}

// TestHasPermissionUnknownPermission verifies unknown permission returns false.
func TestHasPermissionUnknownPermission(t *testing.T) {
	p := &Principal{NormalizedRole: "super_admin"}
	if HasPermission(p, "nonexistent.permission") {
		t.Error("HasPermission(super_admin, nonexistent.permission) should be false")
	}
}

// TestPermissionsFor verifies permissionsFor returns correct permissions per role.
func TestPermissionsFor(t *testing.T) {
	tests := []struct {
		role     string
		wantPerm string
		wantNot  string
	}{
		{"super_admin", "audit.source-ip.read-full", ""},
		{"ops_admin", "audit.read", "audit.source-ip.read-full"},
		{"operator", "subscribers.write", "users.read"},
		{"auditor", "audit.source-ip.read-full", "subscribers.write"},
		{"viewer", "audit.read", "audit.export"},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		perms := PermissionsFor(p)
		permSet := make(map[string]bool)
		for _, perm := range perms {
			permSet[perm] = true
		}
		if !permSet[tt.wantPerm] {
			t.Errorf("PermissionsFor(%q) missing %q", tt.role, tt.wantPerm)
		}
		if tt.wantNot != "" && permSet[tt.wantNot] {
			t.Errorf("PermissionsFor(%q) should not include %q", tt.role, tt.wantNot)
		}
	}
}

// TestPermissionsForNilPrincipal verifies nil principal returns nil.
func TestPermissionsForNilPrincipal(t *testing.T) {
	if PermissionsFor(nil) != nil {
		t.Error("PermissionsFor(nil) should return nil")
	}
}

// TestPermissionCatalogParity verifies Go catalog matches Node PERMISSION_CATALOG exactly.
func TestPermissionCatalogParity(t *testing.T) {
	// Node PERMISSION_CATALOG (32 permissions)
	nodePerms := []string{
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

	// Get Go catalog via super_admin (has all permissions)
	goPerms := rolePermissions("super_admin")

	goSet := make(map[string]bool)
	for _, p := range goPerms {
		goSet[p] = true
	}

	// Every Node permission must exist in Go
	for _, np := range nodePerms {
		if !goSet[np] {
			t.Errorf("Go catalog missing Node permission: %q", np)
		}
	}

	// Go must not have extra permissions
	nodeSet := make(map[string]bool)
	for _, np := range nodePerms {
		nodeSet[np] = true
	}
	for _, gp := range goPerms {
		if !nodeSet[gp] {
			t.Errorf("Go catalog has extra permission not in Node: %q", gp)
		}
	}

	if len(goPerms) != len(nodePerms) {
		t.Errorf("Go catalog count = %d, want %d", len(goPerms), len(nodePerms))
	}
}

// TestRolePermissionMatrixParity verifies Go role matrix matches Node ROLE_PERMISSIONS exactly.
func TestRolePermissionMatrixParity(t *testing.T) {
	// Expected counts per role from Node ROLE_PERMISSIONS
	expected := map[string]int{
		"super_admin": 32,
		"ops_admin":   29,
		"operator":    15,
		"auditor":     5,
		"viewer":      6,
	}

	for role, wantCount := range expected {
		perms := rolePermissions(role)
		if len(perms) != wantCount {
			t.Errorf("rolePermissions(%q) count = %d, want %d", role, len(perms), wantCount)
		}
	}

	// Unknown role returns nil
	if perms := rolePermissions("unknown"); perms != nil {
		t.Errorf("rolePermissions(\"unknown\") = %v, want nil", perms)
	}
}

// TestCapabilitiesFor verifies capability maps match Node ROLE_CAPABILITIES.
func TestCapabilitiesFor(t *testing.T) {
	tests := []struct {
		role     string
		wantNil  bool
		wantCaps map[string]string
	}{
		{
			role: "super_admin",
			wantCaps: map[string]string{
				"subscriber_write": "allow", "policy_approve": "allow", "balance_adjust": "allow",
				"profile_rollback": "allow", "rating_publish": "allow", "approval_review": "allow",
				"approval_execute": "allow", "audit_view": "allow", "audit_export": "export",
				"system_heal": "allow", "user_admin": "allow",
			},
		},
		{
			role: "ops_admin",
			wantCaps: map[string]string{
				"subscriber_write": "allow", "policy_approve": "allow", "balance_adjust": "allow",
				"profile_rollback": "allow", "rating_publish": "allow", "approval_review": "allow",
				"approval_execute": "allow", "audit_view": "allow", "audit_export": "export",
				"system_heal": "allow", "user_admin": "deny",
			},
		},
		{
			role: "operator",
			wantCaps: map[string]string{
				"subscriber_write": "allow", "policy_approve": "approval", "balance_adjust": "approval",
				"profile_rollback": "approval", "rating_publish": "approval", "approval_review": "deny",
				"approval_execute": "deny", "audit_view": "allow", "audit_export": "deny",
				"system_heal": "approval", "user_admin": "deny",
			},
		},
		{
			role: "auditor",
			wantCaps: map[string]string{
				"subscriber_write": "deny", "policy_approve": "deny", "balance_adjust": "deny",
				"profile_rollback": "deny", "rating_publish": "deny", "approval_review": "deny",
				"approval_execute": "deny", "audit_view": "allow", "audit_export": "export",
				"system_heal": "deny", "user_admin": "deny",
			},
		},
		{
			role: "viewer",
			wantCaps: map[string]string{
				"subscriber_write": "deny", "policy_approve": "deny", "balance_adjust": "deny",
				"profile_rollback": "deny", "rating_publish": "deny", "approval_review": "deny",
				"approval_execute": "deny", "audit_view": "allow", "audit_export": "deny",
				"system_heal": "deny", "user_admin": "deny",
			},
		},
		{
			role:    "unknown",
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			caps := CapabilitiesFor(tt.role)
			if tt.wantNil {
				if caps != nil {
					t.Errorf("CapabilitiesFor(%q) = %v, want nil", tt.role, caps)
				}
				return
			}
			if caps == nil {
				t.Fatalf("CapabilitiesFor(%q) = nil, want non-nil", tt.role)
			}
			if len(caps) != len(tt.wantCaps) {
				t.Errorf("CapabilitiesFor(%q) has %d caps, want %d", tt.role, len(caps), len(tt.wantCaps))
			}
			for key, want := range tt.wantCaps {
				got, ok := caps[key]
				if !ok {
					t.Errorf("CapabilitiesFor(%q) missing key %q", tt.role, key)
				} else if got != want {
					t.Errorf("CapabilitiesFor(%q)[%q] = %q, want %q", tt.role, key, got, want)
				}
			}
		})
	}
}

// TestCapabilitiesForConsistency verifies CapabilitiesFor matches capabilityDecision for each key.
func TestCapabilitiesForConsistency(t *testing.T) {
	roles := []string{"super_admin", "ops_admin", "operator", "auditor", "viewer"}
	capKeys := []string{
		"subscriber_write", "policy_approve", "balance_adjust",
		"profile_rollback", "rating_publish", "approval_review",
		"approval_execute", "audit_view", "audit_export",
		"system_heal", "user_admin",
	}

	for _, role := range roles {
		caps := CapabilitiesFor(role)
		if caps == nil {
			t.Fatalf("CapabilitiesFor(%q) = nil", role)
		}
		for _, key := range capKeys {
			fromMap := caps[key]
			fromFunc := capabilityDecision(role, key)
			if fromMap != fromFunc {
				t.Errorf("role=%q cap=%q: map=%q func=%q (mismatch)", role, key, fromMap, fromFunc)
			}
		}
	}
}

// TestHasCapabilityOnlyAllows verifies HasCapability returns true only for "allow" decisions.
// "approval" and "export" require explicit guard options — base HasCapability must deny them.
func TestHasCapabilityOnlyAllows(t *testing.T) {
	// super_admin: all "allow" except audit_export="export"
	superAdmin := &Principal{NormalizedRole: "super_admin"}
	if !HasCapability(superAdmin, "subscriber_write") {
		t.Error("super_admin subscriber_write should be allow")
	}
	if HasCapability(superAdmin, "audit_export") {
		t.Error("super_admin audit_export should be false (export requires options)")
	}

	// operator: policy_approve="approval" → false without options
	operator := &Principal{NormalizedRole: "operator"}
	if HasCapability(operator, "policy_approve") {
		t.Error("operator policy_approve should be false (approval requires options)")
	}
	if !HasCapability(operator, "subscriber_write") {
		t.Error("operator subscriber_write should be allow")
	}
}
