package approval

import "github.com/YGone-001/subscriber-console/backend/internal/auth"

// GovernanceDecision represents the effective governance mode for an operation.
type GovernanceDecision string

const (
	// GovernanceDirect means the operation executes immediately without approval.
	// Super Admin bypasses approval for human-executable operations.
	GovernanceDirect GovernanceDecision = "DIRECT_GOVERNED"

	// GovernanceApproval means the operation requires an approval workflow.
	GovernanceApproval GovernanceDecision = "APPROVAL_GOVERNED"

	// GovernanceDisabled means the operation is not available.
	// Super Admin CANNOT override this.
	GovernanceDisabled GovernanceDecision = "DISABLED"

	// GovernanceRuntimeOnly means the operation is internal and not available
	// via human HTTP endpoints. Super Admin CANNOT override this.
	GovernanceRuntimeOnly GovernanceDecision = "RUNTIME_INTERNAL"
)

// governanceRule defines the base governance mode for an operation.
type governanceRule struct {
	mode    GovernanceDecision
	enabled bool // whether the operation has a production executor
}

// governanceCatalog maps operation names to their base governance rules.
// This is the source of truth for operation governance.
//
// Mode precedence (checked in order):
//  1. DISABLED → always DISABLED (even for super_admin)
//  2. RUNTIME_INTERNAL → always RUNTIME_INTERNAL (even for super_admin)
//  3. super_admin + human-executable + has executor → DIRECT_GOVERNED
//  4. APPROVAL_GOVERNED → requires approval
//  5. DIRECT_GOVERNED → direct execution
var governanceCatalog = map[string]governanceRule{
	// Subscriber operations
	"SUBSCRIBER_CREATE":           {mode: GovernanceDirect, enabled: true},
	"SUBSCRIBER_UPDATE":           {mode: GovernanceApproval, enabled: true},
	"SUBSCRIBER_DELETE":           {mode: GovernanceApproval, enabled: true},
	"SUBSCRIBER_BATCH_CREATE":     {mode: GovernanceApproval, enabled: true},
	"SUBSCRIBER_BATCH_UPDATE":     {mode: GovernanceApproval, enabled: true},
	"SUBSCRIBER_BULK_DELETE":      {mode: GovernanceApproval, enabled: true},
	"SUBSCRIBER_IMPORT":           {mode: GovernanceApproval, enabled: true},
	"SUBSCRIBER_IMPORT_OVERWRITE": {mode: GovernanceApproval, enabled: true},
	"SUBSCRIBER_PROFILE_APPLY":    {mode: GovernanceApproval, enabled: true},

	// OCS operations
	"OCS_BALANCE_ADJUST":  {mode: GovernanceApproval, enabled: true},
	"OCS_BALANCE_RESET":   {mode: GovernanceDisabled, enabled: false},
	"OCS_RUNTIME_RESERVE": {mode: GovernanceRuntimeOnly, enabled: false},
	"OCS_TARIFF_ASSIGN":   {mode: GovernanceApproval, enabled: true},
	"OCS_RATING_WRITE":    {mode: GovernanceApproval, enabled: true},
	"OCS_PLAN_ASSIGN":     {mode: GovernanceApproval, enabled: true},

	// Tariff/Rating operations
	"TARIFF_PLAN_CREATE":      {mode: GovernanceApproval, enabled: true},
	"TARIFF_PLAN_UPDATE":      {mode: GovernanceApproval, enabled: true},
	"TARIFF_PLAN_DELETE":      {mode: GovernanceApproval, enabled: true},
	"TARIFF_PLAN_RULE_CREATE": {mode: GovernanceApproval, enabled: true},
	"TARIFF_PLAN_RULE_UPDATE": {mode: GovernanceApproval, enabled: true},
	"TARIFF_PLAN_RULE_DELETE": {mode: GovernanceApproval, enabled: true},
	"TARIFF_PLAN_RULE_TOGGLE": {mode: GovernanceApproval, enabled: true},
	"TARIFF_PLAN_MIGRATE":     {mode: GovernanceApproval, enabled: true},
	"RATING_CREATE":           {mode: GovernanceDirect, enabled: true},
	"RATING_UPDATE":           {mode: GovernanceApproval, enabled: true},
	"RATING_DELETE":           {mode: GovernanceApproval, enabled: true},

	// Profile operations
	"PROFILE_RESTORE": {mode: GovernanceApproval, enabled: true},

	// System operations
	"SYSTEM_HEAL":        {mode: GovernanceApproval, enabled: true},
	"ACCESS_REQUEST":     {mode: GovernanceApproval, enabled: true},
	"POLICY_CHANGE":      {mode: GovernanceApproval, enabled: true},
	"TRAFFIC_ADJUSTMENT": {mode: GovernanceApproval, enabled: true},
}

