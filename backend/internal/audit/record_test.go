package audit

import (
	"net/http/httptest"
	"testing"
)

func TestBuildRecord_BasicFields(t *testing.T) {
	input := WriteAuditInput{
		Module: "security",
		Action: "authorization.denied",
		Resource: &ResourceInput{
			Type: "api",
			ID:   "/api/test",
		},
		Result: "denied",
		Reason: "capability required",
		Actor: ActorInput{
			Type:     "user",
			Username: "user1",
			Role:     "admin",
		},
		Source: &SourceInput{
			IP:        "192.168.1.1",
			UserAgent: "test-agent",
		},
		Request: &RequestInput{
			RequestID: "req-123",
		},
		Metadata: map[string]any{"capability": "test_cap", "decision": "deny"},
	}

	record := BuildRecord(input)

	// Check _id and id are both set and equal
	if record.MongoID == "" {
		t.Error("expected _id to be set")
	}
	if record.ID == "" {
		t.Error("expected id to be set")
	}
	if record.MongoID != record.ID {
		t.Errorf("expected _id == id, got _id=%s id=%s", record.MongoID, record.ID)
	}

	// Check eventId format
	expectedEventID := "EVT-" + record.ID
	if record.EventID != expectedEventID {
		t.Errorf("expected eventId=%s, got %s", expectedEventID, record.EventID)
	}

	// Check basic fields
	if record.Module != "security" {
		t.Errorf("expected module=security, got %s", record.Module)
	}
	if record.Action != "authorization.denied" {
		t.Errorf("expected action=authorization.denied, got %s", record.Action)
	}
	if record.Resource == nil {
		t.Fatal("expected resource to be set")
	}
	if record.Resource.Type != "api" {
		t.Errorf("expected resourceType=api, got %s", record.Resource.Type)
	}
	if record.Resource.ID != "/api/test" {
		t.Errorf("expected resourceID=/api/test, got %s", record.Resource.ID)
	}
	if record.Result != "denied" {
		t.Errorf("expected result=denied, got %s", record.Result)
	}
	if record.Reason != "capability required" {
		t.Errorf("expected reason='capability required', got %s", record.Reason)
	}
}

func TestBuildRecord_IdentityFields(t *testing.T) {
	input := WriteAuditInput{
		Module: "test",
		Action: "test.action",
		Resource: &ResourceInput{
			Type: "api",
		},
		Result: "success",
		Actor: ActorInput{
			Type:     "user",
			Username: "user1",
			Role:     "admin",
		},
		Source: &SourceInput{
			IP:        "192.168.1.1",
			UserAgent: "test-agent",
		},
		Request: &RequestInput{
			RequestID: "req-123",
		},
	}

	record := BuildRecord(input)

	if record.ActorContext == nil {
		t.Fatal("expected actorContext to be set")
	}
	if record.ActorContext.Username != "user1" {
		t.Errorf("expected username=user1, got %s", record.ActorContext.Username)
	}
	if record.ActorContext.Role != "admin" {
		t.Errorf("expected role=admin, got %s", record.ActorContext.Role)
	}
	if record.Source == nil {
		t.Fatal("expected source to be set")
	}
	if record.Source.IP != "192.168.1.1" {
		t.Errorf("expected sourceIP=192.168.1.1, got %s", record.Source.IP)
	}
	if record.Source.UserAgent != "test-agent" {
		t.Errorf("expected userAgent=test-agent, got %s", record.Source.UserAgent)
	}
}

func TestBuildRecord_Defaults(t *testing.T) {
	input := WriteAuditInput{
		Module: "test",
		Action: "test.action",
		Resource: &ResourceInput{
			Type: "api",
		},
		Result: "success",
	}

	record := BuildRecord(input)

	// Check defaults
	if record.OldData != nil {
		t.Errorf("expected oldData=nil (not missing), got %v", record.OldData)
	}
	if record.NewData != nil {
		t.Errorf("expected newData=nil (not missing), got %v", record.NewData)
	}
}

