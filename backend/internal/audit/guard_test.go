package audit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
)

func TestRequireCapabilityWithAudit_Allow(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/test", nil)
	p := &auth.Principal{Username: "admin", Role: "super_admin", NormalizedRole: "super_admin"}

	// super_admin has all capabilities
	result := RequireCapabilityWithAudit(w, r, p, "subscriber_write", nil)
	if !result {
		t.Error("expected super_admin to have subscriber_write capability")
	}
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestRequireCapabilityWithAudit_Denied(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/test", nil)
	r.Header.Set("X-Request-ID", "req-123")
	p := &auth.Principal{Username: "viewer", Role: "viewer"}

	// viewer does NOT have subscriber_write capability
	result := RequireCapabilityWithAudit(w, r, p, "subscriber_write", nil)
	if result {
		t.Error("expected viewer to be denied subscriber_write capability")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}

	// Check response body
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	// Error must be present
	if resp["error"] == nil {
		t.Error("expected error field in response")
	}

	// requiresApproval MUST be present (even if false)
	requiresApproval, ok := resp["requiresApproval"]
	if !ok {
		t.Error("expected requiresApproval to be present in response")
	}
	if requiresApproval != false {
		t.Errorf("expected requiresApproval=false, got %v", requiresApproval)
	}
}

func TestRequireCapabilityWithAudit_NoRequiresApprovalDeletion(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "viewer", Role: "viewer"}

	RequireCapabilityWithAudit(w, r, p, "subscriber_write", nil)

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	// Verify requiresApproval is NOT deleted from response
	if _, exists := resp["requiresApproval"]; !exists {
		t.Error("requiresApproval should NOT be deleted from denial response")
	}
}