// GovernanceResult holds the effective governance decision for an operation.
type GovernanceResult struct {
	Decision         GovernanceDecision `json:"decision"`
	ApprovalRequired bool               `json:"approvalRequired"`
	Reason           string             `json:"reason,omitempty"`
}

// EvaluateGovernance determines the effective governance mode for an operation
// performed by a given actor.
//
// Ordering is mandatory:
//  1. DISABLED → always DISABLED
//  2. RUNTIME_INTERNAL → always RUNTIME_INTERNAL
//  3. super_admin + human executable + has executor → DIRECT_GOVERNED
//  4. APPROVAL_GOVERNED → requires approval
//  5. DIRECT_GOVERNED → direct execution
//
// This is a POLICY EVALUATOR — it does not check permissions.
// Permission checks must happen separately.
func EvaluateGovernance(operation string, actorRole string) GovernanceResult {
	rule, exists := governanceCatalog[operation]
	if !exists {
		// Unknown operations fail safe as approval-governed
		return GovernanceResult{
			Decision:         GovernanceApproval,
			ApprovalRequired: true,
			Reason:           "Operation is not in the governance catalog; fail-safe review required",
		}
	}

	// 1. DISABLED is always disabled — no override
	if rule.mode == GovernanceDisabled {
		return GovernanceResult{
			Decision:         GovernanceDisabled,
			ApprovalRequired: false,
			Reason:           "Operation is disabled",
		}
	}

	// 2. RUNTIME_INTERNAL is always runtime-only — no override
	if rule.mode == GovernanceRuntimeOnly {
		return GovernanceResult{
			Decision:         GovernanceRuntimeOnly,
			ApprovalRequired: false,
			Reason:           "Operation is runtime-internal and not available via human endpoints",
		}
	}

	// 3. Super Admin + approval-governed + has executor → DIRECT
	if isSuperAdminRole(actorRole) && rule.mode == GovernanceApproval && rule.enabled {
		return GovernanceResult{
			Decision:         GovernanceDirect,
			ApprovalRequired: false,
			Reason:           "Super administrator direct execution",
		}
	}

	// 4. Base mode applies
	return GovernanceResult{
		Decision:         rule.mode,
		ApprovalRequired: rule.mode == GovernanceApproval,
	}
}

// isSuperAdminRole checks if a normalized role is super_admin.
// Centralizes the check to avoid scattered string comparisons.
func isSuperAdminRole(role string) bool {
	return role == "super_admin"
}

// IsSuperAdminRole is the exported version of isSuperAdminRole.
// Use auth.IsSuperAdmin(Principal) when a Principal is available.
func IsSuperAdminRole(role string) bool {
	return isSuperAdminRole(role)
}

// EvaluateGovernanceForPrincipal is a convenience wrapper that takes a Principal.
func EvaluateGovernanceForPrincipal(operation string, p *auth.Principal) GovernanceResult {
	role := ""
	if p != nil {
		role = p.NormalizedRole
	}
	return EvaluateGovernance(operation, role)
}

// GovernanceCatalogOperations returns all operations in the governance catalog.
func GovernanceCatalogOperations() []string {
	ops := make([]string, 0, len(governanceCatalog))
	for k := range governanceCatalog {
		ops = append(ops, k)
	}
	return ops
}

// IsKnownOperation returns true if the operation is in the governance catalog.
func IsKnownOperation(operation string) bool {
	_, ok := governanceCatalog[operation]
	return ok
}
