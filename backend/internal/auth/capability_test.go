package auth

import "testing"

func TestDirectOperationCapabilities(t *testing.T) {
	activeMutations := []string{"subscriber_write", "policy_approve", "balance_adjust", "profile_rollback", "rating_publish", "system_heal"}
	for _, role := range []string{"admin", "operator", "super_admin", "ops_admin"} {
		p := &Principal{NormalizedRole: NormalizeRole(role)}
		for _, capability := range activeMutations {
			if !HasCapability(p, capability) {
				t.Errorf("%s must directly allow %s", role, capability)
			}
		}
	}
	for _, role := range []string{"viewer", "auditor"} {
		p := &Principal{NormalizedRole: NormalizeRole(role)}
		for _, capability := range activeMutations {
			if HasCapability(p, capability) {
				t.Errorf("%s must deny %s", role, capability)
			}
		}
	}
}

func TestGovernanceCapabilitiesRemoved(t *testing.T) {
	for _, capability := range []string{"approval_review", "approval_execute", "audit_view", "audit_export"} {
		if decision := capabilityDecision("admin", capability); decision != "deny" {
			t.Errorf("removed capability %s resolved to %s", capability, decision)
		}
	}
}

func TestUserAdminCapability(t *testing.T) {
	if !HasCapability(&Principal{NormalizedRole: "admin"}, "user_admin") {
		t.Error("admin must retain user_admin")
	}
	if HasCapability(&Principal{NormalizedRole: "operator"}, "user_admin") {
		t.Error("operator must not receive user_admin")
	}
}
