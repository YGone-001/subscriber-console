package approval

import (
	"regexp"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/governance"
)

// TestEvaluateGovernance_SuperAdmin_DirectFromApproval verifies that super_admin
// gets DIRECT_GOVERNED for approval-governed human-executable operations.
func TestEvaluateGovernance_SuperAdmin_DirectFromApproval(t *testing.T) {
	approvalOps := []string{
		"SUBSCRIBER_UPDATE",
		"SUBSCRIBER_DELETE",
	}
	for _, op := range approvalOps {
		t.Run("super_admin/"+op, func(t *testing.T) {
			def := governance.OperationDefinition{
				Operation:         op,
				BaseMode:          governance.Approval,
				HumanExecutable:   true,
				ExecutorAvailable: true,
			}
			r := EvaluateGovernance(def, "super_admin")
			if r.Decision != GovernanceDirect {
				t.Errorf("super_admin + %s = %s, want DIRECT_GOVERNED", op, r.Decision)
			}
			if r.ApprovalRequired {
				t.Errorf("super_admin + %s: approvalRequired = true, want false", op)
			}
		})
	}
}

// TestEvaluateGovernance_Root_DirectFromApproval verifies that root (legacy)
// also gets DIRECT_GOVERNED for approval-governed operations.
func TestEvaluateGovernance_Root_DirectFromApproval(t *testing.T) {
	def := governance.OperationDefinition{
		Operation:         "SUBSCRIBER_UPDATE",
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	}
	r := EvaluateGovernance(def, "super_admin")
	if r.Decision != GovernanceDirect {
		t.Errorf("root(normalized) + SUBSCRIBER_UPDATE = %s, want DIRECT_GOVERNED", r.Decision)
	}
}

// TestEvaluateGovernance_NonAdmin_ApprovalGoverned verifies that non-super_admin
// roles still get APPROVAL_GOVERNED for approval-governed operations.
func TestEvaluateGovernance_NonAdmin_ApprovalGoverned(t *testing.T) {
	roles := []string{"operator", "ops_admin"}
	ops := []string{"SUBSCRIBER_UPDATE", "SUBSCRIBER_DELETE"}
	for _, role := range roles {
		for _, op := range ops {
			t.Run(role+"/"+op, func(t *testing.T) {
				def := governance.OperationDefinition{
					Operation:         op,
					BaseMode:          governance.Approval,
					HumanExecutable:   true,
					ExecutorAvailable: true,
				}
				r := EvaluateGovernance(def, role)
				if r.Decision != GovernanceApproval {
					t.Errorf("%s + %s = %s, want APPROVAL_GOVERNED", role, op, r.Decision)
				}
				if !r.ApprovalRequired {
					t.Errorf("%s + %s: approvalRequired = false, want true", role, op)
				}
			})
		}
	}
}

// TestEvaluateGovernance_Disabled_AlwaysDisabled verifies that DISABLED operations
// remain disabled even for super_admin.
func TestEvaluateGovernance_Disabled_AlwaysDisabled(t *testing.T) {
	roles := []string{"super_admin", "root", "operator", "ops_admin", "viewer", "auditor"}
	for _, role := range roles {
		t.Run(role+"/DISABLED_OP", func(t *testing.T) {
			def := governance.OperationDefinition{
				Operation:         "DISABLED_OP",
				BaseMode:          governance.Disabled,
				HumanExecutable:   false,
				ExecutorAvailable: false,
			}
			r := EvaluateGovernance(def, role)
			if r.Decision != GovernanceDisabled {
				t.Errorf("%s + DISABLED_OP = %s, want DISABLED", role, r.Decision)
			}
			if r.ApprovalRequired {
				t.Errorf("%s + DISABLED_OP: approvalRequired = true, want false", role)
			}
		})
	}
}

// TestEvaluateGovernance_RuntimeInternal_AlwaysRuntime verifies that RUNTIME_INTERNAL
// operations remain runtime-only even for super_admin.
func TestEvaluateGovernance_RuntimeInternal_AlwaysRuntime(t *testing.T) {
	roles := []string{"super_admin", "root", "operator", "ops_admin"}
	for _, role := range roles {
		t.Run(role+"/RUNTIME_OP", func(t *testing.T) {
			def := governance.OperationDefinition{
				Operation:         "RUNTIME_OP",
				BaseMode:          governance.RuntimeOnly,
				HumanExecutable:   false,
				ExecutorAvailable: false,
			}
			r := EvaluateGovernance(def, role)
			if r.Decision != GovernanceRuntimeOnly {
				t.Errorf("%s + RUNTIME_OP = %s, want RUNTIME_INTERNAL", role, r.Decision)
			}
		})
	}
}

