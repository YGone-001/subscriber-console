package auth

import "testing"

func TestHasCapability(t *testing.T) {
	tests := []struct {
		role       string
		capability string
		want       bool
	}{
		// super_admin (root) has everything
		{"super_admin", "subscriber_write", true},
		{"super_admin", "user_admin", true},
		{"super_admin", "audit_view", true},

		// ops_admin has most except user_admin
		{"ops_admin", "subscriber_write", true},
		{"ops_admin", "user_admin", false},

		// operator has subscriber_write
		{"operator", "subscriber_write", true},
		{"operator", "user_admin", false},
		{"operator", "approval_review", false},

		// viewer denied most
		{"viewer", "subscriber_write", false},
		{"viewer", "audit_view", true},

		// auditor denied most, has audit
		{"auditor", "subscriber_write", false},
		{"auditor", "audit_view", true},
		{"auditor", "audit_export", false}, // export is "export", not "allow"

		// unknown role denied
		{"unknown", "subscriber_write", false},

		// unknown capability denied
		{"super_admin", "unknown_capability", false},
	}

	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasCapability(p, tt.capability)
		if got != tt.want {
			t.Errorf("HasCapability(%q, %q) = %v, want %v", tt.role, tt.capability, got, tt.want)
		}
	}
}

func TestCapabilityDecision(t *testing.T) {
	// Test specific decisions
	if capabilityDecision("super_admin", "subscriber_write") != "allow" {
		t.Error("super_admin subscriber_write should be allow")
	}
	if capabilityDecision("operator", "policy_approve") != "approval" {
		t.Error("operator policy_approve should be approval")
	}
	if capabilityDecision("viewer", "subscriber_write") != "deny" {
		t.Error("viewer subscriber_write should be deny")
	}
	if capabilityDecision("auditor", "audit_export") != "export" {
		t.Error("auditor audit_export should be export")
	}
}
