package approval

import (
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/governance"
)

// GovernanceDecision represents the effective governance mode for an operation.
// Delegates to the neutral governance package.
type GovernanceDecision = governance.Decision

const (
	GovernanceDirect      = governance.Direct
	GovernanceApproval    = governance.Approval
	GovernanceDisabled    = governance.Disabled
	GovernanceRuntimeOnly = governance.RuntimeOnly
)

// OperationGovernanceDefinition describes an operation's governance characteristics.
// Delegates to the neutral governance package.
type OperationGovernanceDefinition = governance.OperationDefinition

// GovernanceResult holds the effective governance decision for an operation.
// Delegates to the neutral governance package.
type GovernanceResult = governance.Result

// EvaluateGovernance determines the effective governance mode for an operation
// performed by a given actor. Delegates to the neutral governance package.
func EvaluateGovernance(def OperationGovernanceDefinition, actorRole string) GovernanceResult {
	return governance.Evaluate(def, actorRole)
}

// LookupOperationDefinition looks up a governance definition by canonical
// domain operation ID. Returns the definition and true if found.
// For unknown operations, returns a DISABLED definition and false.
// This function is DEPRECATED — domain packages should supply their own definitions.
func LookupOperationDefinition(domainOperation string) (OperationGovernanceDefinition, bool) {
	return governance.OperationDefinition{
		Operation:         domainOperation,
		BaseMode:          governance.Disabled,
		HumanExecutable:   false,
		ExecutorAvailable: false,
	}, false
}

// EvaluateGovernanceByOperation is a convenience function that looks up the
// definition and evaluates governance in one call.
// This function is DEPRECATED — domain packages should use their own EvaluateOperation.
func EvaluateGovernanceByOperation(domainOperation string, actorRole string) GovernanceResult {
	def, _ := LookupOperationDefinition(domainOperation)
	return governance.Evaluate(def, actorRole)
}

// IsSuperAdminRole checks if a role is super_admin.
// Delegates to the neutral governance package.
func IsSuperAdminRole(role string) bool {
	return governance.IsSuperAdminRole(role)
}

// EvaluateGovernanceForPrincipal is a convenience wrapper that takes a Principal.
func EvaluateGovernanceForPrincipal(domainOperation string, p *auth.Principal) GovernanceResult {
	role := ""
	if p != nil {
		role = p.NormalizedRole
	}
	return EvaluateGovernanceByOperation(domainOperation, role)
}
