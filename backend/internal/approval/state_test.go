package approval

import "testing"

func TestCanTransition_Allowed(t *testing.T) {
	tests := []struct {
		from, to ApprovalStatus
	}{
		{StatusPending, StatusApproved},
		{StatusPending, StatusRejected},
		{StatusPending, StatusCancelled},
		{StatusPending, StatusExpired},
		{StatusApproved, StatusExecuting},
		{StatusApproved, StatusCancelled},
		{StatusExecuting, StatusCompleted},
		{StatusExecuting, StatusFailed},
	}

	for _, tt := range tests {
		t.Run(string(tt.from)+"->"+string(tt.to), func(t *testing.T) {
			if !CanTransition(tt.from, tt.to) {
				t.Errorf("expected %s -> %s to be allowed", tt.from, tt.to)
			}
		})
	}
}

func TestCanTransition_Disallowed(t *testing.T) {
	tests := []struct {
		from, to ApprovalStatus
	}{
		{StatusRejected, StatusApproved},
		{StatusCancelled, StatusApproved},
		{StatusExpired, StatusApproved},
		{StatusCompleted, StatusApproved},
		{StatusFailed, StatusApproved},
		{StatusPending, StatusCompleted},
		{StatusPending, StatusFailed},
		{StatusPending, StatusExecuting},
		{StatusApproved, StatusCompleted},
		{StatusApproved, StatusFailed},
		{StatusApproved, StatusRejected},
		{StatusExecuting, StatusApproved},
		{StatusExecuting, StatusCancelled},
		{StatusCompleted, StatusFailed},
		{StatusFailed, StatusCompleted},
	}

	for _, tt := range tests {
		t.Run(string(tt.from)+"->"+string(tt.to), func(t *testing.T) {
			if CanTransition(tt.from, tt.to) {
				t.Errorf("expected %s -> %s to be disallowed", tt.from, tt.to)
			}
		})
	}
}

func TestIsTerminal(t *testing.T) {
	terminal := []ApprovalStatus{
		StatusRejected, StatusCancelled, StatusExpired, StatusCompleted, StatusFailed,
	}
	nonTerminal := []ApprovalStatus{
		StatusPending, StatusApproved, StatusExecuting,
	}

	for _, s := range terminal {
		if !IsTerminal(s) {
			t.Errorf("expected %s to be terminal", s)
		}
	}
	for _, s := range nonTerminal {
		if IsTerminal(s) {
			t.Errorf("expected %s to not be terminal", s)
		}
	}
}
