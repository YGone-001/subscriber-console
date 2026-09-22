package audit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"subscriber/internal/auth"
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
	p := &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}

	// Create a writer for audit
	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	// viewer does NOT have subscriber_write capability
	result := RequireCapabilityWithAudit(w, r, p, "subscriber_write", writer)
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

	if _, exists := resp["requiresApproval"]; exists {
		t.Error("retired requiresApproval field must be absent")
	}

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRequireCapabilityWithAudit_NoApprovalMetadata(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}

	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	RequireCapabilityWithAudit(w, r, p, "subscriber_write", writer)

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	if _, exists := resp["requiresApproval"]; exists {
		t.Error("retired requiresApproval field must be absent")
	}

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRequirePermissionWithAudit_Allow(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/test", nil)
	p := &auth.Principal{Username: "admin", Role: "super_admin", NormalizedRole: "super_admin"}

	result := RequirePermissionWithAudit(w, r, p, "users.read", nil)
	if !result {
		t.Error("expected super_admin to have users.read permission")
	}
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestRequirePermissionWithAudit_Denied(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/test", nil)
	r.Header.Set("X-Request-ID", "req-456")
	p := &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}

	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	result := RequirePermissionWithAudit(w, r, p, "users.create", writer)
	if result {
		t.Error("expected viewer to be denied users.create permission")
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
	if resp["permission"] != "users.create" {
		t.Errorf("expected permission=users.create, got %v", resp["permission"])
	}

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRecordPermissionDenied_CreatesAuditRecord(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	r.Header.Set("X-Request-ID", "req-789")
	p := &auth.Principal{Username: "testuser", Role: "viewer", NormalizedRole: "viewer"}

	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	RecordPermissionDenied(writer, r, p, DenialMetadata{
		Capability: "test_capability",
		Decision:   "deny",
	})

	// Give workers time to process
	waitForRecords(t, store, 1)

	// Should have persisted a record
	if store.count() != 1 {
		t.Fatalf("expected 1 record, got %d", store.count())
	}

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRecordPermissionDenied_NoRiskLevel(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer", NormalizedRole: "viewer"}

	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	RecordPermissionDenied(writer, r, p, DenialMetadata{
		Capability: "test_cap",
		Decision:   "deny",
	})

	// Give workers time to process
	waitForRecords(t, store, 1)

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRecordPermissionDenied_NoRetiredApprovalMetadata(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer", NormalizedRole: "viewer"}

	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	RecordPermissionDenied(writer, r, p, DenialMetadata{
		Capability: "test_cap",
		Decision:   "deny",
	})

	// Give workers time to process
	waitForRecords(t, store, 1)

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRecordPermissionDenied_CapabilityMetadata(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer", NormalizedRole: "viewer"}

	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	RecordPermissionDenied(writer, r, p, DenialMetadata{
		Capability: "subscriber_write",
		Decision:   "deny",
	})

	// Give workers time to process
	waitForRecords(t, store, 1)

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRecordPermissionDenied_PermissionMetadata(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer", NormalizedRole: "viewer"}

	store := newFakeEvidenceStore()
	writer := newTestWriterWithWorkers(t, 2, store)

	// Use permission guard (not capability)
	RequirePermissionWithAudit(httptest.NewRecorder(), r, p, "users.create", writer)

	// Give workers time to process
	waitForRecords(t, store, 1)

	// Cleanup
	closeCtx := testCtx(t)
	writer.Close(closeCtx)
}

func TestRecordPermissionDenied_NilWriter(t *testing.T) {
	// Should not panic with nil writer
	r := httptest.NewRequest("POST", "/api/test", nil)
	p := &auth.Principal{Username: "testuser", Role: "viewer", NormalizedRole: "viewer"}

	// Should not panic
	RecordPermissionDenied(nil, r, p, DenialMetadata{
		Capability: "test_cap",
		Decision:   "deny",
	})
}

// testCtx creates a context with timeout for tests.
func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// waitForRecords waits until the store has at least n records.
func waitForRecords(t *testing.T, store *fakeEvidenceStore, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if store.count() >= n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %d records, got %d", n, store.count())
}