func TestRequirePermissionWithAudit_Allow(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/test", nil)
	p := &auth.Principal{Username: "admin", Role: "super_admin", NormalizedRole: "super_admin"}

	// super_admin has all permissions
	result := RequirePermissionWithAudit(w, r, p, "audit.read", nil)
	if !result {
		t.Error("expected super_admin to have audit.read permission")
	}
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestRequirePermissionWithAudit_Denied(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/test", nil)
	r.Header.Set("X-Request-ID", "req-456")
	p := &auth.Principal{Username: "viewer", Role: "viewer"}

	// viewer does NOT have audit.source-ip.read-full permission
	result := RequirePermissionWithAudit(w, r, p, "audit.source-ip.read-full", nil)
	if result {
		t.Error("expected viewer to be denied audit.source-ip.read-full permission")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}

	// Check response body
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	// Error must be present
	if resp["error"] == nil {
		t.Error("expected error field in response")
	}

	// Permission denial response should have permission field
	if resp["permission"] != "audit.source-ip.read-full" {
		t.Errorf("expected permission=audit.source-ip.read-full, got %v", resp["permission"])
	}
}

func TestRecordPermissionDenied_CreatesAuditRecord(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	r.Header.Set("X-Request-ID", "req-789")
	p := &auth.Principal{Username: "testuser", Role: "viewer"}

	// Create a mock writer that captures records
	mockWriter := &Writer{
		queue: make(chan pendingRecord, 1),
		done:  make(chan struct{}),
	}

	RecordPermissionDenied(mockWriter, r, p, DenialMetadata{
		Capability: "test_capability",
		Decision:   "deny",
	})

	// Should have enqueued a record
	if len(mockWriter.queue) != 1 {
		t.Fatalf("expected 1 record in queue, got %d", len(mockWriter.queue))
	}
	pending := <-mockWriter.queue
	capturedRecord := pending.record

	// Verify record fields
	if capturedRecord.Module != "security" {
		t.Errorf("expected module=security, got %s", capturedRecord.Module)
	}
	if capturedRecord.Action != "authorization.denied" {
		t.Errorf("expected action=authorization.denied, got %s", capturedRecord.Action)
	}
	if capturedRecord.Resource == nil {
		t.Fatal("expected resource to be set")
	}
	if capturedRecord.Resource.Type != "api" {
		t.Errorf("expected resourceType=api, got %s", capturedRecord.Resource.Type)
	}
	if capturedRecord.Resource.ID != "/api/test" {
		t.Errorf("expected resourceID=/api/test, got %s", capturedRecord.Resource.ID)
	}
	if capturedRecord.Result != "denied" {
		t.Errorf("expected result=denied, got %s", capturedRecord.Result)
	}
	if capturedRecord.ActorContext == nil {
		t.Fatal("expected actorContext to be set")
	}
	if capturedRecord.ActorContext.Username != "testuser" {
		t.Errorf("expected username=testuser, got %s", capturedRecord.ActorContext.Username)
	}
	if capturedRecord.ActorContext.Role != "viewer" {
		t.Errorf("expected role=viewer, got %s", capturedRecord.ActorContext.Role)
	}
}

func TestRecordPermissionDenied_NoRiskLevel(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer"}

	mockWriter := &Writer{
		queue: make(chan pendingRecord, 1),
		done:  make(chan struct{}),
	}

	RecordPermissionDenied(mockWriter, r, p, DenialMetadata{
		Capability: "test_cap",
		Decision:   "deny",
	})

	pending := <-mockWriter.queue
	capturedRecord := pending.record

	// Verify NO riskLevel in metadata
	if capturedRecord.Metadata == nil {
		t.Fatal("expected metadata to be set")
	}
	if _, exists := capturedRecord.Metadata["riskLevel"]; exists {
		t.Error("riskLevel should NOT be present in authorization.denied metadata")
	}
}

func TestRecordPermissionDenied_NoRequiresApprovalInMetadata(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer"}

	mockWriter := &Writer{
		queue: make(chan pendingRecord, 1),
		done:  make(chan struct{}),
	}

	RecordPermissionDenied(mockWriter, r, p, DenialMetadata{
		Capability: "test_cap",
		Decision:   "deny",
	})

	pending := <-mockWriter.queue
	capturedRecord := pending.record

	if capturedRecord.Metadata == nil {
		t.Fatal("expected metadata to be set")
	}
	if _, exists := capturedRecord.Metadata["requiresApproval"]; exists {
		t.Error("requiresApproval should NOT be present in authorization.denied metadata")
	}
}

func TestRecordPermissionDenied_CapabilityMetadata(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer"}

	mockWriter := &Writer{
		queue: make(chan pendingRecord, 1),
		done:  make(chan struct{}),
	}

	RecordPermissionDenied(mockWriter, r, p, DenialMetadata{
		Capability: "subscriber_write",
		Decision:   "deny",
	})

	pending := <-mockWriter.queue
	capturedRecord := pending.record

	if capturedRecord.Metadata == nil {
		t.Fatal("expected metadata to be set")
	}

	// For capability denials: only {capability, decision}
	if capturedRecord.Metadata["capability"] != "subscriber_write" {
		t.Errorf("expected capability=subscriber_write, got %v", capturedRecord.Metadata["capability"])
	}
	if capturedRecord.Metadata["decision"] != "deny" {
		t.Errorf("expected decision=deny, got %v", capturedRecord.Metadata["decision"])
	}
}

func TestRecordPermissionDenied_PermissionMetadata(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer"}

	mockWriter := &Writer{
		queue: make(chan pendingRecord, 1),
		done:  make(chan struct{}),
	}

	// Use permission guard (not capability)
	RequirePermissionWithAudit(httptest.NewRecorder(), r, p, "audit.source-ip.read-full", mockWriter)

	pending := <-mockWriter.queue
	capturedRecord := pending.record

	if capturedRecord.Metadata == nil {
		t.Fatal("expected metadata to be set")
	}

	// For permission denials: only {permission}
	if capturedRecord.Metadata["permission"] != "audit.source-ip.read-full" {
		t.Errorf("expected permission=audit.source-ip.read-full, got %v", capturedRecord.Metadata["permission"])
	}
	// Should NOT have capability or decision
	if _, exists := capturedRecord.Metadata["capability"]; exists {
		t.Error("capability should NOT be present in permission denial metadata")
	}
	if _, exists := capturedRecord.Metadata["decision"]; exists {
		t.Error("decision should NOT be present in permission denial metadata")
	}
}

func TestRecordPermissionDenied_NilWriter(t *testing.T) {
	// Should not panic with nil writer
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer"}

	// Should not panic
	RecordPermissionDenied(nil, r, p, DenialMetadata{
		Capability: "test_cap",
		Decision:   "deny",
	})
}
