package approval

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
)

// ── Mock Evidence Store ──────────────────────────────────────────────────────

type mockEvidenceStore struct {
	records []audit.AuditWriteRecord
}

func (m *mockEvidenceStore) Insert(ctx context.Context, record audit.AuditWriteRecord) error {
	m.records = append(m.records, record)
	return nil
}

func (m *mockEvidenceStore) FindByMongoID(ctx context.Context, id string) (*audit.AuditWriteRecord, error) {
	return nil, nil
}

// ── Fake User Lookup ────────────────────────────────────────────────────────

type fakeUserLookup struct {
	users      map[string]*user.SafeUser
	identities map[string]*user.UserIdentity
}

func newFakeUserLookup() *fakeUserLookup {
	return &fakeUserLookup{
		users:      make(map[string]*user.SafeUser),
		identities: make(map[string]*user.UserIdentity),
	}
}

func (f *fakeUserLookup) seedUser(username, role, status string) {
	f.users[username] = &user.SafeUser{
		Username: username,
		Role:     role,
		Status:   status,
		Security: &user.UserSecurity{SessionVersion: 1},
	}
	f.identities[username] = &user.UserIdentity{
		MongoID: "mongo-" + username,
		SafeUser: user.SafeUser{
			Username: username,
			Role:     role,
			Status:   status,
			Security: &user.UserSecurity{SessionVersion: 1},
		},
	}
}

func (f *fakeUserLookup) FindByUsername(_ context.Context, username string) (*user.SafeUser, error) {
	u, ok := f.users[username]
	if !ok {
		return nil, nil
	}
	copy := *u
	return &copy, nil
}

func (f *fakeUserLookup) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	id, ok := f.identities[username]
	if !ok {
		return nil, nil
	}
	copy := *id
	return &copy, nil
}

// ── Mock Rate Limiter ────────────────────────────────────────────────────────

type mockRateLimiter struct{}

func (m *mockRateLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	return true // always allow
}

// ── Test Helper ──────────────────────────────────────────────────────────────

// mockApprovalRepo is a minimal mock for the approval Repository.
type mockApprovalRepo struct {
	pending *ApprovalDocument
}

func (m *mockApprovalRepo) GetPendingAccessRequest(ctx context.Context, username string) (*ApprovalDocument, error) {
	return m.pending, nil
}

// newPermissionTestHandler creates a handler for ACCESS_REQUEST tests.
func newPermissionTestHandler(users *fakeUserLookup, evidenceStore *mockEvidenceStore) (*Handler, *audit.Writer) {
	writer := audit.NewWriter(evidenceStore, audit.WriterConfig{
		QueueSize:   64,
		WorkerCount: 1,
	})
	h := &Handler{
		repo:    &Repository{approvals: nil}, // minimal repo, won't be used for most tests
		writer:  writer,
		users:   users,
		limiter: &mockRateLimiter{},
	}
	return h, writer
}

// ── ACCESS_REQUEST Permission Tests ─────────────────────────────────────────

func TestAccessRequest_PermissionDenied(t *testing.T) {
	users := newFakeUserLookup()
	users.seedUser("auditor", "auditor", "active")
	evidenceStore := &mockEvidenceStore{}
	h, writer := newPermissionTestHandler(users, evidenceStore)

	// auditor lacks approvals.create permission
	body := map[string]any{"reason": "I need operator access"}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/approvals", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		UserID:         "aud-id",
		Username:       "auditor",
		Role:           "auditor",
		NormalizedRole: "auditor",
		SessionVersion: 1,
	}))
	w := httptest.NewRecorder()

	h.CreateAccessRequest(w, req)

	// operator lacks approvals.create → 403
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
	}

	// Verify response body matches Node contract
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["code"] != "PERMISSION_DENIED" {
		t.Errorf("expected code=PERMISSION_DENIED, got=%v", resp["code"])
	}
	if resp["permission"] != "approvals.create" {
		t.Errorf("expected permission=approvals.create, got=%v", resp["permission"])
	}

	// Verify authorization.denied audit evidence was recorded
	writer.Close(context.Background()) // flush workers
	if len(evidenceStore.records) == 0 {
		t.Fatal("expected at least 1 audit record for authorization.denied")
	}
	found := false
	for _, rec := range evidenceStore.records {
		if rec.Action == "authorization.denied" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected authorization.denied audit record")
	}
}

