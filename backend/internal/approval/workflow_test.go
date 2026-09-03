package approval

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
)

// ── Fake CAS Store ──────────────────────────────────────────────────────────

// fakeApprovalStore is an in-memory CAS store for workflow tests.
// Thread-safe. Transitions succeed only when expectedStatus matches current status.
type fakeApprovalStore struct {
	mu         sync.Mutex
	approvals  map[string]*ApprovalDocument
	transition func(input TransitionInput) // optional hook for test assertions
}

func newFakeApprovalStore() *fakeApprovalStore {
	return &fakeApprovalStore{approvals: make(map[string]*ApprovalDocument)}
}

func (f *fakeApprovalStore) seedApproval(doc *ApprovalDocument) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.approvals[doc.ID] = doc
}

func (f *fakeApprovalStore) GetApproval(_ context.Context, id string) (*ApprovalDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	doc, ok := f.approvals[id]
	if !ok {
		return nil, nil
	}
	copy := *doc
	return &copy, nil
}

func (f *fakeApprovalStore) TransitionApproval(_ context.Context, input TransitionInput) (*TransitionResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.transition != nil {
		f.transition(input)
	}

	current, ok := f.approvals[input.ID]
	if !ok {
		return &TransitionResult{OK: false, Reason: "not_found"}, nil
	}
	if current.Status != input.ExpectedStatus {
		copy := *current
		return &TransitionResult{OK: false, Reason: "conflict", Approval: &copy}, nil
	}

	// Apply transition
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	current.Status = input.NextStatus
	current.UpdatedAt = now

	if input.EventType != "" {
		current.Events = append(current.Events, GovernanceEvent{
			ID:        fmt.Sprintf("evt-%d", len(current.Events)+1),
			Timestamp: now,
			Type:      input.EventType,
			Actor:     input.Actor,
			Message:   input.EventMessage,
		})
	}
	for k, v := range input.Patch {
		switch k {
		case "reviewer":
			if s, ok := v.(string); ok {
				current.Reviewer = s
			}
		case "reviewedAt":
			if s, ok := v.(string); ok {
				current.ReviewedAt = s
			}
		case "note":
			if s, ok := v.(string); ok {
				current.Note = s
			}
		case "decision":
			if d, ok := v.(map[string]interface{}); ok {
				current.Decision = &ApprovalDecision{
					Outcome:   d["outcome"].(string),
					DecidedAt: d["decidedAt"].(string),
				}
				if c, ok := d["comment"].(string); ok {
					current.Decision.Comment = c
				}
			}
		}
	}

	copy := *current
	return &TransitionResult{OK: true, Approval: &copy}, nil
}

// ── Fake Identity Reader ────────────────────────────────────────────────────

type fakeIdentityReader struct {
	identities map[string]*user.UserIdentity
}

func newFakeIdentityReader() *fakeIdentityReader {
	return &fakeIdentityReader{identities: make(map[string]*user.UserIdentity)}
}

func (f *fakeIdentityReader) seed(username string, identity *user.UserIdentity) {
	f.identities[username] = identity
}

func (f *fakeIdentityReader) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	id, ok := f.identities[username]
	if !ok {
		return nil, nil
	}
	copy := *id
	return &copy, nil
}

// ── Fake Strict Audit Writer ────────────────────────────────────────────────

type fakeAuditWriter struct {
	mu     sync.Mutex
	inputs []audit.WriteAuditInput
	err    error // if set, WriteStrict returns this
}

func newFakeAuditWriter() *fakeAuditWriter {
	return &fakeAuditWriter{}
}

func (f *fakeAuditWriter) WriteStrict(_ context.Context, input audit.WriteAuditInput) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inputs = append(f.inputs, input)
	return f.err
}

func (f *fakeAuditWriter) captured() []audit.WriteAuditInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := make([]audit.WriteAuditInput, len(f.inputs))
	copy(result, f.inputs)
	return result
}

// ── Helpers ─────────────────────────────────────────────────────────────────

func makePrincipal(username, role string) *auth.Principal {
	return &auth.Principal{
		Username:       username,
		NormalizedRole: role,
		SessionVersion: 1,
	}
}

func makeRequest(method, path string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.Header.Set("X-Request-Id", "req-test-123")
	return r
}

