package approval

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
)

// ── Fake stores for creator tests ──────────────────────────────────────────

type fakeCreateStore struct {
	called    int
	lastInput CreateApprovalInput
	result    *ApprovalDocument
	err       error
}

func (f *fakeCreateStore) CreateApprovalRequest(_ context.Context, input CreateApprovalInput) (*ApprovalDocument, error) {
	f.called++
	f.lastInput = input
	return f.result, f.err
}

type fakeCreatorAuditWriter struct {
	called    int
	lastInput audit.WriteAuditInput
	err       error
}

func (f *fakeCreatorAuditWriter) WriteStrict(_ context.Context, input audit.WriteAuditInput) error {
	f.called++
	f.lastInput = input
	return f.err
}

func sampleApproval() *ApprovalDocument {
	return &ApprovalDocument{
		ID:                   "test-id-1",
		ChangeID:             "CHG-20260101-00001",
		Title:                "Test Approval",
		Action:               "SUBSCRIBER_UPDATE",
		Status:               StatusPending,
		Operation:            ApprovalOperation{ResourceType: "subscriber", ResourceID: "test"},
		OperationFingerprint: "abc123",
		RiskLevel:            RiskHigh,
		RiskAssessment:       RiskAssessment{Level: RiskHigh, Reasons: []string{"test"}, PolicyID: ApprovalRiskPolicyID},
		Requester:            "testuser",
		RequesterContext:     &GovernanceActor{Type: "user", Username: "testuser", Role: "operator"},
		TargetID:             "test",
		Summary:              "Test",
		Reason:               "test reason",
		Payload:              map[string]interface{}{"key": "val"},
		Events:               []GovernanceEvent{{ID: "evt1", Timestamp: "2026-01-01T00:00:00.000Z", Type: "created", Actor: "testuser", Message: "created"}},
		CreatedAt:            "2026-01-01T00:00:00.000Z",
		UpdatedAt:            "2026-01-01T00:00:00.000Z",
	}
}