func TestAccessRequest_Unauthenticated(t *testing.T) {
	users := newFakeUserLookup()
	evidenceStore := &mockEvidenceStore{}
	h, writer := newPermissionTestHandler(users, evidenceStore)
	defer writer.Close(context.Background())

	body := map[string]any{"reason": "I need operator access for my work"}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/approvals", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	// No principal in context
	w := httptest.NewRecorder()

	h.CreateAccessRequest(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAccessRequest_InactiveUser(t *testing.T) {
	// Use operator role (has approvals.create) to reach account validation
	users := newFakeUserLookup()
	users.seedUser("alice", "operator", "disabled")
	evidenceStore := &mockEvidenceStore{}
	h, writer := newPermissionTestHandler(users, evidenceStore)
	defer writer.Close(context.Background())

	body := map[string]any{"reason": "I need operator access for my work"}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/approvals", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		UserID:         "mongo-alice",
		Username:       "alice",
		Role:           "operator",
		NormalizedRole: "operator",
		SessionVersion: 1,
	}))
	w := httptest.NewRecorder()

	h.CreateAccessRequest(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["code"] != "ACCOUNT_NOT_ELIGIBLE" {
		t.Errorf("expected ACCOUNT_NOT_ELIGIBLE, got=%v", resp["code"])
	}
}

func TestAccessRequest_NonViewer(t *testing.T) {
	// operator already has operator role → ACCESS_ALREADY_GRANTED
	users := newFakeUserLookup()
	users.seedUser("alice", "operator", "active")
	evidenceStore := &mockEvidenceStore{}
	h, writer := newPermissionTestHandler(users, evidenceStore)
	defer writer.Close(context.Background())

	body := map[string]any{"reason": "I need operator access for my work"}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/approvals", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		UserID:         "mongo-alice",
		Username:       "alice",
		Role:           "operator",
		NormalizedRole: "operator",
		SessionVersion: 1,
	}))
	w := httptest.NewRecorder()

	h.CreateAccessRequest(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["code"] != "ACCESS_ALREADY_GRANTED" {
		t.Errorf("expected ACCESS_ALREADY_GRANTED, got=%v", resp["code"])
	}
}

func TestAccessRequest_ReasonTooShort(t *testing.T) {
	// Use operator role (has approvals.create) to reach reason validation
	users := newFakeUserLookup()
	users.seedUser("alice", "operator", "active")
	evidenceStore := &mockEvidenceStore{}
	h, writer := newPermissionTestHandler(users, evidenceStore)
	defer writer.Close(context.Background())

	body := map[string]any{"reason": "short"}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/approvals", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		UserID:         "mongo-alice",
		Username:       "alice",
		Role:           "operator",
		NormalizedRole: "operator",
		SessionVersion: 1,
	}))
	w := httptest.NewRecorder()

	h.CreateAccessRequest(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["code"] != "ACCESS_REASON_REQUIRED" {
		t.Errorf("expected ACCESS_REASON_REQUIRED, got=%v", resp["code"])
	}
}