func seedUserIdentity(identities *fakeIdentityReader, username, role, status string, locked bool) {
	identities.seed(username, &user.UserIdentity{
		MongoID: "mongo-" + username,
		SafeUser: user.SafeUser{
			Username: username,
			Role:     role,
			Status:   status,
			Locked:   locked,
			Security: &user.UserSecurity{SessionVersion: 1},
		},
	})
}

func seedApproval(store *fakeApprovalStore, id, status, requester, action, riskLevel string) *ApprovalDocument {
	doc := &ApprovalDocument{
		ID:        id,
		ChangeID:  "CHG-TEST-00001",
		Title:     "Test Approval",
		Action:    action,
		Status:    ApprovalStatus(status),
		Requester: requester,
		RiskLevel: RiskLevel(riskLevel),
		RiskAssessment: RiskAssessment{
			Level:    RiskLevel(riskLevel),
			PolicyID: "approval-risk-v1",
		},
		TargetID:  "test:target",
		Summary:   "Test summary",
		Events:    []GovernanceEvent{},
		Payload:   map[string]interface{}{},
		CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		UpdatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	store.seedApproval(doc)
	return doc
}

func assertErrorCode(t *testing.T, err error, expectedCode string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %s, got nil", expectedCode)
	}
	awe, ok := err.(*ApprovalWorkflowError)
	if !ok {
		t.Fatalf("expected ApprovalWorkflowError, got %T: %v", err, err)
	}
	if awe.Code != expectedCode {
		t.Errorf("expected code=%s, got=%s", expectedCode, awe.Code)
	}
}

func assertStatus(t *testing.T, err error, expectedStatus int) {
	t.Helper()
	awe, ok := err.(*ApprovalWorkflowError)
	if !ok {
		t.Fatalf("expected ApprovalWorkflowError, got %T: %v", err, err)
	}
	if awe.Status != expectedStatus {
		t.Errorf("expected status=%d, got=%d", expectedStatus, awe.Status)
	}
}

// ── Approve Tests ───────────────────────────────────────────────────────────

func TestApprove_PendingMedium_SameReviewer(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "a1", "pending", "alice", "RATING_CREATE", "medium")
	seedUserIdentity(identities, "alice", "ops_admin", "active", false)

	approval, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/a1/approve"), "a1", makePrincipal("alice", "ops_admin"), "looks good")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != StatusApproved {
		t.Errorf("expected status=approved, got=%s", approval.Status)
	}
	if approval.Decision == nil || approval.Decision.Outcome != "approved" {
		t.Error("expected decision.outcome=approved")
	}

	inputs := writer.captured()
	if len(inputs) != 1 {
		t.Fatalf("expected 1 audit input, got %d", len(inputs))
	}
	if inputs[0].Action != "approval.approve" {
		t.Errorf("expected audit action=approval.approve, got=%s", inputs[0].Action)
	}
}

func TestApprove_PendingHigh_SelfReview_Blocked(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "a2", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "alice", "ops_admin", "active", false)

	_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/a2/approve"), "a2", makePrincipal("alice", "ops_admin"), "")
	assertErrorCode(t, err, "MAKER_CHECKER_VIOLATION")
	assertStatus(t, err, http.StatusForbidden)

	// No audit should be written
	if len(writer.captured()) != 0 {
		t.Error("expected no audit writes for maker-checker violation")
	}
}

func TestApprove_PendingHigh_IndependentReviewer_Success(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "a3", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	approval, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/a3/approve"), "a3", makePrincipal("bob", "ops_admin"), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != StatusApproved {
		t.Errorf("expected status=approved, got=%s", approval.Status)
	}
}

func TestApprove_NonPending_Conflict(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "a4", "approved", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/a4/approve"), "a4", makePrincipal("bob", "ops_admin"), "")
	assertErrorCode(t, err, "APPROVAL_STATE_CONFLICT")
	assertStatus(t, err, http.StatusConflict)
}

func TestApprove_NotFound(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/nonexistent/approve"), "nonexistent", makePrincipal("bob", "ops_admin"), "")
	assertErrorCode(t, err, "APPROVAL_NOT_FOUND")
	assertStatus(t, err, http.StatusNotFound)
}

// ── Reject Tests ────────────────────────────────────────────────────────────

func TestReject_ReasonMissing(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "r1", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	_, err := wf.RejectChange(makeRequest("POST", "/api/approvals/r1/reject"), "r1", makePrincipal("bob", "ops_admin"), "")
	assertErrorCode(t, err, "REJECTION_REASON_REQUIRED")
	assertStatus(t, err, http.StatusBadRequest)
}

