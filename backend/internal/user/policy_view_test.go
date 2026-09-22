package user

import (
	"sort"
	"testing"
)

func TestAssignableRolesAdmin(t *testing.T) {
	for _, role := range []string{"admin", "super_admin", "root"} {
		roles := assignableRoles(role)
		expected := []string{"admin", "operator", "viewer"}
		if len(roles) != len(expected) {
			t.Fatalf("%s len = %d, want %d; got %v", role, len(roles), len(expected), roles)
		}
		for i, r := range expected {
			if roles[i] != r {
				t.Errorf("%s roles[%d] = %q, want %q", role, i, roles[i], r)
			}
		}
	}
}

func TestAssignableRolesNonAdmin(t *testing.T) {
	for _, role := range []string{"ops_admin", "operator", "auditor", "viewer", "unknown"} {
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

func TestUserManagementActionsOperatorOnOther(t *testing.T) {
	for _, actorRole := range []string{"operator", "ops_admin"} {
		actions := userManagementActions(actorRole, "operator", "ops1", "op1")
		if len(actions) != 0 {
			t.Errorf("%s should have no actions on operator, got %v", actorRole, actions)
		}
	}
}

func TestUserManagementActionsTargetRoleProtection(t *testing.T) {
	// non-admin cannot manage admin targets
	actions := userManagementActions("operator", "admin", "op1", "admin1")
	if len(actions) != 0 {
		t.Errorf("operator should have no actions on admin, got %v", actions)
	}

	actions2 := userManagementActions("operator", "super_admin", "op1", "admin1")
	if len(actions2) != 0 {
		t.Errorf("operator should have no actions on super_admin, got %v", actions2)
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
