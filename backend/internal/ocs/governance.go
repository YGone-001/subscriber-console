package ocs

import "subscriber/internal/governance"

// SubscriberOperation is the canonical OCS subscriber contract operation ID.
type SubscriberOperation string

const (
	OpContractCreate    SubscriberOperation = "OCS_SUBSCRIBER_CREATE"
	OpContractUpdate    SubscriberOperation = "OCS_SUBSCRIBER_UPDATE"
	OpContractSuspend   SubscriberOperation = "OCS_SUBSCRIBER_SUSPEND"
	OpContractResume    SubscriberOperation = "OCS_SUBSCRIBER_RESUME"
	OpContractTerminate SubscriberOperation = "OCS_SUBSCRIBER_TERMINATE"
)

// subscriberRegistry is the OCS subscriber contract governance registry.
// Phase 5.7-A: All authorized operations execute directly.
var subscriberRegistry = map[SubscriberOperation]governance.OperationDefinition{
	OpContractCreate: {
		Operation:         string(OpContractCreate),
		BaseMode:          governance.Direct,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractUpdate: {
		Operation:         string(OpContractUpdate),
		BaseMode:          governance.Direct,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractSuspend: {
		Operation:         string(OpContractSuspend),
		BaseMode:          governance.Direct,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractResume: {
		Operation:         string(OpContractResume),
		BaseMode:          governance.Direct,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractTerminate: {
		Operation:         string(OpContractTerminate),
		BaseMode:          governance.Direct,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
}

// LookupSubscriberOperation returns the governance definition for an OCS subscriber operation.
// Returns the definition and true if found.
// For unknown operations, returns a Disabled definition and false (fail CLOSED).
func LookupSubscriberOperation(op SubscriberOperation) (governance.OperationDefinition, bool) {
	def, ok := subscriberRegistry[op]
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

// EvaluateSubscriberOperation evaluates the effective governance for an OCS subscriber operation.
// Unknown operations return Disabled (fail CLOSED).
func EvaluateSubscriberOperation(op SubscriberOperation, actorRole string) governance.Result {
	def, _ := LookupSubscriberOperation(op)
	return governance.Evaluate(def, actorRole)
}