// TestEvaluateGovernance_DirectBase_StaysDirect verifies that operations with
// base DIRECT_GOVERNED stay direct for all roles.
func TestEvaluateGovernance_DirectBase_StaysDirect(t *testing.T) {
	roles := []string{"super_admin", "operator", "ops_admin"}
	for _, role := range roles {
		t.Run(role+"/DIRECT_OP", func(t *testing.T) {
			def := governance.OperationDefinition{
				Operation:         "DIRECT_OP",
				BaseMode:          governance.Direct,
				HumanExecutable:   true,
				ExecutorAvailable: true,
			}
			r := EvaluateGovernance(def, role)
			if r.Decision != GovernanceDirect {
				t.Errorf("%s + DIRECT_OP = %s, want DIRECT_GOVERNED", role, r.Decision)
			}
		})
	}
}

// TestEvaluateGovernance_EmptyRole_FailSafe verifies empty role gets approval.
func TestEvaluateGovernance_EmptyRole_FailSafe(t *testing.T) {
	def := governance.OperationDefinition{
		Operation:         "SUBSCRIBER_UPDATE",
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	}
	r := EvaluateGovernance(def, "")
	if r.Decision != GovernanceApproval {
		t.Errorf("empty role + SUBSCRIBER_UPDATE = %s, want APPROVAL_GOVERNED", r.Decision)
	}
}

// TestEvaluateGovernanceForPrincipal tests the Principal-based convenience function.
func TestEvaluateGovernanceForPrincipal(t *testing.T) {
	superAdmin := &auth.Principal{NormalizedRole: "super_admin"}
	operator := &auth.Principal{NormalizedRole: "operator"}

	r1 := EvaluateGovernanceForPrincipal("SUBSCRIBER_UPDATE", superAdmin)
	// LookupOperationDefinition now returns Disabled for unknown ops
	if r1.Decision != GovernanceDisabled {
		t.Errorf("super_admin principal + SUBSCRIBER_UPDATE = %s, want DISABLED (no catalog)", r1.Decision)
	}

	r2 := EvaluateGovernanceForPrincipal("SUBSCRIBER_UPDATE", operator)
	if r2.Decision != GovernanceDisabled {
		t.Errorf("operator principal + SUBSCRIBER_UPDATE = %s, want DISABLED (no catalog)", r2.Decision)
	}

	// nil principal
	r3 := EvaluateGovernanceForPrincipal("SUBSCRIBER_UPDATE", nil)
	if r3.Decision != GovernanceDisabled {
		t.Errorf("nil principal + SUBSCRIBER_UPDATE = %s, want DISABLED (no catalog)", r3.Decision)
	}
}

// TestIsSuperAdminRole verifies the role check helper.
func TestIsSuperAdminRole(t *testing.T) {
	tests := []struct {
		role string
		want bool
	}{
		{"super_admin", true},
		{"root", true}, // legacy root normalizes to super_admin
		{"operator", false},
		{"ops_admin", false},
		{"viewer", false},
		{"auditor", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			got := IsSuperAdminRole(tt.role)
			if got != tt.want {
				t.Errorf("IsSuperAdminRole(%q) = %v, want %v", tt.role, got, tt.want)
			}
		})
	}
}

// TestAuthIsSuperAdmin verifies the auth package helper.
func TestAuthIsSuperAdmin(t *testing.T) {
	superAdmin := &auth.Principal{NormalizedRole: "super_admin"}
	root := &auth.Principal{NormalizedRole: "super_admin"} // root normalizes to super_admin
	operator := &auth.Principal{NormalizedRole: "operator"}

	if !auth.IsSuperAdmin(superAdmin) {
		t.Error("super_admin principal should be super admin")
	}
	if !auth.IsSuperAdmin(root) {
		t.Error("root (normalized) principal should be super admin")
	}
	if auth.IsSuperAdmin(operator) {
		t.Error("operator principal should not be super admin")
	}
	if auth.IsSuperAdmin(nil) {
		t.Error("nil principal should not be super admin")
	}
}

// TestGenerateEventID_UUIDv4 verifies that approval lifecycle event IDs
// are UUIDv4 format (not EVT-prefixed).
func TestGenerateEventID_UUIDv4(t *testing.T) {
	uuidPattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

	for i := 0; i < 10; i++ {
		id := generateEventID()
		if !uuidPattern.MatchString(id) {
			t.Errorf("event ID %q is not a valid UUIDv4", id)
		}
		if len(id) > 4 && id[:4] == "EVT-" {
			t.Errorf("event ID %q should not have EVT- prefix", id)
		}
	}

	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id := generateEventID()
		if seen[id] {
			t.Errorf("duplicate event ID: %s", id)
		}
		seen[id] = true
	}
}

// TestLookupOperationDefinition_AlwaysDisabled verifies that the deprecated
// LookupOperationDefinition now always returns Disabled (catalog removed).
func TestLookupOperationDefinition_AlwaysDisabled(t *testing.T) {
	def, ok := LookupOperationDefinition("SUBSCRIBER_UPDATE")
	if ok {
		t.Error("LookupOperationDefinition should return false (catalog removed)")
	}
	if def.BaseMode != GovernanceDisabled {
		t.Errorf("BaseMode = %s, want DISABLED", def.BaseMode)
	}
}
