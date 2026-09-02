package audit

import (
	"testing"
)

func TestBuildRecord(t *testing.T) {
	t.Run("basic record", func(t *testing.T) {
		input := WriteAuditInput{
			Action: "authorization.denied",
			Module: "security",
			Actor: ActorInput{
				Type:     "user",
				Username: "alice",
				Role:     "operator",
			},
			Resource: &ResourceInput{
				Type: "api",
				ID:   "/api/audit",
			},
			Result: "denied",
		}

		rec := BuildRecord(input)

		if rec.ID == "" {
			t.Error("ID should not be empty")
		}
		if rec.EventID != "EVT-"+rec.ID {
			t.Errorf("EventID = %q, want %q", rec.EventID, "EVT-"+rec.ID)
		}
		if rec.Timestamp == "" {
			t.Error("Timestamp should not be empty")
		}
		if rec.Level != "warning" {
			t.Errorf("Level = %q, want %q", rec.Level, "warning")
		}
		if rec.Action != "authorization.denied" {
			t.Errorf("Action = %q, want %q", rec.Action, "authorization.denied")
		}
		if rec.Module != "security" {
			t.Errorf("Module = %q, want %q", rec.Module, "security")
		}
		if rec.Actor != "alice" {
			t.Errorf("Actor = %q, want %q", rec.Actor, "alice")
		}
		if rec.TargetID != "/api/audit" {
			t.Errorf("TargetID = %q, want %q", rec.TargetID, "/api/audit")
		}
		if rec.Result != "denied" {
			t.Errorf("Result = %q, want %q", rec.Result, "denied")
		}
	})

	t.Run("actor fallback chain", func(t *testing.T) {
		// username > system > userId
		input := WriteAuditInput{
			Action: "test",
			Actor:  ActorInput{Type: "system"},
		}
		rec := BuildRecord(input)
		if rec.Actor != "system" {
			t.Errorf("Actor = %q, want %q", rec.Actor, "system")
		}

		input = WriteAuditInput{
			Action: "test",
			Actor:  ActorInput{Type: "user", UserID: "u123"},
		}
		rec = BuildRecord(input)
		if rec.Actor != "u123" {
			t.Errorf("Actor = %q, want %q", rec.Actor, "u123")
		}
	})

	t.Run("targetID fallback", func(t *testing.T) {
		// targetId > resource.id > resource.name > module
		input := WriteAuditInput{
			Action:   "test",
			Module:   "security",
			Resource: &ResourceInput{Type: "api", ID: "/api/test"},
		}
		rec := BuildRecord(input)
		if rec.TargetID != "/api/test" {
			t.Errorf("TargetID = %q, want %q", rec.TargetID, "/api/test")
		}

		input = WriteAuditInput{
			Action:   "test",
			Module:   "security",
			Resource: &ResourceInput{Type: "api", Name: "test-resource"},
		}
		rec = BuildRecord(input)
		if rec.TargetID != "test-resource" {
			t.Errorf("TargetID = %q, want %q", rec.TargetID, "test-resource")
		}

		input = WriteAuditInput{
			Action: "test",
			Module: "security",
		}
		rec = BuildRecord(input)
		if rec.TargetID != "security" {
			t.Errorf("TargetID = %q, want %q", rec.TargetID, "security")
		}
	})

	t.Run("level determination", func(t *testing.T) {
		// success + non-high risk = info
		input := WriteAuditInput{Action: "test", Result: "success", RiskLevel: "low"}
		rec := BuildRecord(input)
		if rec.Level != "info" {
			t.Errorf("Level = %q, want %q", rec.Level, "info")
		}

		// denied = warning
		input = WriteAuditInput{Action: "test", Result: "denied"}
		rec = BuildRecord(input)
		if rec.Level != "warning" {
			t.Errorf("Level = %q, want %q", rec.Level, "warning")
		}

		// high risk = warning
		input = WriteAuditInput{Action: "test", Result: "success", RiskLevel: "high"}
		rec = BuildRecord(input)
		if rec.Level != "warning" {
			t.Errorf("Level = %q, want %q", rec.Level, "warning")
		}

		// explicit level overrides
		input = WriteAuditInput{Action: "test", Result: "success", Level: "info"}
		rec = BuildRecord(input)
		if rec.Level != "info" {
			t.Errorf("Level = %q, want %q", rec.Level, "info")
		}
	})

	t.Run("correlation ID from request", func(t *testing.T) {
		input := WriteAuditInput{
			Action: "test",
			Request: &RequestInput{
				RequestID:     "req-123",
				CorrelationID: "corr-456",
			},
		}
		rec := BuildRecord(input)
		if rec.CorrelationID != "corr-456" {
			t.Errorf("CorrelationID = %q, want %q", rec.CorrelationID, "corr-456")
		}

		// Fallback to requestId
		input = WriteAuditInput{
			Action: "test",
			Request: &RequestInput{
				RequestID: "req-123",
			},
		}
		rec = BuildRecord(input)
		if rec.CorrelationID != "req-123" {
			t.Errorf("CorrelationID = %q, want %q", rec.CorrelationID, "req-123")
		}
	})

	t.Run("operator IP fallback", func(t *testing.T) {
		input := WriteAuditInput{Action: "test"}
		rec := BuildRecord(input)
		if rec.OperatorIP != "unknown" {
			t.Errorf("OperatorIP = %q, want %q", rec.OperatorIP, "unknown")
		}

		input = WriteAuditInput{
			Action: "test",
			Source: &SourceInput{IP: "10.0.0.1"},
		}
		rec = BuildRecord(input)
		if rec.OperatorIP != "10.0.0.1" {
			t.Errorf("OperatorIP = %q, want %q", rec.OperatorIP, "10.0.0.1")
		}
	})

	t.Run("sanitizes sensitive metadata", func(t *testing.T) {
		input := WriteAuditInput{
			Action: "test",
			Metadata: map[string]interface{}{
				"capability": "audit_view",
				"password":   "secret123",
			},
		}
		rec := BuildRecord(input)
		if rec.Metadata == nil {
			t.Fatal("Metadata should not be nil")
		}
		if rec.Metadata["capability"] != "audit_view" {
			t.Errorf("capability = %v, want audit_view", rec.Metadata["capability"])
		}
		if rec.Metadata["password"] != redacted {
			t.Errorf("password = %v, want [REDACTED]", rec.Metadata["password"])
		}
	})
}

func TestAuditRequestContext(t *testing.T) {
	t.Run("nil request", func(t *testing.T) {
		source, request, reason := AuditRequestContext(nil)
		if source != nil || request != nil || reason != "" {
			t.Error("expected all zero values for nil request")
		}
	})
}
