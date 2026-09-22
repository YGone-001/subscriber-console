package auth

import "testing"

// TestSubscriberWriteCapability verifies the subscriber_write capability
// matches Node ROLE_CAPABILITIES exactly.
func TestSubscriberWriteCapability(t *testing.T) {
	// subscriber_write: admin/root/super_admin/ops_admin/operator = allow, viewer/auditor = deny
	tests := []struct {
		role string
		want bool
	}{
		{"admin", true},
		{"super_admin", true},
		{"root", true},
		{"ops_admin", true},
		{"operator", true},
		{"auditor", false},
		{"viewer", false},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: NormalizeRole(tt.role)}
		got := HasCapability(p, "subscriber_write")
		if got != tt.want {
			t.Errorf("HasCapability(%q, subscriber_write) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestCapabilityDecisionTypes verifies decisions for canonical 3 roles and legacy aliases.
func TestCapabilityDecisionTypes(t *testing.T) {
	tests := []struct {
		role       string
		capability string
		want       string
	}{
		// allow decisions
		{"admin", "subscriber_write", "allow"},
		{"admin", "audit_view", "allow"},
		{"admin", "user_admin", "allow"},
		{"super_admin", "subscriber_write", "allow"},
		{"super_admin", "audit_view", "allow"},
		{"super_admin", "user_admin", "allow"},

		// deny decisions
		{"viewer", "subscriber_write", "deny"},
		{"viewer", "user_admin", "deny"},
		{"auditor", "subscriber_write", "deny"},
		{"operator", "user_admin", "deny"},

		// operator active mutations (Phase 5.7: direct allow, no approval)
		{"operator", "policy_approve", "allow"},
		{"operator", "balance_adjust", "allow"},
		{"operator", "profile_rollback", "allow"},
		{"operator", "rating_publish", "allow"},
		{"operator", "system_heal", "allow"},

		// export decisions
		{"admin", "audit_export", "export"},
		{"super_admin", "audit_export", "export"},
		{"ops_admin", "audit_export", "deny"},
		{"auditor", "audit_export", "deny"},
		{"viewer", "audit_export", "deny"},
		{"operator", "audit_export", "deny"},

		// unknown capability -> deny
		{"admin", "nonexistent_cap", "deny"},
	}
	for _, tt := range tests {
		got := capabilityDecision(tt.role, tt.capability)
		if got != tt.want {
			t.Errorf("capabilityDecision(%q, %q) = %q, want %q", tt.role, tt.capability, got, tt.want)
		}
	}
}

// TestHasCapabilityOnlyAllowsOnAllow verifies that HasCapability returns true
// only for "allow" decisions, not for "export" or "deny".
func TestHasCapabilityOnlyAllowsOnAllow(t *testing.T) {
	p := &Principal{NormalizedRole: "admin"}
	// admin has "export" for audit_export, not "allow"
	if HasCapability(p, "audit_export") {
		t.Error("HasCapability should not return true for 'export' decision")
	}
	// admin has "allow" for subscriber_write
	if !HasCapability(p, "subscriber_write") {
		t.Error("HasCapability should return true for 'allow' decision")
	}
}

func TestHasCapabilityGeneral(t *testing.T) {
	tests := []struct {
		role       string
		capability string
		want       bool
	}{
		// admin has everything that's "allow"
		{"admin", "subscriber_write", true},
		{"admin", "user_admin", true},
		{"admin", "audit_view", true},

		// operator has mutations but not user_admin
		{"operator", "subscriber_write", true},
		{"operator", "balance_adjust", true},
		{"operator", "user_admin", false},

		// viewer has view but not mutations
		{"viewer", "audit_view", true},
		{"viewer", "subscriber_write", false},
		{"viewer", "balance_adjust", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: NormalizeRole(tt.role)}
		got := HasCapability(p, tt.capability)
		if got != tt.want {
			t.Errorf("HasCapability(%q, %q) = %v, want %v", tt.role, tt.capability, got, tt.want)
		}
	}
}
