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

// OperationGovernanceDefinition describes an operation's governance characteristics.
// The domain registry (subscriber, OCS, tariff, etc.) supplies this.
// The evaluator does NOT maintain its own operation map.
type OperationGovernanceDefinition struct {
	// Operation is the canonical domain operation ID (e.g. "OCS_RATING_CREATE").
	Operation string

	// BaseMode is the base governance mode from the domain registry.
	BaseMode GovernanceDecision

	// HumanExecutable indicates whether a human can trigger this operation
	// via HTTP endpoints (as opposed to runtime-only internal operations).
	HumanExecutable bool

	// ExecutorAvailable indicates whether a production executor exists.
	ExecutorAvailable bool
}

// governanceDefinitionEntry is the internal catalog entry with mode and flags.
type governanceDefinitionEntry struct {
	mode              GovernanceDecision
	humanExecutable   bool
	executorAvailable bool
}

// governanceCatalog maps canonical domain operation IDs to governance definitions.
//
// Domain operation IDs are source-derived from domain registries:
//   - Subscriber: SUBSCRIBER_* (from subscriber package)
//   - OCS: OCS_* (from ocs package)
//   - Tariff: TARIFF_* (from tariff package)
//   - Rating: RATING_* (from rating package)
//   - Profile: PROFILE_* (from profile package)
//   - System: SYSTEM_*, ACCESS_REQUEST, POLICY_CHANGE, TRAFFIC_ADJUSTMENT
//
// Mode precedence (checked in EvaluateGovernance):
//  1. DISABLED → always DISABLED (even for super_admin)
//  2. RUNTIME_INTERNAL → always RUNTIME_INTERNAL (even for super_admin)
//  3. super_admin + human-executable + has executor → DIRECT_GOVERNED
//  4. APPROVAL_GOVERNED → requires approval
//  5. DIRECT_GOVERNED → direct execution
//
// IMPORTANT: Domain operation ID ≠ ApprovalAction.
// ApprovalAction (in risk catalog) is the human-facing action label.
// Domain operation ID is the canonical registry identifier.
// Example: approval action "RATING_CREATE" may map to domain operation
// "OCS_RATING_CREATE" (disabled) or "TARIFF_RATING_CREATE" (direct).
// The caller (workflow) is responsible for resolving the correct domain operation.
var governanceCatalog = map[string]governanceDefinitionEntry{
	// ── Subscriber operations (from subscriber registry) ────────────────────
	"SUBSCRIBER_CREATE":           {mode: GovernanceDirect, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_UPDATE":           {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_DELETE":           {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_BATCH_CREATE":     {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_BATCH_UPDATE":     {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_BULK_DELETE":      {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_IMPORT":           {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_IMPORT_OVERWRITE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"SUBSCRIBER_PROFILE_APPLY":    {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},

	// ── OCS operations (from OCS registry) ──────────────────────────────────
	"OCS_BALANCE_ADJUST":  {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"OCS_BALANCE_RESET":   {mode: GovernanceDisabled, humanExecutable: false, executorAvailable: false},
	"OCS_RUNTIME_RESERVE": {mode: GovernanceRuntimeOnly, humanExecutable: false, executorAvailable: false},
	"OCS_TARIFF_ASSIGN":   {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"OCS_RATING_CREATE":   {mode: GovernanceDisabled, humanExecutable: false, executorAvailable: false},
	"OCS_RATING_WRITE":    {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"OCS_PLAN_ASSIGN":     {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},

	// ── Tariff operations (from tariff registry) ───────────────────────────
	"TARIFF_PLAN_CREATE":      {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TARIFF_PLAN_UPDATE":      {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TARIFF_PLAN_DELETE":      {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TARIFF_PLAN_RULE_CREATE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TARIFF_PLAN_RULE_UPDATE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TARIFF_PLAN_RULE_DELETE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TARIFF_PLAN_RULE_TOGGLE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TARIFF_PLAN_MIGRATE":     {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},

	// ── Rating operations (from rating registry) ───────────────────────────
	"RATING_CREATE": {mode: GovernanceDirect, humanExecutable: true, executorAvailable: true},
	"RATING_UPDATE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"RATING_DELETE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},

	// ── Profile operations (from profile registry) ─────────────────────────
	"PROFILE_RESTORE": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},

	// ── System operations ──────────────────────────────────────────────────
	"SYSTEM_HEAL":        {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"ACCESS_REQUEST":     {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"POLICY_CHANGE":      {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
	"TRAFFIC_ADJUSTMENT": {mode: GovernanceApproval, humanExecutable: true, executorAvailable: true},
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
// This is a PURE POLICY EVALUATOR — it does not check permissions and does
// not maintain its own operation map. The caller supplies the definition
// from the domain registry via LookupOperationDefinition.
//
// Ordering is mandatory:
//  1. DISABLED → always DISABLED
//  2. RUNTIME_INTERNAL → always RUNTIME_INTERNAL
//  3. super_admin + approval-governed + has executor → DIRECT_GOVERNED
//  4. APPROVAL_GOVERNED → requires approval
//  5. DIRECT_GOVERNED → direct execution
//
// For unknown operations, callers should use LookupOperationDefinition
// which returns GovernanceDisabled (fail CLOSED).
func EvaluateGovernance(def OperationGovernanceDefinition, actorRole string) GovernanceResult {
	// 1. DISABLED is always disabled — no override
	if def.BaseMode == GovernanceDisabled {
		return GovernanceResult{
			Decision:         GovernanceDisabled,
			ApprovalRequired: false,
			Reason:           "Operation is disabled",
		}
	}

	// 2. RUNTIME_INTERNAL is always runtime-only — no override
	if def.BaseMode == GovernanceRuntimeOnly {
		return GovernanceResult{
			Decision:         GovernanceRuntimeOnly,
			ApprovalRequired: false,
			Reason:           "Operation is runtime-internal and not available via human endpoints",
		}
	}

	// 3. Super Admin + approval-governed + human-executable + has executor → DIRECT
	if isSuperAdminRole(actorRole) && def.BaseMode == GovernanceApproval && def.HumanExecutable && def.ExecutorAvailable {
		return GovernanceResult{
			Decision:         GovernanceDirect,
			ApprovalRequired: false,
			Reason:           "Super administrator direct execution",
		}
	}

	// 4. Base mode applies
	return GovernanceResult{
		Decision:         def.BaseMode,
		ApprovalRequired: def.BaseMode == GovernanceApproval,
	}
}

// LookupOperationDefinition looks up a governance definition by canonical
// domain operation ID. Returns the definition and true if found.
//
// For unknown operations, returns a DISABLED definition and false.
// This implements fail CLOSED — unknown operations are not available.
func LookupOperationDefinition(domainOperation string) (OperationGovernanceDefinition, bool) {
	entry, ok := governanceCatalog[domainOperation]
	if !ok {
		return OperationGovernanceDefinition{
			Operation:         domainOperation,
			BaseMode:          GovernanceDisabled,
			HumanExecutable:   false,
			ExecutorAvailable: false,
		}, false
	}
	return OperationGovernanceDefinition{
		Operation:         domainOperation,
		BaseMode:          entry.mode,
		HumanExecutable:   entry.humanExecutable,
		ExecutorAvailable: entry.executorAvailable,
	}, true
}

// EvaluateGovernanceByOperation is a convenience function that looks up the
// definition and evaluates governance in one call.
// Unknown operations return GovernanceDisabled (fail CLOSED).
func EvaluateGovernanceByOperation(domainOperation string, actorRole string) GovernanceResult {
	def, _ := LookupOperationDefinition(domainOperation)
	return EvaluateGovernance(def, actorRole)
}

// isSuperAdminRole checks if a role is super_admin.
// Handles both raw and normalized roles: "root" (legacy) and "super_admin".
// Uses canonical normalization: auth.NormalizeRole(role) == "super_admin".
func isSuperAdminRole(role string) bool {
	return auth.NormalizeRole(role) == "super_admin"
}

// IsSuperAdminRole is the exported version of isSuperAdminRole.
// Use auth.IsSuperAdmin(Principal) when a Principal is available.
func IsSuperAdminRole(role string) bool {
	return isSuperAdminRole(role)
}

// EvaluateGovernanceForPrincipal is a convenience wrapper that takes a Principal.
func EvaluateGovernanceForPrincipal(domainOperation string, p *auth.Principal) GovernanceResult {
	role := ""
	if p != nil {
		role = p.NormalizedRole
	}
	return EvaluateGovernanceByOperation(domainOperation, role)
}

// GovernanceCatalogOperations returns all domain operation IDs in the governance catalog.
func GovernanceCatalogOperations() []string {
	ops := make([]string, 0, len(governanceCatalog))
	for k := range governanceCatalog {
		ops = append(ops, k)
	}
	return ops
}

// IsKnownOperation returns true if the domain operation ID is in the governance catalog.
func IsKnownOperation(domainOperation string) bool {
	_, ok := governanceCatalog[domainOperation]
	return ok
}