func TestReject_ReasonTooShort(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "r2", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	_, err := wf.RejectChange(makeRequest("POST", "/api/approvals/r2/reject"), "r2", makePrincipal("bob", "ops_admin"), "ab")
	assertErrorCode(t, err, "REJECTION_REASON_REQUIRED")
	assertStatus(t, err, http.StatusBadRequest)
}

func TestReject_ReasonTooLong(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "r3", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	longReason := make([]byte, 1001)
	for i := range longReason {
		longReason[i] = 'x'
	}

	_, err := wf.RejectChange(makeRequest("POST", "/api/approvals/r3/reject"), "r3", makePrincipal("bob", "ops_admin"), string(longReason))
	assertErrorCode(t, err, "APPROVAL_TEXT_TOO_LONG")
	assertStatus(t, err, http.StatusBadRequest)
}

func TestReject_HighRisk_SelfReview_Blocked(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "r4", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "alice", "ops_admin", "active", false)

	_, err := wf.RejectChange(makeRequest("POST", "/api/approvals/r4/reject"), "r4", makePrincipal("alice", "ops_admin"), "not needed")
	assertErrorCode(t, err, "MAKER_CHECKER_VIOLATION")
	assertStatus(t, err, http.StatusForbidden)
}

func TestReject_IndependentReviewer_Success(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "r5", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	approval, err := wf.RejectChange(makeRequest("POST", "/api/approvals/r5/reject"), "r5", makePrincipal("bob", "ops_admin"), "not justified")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != StatusRejected {
		t.Errorf("expected status=rejected, got=%s", approval.Status)
	}

	inputs := writer.captured()
	if len(inputs) != 1 || inputs[0].Action != "approval.reject" {
		t.Error("expected audit action=approval.reject")
	}
}

// ── Cancel Tests ────────────────────────────────────────────────────────────

func TestCancel_PendingRequester_Success(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "c1", "pending", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "alice", "operator", "active", false)

	approval, err := wf.CancelChange(makeRequest("POST", "/api/approvals/c1/cancel"), "c1", makePrincipal("alice", "operator"), "changed my mind")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if approval.Status != StatusCancelled {
		t.Errorf("expected status=cancelled, got=%s", approval.Status)
	}

	inputs := writer.captured()
	if len(inputs) != 1 || inputs[0].Action != "approval.cancel" {
		t.Error("expected audit action=approval.cancel")
	}
}

func TestCancel_PendingDifferentActor_Forbidden(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "c2", "pending", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "bob", "operator", "active", false)

	_, err := wf.CancelChange(makeRequest("POST", "/api/approvals/c2/cancel"), "c2", makePrincipal("bob", "operator"), "")
	assertErrorCode(t, err, "APPROVAL_CANCEL_FORBIDDEN")
	assertStatus(t, err, http.StatusForbidden)
}

func TestCancel_NonPending_Conflict(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "c3", "approved", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "alice", "operator", "active", false)

	_, err := wf.CancelChange(makeRequest("POST", "/api/approvals/c3/cancel"), "c3", makePrincipal("alice", "operator"), "")
	assertErrorCode(t, err, "APPROVAL_STATE_CONFLICT")
	assertStatus(t, err, http.StatusConflict)
}

// ── Expiry Test ─────────────────────────────────────────────────────────────

func TestExpiry_PendingExpired_TransitionsToExpired(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	// Seed an approval that expired 1 hour ago
	doc := seedApproval(store, "e1", "pending", "alice", "ACCESS_REQUEST", "medium")
	doc.ExpiresAt = time.Now().UTC().Add(-1 * time.Hour).Format("2006-01-02T15:04:05.000Z")
	seedUserIdentity(identities, "bob", "operator", "active", false)

	_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/e1/approve"), "e1", makePrincipal("bob", "operator"), "")
	assertErrorCode(t, err, "APPROVAL_EXPIRED")
	assertStatus(t, err, http.StatusConflict)

	awe := err.(*ApprovalWorkflowError)
	if awe.Approval == nil {
		t.Fatal("expected approval in error response")
	}
	if awe.Approval.Status != StatusExpired {
		t.Errorf("expected expired status, got=%s", awe.Approval.Status)
	}

	// Verify exactly one expired event
	events := awe.Approval.Events
	expiredCount := 0
	for _, ev := range events {
		if ev.Type == "expired" {
			expiredCount++
		}
	}
	if expiredCount != 1 {
		t.Errorf("expected exactly 1 expired event, got %d", expiredCount)
	}

	// Verify no approve/reject/cancel event
	for _, ev := range events {
		if ev.Type == "approved" || ev.Type == "rejected" || ev.Type == "cancelled" {
			t.Errorf("unexpected event type=%s on expired approval", ev.Type)
		}
	}
}

