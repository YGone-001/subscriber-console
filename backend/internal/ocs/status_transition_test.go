package ocs

import (
	"net/http"
	"testing"
)

func TestContractTransitionError(t *testing.T) {
	tests := []struct {
		current string
		target  string
		status  int
		code    string
	}{
		{"active", "suspended", 0, ""},
		{"suspended", "active", 0, ""},
		{"active", "terminated", 0, ""},
		{"suspended", "terminated", 0, ""},
		{"terminated", "terminated", 0, ""},
		{"terminated", "active", http.StatusConflict, "CONTRACT_TERMINATED"},
		{"terminated", "suspended", http.StatusConflict, "CONTRACT_TERMINATED"},
		{"active", "active", http.StatusConflict, "CONTRACT_NOT_SUSPENDED"},
		{"suspended", "suspended", http.StatusConflict, "CONTRACT_NOT_ACTIVE"},
		{"", "active", http.StatusConflict, "CONTRACT_NOT_SUSPENDED"},
	}
	for _, tt := range tests {
		t.Run(tt.current+"_to_"+tt.target, func(t *testing.T) {
			status, _, code := contractTransitionError(tt.current, tt.target)
			if status != tt.status || code != tt.code {
				t.Fatalf("contractTransitionError(%q,%q) = %d/%q, want %d/%q", tt.current, tt.target, status, code, tt.status, tt.code)
			}
		})
	}
}
