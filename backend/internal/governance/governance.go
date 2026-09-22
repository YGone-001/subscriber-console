// Package governance provides a neutral, domain-agnostic operation policy evaluator.
//
// Domain packages (subscriber, ocs, tariff, etc.) supply their own
// OperationDefinition. This package evaluates whether an operation is disabled,
// runtime-only, or directly executable.
//
// In Phase 5.7-C, all approval workflows are removed.
// Human-triggered mutations execute directly if permitted by RBAC.
package governance

// Decision represents the effective execution mode for an operation.
type Decision string

const (
	// Direct means the operation executes immediately without approval.
	Direct Decision = "DIRECT_GOVERNED"

	// Disabled means the operation is permanently disabled (e.g. balance reset).
	Disabled Decision = "DISABLED"

	// RuntimeOnly means the operation is internal and not available
	// via human HTTP endpoints.
	RuntimeOnly Decision = "RUNTIME_INTERNAL"
)

// OperationDefinition describes an operation's governance characteristics.
type OperationDefinition struct {
	// Operation is the canonical domain operation ID (e.g. "SUBSCRIBER_UPDATE").
	Operation string

	// BaseMode is the base execution mode from the domain registry.
	BaseMode Decision

	// HumanExecutable indicates whether a human can trigger this operation.
	HumanExecutable bool

	// ExecutorAvailable indicates whether a production executor exists.
	ExecutorAvailable bool
}

// Result holds the effective policy decision for an operation.
type Result struct {
	Decision Decision `json:"decision"`
	Reason   string   `json:"reason,omitempty"`
}

// Evaluate determines the effective mode for an operation performed by a given actor.
func Evaluate(def OperationDefinition, actorRole string) Result {
	// 1. Disabled is always disabled — no override
	if def.BaseMode == Disabled {
		return Result{
			Decision: Disabled,
			Reason:   "Operation is disabled",
		}
	}

	// 2. RuntimeOnly is always runtime-only — no override
	if def.BaseMode == RuntimeOnly {
		return Result{
			Decision: RuntimeOnly,
			Reason:   "Operation is runtime-internal and not available via human endpoints",
		}
	}

	// 3. Otherwise Direct execution
	return Result{
		Decision: Direct,
	}
}