// ── CAS Concurrency Tests ──────────────────────────────────────────────────

func TestCAS_ApproveApprove_OnlyOneWins(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "cas1", "pending", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)
	seedUserIdentity(identities, "charlie", "ops_admin", "active", false)

	var wg sync.WaitGroup
	results := make(chan error, 2)

	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/cas1/approve"), "cas1", makePrincipal("bob", "ops_admin"), "approved by bob")
		results <- err
	}()
	go func() {
		defer wg.Done()
		_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/cas1/approve"), "cas1", makePrincipal("charlie", "ops_admin"), "approved by charlie")
		results <- err
	}()
	wg.Wait()
	close(results)

	winners := 0
	losers := 0
	for err := range results {
		if err == nil {
			winners++
		} else {
			awe, ok := err.(*ApprovalWorkflowError)
			if !ok {
				t.Fatalf("expected ApprovalWorkflowError, got %T", err)
			}
			if awe.Code != "APPROVAL_STATE_CONFLICT" {
				t.Errorf("expected APPROVAL_STATE_CONFLICT, got %s", awe.Code)
			}
			losers++
		}
	}
	if winners != 1 {
		t.Errorf("expected exactly 1 winner, got %d", winners)
	}
	if losers != 1 {
		t.Errorf("expected exactly 1 loser, got %d", losers)
	}

	// Exactly one transition audit
	inputs := writer.captured()
	auditCount := 0
	for _, inp := range inputs {
		if inp.Action == "approval.approve" {
			auditCount++
		}
	}
	if auditCount != 1 {
		t.Errorf("expected exactly 1 approve audit, got %d", auditCount)
	}
}

func TestCAS_ApproveReject_OnlyOneWins(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "cas2", "pending", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)
	seedUserIdentity(identities, "charlie", "ops_admin", "active", false)

	var wg sync.WaitGroup
	results := make(chan error, 2)

	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/cas2/approve"), "cas2", makePrincipal("bob", "ops_admin"), "")
		results <- err
	}()
	go func() {
		defer wg.Done()
		_, err := wf.RejectChange(makeRequest("POST", "/api/approvals/cas2/reject"), "cas2", makePrincipal("charlie", "ops_admin"), "not justified reason")
		results <- err
	}()
	wg.Wait()
	close(results)

	winners := 0
	for err := range results {
		if err == nil {
			winners++
		}
	}
	if winners != 1 {
		t.Errorf("expected exactly 1 winner, got %d", winners)
	}
}

func TestCAS_ApproveCancel_OnlyOneWins(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "cas3", "pending", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "alice", "operator", "active", false)
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	var wg sync.WaitGroup
	results := make(chan error, 2)

	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/cas3/approve"), "cas3", makePrincipal("bob", "ops_admin"), "")
		results <- err
	}()
	go func() {
		defer wg.Done()
		_, err := wf.CancelChange(makeRequest("POST", "/api/approvals/cas3/cancel"), "cas3", makePrincipal("alice", "operator"), "changed my mind")
		results <- err
	}()
	wg.Wait()
	close(results)

	winners := 0
	for err := range results {
		if err == nil {
			winners++
		}
	}
	if winners != 1 {
		t.Errorf("expected exactly 1 winner, got %d", winners)
	}
}

// ── Strict Audit Tests ─────────────────────────────────────────────────────

