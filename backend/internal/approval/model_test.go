package approval

import "testing"

func TestIsApprovalStatus(t *testing.T) {
	valid := []string{"pending", "approved", "rejected", "cancelled", "executing", "completed", "failed", "expired"}
	for _, s := range valid {
		if !IsApprovalStatus(s) {
			t.Errorf("expected %s to be valid", s)
		}
	}
	if IsApprovalStatus("executed") {
		t.Error("expected 'executed' to NOT be a valid status (it's a legacy stored status)")
	}
	if IsApprovalStatus("invalid") {
		t.Error("expected 'invalid' to not be valid")
	}
}

func TestIsRiskLevel(t *testing.T) {
	valid := []string{"low", "medium", "high", "critical"}
	for _, r := range valid {
		if !IsRiskLevel(r) {
			t.Errorf("expected %s to be valid", r)
		}
	}
	if IsRiskLevel("extreme") {
		t.Error("expected 'extreme' to not be valid")
	}
}

func TestStatusNormalization_LegacyExecuted(t *testing.T) {
	// Verify that the mapper normalizes "executed" to "completed" with legacyStatus
	// This is tested via the mapper, but the constants should be consistent
	if StatusCompleted != "completed" {
		t.Errorf("expected StatusCompleted='completed', got '%s'", StatusCompleted)
	}
}
