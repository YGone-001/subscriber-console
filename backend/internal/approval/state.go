package approval

// allowedTransitions defines the pure state machine for approval status transitions.
// Matches Node ALLOWED_TRANSITIONS exactly.
var allowedTransitions = map[ApprovalStatus][]ApprovalStatus{
	StatusPending:   {StatusApproved, StatusRejected, StatusCancelled, StatusExpired},
	StatusApproved:  {StatusExecuting, StatusCancelled},
	StatusExecuting: {StatusCompleted, StatusFailed},
	StatusRejected:  {},
	StatusCancelled: {},
	StatusExpired:   {},
	StatusCompleted: {},
	StatusFailed:    {},
}

// CanTransition returns true if the transition from one status to another is allowed.
// This is a pure policy function — no Mongo writes.
func CanTransition(from, to ApprovalStatus) bool {
	targets, ok := allowedTransitions[from]
	if !ok {
		return false
	}
	for _, t := range targets {
		if t == to {
			return true
		}
	}
	return false
}

// TerminalStatuses are statuses from which no further transitions are possible.
var TerminalStatuses = map[ApprovalStatus]bool{
	StatusRejected:  true,
	StatusCancelled: true,
	StatusExpired:   true,
	StatusCompleted: true,
	StatusFailed:    true,
}

// IsTerminal returns true if the status is terminal (no further transitions).
func IsTerminal(status ApprovalStatus) bool {
	return TerminalStatuses[status]
}