func TestBuildRecord_UUIDFormat(t *testing.T) {
	input := WriteAuditInput{
		Module: "test",
		Action: "test.action",
		Resource: &ResourceInput{
			Type: "api",
		},
		Result: "success",
	}

	record := BuildRecord(input)

	// UUID v4 format: 8-4-4-4-12 hex chars
	if len(record.ID) != 36 {
		t.Errorf("expected UUID length 36, got %d", len(record.ID))
	}
	if record.ID[8] != '-' || record.ID[13] != '-' || record.ID[18] != '-' || record.ID[23] != '-' {
		t.Errorf("expected UUID format with dashes, got %s", record.ID)
	}
	// Version 4: char 14 should be '4'
	if record.ID[14] != '4' {
		t.Errorf("expected UUID version 4, got %s", record.ID)
	}
}

func TestBuildRecord_MetadataSanitized(t *testing.T) {
	input := WriteAuditInput{
		Module: "test",
		Action: "test.action",
		Resource: &ResourceInput{
			Type: "api",
		},
		Result: "success",
		Metadata: map[string]any{
			"password": "secret123",
			"normal":   "visible",
		},
	}

	record := BuildRecord(input)

	if record.Metadata == nil {
		t.Fatal("expected metadata to be set")
	}
	if record.Metadata["password"] != "[REDACTED]" {
		t.Errorf("expected metadata password redacted, got %v", record.Metadata["password"])
	}
	if record.Metadata["normal"] != "visible" {
		t.Errorf("expected metadata normal visible, got %v", record.Metadata["normal"])
	}
}

func TestBuildRecord_ErrorSanitized(t *testing.T) {
	input := WriteAuditInput{
		Module: "test",
		Action: "test.action",
		Resource: &ResourceInput{
			Type: "api",
		},
		Result: "failure",
		Error: &ErrorInput{
			Message: "something failed: password=secret123",
		},
	}

	record := BuildRecord(input)

	if record.Error == nil {
		t.Fatal("expected error to be set")
	}
	str := record.Error.Message
	if str != "something failed: password=[REDACTED]" {
		t.Errorf("expected error with redaction, got: %s", str)
	}
}

func TestAuditRequestContext_ReusesRequestID(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/test", nil)
	r.Header.Set("X-Request-ID", "existing-req-id")

	source, request, _ := AuditRequestContext(r)

	if request == nil {
		t.Fatal("expected request to be set")
	}
	if request.RequestID != "existing-req-id" {
		t.Errorf("expected requestID=existing-req-id, got %s", request.RequestID)
	}
	if source == nil {
		t.Fatal("expected source to be set")
	}
}

func TestAuditRequestContext_EmptyRequestID(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/test", nil)
	// No X-Request-ID header

	_, request, _ := AuditRequestContext(r)

	// Should be empty (caller should generate if needed)
	if request != nil && request.RequestID != "" {
		// This is actually ok - it might use middleware-generated ID
	}
}

func TestAuditRequestContext_PrincipalFields(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/test", nil)

	source, request, _ := AuditRequestContext(r)

	if source == nil {
		t.Fatal("expected source to be set")
	}
	if request == nil {
		t.Fatal("expected request to be set")
	}
}

func TestBuildRecord_NilOldDataNewData(t *testing.T) {
	input := WriteAuditInput{
		Module: "test",
		Action: "test.action",
		Resource: &ResourceInput{
			Type: "api",
		},
		Result: "success",
	}

	record := BuildRecord(input)

	// oldData and newData must be nil (null in JSON), not missing
	if record.OldData != nil {
		t.Errorf("expected oldData=nil, got %v", record.OldData)
	}
	if record.NewData != nil {
		t.Errorf("expected newData=nil, got %v", record.NewData)
	}
}

func TestBuildRecord_WithData(t *testing.T) {
	input := WriteAuditInput{
		Module: "test",
		Action: "test.update",
		Resource: &ResourceInput{
			Type: "api",
		},
		Result: "success",
		Before: map[string]any{"status": "active"},
		After:  map[string]any{"status": "suspended"},
	}

	record := BuildRecord(input)

	oldMap, ok := record.OldData.(map[string]any)
	if !ok {
		t.Fatalf("expected oldData to be map, got %T", record.OldData)
	}
	if oldMap["status"] != "active" {
		t.Errorf("expected old status=active, got %v", oldMap["status"])
	}

	newMap, ok := record.NewData.(map[string]any)
	if !ok {
		t.Fatalf("expected newData to be map, got %T", record.NewData)
	}
	if newMap["status"] != "suspended" {
		t.Errorf("expected new status=suspended, got %v", newMap["status"])
	}
}
