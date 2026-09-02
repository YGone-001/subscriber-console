package approval

import (
	"testing"
)

func TestAssessApprovalRisk_KnownActions(t *testing.T) {
	// Verify every source-supported action has the correct risk level and policyId
	tests := []struct {
		action string
		level  RiskLevel
	}{
		{"ACCESS_REQUEST", RiskHigh},
		{"POLICY_CHANGE", RiskHigh},
		{"TRAFFIC_ADJUSTMENT", RiskHigh},
		{"TARIFF_PLAN_CREATE", RiskHigh},
		{"TARIFF_PLAN_UPDATE", RiskHigh},
		{"TARIFF_PLAN_DELETE", RiskCritical},
		{"TARIFF_PLAN_RULE_CREATE", RiskHigh},
		{"TARIFF_PLAN_RULE_UPDATE", RiskHigh},
		{"TARIFF_PLAN_RULE_DELETE", RiskCritical},
		{"TARIFF_PLAN_RULE_TOGGLE", RiskHigh},
		{"RATING_CREATE", RiskMedium},
		{"RATING_UPDATE", RiskHigh},
		{"RATING_DELETE", RiskCritical},
		{"TARIFF_PLAN_MIGRATE", RiskCritical},
		{"PROFILE_RESTORE", RiskHigh},
		{"SYSTEM_HEAL", RiskHigh},
		{"SUBSCRIBER_BATCH_CREATE", RiskHigh},
		{"SUBSCRIBER_BATCH_UPDATE", RiskHigh},
		{"SUBSCRIBER_CREATE", RiskMedium},
		{"SUBSCRIBER_UPDATE", RiskHigh},
		{"SUBSCRIBER_DELETE", RiskHigh},
		{"SUBSCRIBER_IMPORT", RiskHigh},
		{"SUBSCRIBER_IMPORT_OVERWRITE", RiskCritical},
		{"SUBSCRIBER_BULK_DELETE", RiskCritical},
		{"SUBSCRIBER_PROFILE_APPLY", RiskHigh},
	}

	for _, tt := range tests {
		t.Run(tt.action, func(t *testing.T) {
			ra := AssessApprovalRisk(tt.action)
			if ra.Level != tt.level {
				t.Errorf("action %s: expected level=%s, got %s", tt.action, tt.level, ra.Level)
			}
			if ra.PolicyID != ApprovalRiskPolicyID {
				t.Errorf("action %s: expected policyId=%s, got %s", tt.action, ApprovalRiskPolicyID, ra.PolicyID)
			}
			if len(ra.Reasons) == 0 {
				t.Errorf("action %s: expected non-empty reasons", tt.action)
			}
		})
	}
}

func TestAssessApprovalRisk_UnknownAction(t *testing.T) {
	ra := AssessApprovalRisk("UNKNOWN_ACTION")
	if ra.Level != RiskHigh {
		t.Errorf("expected high risk for unknown action, got %s", ra.Level)
	}
	if ra.PolicyID != ApprovalRiskPolicyID {
		t.Errorf("expected policyId=%s, got %s", ApprovalRiskPolicyID, ra.PolicyID)
	}
	if len(ra.Reasons) == 0 {
		t.Error("expected non-empty reasons for unknown action")
	}
}

func TestRequiresIndependentReviewer(t *testing.T) {
	tests := []struct {
		risk     RiskLevel
		expected bool
	}{
		{RiskLow, false},
		{RiskMedium, false},
		{RiskHigh, true},
		{RiskCritical, true},
	}

	for _, tt := range tests {
		t.Run(string(tt.risk), func(t *testing.T) {
			if got := RequiresIndependentReviewer(tt.risk); got != tt.expected {
				t.Errorf("RequiresIndependentReviewer(%s) = %v, want %v", tt.risk, got, tt.expected)
			}
		})
	}
}

func TestIsSupportedApprovalAction(t *testing.T) {
	if !IsSupportedApprovalAction("SUBSCRIBER_CREATE") {
		t.Error("expected SUBSCRIBER_CREATE to be supported")
	}
	if IsSupportedApprovalAction("FAKE_ACTION") {
		t.Error("expected FAKE_ACTION to not be supported")
	}
}

func TestSupportedApprovalActions_Count(t *testing.T) {
	actions := SupportedApprovalActions()
	// Verify we have all expected actions from the source risk catalog
	expected := 25
	if len(actions) != expected {
		t.Errorf("expected %d supported actions, got %d", expected, len(actions))
	}
}

func TestSupportedApprovalActions_DriftGuard(t *testing.T) {
	// Verify every action in the catalog is present
	expectedActions := map[string]bool{
		"ACCESS_REQUEST":              false,
		"POLICY_CHANGE":               false,
		"TRAFFIC_ADJUSTMENT":          false,
		"TARIFF_PLAN_CREATE":          false,
		"TARIFF_PLAN_UPDATE":          false,
		"TARIFF_PLAN_DELETE":          false,
		"TARIFF_PLAN_RULE_CREATE":     false,
		"TARIFF_PLAN_RULE_UPDATE":     false,
		"TARIFF_PLAN_RULE_DELETE":     false,
		"TARIFF_PLAN_RULE_TOGGLE":     false,
		"RATING_CREATE":               false,
		"RATING_UPDATE":               false,
		"RATING_DELETE":               false,
		"TARIFF_PLAN_MIGRATE":         false,
		"PROFILE_RESTORE":             false,
		"SYSTEM_HEAL":                 false,
		"SUBSCRIBER_BATCH_CREATE":     false,
		"SUBSCRIBER_BATCH_UPDATE":     false,
		"SUBSCRIBER_CREATE":           false,
		"SUBSCRIBER_UPDATE":           false,
		"SUBSCRIBER_DELETE":           false,
		"SUBSCRIBER_IMPORT":           false,
		"SUBSCRIBER_IMPORT_OVERWRITE": false,
		"SUBSCRIBER_BULK_DELETE":      false,
		"SUBSCRIBER_PROFILE_APPLY":    false,
	}

	actions := SupportedApprovalActions()
	for _, a := range actions {
		if _, ok := expectedActions[a]; !ok {
			t.Errorf("unexpected action in catalog: %s", a)
		}
		expectedActions[a] = true
	}

	for a, found := range expectedActions {
		if !found {
			t.Errorf("missing action in catalog: %s", a)
		}
	}
}