func TestAccessRequest_ReasonTruncation(t *testing.T) {
	// Use operator role (has approvals.create) to reach reason validation
	users := newFakeUserLookup()
	users.seedUser("alice", "operator", "active")
	evidenceStore := &mockEvidenceStore{}
	h, writer := newPermissionTestHandler(users, evidenceStore)
	defer writer.Close(context.Background())

	longReason := make([]byte, 1001)
	for i := range longReason {
		longReason[i] = 'x'
	}
	body := map[string]any{"reason": string(longReason)}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/approvals", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		UserID:         "mongo-alice",
		Username:       "alice",
		Role:           "operator",
		NormalizedRole: "operator",
		SessionVersion: 1,
	}))
	w := httptest.NewRecorder()

	h.CreateAccessRequest(w, req)

	// Should NOT be 400 — reason is truncated, not rejected
	if w.Code == http.StatusBadRequest {
		t.Errorf("reason truncation should not be 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAccessRequest_MissingUser(t *testing.T) {
	// Use operator role (has approvals.create) to reach user lookup
	users := newFakeUserLookup() // no users seeded
	evidenceStore := &mockEvidenceStore{}
	h, writer := newPermissionTestHandler(users, evidenceStore)
	defer writer.Close(context.Background())

	body := map[string]any{"reason": "I need operator access for my work"}
	data, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/approvals", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		UserID:         "mongo-ghost",
		Username:       "ghost",
		Role:           "operator",
		NormalizedRole: "operator",
		SessionVersion: 1,
	}))
	w := httptest.NewRecorder()

	h.CreateAccessRequest(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["code"] != "ACCOUNT_NOT_ELIGIBLE" {
		t.Errorf("expected ACCOUNT_NOT_ELIGIBLE, got=%v", resp["code"])
	}
}

// ── Error Response Contract Tests ───────────────────────────────────────────

func TestAccessRequest_ErrorResponses(t *testing.T) {
	tests := []struct {
		code        string
		status      int
		committed   bool
		hasApproval bool
	}{
		{"ACCESS_REASON_REQUIRED", 400, false, false},
		{"ACCOUNT_NOT_ELIGIBLE", 403, false, false},
		{"ACCESS_ALREADY_GRANTED", 409, false, false},
		{"ACCESS_REQUEST_PENDING", 409, false, true},
		{"AUDIT_UNAVAILABLE", 503, true, true},
		{"APPROVAL_CREATE_FAILED", 503, false, false},
	}

	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			err := &ApprovalWorkflowError{
				Code:      tt.code,
				Status:    tt.status,
				Committed: tt.committed,
			}
			if tt.hasApproval {
				err.Approval = &ApprovalDocument{ID: "test"}
			}

			resp := err.ErrorResponse()
			if resp["code"] != tt.code {
				t.Errorf("expected code=%s, got=%v", tt.code, resp["code"])
			}
			if resp["error"] != tt.code {
				t.Errorf("expected error=%s, got=%v", tt.code, resp["error"])
			}
			if tt.committed {
				if resp["committed"] != true {
					t.Error("expected committed=true")
				}
			}
			if tt.hasApproval {
				if resp["approval"] == nil {
					t.Error("expected approval in response")
				}
			}
		})
	}
}

// ── ACCESS_REQUEST Document Shape ───────────────────────────────────────────

func TestAccessRequest_DocumentShape(t *testing.T) {
	input := CreateApprovalInput{
		Action:    "ACCESS_REQUEST",
		Requester: "alice",
		RequesterContext: &GovernanceActor{
			Type:     "user",
			UserID:   "mongo-alice",
			Username: "alice",
			Role:     "viewer",
		},
		TargetID: "alice",
		Summary:  "Request viewer to operator access",
		Title:    "Request viewer to operator access",
		Operation: &ApprovalOperation{
			ResourceType: "user",
			ResourceID:   "alice",
		},
		Reason: ptrString("I need operator access for my work"),
		Before: map[string]interface{}{
			"role":   "viewer",
			"status": "active",
		},
		After: map[string]interface{}{
			"role":   "operator",
			"status": "active",
		},
		Payload: map[string]interface{}{
			"currentRole":   "viewer",
			"requestedRole": "operator",
			"reason":        "I need operator access for my work",
		},
	}

	if input.Action != "ACCESS_REQUEST" {
		t.Errorf("expected action=ACCESS_REQUEST, got=%s", input.Action)
	}
	if input.Operation.ResourceType != "user" {
		t.Errorf("expected resourceType=user, got=%s", input.Operation.ResourceType)
	}
}

func ptrString(s string) *string { return &s }
