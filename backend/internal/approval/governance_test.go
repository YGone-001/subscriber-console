package approval

import (
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
)

// TestEvaluateGovernance_SuperAdmin_DirectFromApproval verifies that super_admin
// gets DIRECT_GOVERNED for approval-governed human operations.
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
			r := EvaluateGovernance(op, "super_admin")
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
	// root normalizes to super_admin, so role passed to EvaluateGovernance
	// should already be normalized. Test with "super_admin" since that's what
	// NormalizeRole("root") returns.
	r := EvaluateGovernance("SUBSCRIBER_UPDATE", "super_admin")
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
				r := EvaluateGovernance(op, role)
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
		t.Run(role+"/OCS_BALANCE_RESET", func(t *testing.T) {
			r := EvaluateGovernance("OCS_BALANCE_RESET", role)
			if r.Decision != GovernanceDisabled {
				t.Errorf("%s + OCS_BALANCE_RESET = %s, want DISABLED", role, r.Decision)
			}
			if r.ApprovalRequired {
				t.Errorf("%s + OCS_BALANCE_RESET: approvalRequired = true, want false", role)
			}
		})
	}
}

// TestEvaluateGovernance_RuntimeInternal_AlwaysRuntime verifies that RUNTIME_INTERNAL
// operations remain runtime-only even for super_admin.
func TestEvaluateGovernance_RuntimeInternal_AlwaysRuntime(t *testing.T) {
	roles := []string{"super_admin", "root", "operator", "ops_admin"}
	for _, role := range roles {
		t.Run(role+"/OCS_RUNTIME_RESERVE", func(t *testing.T) {
			r := EvaluateGovernance("OCS_RUNTIME_RESERVE", role)
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
				r := EvaluateGovernance(op, role)
				if r.Decision != GovernanceDirect {
					t.Errorf("%s + %s = %s, want DIRECT_GOVERNED", role, op, r.Decision)
				}
			})
		}
	}
}

// TestEvaluateGovernance_UnknownOperation_FailSafe verifies unknown operations
// fail safe as approval-governed.
func TestEvaluateGovernance_UnknownOperation_FailSafe(t *testing.T) {
	r := EvaluateGovernance("UNKNOWN_OPERATION", "super_admin")
	if r.Decision != GovernanceApproval {
		t.Errorf("unknown + super_admin = %s, want APPROVAL_GOVERNED", r.Decision)
	}
	if !r.ApprovalRequired {
		t.Errorf("unknown + super_admin: approvalRequired = false, want true")
	}
}

// TestEvaluateGovernance_EmptyRole_FailSafe verifies empty role gets approval.
func TestEvaluateGovernance_EmptyRole_FailSafe(t *testing.T) {
	r := EvaluateGovernance("SUBSCRIBER_UPDATE", "")
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
	if !IsSuperAdminRole("super_admin") {
		t.Error("super_admin should be super admin")
	}
	if IsSuperAdminRole("operator") {
		t.Error("operator should not be super admin")
	}
	if IsSuperAdminRole("ops_admin") {
		t.Error("ops_admin should not be super admin")
	}
	if IsSuperAdminRole("") {
		t.Error("empty should not be super admin")
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

// TestGovernanceCatalogCompleteness verifies all risk catalog operations
// have a governance rule.
func TestGovernanceCatalogCompleteness(t *testing.T) {
	for op := range riskCatalog {
		if _, ok := governanceCatalog[op]; !ok {
			t.Errorf("risk catalog operation %s has no governance rule", op)
		}
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

	r := EvaluateGovernance("SUBSCRIBER_BULK_DELETE", "super_admin")
	if r.Decision != GovernanceDirect {
		t.Errorf("super_admin + SUBSCRIBER_BULK_DELETE = %s, want DIRECT_GOVERNED", r.Decision)
	}
}