func TestStrictAudit_Success_CapturesAllFields(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "sa1", "pending", "alice", "ACCESS_REQUEST", "high")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	_, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/sa1/approve"), "sa1", makePrincipal("bob", "ops_admin"), "approved reason")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	inputs := writer.captured()
	if len(inputs) != 1 {
		t.Fatalf("expected 1 audit input, got %d", len(inputs))
	}
	inp := inputs[0]
	if inp.Action != "approval.approve" {
		t.Errorf("expected action=approval.approve, got=%s", inp.Action)
	}
	if inp.Module != "approvals" {
		t.Errorf("expected module=approvals, got=%s", inp.Module)
	}
	if inp.ApprovalID != "sa1" {
		t.Errorf("expected approvalId=sa1, got=%s", inp.ApprovalID)
	}
	if inp.RiskLevel != "high" {
		t.Errorf("expected riskLevel=high, got=%s", inp.RiskLevel)
	}
	if inp.Resource == nil || inp.Resource.ID != "sa1" {
		t.Error("expected resource.id=sa1")
	}
	if inp.TargetID != "approval:sa1" {
		t.Errorf("expected targetId=approval:sa1, got=%s", inp.TargetID)
	}
	if inp.Before == nil {
		t.Error("expected before context")
	} else if beforeMap, ok := inp.Before.(map[string]interface{}); ok {
		if beforeMap["status"] != "pending" {
			t.Errorf("expected before.status=pending, got=%v", beforeMap["status"])
		}
	}
	if inp.After == nil {
		t.Error("expected after context")
	} else if afterMap, ok := inp.After.(map[string]interface{}); ok {
		if afterMap["status"] != "approved" {
			t.Errorf("expected after.status=approved, got=%v", afterMap["status"])
		}
	}
	if inp.Request == nil {
		t.Error("expected request context")
	}
	if inp.Source == nil {
		t.Error("expected source context")
	}
}

func TestStrictAudit_Failure_CommittedTrue(t *testing.T) {
	store := newFakeApprovalStore()
	identities := newFakeIdentityReader()
	writer := newFakeAuditWriter()
	writer.err = errors.New("mongo write failed")
	wf := NewWorkflowWithDeps(store, identities, writer)

	seedApproval(store, "sa2", "pending", "alice", "ACCESS_REQUEST", "medium")
	seedUserIdentity(identities, "bob", "ops_admin", "active", false)

	approval, err := wf.ApproveChange(makeRequest("POST", "/api/approvals/sa2/approve"), "sa2", makePrincipal("bob", "ops_admin"), "")
	if err == nil {
		t.Fatal("expected error from audit failure")
	}

	awe, ok := err.(*ApprovalWorkflowError)
	if !ok {
		t.Fatalf("expected ApprovalWorkflowError, got %T", err)
	}
	if awe.Code != "AUDIT_UNAVAILABLE" {
		t.Errorf("expected code=AUDIT_UNAVAILABLE, got=%s", awe.Code)
	}
	if awe.Status != 503 {
		t.Errorf("expected status=503, got=%d", awe.Status)
	}
	if !awe.Committed {
		t.Error("expected committed=true")
	}
	if awe.Approval == nil {
		t.Fatal("expected approval in error (committed after-state)")
	}
	if awe.Approval.Status != StatusApproved {
		t.Errorf("expected committed approval status=approved, got=%s", awe.Approval.Status)
	}
	if approval != nil && approval.Status != StatusApproved {
		t.Errorf("expected returned approval status=approved, got=%s", approval.Status)
	}
}

// ── Error Response Tests ────────────────────────────────────────────────────

func TestWorkflowErrorResponse_ApprovalWorkflowError(t *testing.T) {
	err := &ApprovalWorkflowError{Code: "TEST_CODE", Status: 418}
	status, body := WorkflowErrorResponse(err)
	if status != 418 {
		t.Errorf("expected status=418, got=%d", status)
	}
	if body["code"] != "TEST_CODE" {
		t.Errorf("expected code=TEST_CODE, got=%v", body["code"])
	}
}

func TestWorkflowErrorResponse_GenericError(t *testing.T) {
	err := errors.New("something broke")
	status, body := WorkflowErrorResponse(err)
	if status != 500 {
		t.Errorf("expected status=500, got=%d", status)
	}
	if body["code"] != "APPROVAL_OPERATION_FAILED" {
		t.Errorf("expected code=APPROVAL_OPERATION_FAILED, got=%v", body["code"])
	}
}

func TestWorkflowErrorResponse_AccountError(t *testing.T) {
	err := errors.New("ACCOUNT_LOCKED")
	status, body := WorkflowErrorResponse(err)
	if status != 401 {
		t.Errorf("expected status=401, got=%d", status)
	}
	if body["code"] != "ACCOUNT_LOCKED" {
		t.Errorf("expected code=ACCOUNT_LOCKED, got=%v", body["code"])
	}
}
