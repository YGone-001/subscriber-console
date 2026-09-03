// Package governance provides a neutral, domain-agnostic governance evaluator.
//
// Domain packages (subscriber, ocs, tariff, etc.) supply their own
// OperationGovernanceDefinition. This package only evaluates the effective
// governance mode based on the definition and actor role.
//
// IMPORTANT: This package does NOT maintain any domain operation maps.
// Each domain owns its own registry.
package governance

import "github.com/YGone-001/subscriber-console/backend/internal/auth"

// Decision represents the effective governance mode for an operation.
type Decision string

const (
	// Direct means the operation executes immediately without approval.
	Direct Decision = "DIRECT_GOVERNED"

	// Approval means the operation requires an approval workflow.
	Approval Decision = "APPROVAL_GOVERNED"

	// Disabled means the operation is not available.
	// Super Admin CANNOT override this.
	Disabled Decision = "DISABLED"

	// RuntimeOnly means the operation is internal and not available
	// via human HTTP endpoints. Super Admin CANNOT override this.
	RuntimeOnly Decision = "RUNTIME_INTERNAL"
)

// OperationDefinition describes an operation's governance characteristics.
// The domain registry (subscriber, OCS, tariff, etc.) supplies this.
type OperationDefinition struct {
	// Operation is the canonical domain operation ID (e.g. "SUBSCRIBER_UPDATE").
	Operation string

	// BaseMode is the base governance mode from the domain registry.
	BaseMode Decision

	// HumanExecutable indicates whether a human can trigger this operation
	// via HTTP endpoints (as opposed to runtime-only internal operations).
	HumanExecutable bool

	// ExecutorAvailable indicates whether a production executor exists.
	ExecutorAvailable bool
}

// Result holds the effective governance decision for an operation.
type Result struct {
	Decision         Decision `json:"decision"`
	ApprovalRequired bool     `json:"approvalRequired"`
	Reason           string   `json:"reason,omitempty"`
}

// Evaluate determines the effective governance mode for an operation
// performed by a given actor.
//
// This is a PURE POLICY EVALUATOR — it does not check permissions and does
// not maintain its own operation map. The caller supplies the definition
// from the domain registry.
//
// Ordering is mandatory:
//  1. Disabled → always Disabled
//  2. RuntimeOnly → always RuntimeOnly
//  3. super_admin + approval-governed + human-executable + has executor → Direct
//  4. Approval → requires approval
//  5. Direct → direct execution
func Evaluate(def OperationDefinition, actorRole string) Result {
	// 1. Disabled is always disabled — no override
	if def.BaseMode == Disabled {
		return Result{
			Decision:         Disabled,
			ApprovalRequired: false,
			Reason:           "Operation is disabled",
		}
	}

	// 2. RuntimeOnly is always runtime-only — no override
	if def.BaseMode == RuntimeOnly {
		return Result{
			Decision:         RuntimeOnly,
			ApprovalRequired: false,
			Reason:           "Operation is runtime-internal and not available via human endpoints",
		}
	}

	// 3. Super Admin + approval-governed + human-executable + has executor → DIRECT
	if IsSuperAdminRole(actorRole) && def.BaseMode == Approval && def.HumanExecutable && def.ExecutorAvailable {
		return Result{
			Decision:         Direct,
			ApprovalRequired: false,
			Reason:           "Super administrator direct execution",
		}
	}

	// 4. Base mode applies
	return Result{
		Decision:         def.BaseMode,
		ApprovalRequired: def.BaseMode == Approval,
	}
}

// IsSuperAdminRole checks if a role is super_admin.
// Handles both raw and normalized roles: "root" (legacy) and "super_admin".
func IsSuperAdminRole(role string) bool {
	return auth.NormalizeRole(role) == "super_admin"
}
