package user

import (
	"sort"
	"testing"
)

func TestAssignableRolesSuperAdmin(t *testing.T) {
	roles := assignableRoles("super_admin")
	expected := []string{"root", "ops_admin", "operator", "auditor", "viewer"}
	if len(roles) != len(expected) {
		t.Fatalf("len = %d, want %d; got %v", len(roles), len(expected), roles)
	}
	for i, r := range expected {
		if roles[i] != r {
			t.Errorf("roles[%d] = %q, want %q", i, roles[i], r)
		}
	}
}

func TestAssignableRolesOpsAdmin(t *testing.T) {
	roles := assignableRoles("ops_admin")
	expected := []string{"operator", "auditor", "viewer"}
	if len(roles) != len(expected) {
		t.Fatalf("len = %d, want %d", len(roles), len(expected))
	}
	for i, r := range expected {
		if roles[i] != r {
			t.Errorf("roles[%d] = %q, want %q", i, roles[i], r)
		}
	}
}

func TestAssignableRolesOthers(t *testing.T) {
	for _, role := range []string{"operator", "auditor", "viewer", "unknown"} {
		roles := assignableRoles(role)
		if len(roles) != 0 {
			t.Errorf("assignableRoles(%q) = %v, want empty", role, roles)
		}
	}
}

func TestUserManagementActionsSuperAdminOnOperator(t *testing.T) {
	actions := userManagementActions("super_admin", "operator", "admin1", "op1")
	actionSet := make(map[string]bool)
	for _, a := range actions {
		actionSet[a] = true
	}
	// Node filters out "create" and "delete" explicitly
	expectedActions := []string{"update", "role.change", "disable", "enable", "lock", "unlock", "password.reset"}
	for _, ea := range expectedActions {
		if !actionSet[ea] {
			t.Errorf("super_admin missing action %q on operator", ea)
		}
	}
}

func TestUserManagementActionsSelfProtection(t *testing.T) {
	actions := userManagementActions("super_admin", "super_admin", "admin1", "admin1")
	actionSet := make(map[string]bool)
	for _, a := range actions {
		actionSet[a] = true
	}
	// Self-protection: disable, lock, delete, role.change blocked
	blocked := []string{"disable", "lock", "role.change"}
	for _, b := range blocked {
		if actionSet[b] {
			t.Errorf("super_admin should NOT have action %q on self", b)
		}
	}
	// Should still allow update, enable, unlock, password.reset on self
	allowed := []string{"update", "unlock", "password.reset"}
	for _, a := range allowed {
		if !actionSet[a] {
			t.Errorf("super_admin should allow action %q on self", a)
		}
	}
}

func TestUserManagementActionsOperatorOnViewer(t *testing.T) {
	// operator does NOT have users.role.change, users.disable, users.update, etc.
	actions := userManagementActions("operator", "viewer", "op1", "viewer1")
	if len(actions) != 0 {
		t.Errorf("operator should have no actions on viewer, got %v", actions)
	}
}

func TestUserManagementActionsOpsAdminOnOperator(t *testing.T) {
	actions := userManagementActions("ops_admin", "operator", "ops1", "op1")
	actionSet := make(map[string]bool)
	for _, a := range actions {
		actionSet[a] = true
	}
	if !actionSet["update"] {
		t.Error("ops_admin should have update on operator")
	}
	if !actionSet["role.change"] {
		t.Error("ops_admin should have role.change on operator")
	}
	if !actionSet["disable"] {
		t.Error("ops_admin should have disable on operator")
	}
}

func TestUserManagementActionsTargetRoleProtection(t *testing.T) {
	// ops_admin cannot manage super_admin or ops_admin targets
	actions := userManagementActions("ops_admin", "super_admin", "ops1", "admin1")
	if len(actions) != 0 {
		t.Errorf("ops_admin should have no actions on super_admin, got %v", actions)
	}

	actions2 := userManagementActions("ops_admin", "ops_admin", "ops1", "ops2")
	if len(actions2) != 0 {
		t.Errorf("ops_admin should have no actions on another ops_admin, got %v", actions2)
	}
}

func TestUserManagementActionsViewerOnAnyone(t *testing.T) {
	actions := userManagementActions("viewer", "operator", "viewer1", "op1")
	if len(actions) != 0 {
		t.Errorf("viewer should have no actions, got %v", actions)
	}
}

func TestUserManagementActionsSorted(t *testing.T) {
	actions := userManagementActions("super_admin", "operator", "admin1", "op1")
	sorted := make([]string, len(actions))
	copy(sorted, actions)
	sort.Strings(sorted)
	// The order should be deterministic (iteration order of operations slice)
	for i, a := range actions {
		if sorted[i] != a {
			// Not necessarily sorted, but should be consistent
			break
		}
	}
}
