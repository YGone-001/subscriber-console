package subscriber

import "testing"

func TestSubscriberDeleteContractGuard(t *testing.T) {
	tests := []struct {
		name    string
		status  string
		exists  bool
		blocked bool
		cleanup bool
	}{
		{"no contract", "", false, false, true},
		{"active contract", "active", true, true, false},
		{"suspended contract", "suspended", true, true, false},
		{"terminated contract", "terminated", true, false, false},
		{"unknown contract status", "", true, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := subscriberDeleteBlockedByContract(tt.status, tt.exists); got != tt.blocked {
				t.Fatalf("blocked = %v, want %v", got, tt.blocked)
			}
			if got := ocsCleanupAllowed(tt.status, tt.exists); got != tt.cleanup {
				t.Fatalf("cleanup = %v, want %v", got, tt.cleanup)
			}
		})
	}
}
