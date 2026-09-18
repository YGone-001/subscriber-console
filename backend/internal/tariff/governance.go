package tariff

import "subscriber/internal/governance"

// TariffOperation is the canonical tariff operation ID.
type TariffOperation string

const (
	OpCreate TariffOperation = "TARIFF_PLAN_CREATE"
	OpUpdate TariffOperation = "TARIFF_PLAN_UPDATE"
	OpDelete TariffOperation = "TARIFF_PLAN_DELETE"
)

// tariffRegistry is the tariff-domain governance registry.
// Derived from Node ocsGovernanceRegistry.ts exactly.
var tariffRegistry = map[TariffOperation]governance.OperationDefinition{
	OpCreate: {
		Operation:         string(OpCreate),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpUpdate: {
		Operation:         string(OpUpdate),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpDelete: {
		Operation:         string(OpDelete),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
}

// LookupOperation returns the governance definition for a tariff operation.
// Returns the definition and true if found.
// For unknown operations, returns a Disabled definition and false (fail CLOSED).
func LookupOperation(op TariffOperation) (governance.OperationDefinition, bool) {
	def, ok := tariffRegistry[op]
	if !ok {
		return governance.OperationDefinition{
			Operation:         string(op),
			BaseMode:          governance.Disabled,
			HumanExecutable:   false,
			ExecutorAvailable: false,
		}, false
	}
	return def, true
}

// EvaluateOperation evaluates the effective governance for a tariff operation.
// Unknown operations return Disabled (fail CLOSED).
func EvaluateOperation(op TariffOperation, actorRole string) governance.Result {
	def, _ := LookupOperation(op)
	return governance.Evaluate(def, actorRole)
}
