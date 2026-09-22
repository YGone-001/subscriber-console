package balance

import "subscriber/internal/governance"

// BalanceOperation represents a governed balance management operation.
type BalanceOperation string

const (
	// OpAdjust is the balance adjustment operation (credit or debit).
	OpAdjust BalanceOperation = "BALANCE_ADJUST"

	// OpReset is the balance reset operation (permanently disabled).
	OpReset BalanceOperation = "BALANCE_RESET"
)

// balanceRegistry defines governance rules for balance management operations.
var balanceRegistry = map[BalanceOperation]governance.OperationDefinition{
	OpAdjust: {
		Operation:         string(OpAdjust),
		BaseMode:          governance.Direct,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpReset: {
		Operation:         string(OpReset),
		BaseMode:          governance.Disabled,
		HumanExecutable:   false,
		ExecutorAvailable: false,
	},
}

// LookupOperation returns the governance definition for a balance operation.
// Returns Disabled and false for unknown operations (fail CLOSED).
func LookupOperation(op BalanceOperation) (governance.OperationDefinition, bool) {
	def, ok := balanceRegistry[op]
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

// EvaluateOperation evaluates the effective governance decision for a balance operation.
// Unknown operations return Disabled (fail CLOSED).
func EvaluateOperation(op BalanceOperation, actorRole string) governance.Result {
	def, _ := LookupOperation(op)
	return governance.Evaluate(def, actorRole)
}
