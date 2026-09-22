package auth

import "testing"

// TestHasPermissionAuditRead verifies audit.read permission matches Node ROLE_PERMISSIONS.
func TestHasPermissionAuditRead(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"admin", true},
		{"super_admin", true},
		{"ops_admin", true},
		{"operator", true},
		{"auditor", true},
		{"viewer", true},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: NormalizeRole(tt.role)}
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
		{"admin", true},
		{"super_admin", true},
		{"ops_admin", false},
		{"operator", false},
		{"auditor", false},
		{"viewer", false},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: NormalizeRole(tt.role)}
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
		{"admin", true},
		{"super_admin", true},
		{"ops_admin", false}, // ops_admin normalizes to operator (no users.read)
		{"operator", false},  // operator does NOT have users.read
		{"auditor", false},   // auditor normalizes to viewer
		{"viewer", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: NormalizeRole(tt.role)}
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
	p := &Principal{NormalizedRole: "admin"}
	if HasPermission(p, "nonexistent.permission") {
		t.Error("HasPermission(admin, nonexistent.permission) should be false")
	}
}

// TestPermissionsFor verifies permissionsFor returns correct permissions per role.
func TestPermissionsFor(t *testing.T) {
	tests := []struct {
		role     string
		wantPerm string
		wantNot  string
	}{
		{"admin", "audit.source-ip.read-full", ""},
		{"super_admin", "audit.source-ip.read-full", ""},
		{"operator", "subscribers.write", "users.read"},
		{"ops_admin", "subscribers.write", "users.read"},
		{"viewer", "audit.read", "audit.export"},
		{"auditor", "audit.read", "audit.export"},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: NormalizeRole(tt.role)}
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

	// Get Go catalog via admin (has all permissions)
	goPerms := rolePermissions("admin")

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

// TestRolePermissionMatrixParity verifies Go role matrix matches canonical 3-role model.
func TestRolePermissionMatrixParity(t *testing.T) {
	expected := map[string]int{
		"admin":       32,
		"super_admin": 32,
		"root":        32,
		"operator":    17,
		"ops_admin":   17,
		"viewer":      6,
		"auditor":     6,
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
	adminCaps := map[string]string{
		"subscriber_write": "allow", "policy_approve": "allow", "balance_adjust": "allow",
		"profile_rollback": "allow", "rating_publish": "allow", "approval_review": "allow",
		"approval_execute": "allow", "audit_view": "allow", "audit_export": "export",
		"system_heal": "allow", "user_admin": "allow",
	}
	operatorCaps := map[string]string{
		"subscriber_write": "allow", "policy_approve": "allow", "balance_adjust": "allow",
		"profile_rollback": "allow", "rating_publish": "allow", "approval_review": "deny",
		"approval_execute": "deny", "audit_view": "allow", "audit_export": "deny",
		"system_heal": "allow", "user_admin": "deny",
	}
	viewerCaps := map[string]string{
		"subscriber_write": "deny", "policy_approve": "deny", "balance_adjust": "deny",
		"profile_rollback": "deny", "rating_publish": "deny", "approval_review": "deny",
		"approval_execute": "deny", "audit_view": "allow", "audit_export": "deny",
		"system_heal": "deny", "user_admin": "deny",
	}

	tests := []struct {
		role     string
		wantNil  bool
		wantCaps map[string]string
	}{
		{role: "admin", wantCaps: adminCaps},
		{role: "super_admin", wantCaps: adminCaps},
		{role: "root", wantCaps: adminCaps},
		{role: "operator", wantCaps: operatorCaps},
		{role: "ops_admin", wantCaps: operatorCaps},
		{role: "viewer", wantCaps: viewerCaps},
		{role: "auditor", wantCaps: viewerCaps},
		{role: "unknown", wantNil: true},
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
	roles := []string{"admin", "root", "super_admin", "ops_admin", "operator", "auditor", "viewer"}
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
func TestHasCapabilityOnlyAllows(t *testing.T) {
	admin := &Principal{NormalizedRole: "admin"}
	if !HasCapability(admin, "subscriber_write") {
		t.Error("admin subscriber_write should be allow")
	}
	if HasCapability(admin, "audit_export") {
		t.Error("admin audit_export should be false (export requires options)")
	}

	operator := &Principal{NormalizedRole: "operator"}
	if !HasCapability(operator, "subscriber_write") {
		t.Error("operator subscriber_write should be allow")
	}
	if !HasCapability(operator, "balance_adjust") {
		t.Error("operator balance_adjust should be allow")
	}
	if HasCapability(operator, "user_admin") {
		t.Error("operator user_admin should be deny")
	}

	viewer := &Principal{NormalizedRole: "viewer"}
	if HasCapability(viewer, "subscriber_write") {
		t.Error("viewer subscriber_write should be deny")
	}
}
