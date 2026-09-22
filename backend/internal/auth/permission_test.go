package auth

import "testing"

func TestRolePermissionMatrix(t *testing.T) {
	expected := map[string]int{
		"admin": 23, "super_admin": 23, "root": 23,
		"operator": 13, "ops_admin": 13,
		"viewer": 4, "auditor": 4,
	}
	for role, want := range expected {
		if got := len(rolePermissions(role)); got != want {
			t.Errorf("rolePermissions(%q) count = %d, want %d", role, got, want)
		}
	}
	if perms := rolePermissions("unknown"); perms != nil {
		t.Errorf("rolePermissions(unknown) = %v, want nil", perms)
	}
}

func TestGovernancePermissionsRemoved(t *testing.T) {
	removed := []string{
		"approvals.read", "approvals.create", "approvals.approve", "approvals.reject",
		"approvals.cancel", "approvals.execute", "audit.read", "audit.export", "audit.source-ip.read-full",
	}
	for _, role := range []string{"admin", "operator", "viewer"} {
		p := &Principal{NormalizedRole: role}
		for _, permission := range removed {
			if HasPermission(p, permission) {
				t.Errorf("%s unexpectedly retains removed permission %s", role, permission)
			}
		}
	}
}

func TestActivePermissionsAndAliases(t *testing.T) {
	checks := []struct {
		role, permission string
		want             bool
	}{
		{"admin", "users.read", true},
		{"super_admin", "users.read", true},
		{"operator", "subscribers.write", true},
		{"ops_admin", "ocs.balance.adjust", true},
		{"viewer", "subscribers.read", true},
		{"auditor", "subscribers.write", false},
	}
	for _, check := range checks {
		p := &Principal{NormalizedRole: NormalizeRole(check.role)}
		if got := HasPermission(p, check.permission); got != check.want {
			t.Errorf("HasPermission(%q, %q) = %v, want %v", check.role, check.permission, got, check.want)
		}
	}
}

func TestPermissionHelpersRejectInvalidSubjects(t *testing.T) {
	if HasPermission(nil, "subscribers.read") {
		t.Error("nil principal must not have permissions")
	}
	if HasPermission(&Principal{NormalizedRole: "admin"}, "nonexistent.permission") {
		t.Error("unknown permission must be denied")
	}
	if PermissionsFor(nil) != nil {
		t.Error("PermissionsFor(nil) must return nil")
	}
}
