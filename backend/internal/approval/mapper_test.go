package approval

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestNormalizeApproval_Basic(t *testing.T) {
	doc := bson.M{
		"id":        "test-id-1",
		"changeId":  "CHG-20260902-00001",
		"title":     "Test Approval",
		"action":    "SUBSCRIBER_CREATE",
		"status":    "pending",
		"targetId":  "subscriber:imsi-123",
		"summary":   "Create subscriber",
		"requester": "alice",
		"riskLevel": "medium",
		"riskAssessment": bson.M{
			"level":    "medium",
			"reasons":  bson.A{"Creates a new subscriber record"},
			"policyId": "approval-risk-v1",
		},
		"operation": bson.M{
			"resourceType": "subscriber",
			"resourceId":   "imsi-123",
		},
		"events":    bson.A{},
		"payload":   bson.M{"key": "value"},
		"createdAt": "2026-09-02T00:00:00Z",
		"updatedAt": "2026-09-02T00:00:00Z",
	}

	approval := normalizeApproval(doc)
	if approval == nil {
		t.Fatal("expected non-nil approval")
	}

	if approval.ID != "test-id-1" {
		t.Errorf("expected id=test-id-1, got %s", approval.ID)
	}
	if approval.ChangeID != "CHG-20260902-00001" {
		t.Errorf("expected changeId=CHG-20260902-00001, got %s", approval.ChangeID)
	}
	if approval.Title != "Test Approval" {
		t.Errorf("expected title='Test Approval', got %s", approval.Title)
	}
	if approval.Status != StatusPending {
		t.Errorf("expected status=pending, got %s", approval.Status)
	}
	if approval.RiskLevel != RiskMedium {
		t.Errorf("expected riskLevel=medium, got %s", approval.RiskLevel)
	}
	if approval.Events == nil {
		t.Error("expected events to be non-nil (empty array)")
	}
	if len(approval.Events) != 0 {
		t.Errorf("expected 0 events, got %d", len(approval.Events))
	}
}

func TestNormalizeApproval_LegacyExecuted(t *testing.T) {
	doc := bson.M{
		"id":        "test-id-2",
		"action":    "SUBSCRIBER_UPDATE",
		"status":    "executed",
		"targetId":  "subscriber:imsi-456",
		"summary":   "Update subscriber",
		"requester": "bob",
		"payload":   bson.M{},
		"events":    bson.A{},
		"createdAt": "2026-09-01T00:00:00Z",
		"updatedAt": "2026-09-01T00:00:00Z",
	}

	approval := normalizeApproval(doc)
	if approval == nil {
		t.Fatal("expected non-nil approval")
	}

	if approval.Status != StatusCompleted {
		t.Errorf("expected status=completed (normalized from executed), got %s", approval.Status)
	}
	if approval.LegacyStatus != "executed" {
		t.Errorf("expected legacyStatus=executed, got %s", approval.LegacyStatus)
	}
}

func TestNormalizeApproval_MissingTitle_FallbackToSummary(t *testing.T) {
	doc := bson.M{
		"id":       "test-id-3",
		"action":   "RATING_CREATE",
		"status":   "pending",
		"targetId": "rating:rate-1",
		"summary":  "Create rating",
		"payload":  bson.M{},
		"events":   bson.A{},
	}

	approval := normalizeApproval(doc)
	if approval == nil {
		t.Fatal("expected non-nil approval")
	}

	if approval.Title != "Create rating" {
		t.Errorf("expected title to fallback to summary='Create rating', got %s", approval.Title)
	}
}

func TestNormalizeApproval_MissingOperation_DeriveFromTargetId(t *testing.T) {
	doc := bson.M{
		"id":       "test-id-4",
		"action":   "TARIFF_PLAN_CREATE",
		"status":   "pending",
		"targetId": "tariff:plan-abc",
		"summary":  "Create tariff plan",
		"payload":  bson.M{},
		"events":   bson.A{},
	}

	approval := normalizeApproval(doc)
	if approval == nil {
		t.Fatal("expected non-nil approval")
	}

	if approval.Operation.ResourceType != "tariff" {
		t.Errorf("expected resourceType=tariff, got %s", approval.Operation.ResourceType)
	}
	if approval.Operation.ResourceID != "tariff:plan-abc" {
		t.Errorf("expected resourceId=tariff:plan-abc, got %s", approval.Operation.ResourceID)
	}
}

func TestNormalizeApproval_MissingRiskAssessment_DeriveFromAction(t *testing.T) {
	doc := bson.M{
		"id":       "test-id-5",
		"action":   "TARIFF_PLAN_DELETE",
		"status":   "pending",
		"targetId": "tariff:plan-abc",
		"summary":  "Delete tariff plan",
		"payload":  bson.M{},
		"events":   bson.A{},
	}

	approval := normalizeApproval(doc)
	if approval == nil {
		t.Fatal("expected non-nil approval")
	}

	if approval.RiskLevel != RiskCritical {
		t.Errorf("expected riskLevel=critical (from catalog), got %s", approval.RiskLevel)
	}
	if approval.RiskAssessment.Level != RiskCritical {
		t.Errorf("expected riskAssessment.level=critical, got %s", approval.RiskAssessment.Level)
	}
	if approval.RiskAssessment.PolicyID != ApprovalRiskPolicyID {
		t.Errorf("expected policyId=%s, got %s", ApprovalRiskPolicyID, approval.RiskAssessment.PolicyID)
	}
}

func TestNormalizeApproval_MissingEvents_EmptyArray(t *testing.T) {
	doc := bson.M{
		"id":      "test-id-6",
		"action":  "SUBSCRIBER_CREATE",
		"status":  "pending",
		"payload": bson.M{},
	}

	approval := normalizeApproval(doc)
	if approval == nil {
		t.Fatal("expected non-nil approval")
	}

	if approval.Events == nil {
		t.Error("expected events to be [] not nil")
	}
	if len(approval.Events) != 0 {
		t.Errorf("expected 0 events, got %d", len(approval.Events))
	}
}

func TestNormalizeApproval_Nil(t *testing.T) {
	result := normalizeApproval(nil)
	if result != nil {
		t.Error("expected nil for nil input")
	}
}

func TestResourceTypeFromTarget(t *testing.T) {
	tests := []struct {
		target   string
		expected string
	}{
		{"subscriber:imsi-123", "subscriber"},
		{"tariff:plan-abc", "tariff"},
		{"no-colon", "approval-target"},
		{":leading-colon", "approval-target"},
		{"", "approval-target"},
	}

	for _, tt := range tests {
		t.Run(tt.target, func(t *testing.T) {
			got := resourceTypeFromTarget(tt.target)
			if got != tt.expected {
				t.Errorf("resourceTypeFromTarget(%q) = %q, want %q", tt.target, got, tt.expected)
			}
		})
	}
}
