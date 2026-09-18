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
// All operations are APPROVAL_GOVERNED base; super_admin/root override to DIRECT.
var subscriberRegistry = map[SubscriberOperation]governance.OperationDefinition{
	OpContractCreate: {
		Operation:         string(OpContractCreate),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractUpdate: {
		Operation:         string(OpContractUpdate),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractSuspend: {
		Operation:         string(OpContractSuspend),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractResume: {
		Operation:         string(OpContractResume),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpContractTerminate: {
		Operation:         string(OpContractTerminate),
		BaseMode:          governance.Approval,
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
