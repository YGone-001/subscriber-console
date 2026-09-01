package auth

import "testing"

// TestSubscriberWriteCapability verifies the subscriber_write capability
// matches Node ROLE_CAPABILITIES exactly.
func TestSubscriberWriteCapability(t *testing.T) {
	// subscriber_write: root/super_admin/ops_admin/operator = allow, viewer/auditor = deny
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"ops_admin", true},
		{"operator", true},
		{"auditor", false},
		{"viewer", false},
		{"unknown", false},
	}
	for _, tt := range tests {
		p := &Principal{NormalizedRole: tt.role}
		got := HasCapability(p, "subscriber_write")
		if got != tt.want {
			t.Errorf("HasCapability(%q, subscriber_write) = %v, want %v", tt.role, got, tt.want)
		}
	}
}

// TestCapabilityDecisionTypes verifies that approval/export decisions are
// preserved (not collapsed to bool). This is critical for Phase 3 compatibility.
func TestCapabilityDecisionTypes(t *testing.T) {
	tests := []struct {
		role       string
		capability string
		want       string
	}{
		// allow decisions
		{"super_admin", "subscriber_write", "allow"},
		{"super_admin", "audit_view", "allow"},
		{"super_admin", "user_admin", "allow"},

		// deny decisions
		{"viewer", "subscriber_write", "deny"},
		{"viewer", "user_admin", "deny"},
		{"auditor", "subscriber_write", "deny"},

		// approval decisions (Phase 3)
		{"operator", "policy_approve", "approval"},
		{"operator", "balance_adjust", "approval"},
		{"operator", "profile_rollback", "approval"},
		{"operator", "rating_publish", "approval"},
		{"operator", "system_heal", "approval"},

		// export decisions
		{"super_admin", "audit_export", "export"},
		{"ops_admin", "audit_export", "export"},
		{"auditor", "audit_export", "export"},
		{"viewer", "audit_export", "deny"},
		{"operator", "audit_export", "deny"},

		// unknown capability → deny
		{"super_admin", "nonexistent_cap", "deny"},
	}
	for _, tt := range tests {
		got := capabilityDecision(tt.role, tt.capability)
		if got != tt.want {
			t.Errorf("capabilityDecision(%q, %q) = %q, want %q", tt.role, tt.capability, got, tt.want)
		}
	}
}

// TestHasCapabilityOnlyAllowsOnAllow verifies that HasCapability returns true
// only for "allow" decisions, not for "approval" or "export".
func TestHasCapabilityOnlyAllowsOnAllow(t *testing.T) {
	p := &Principal{NormalizedRole: "operator"}
	// operator has "approval" for policy_approve, not "allow"
	if HasCapability(p, "policy_approve") {
		t.Error("HasCapability should not return true for 'approval' decision")
	}
	// operator has "allow" for subscriber_write
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
		// super_admin (root) has everything that's "allow"
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
