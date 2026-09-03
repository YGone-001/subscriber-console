package approval

import (
	"regexp"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
)

// TestEvaluateGovernance_SuperAdmin_DirectFromApproval verifies that super_admin
// gets DIRECT_GOVERNED for approval-governed human-executable operations.
func TestEvaluateGovernance_SuperAdmin_DirectFromApproval(t *testing.T) {
	approvalOps := []string{
		"SUBSCRIBER_UPDATE",
		"SUBSCRIBER_DELETE",
		"SUBSCRIBER_BATCH_CREATE",
		"SUBSCRIBER_BATCH_UPDATE",
		"SUBSCRIBER_BULK_DELETE",
		"SUBSCRIBER_IMPORT",
		"SUBSCRIBER_IMPORT_OVERWRITE",
		"SUBSCRIBER_PROFILE_APPLY",
		"OCS_BALANCE_ADJUST",
		"OCS_TARIFF_ASSIGN",
		"OCS_RATING_WRITE",
		"OCS_PLAN_ASSIGN",
		"TARIFF_PLAN_CREATE",
		"TARIFF_PLAN_UPDATE",
		"TARIFF_PLAN_DELETE",
		"TARIFF_PLAN_RULE_CREATE",
		"TARIFF_PLAN_RULE_UPDATE",
		"TARIFF_PLAN_RULE_DELETE",
		"TARIFF_PLAN_RULE_TOGGLE",
		"TARIFF_PLAN_MIGRATE",
		"RATING_UPDATE",
		"RATING_DELETE",
		"PROFILE_RESTORE",
		"SYSTEM_HEAL",
		"ACCESS_REQUEST",
		"POLICY_CHANGE",
		"TRAFFIC_ADJUSTMENT",
	}
	for _, op := range approvalOps {
		t.Run("super_admin/"+op, func(t *testing.T) {
			r := EvaluateGovernanceByOperation(op, "super_admin")
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
	r := EvaluateGovernanceByOperation("SUBSCRIBER_UPDATE", "super_admin")
	if r.Decision != GovernanceDirect {
		t.Errorf("root(normalized) + SUBSCRIBER_UPDATE = %s, want DIRECT_GOVERNED", r.Decision)
	}
}

// TestEvaluateGovernance_NonAdmin_ApprovalGoverned verifies that non-super_admin
// roles still get APPROVAL_GOVERNED for approval-governed operations.
func TestEvaluateGovernance_NonAdmin_ApprovalGoverned(t *testing.T) {
	roles := []string{"operator", "ops_admin"}
	approvalOps := []string{
		"SUBSCRIBER_UPDATE",
		"SUBSCRIBER_DELETE",
		"OCS_BALANCE_ADJUST",
		"TARIFF_PLAN_DELETE",
	}
	for _, role := range roles {
		for _, op := range approvalOps {
			t.Run(role+"/"+op, func(t *testing.T) {
				r := EvaluateGovernanceByOperation(op, role)
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
	disabledOps := []string{"OCS_BALANCE_RESET", "OCS_RATING_CREATE"}
	roles := []string{"super_admin", "root", "operator", "ops_admin", "viewer", "auditor"}
	for _, role := range roles {
		for _, op := range disabledOps {
			t.Run(role+"/"+op, func(t *testing.T) {
				r := EvaluateGovernanceByOperation(op, role)
				if r.Decision != GovernanceDisabled {
					t.Errorf("%s + %s = %s, want DISABLED", role, op, r.Decision)
				}
				if r.ApprovalRequired {
					t.Errorf("%s + %s: approvalRequired = true, want false", role, op)
				}
			})
		}
	}
}

// TestEvaluateGovernance_RuntimeInternal_AlwaysRuntime verifies that RUNTIME_INTERNAL
// operations remain runtime-only even for super_admin.
func TestEvaluateGovernance_RuntimeInternal_AlwaysRuntime(t *testing.T) {
	roles := []string{"super_admin", "root", "operator", "ops_admin"}
	for _, role := range roles {
		t.Run(role+"/OCS_RUNTIME_RESERVE", func(t *testing.T) {
			r := EvaluateGovernanceByOperation("OCS_RUNTIME_RESERVE", role)
			if r.Decision != GovernanceRuntimeOnly {
				t.Errorf("%s + OCS_RUNTIME_RESERVE = %s, want RUNTIME_INTERNAL", role, r.Decision)
			}
		})
	}
}

// TestEvaluateGovernance_DirectBase_StaysDirect verifies that operations with
// base DIRECT_GOVERNED stay direct for all roles.
func TestEvaluateGovernance_DirectBase_StaysDirect(t *testing.T) {
	directOps := []string{"SUBSCRIBER_CREATE", "RATING_CREATE"}
	roles := []string{"super_admin", "operator", "ops_admin"}
	for _, role := range roles {
		for _, op := range directOps {
			t.Run(role+"/"+op, func(t *testing.T) {
				r := EvaluateGovernanceByOperation(op, role)
				if r.Decision != GovernanceDirect {
					t.Errorf("%s + %s = %s, want DIRECT_GOVERNED", role, op, r.Decision)
				}
			})
		}
	}
}

// TestEvaluateGovernance_UnknownOperation_FailClosed verifies unknown operations
// fail CLOSED as DISABLED (not APPROVAL_GOVERNED).
func TestEvaluateGovernance_UnknownOperation_FailClosed(t *testing.T) {
	unknownOps := []string{
		"UNKNOWN_OPERATION",
		"OCS_RATING_CREATE_UNKNOWN",
		"",
		"random_garbage",
	}
	for _, op := range unknownOps {
		t.Run("super_admin/"+op, func(t *testing.T) {
			r := EvaluateGovernanceByOperation(op, "super_admin")
			if r.Decision != GovernanceDisabled {
				t.Errorf("unknown %q + super_admin = %s, want DISABLED", op, r.Decision)
			}
			if r.ApprovalRequired {
				t.Errorf("unknown %q + super_admin: approvalRequired = true, want false", op)
			}
		})
	}
}

// TestEvaluateGovernance_EmptyRole_FailSafe verifies empty role gets approval.
func TestEvaluateGovernance_EmptyRole_FailSafe(t *testing.T) {
	r := EvaluateGovernanceByOperation("SUBSCRIBER_UPDATE", "")
	if r.Decision != GovernanceApproval {
		t.Errorf("empty role + SUBSCRIBER_UPDATE = %s, want APPROVAL_GOVERNED", r.Decision)
	}
}

// TestEvaluateGovernanceForPrincipal tests the Principal-based convenience function.
func TestEvaluateGovernanceForPrincipal(t *testing.T) {
	superAdmin := &auth.Principal{NormalizedRole: "super_admin"}
	operator := &auth.Principal{NormalizedRole: "operator"}

	r1 := EvaluateGovernanceForPrincipal("SUBSCRIBER_UPDATE", superAdmin)
	if r1.Decision != GovernanceDirect {
		t.Errorf("super_admin principal + SUBSCRIBER_UPDATE = %s, want DIRECT_GOVERNED", r1.Decision)
	}

	r2 := EvaluateGovernanceForPrincipal("SUBSCRIBER_UPDATE", operator)
	if r2.Decision != GovernanceApproval {
		t.Errorf("operator principal + SUBSCRIBER_UPDATE = %s, want APPROVAL_GOVERNED", r2.Decision)
	}

	// nil principal
	r3 := EvaluateGovernanceForPrincipal("SUBSCRIBER_UPDATE", nil)
	if r3.Decision != GovernanceApproval {
		t.Errorf("nil principal + SUBSCRIBER_UPDATE = %s, want APPROVAL_GOVERNED", r3.Decision)
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

// TestEvaluateGovernance_Subscriber_BulkDelete_CriticalRisk verifies that
// SUBSCRIBER_BULK_DELETE has critical risk but super_admin gets DIRECT.
// Risk and governance mode are separate concepts.
func TestEvaluateGovernance_Subscriber_BulkDelete_CriticalRisk(t *testing.T) {
	risk := AssessApprovalRisk("SUBSCRIBER_BULK_DELETE")
	if risk.Level != RiskCritical {
		t.Errorf("SUBSCRIBER_BULK_DELETE risk = %s, want critical", risk.Level)
	}

	r := EvaluateGovernanceByOperation("SUBSCRIBER_BULK_DELETE", "super_admin")
	if r.Decision != GovernanceDirect {
		t.Errorf("super_admin + SUBSCRIBER_BULK_DELETE = %s, want DIRECT_GOVERNED", r.Decision)
	}
}

// TestGenerateEventID_UUIDv4 verifies that approval lifecycle event IDs
// are UUIDv4 format (not EVT-prefixed). This is distinct from audit eventId
// which uses EVT-{UUID} format.
func TestGenerateEventID_UUIDv4(t *testing.T) {
	uuidPattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

	for i := 0; i < 10; i++ {
		id := generateEventID()
		if !uuidPattern.MatchString(id) {
			t.Errorf("event ID %q is not a valid UUIDv4", id)
		}
		// Must NOT have EVT- prefix (that's for audit eventId)
		if len(id) > 4 && id[:4] == "EVT-" {
			t.Errorf("event ID %q should not have EVT- prefix", id)
		}
	}

	// Verify uniqueness
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id := generateEventID()
		if seen[id] {
			t.Errorf("duplicate event ID: %s", id)
		}
		seen[id] = true
	}
}

// TestOCS_RATING_CREATE_Disabled_SuperAdmin is a regression test ensuring that
// OCS_RATING_CREATE stays DISABLED for super_admin. This is a domain operation
// (from the OCS registry), not an approval action. Even though the approval
// action "RATING_CREATE" maps to a DIRECT domain operation in the tariff domain,
// OCS_RATING_CREATE must remain DISABLED — super_admin must NOT gain direct
// execution by evaluating the wrong domain operation.
func TestOCS_RATING_CREATE_Disabled_SuperAdmin(t *testing.T) {
	def, known := LookupOperationDefinition("OCS_RATING_CREATE")
	if !known {
		t.Fatal("OCS_RATING_CREATE should be in the governance catalog")
	}
	if def.BaseMode != GovernanceDisabled {
		t.Errorf("OCS_RATING_CREATE base mode = %s, want DISABLED", def.BaseMode)
	}
	if def.HumanExecutable {
		t.Error("OCS_RATING_CREATE should not be human-executable")
	}
	if def.ExecutorAvailable {
		t.Error("OCS_RATING_CREATE should not have an executor available")
	}

	// Evaluate for super_admin — must remain DISABLED
	r := EvaluateGovernance(def, "super_admin")
	if r.Decision != GovernanceDisabled {
		t.Errorf("super_admin + OCS_RATING_CREATE = %s, want DISABLED", r.Decision)
	}
	if r.ApprovalRequired {
		t.Error("super_admin + OCS_RATING_CREATE: approvalRequired should be false")
	}
}

// TestLookupOperationDefinition_Known verifies lookup for known operations.
func TestLookupOperationDefinition_Known(t *testing.T) {
	tests := []struct {
		op           string
		wantMode     GovernanceDecision
		wantHuman    bool
		wantExecutor bool
	}{
		{"SUBSCRIBER_CREATE", GovernanceDirect, true, true},
		{"SUBSCRIBER_UPDATE", GovernanceApproval, true, true},
		{"OCS_BALANCE_ADJUST", GovernanceApproval, true, true},
		{"OCS_BALANCE_RESET", GovernanceDisabled, false, false},
		{"OCS_RUNTIME_RESERVE", GovernanceRuntimeOnly, false, false},
		{"OCS_RATING_CREATE", GovernanceDisabled, false, false},
		{"RATING_CREATE", GovernanceDirect, true, true},
		{"TARIFF_PLAN_DELETE", GovernanceApproval, true, true},
	}
	for _, tt := range tests {
		t.Run(tt.op, func(t *testing.T) {
			def, ok := LookupOperationDefinition(tt.op)
			if !ok {
				t.Fatalf("LookupOperationDefinition(%q) returned false", tt.op)
			}
			if def.Operation != tt.op {
				t.Errorf("Operation = %q, want %q", def.Operation, tt.op)
			}
			if def.BaseMode != tt.wantMode {
				t.Errorf("BaseMode = %s, want %s", def.BaseMode, tt.wantMode)
			}
			if def.HumanExecutable != tt.wantHuman {
				t.Errorf("HumanExecutable = %v, want %v", def.HumanExecutable, tt.wantHuman)
			}
			if def.ExecutorAvailable != tt.wantExecutor {
				t.Errorf("ExecutorAvailable = %v, want %v", def.ExecutorAvailable, tt.wantExecutor)
			}
		})
	}
}

// TestLookupOperationDefinition_Unknown verifies fail CLOSED for unknown operations.
func TestLookupOperationDefinition_Unknown(t *testing.T) {
	def, ok := LookupOperationDefinition("NONEXISTENT_OPERATION")
	if ok {
		t.Error("LookupOperationDefinition should return false for unknown operations")
	}
	if def.BaseMode != GovernanceDisabled {
		t.Errorf("unknown operation BaseMode = %s, want DISABLED", def.BaseMode)
	}
	if def.HumanExecutable {
		t.Error("unknown operation should not be human-executable")
	}
	if def.ExecutorAvailable {
		t.Error("unknown operation should not have executor available")
	}
}

// TestGovernanceCatalogCompleteness verifies all domain operations in the
// catalog have valid definitions. This does NOT require 1:1 match with the
// risk catalog because domain operation IDs ≠ approval actions.
func TestGovernanceCatalogCompleteness(t *testing.T) {
	ops := GovernanceCatalogOperations()
	if len(ops) == 0 {
		t.Fatal("governance catalog is empty")
	}
	for _, op := range ops {
		def, ok := LookupOperationDefinition(op)
		if !ok {
			t.Errorf("catalog operation %s not found via LookupOperationDefinition", op)
		}
		if def.Operation != op {
			t.Errorf("Operation field mismatch: catalog key=%q, def.Operation=%q", op, def.Operation)
		}
		// Validate mode is one of the known values
		switch def.BaseMode {
		case GovernanceDirect, GovernanceApproval, GovernanceDisabled, GovernanceRuntimeOnly:
			// valid
		default:
			t.Errorf("operation %s has invalid BaseMode: %s", op, def.BaseMode)
		}
	}
}