func TestCreator_CallsStoreOnce(t *testing.T) {
	approval := sampleApproval()
	store := &fakeCreateStore{result: approval}
	writer := &fakeCreatorAuditWriter{}
	creator := NewApprovalCreatorWithDeps(store, writer)

	actor := GovernanceActor{Type: "user", UserID: "uid1", Username: "testuser", Role: "operator"}
	reason := "test reason"
	input := CreateApprovalInput{
		Action:    "ACCESS_REQUEST",
		Requester: "testuser",
		TargetID:  "testuser",
		Summary:   "Request access",
		Reason:    &reason,
		Payload:   map[string]interface{}{"reason": "test reason"},
	}

	req := httptest.NewRequest("POST", "/api/approvals", nil)
	result, err := creator.Create(req, actor, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store.called != 1 {
		t.Errorf("expected store called once, got %d", store.called)
	}
	if result.ID != approval.ID {
		t.Errorf("expected approval ID %s, got %s", approval.ID, result.ID)
	}
}

func TestCreator_FullApprovalAfterAudit(t *testing.T) {
	approval := sampleApproval()
	store := &fakeCreateStore{result: approval}
	writer := &fakeCreatorAuditWriter{}
	creator := NewApprovalCreatorWithDeps(store, writer)

	actor := GovernanceActor{Type: "user", UserID: "uid1", Username: "testuser", Role: "operator"}
	reason := "test reason"
	input := CreateApprovalInput{
		Action:    "ACCESS_REQUEST",
		Requester: "testuser",
		TargetID:  "testuser",
		Summary:   "Request access",
		Reason:    &reason,
		Payload:   map[string]interface{}{"reason": "test reason"},
	}

	req := httptest.NewRequest("POST", "/api/approvals", nil)
	_, err := creator.Create(req, actor, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if writer.called != 1 {
		t.Fatalf("expected writer called once, got %d", writer.called)
	}
	// Verify audit After contains full approval snapshot, not just status
	after, ok := writer.lastInput.After.(map[string]interface{})
	if !ok {
		t.Fatalf("expected After to be map, got %T", writer.lastInput.After)
	}
	if after["id"] != approval.ID {
		t.Errorf("expected after.id = %s, got %v", approval.ID, after["id"])
	}
	if after["changeId"] != approval.ChangeID {
		t.Errorf("expected after.changeId = %s, got %v", approval.ChangeID, after["changeId"])
	}
	if after["action"] != approval.Action {
		t.Errorf("expected after.action = %s, got %v", approval.Action, after["action"])
	}
	if after["status"] != string(approval.Status) {
		t.Errorf("expected after.status = %s, got %v", approval.Status, after["status"])
	}
	// Verify actor uses fresh GovernanceActor, not Principal
	if writer.lastInput.Actor.Username != "testuser" {
		t.Errorf("expected actor username testuser, got %s", writer.lastInput.Actor.Username)
	}
	if writer.lastInput.Actor.UserID != "uid1" {
		t.Errorf("expected actor userId uid1, got %s", writer.lastInput.Actor.UserID)
	}
}

func TestCreator_AuditFailure_ReturnsCommitted(t *testing.T) {
	approval := sampleApproval()
	store := &fakeCreateStore{result: approval}
	writer := &fakeCreatorAuditWriter{err: errors.New("audit unavailable")}
	creator := NewApprovalCreatorWithDeps(store, writer)

	actor := GovernanceActor{Type: "user", UserID: "uid1", Username: "testuser", Role: "operator"}
	reason := "test reason"
	input := CreateApprovalInput{
		Action:    "ACCESS_REQUEST",
		Requester: "testuser",
		TargetID:  "testuser",
		Summary:   "Request access",
		Reason:    &reason,
		Payload:   map[string]interface{}{"reason": "test reason"},
	}

	req := httptest.NewRequest("POST", "/api/approvals", nil)
	result, err := creator.Create(req, actor, input)
	if err == nil {
		t.Fatal("expected error on audit failure")
	}
	awe, ok := err.(*ApprovalWorkflowError)
	if !ok {
		t.Fatalf("expected ApprovalWorkflowError, got %T", err)
	}
	if awe.Code != "AUDIT_UNAVAILABLE" {
		t.Errorf("expected AUDIT_UNAVAILABLE, got %s", awe.Code)
	}
	if !awe.Committed {
		t.Error("expected committed=true")
	}
	if awe.Status != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", awe.Status)
	}
	if result == nil {
		t.Error("expected approval to be returned even on audit failure")
	}
}

func TestCreator_ActorFromFreshGovernanceActor(t *testing.T) {
	approval := sampleApproval()
	store := &fakeCreateStore{result: approval}
	writer := &fakeCreatorAuditWriter{}
	creator := NewApprovalCreatorWithDeps(store, writer)

	// Actor with fresh data — should be used for audit, not Principal
	actor := GovernanceActor{Type: "user", UserID: "fresh-mongo-id", Username: "freshuser", Role: "ops_admin"}
	reason := "test reason"
	input := CreateApprovalInput{
		Action:    "ACCESS_REQUEST",
		Requester: "freshuser",
		TargetID:  "freshuser",
		Summary:   "Request access",
		Reason:    &reason,
		Payload:   map[string]interface{}{"reason": "test reason"},
	}

	req := httptest.NewRequest("POST", "/api/approvals", nil)
	_, err := creator.Create(req, actor, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if writer.lastInput.Actor.UserID != "fresh-mongo-id" {
		t.Errorf("expected actor userId fresh-mongo-id, got %s", writer.lastInput.Actor.UserID)
	}
	if writer.lastInput.Actor.Username != "freshuser" {
		t.Errorf("expected actor username freshuser, got %s", writer.lastInput.Actor.Username)
	}
	if writer.lastInput.Actor.Role != "ops_admin" {
		t.Errorf("expected actor role ops_admin, got %s", writer.lastInput.Actor.Role)
	}
}

func TestCreator_ExplicitEmptyReason_NoFallback(t *testing.T) {
	approval := sampleApproval()
	approval.Reason = ""
	store := &fakeCreateStore{result: approval}
	writer := &fakeCreatorAuditWriter{}
	creator := NewApprovalCreatorWithDeps(store, writer)

	actor := GovernanceActor{Type: "user", UserID: "uid1", Username: "testuser", Role: "operator"}
	// Explicitly empty reason — should NOT fallback to payload.reason
	emptyReason := ""
	input := CreateApprovalInput{
		Action:    "ACCESS_REQUEST",
		Requester: "testuser",
		TargetID:  "testuser",
		Summary:   "Request access",
		Reason:    &emptyReason,
		Payload:   map[string]interface{}{"reason": "payload reason fallback"},
	}

	req := httptest.NewRequest("POST", "/api/approvals", nil)
	_, err := creator.Create(req, actor, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Verify the input passed to store has nil-empty reason (no fallback)
	if store.lastInput.Reason == nil {
		t.Error("expected Reason to be set (not nil)")
	} else if *store.lastInput.Reason != "" {
		t.Errorf("expected empty reason, got %q", *store.lastInput.Reason)
	}
}

func TestCreator_AbsentReason_DoesFallback(t *testing.T) {
	approval := sampleApproval()
	store := &fakeCreateStore{result: approval}
	writer := &fakeCreatorAuditWriter{}
	creator := NewApprovalCreatorWithDeps(store, writer)

	actor := GovernanceActor{Type: "user", UserID: "uid1", Username: "testuser", Role: "operator"}
	// Absent reason (nil) — should fallback to payload.reason
	input := CreateApprovalInput{
		Action:    "ACCESS_REQUEST",
		Requester: "testuser",
		TargetID:  "testuser",
		Summary:   "Request access",
		Reason:    nil,
		Payload:   map[string]interface{}{"reason": "payload reason fallback"},
	}

	req := httptest.NewRequest("POST", "/api/approvals", nil)
	_, err := creator.Create(req, actor, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The store receives the original input — reason resolution happens in repository
	// Verify the input.Reason is nil (store handles fallback)
	if store.lastInput.Reason != nil {
		t.Errorf("expected nil reason passed to store, got %v", *store.lastInput.Reason)
	}
}
