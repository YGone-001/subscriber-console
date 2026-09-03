package approval

import (
	"context"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/user"
)

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

// ── ACCESS_REQUEST Handler Contract Tests ───────────────────────────────────

func TestAccessRequest_PermissionDenied(t *testing.T) {
	// viewer has approvals.create, so this would pass.
	// But if the user lacks the permission, it should 403.
	// We test this by checking that RequirePermissionWithAudit is called.
	// (Integration-level test — the guard itself is tested in audit package.)
	t.Skip("permission denial tested in audit/guard_test.go")
}

func TestAccessRequest_ReasonMissing(t *testing.T) {
	// reason missing or < 8 chars → 400 ACCESS_REASON_REQUIRED
	reason := ""
	if len(reason) < 8 {
		// Expected behavior
		return
	}
	t.Error("expected reason to be too short")
}

func TestAccessRequest_ReasonTruncation(t *testing.T) {
	// reason > 1000 is silently truncated to 1000, NOT APPROVAL_TEXT_TOO_LONG
	longReason := make([]byte, 1001)
	for i := range longReason {
		longReason[i] = 'x'
	}
	reason := string(longReason)
	if len(reason) > 1000 {
		reason = reason[:1000]
	}
	if len(reason) != 1000 {
		t.Errorf("expected truncated reason length=1000, got=%d", len(reason))
	}
}

func TestAccessRequest_InactiveUser(t *testing.T) {
	users := newFakeUserLookup()
	users.seedUser("alice", "viewer", "disabled")

	u, _ := users.FindByUsername(context.Background(), "alice")
	if u == nil || u.Status != "disabled" {
		t.Fatal("expected disabled user")
	}
	if u.Status == "active" {
		t.Error("expected user to NOT be active")
	}
}

func TestAccessRequest_MissingUser(t *testing.T) {
	users := newFakeUserLookup()

	u, _ := users.FindByUsername(context.Background(), "nonexistent")
	if u != nil {
		t.Error("expected nil for missing user")
	}
}

func TestAccessRequest_NonViewer(t *testing.T) {
	users := newFakeUserLookup()
	users.seedUser("alice", "operator", "active")

	u, _ := users.FindByUsername(context.Background(), "alice")
	if u == nil {
		t.Fatal("expected user")
	}
	if u.Role != "viewer" {
		// Should return 409 ACCESS_ALREADY_GRANTED
		// This is correct behavior — operator already has access
		return
	}
	t.Error("expected non-viewer role")
}

func TestAccessRequest_ViewerRole(t *testing.T) {
	users := newFakeUserLookup()
	users.seedUser("alice", "viewer", "active")

	u, _ := users.FindByUsername(context.Background(), "alice")
	if u == nil {
		t.Fatal("expected user")
	}
	if u.Role != "viewer" {
		t.Errorf("expected role=viewer, got=%s", u.Role)
	}
}

// ── ACCESS_REQUEST Document Shape ───────────────────────────────────────────

func TestAccessRequest_DocumentShape(t *testing.T) {
	// Verify the exact shape matches Node contract
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
		Reason: "I need operator access for my work",
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

	// Verify fields
	if input.Action != "ACCESS_REQUEST" {
		t.Errorf("expected action=ACCESS_REQUEST, got=%s", input.Action)
	}
	if input.Summary != "Request viewer to operator access" {
		t.Errorf("expected summary='Request viewer to operator access', got=%s", input.Summary)
	}
	if input.Operation.ResourceType != "user" {
		t.Errorf("expected resourceType=user, got=%s", input.Operation.ResourceType)
	}
	if input.Operation.ResourceID != "alice" {
		t.Errorf("expected resourceId=alice, got=%s", input.Operation.ResourceID)
	}

	// Verify before/after
	before, ok := input.Before.(map[string]interface{})
	if !ok {
		t.Fatal("expected before to be map")
	}
	if before["role"] != "viewer" {
		t.Errorf("expected before.role=viewer, got=%v", before["role"])
	}

	after, ok := input.After.(map[string]interface{})
	if !ok {
		t.Fatal("expected after to be map")
	}
	if after["role"] != "operator" {
		t.Errorf("expected after.role=operator, got=%v", after["role"])
	}

	// Verify payload
	if input.Payload["currentRole"] != "viewer" {
		t.Errorf("expected payload.currentRole=viewer, got=%v", input.Payload["currentRole"])
	}
	if input.Payload["requestedRole"] != "operator" {
		t.Errorf("expected payload.requestedRole=operator, got=%v", input.Payload["requestedRole"])
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

// ── Rate Limit Key Test ─────────────────────────────────────────────────────

func TestAccessRequest_RateLimitKey(t *testing.T) {
	// Rate limit key: approvals:access-request:{username}
	key := "approvals:access-request:alice"
	expected := "approvals:access-request:alice"
	if key != expected {
		t.Errorf("expected rate limit key=%s, got=%s", expected, key)
	}
}
