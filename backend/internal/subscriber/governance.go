package subscriber

import "github.com/YGone-001/subscriber-console/backend/internal/governance"

// SubscriberOperation is the canonical subscriber operation ID.
type SubscriberOperation string

const (
	OpCreate      SubscriberOperation = "SUBSCRIBER_CREATE"
	OpUpdate      SubscriberOperation = "SUBSCRIBER_UPDATE"
	OpDelete      SubscriberOperation = "SUBSCRIBER_DELETE"
	OpBatchCreate SubscriberOperation = "SUBSCRIBER_BATCH_CREATE"
	OpBatchUpdate SubscriberOperation = "SUBSCRIBER_BATCH_UPDATE"
	OpBulkDelete  SubscriberOperation = "SUBSCRIBER_BULK_DELETE"
	OpImport      SubscriberOperation = "SUBSCRIBER_IMPORT"
)

// subscriberRegistry is the subscriber-domain governance registry.
// Derived from Node subscriberGovernanceRegistry.ts exactly.
var subscriberRegistry = map[SubscriberOperation]governance.OperationDefinition{
	OpCreate: {
		Operation:         string(OpCreate),
		BaseMode:          governance.Direct,
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
	OpBatchCreate: {
		Operation:         string(OpBatchCreate),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpBatchUpdate: {
		Operation:         string(OpBatchUpdate),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpBulkDelete: {
		Operation:         string(OpBulkDelete),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
	OpImport: {
		Operation:         string(OpImport),
		BaseMode:          governance.Approval,
		HumanExecutable:   true,
		ExecutorAvailable: true,
	},
}

// LookupOperation returns the governance definition for a subscriber operation.
// Returns the definition and true if found.
// For unknown operations, returns a Disabled definition and false (fail CLOSED).
func LookupOperation(op SubscriberOperation) (governance.OperationDefinition, bool) {
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

// EvaluateOperation evaluates the effective governance for a subscriber operation.
// Unknown operations return Disabled (fail CLOSED).
func EvaluateOperation(op SubscriberOperation, actorRole string) governance.Result {
	def, _ := LookupOperation(op)
	return governance.Evaluate(def, actorRole)
}
