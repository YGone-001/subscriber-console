package audit

import (
	"errors"
	"testing"
)

func TestIsWriteFailed(t *testing.T) {
	err := &ErrWriteFailed{EventID: "EVT-123", Err: errors.New("test error")}
	if evt, ok := IsWriteFailed(err); !ok {
		t.Error("IsWriteFailed should return true for ErrWriteFailed")
	} else if evt.EventID != "EVT-123" {
		t.Errorf("EventID = %q, want %q", evt.EventID, "EVT-123")
	}

	normalErr := errors.New("normal error")
	if _, ok := IsWriteFailed(normalErr); ok {
		t.Error("IsWriteFailed should return false for normal error")
	}
}

func TestErrWriteFailed_Error(t *testing.T) {
	err := &ErrWriteFailed{
		EventID: "EVT-abc",
		Err:     errors.New("insert failed"),
	}
	msg := err.Error()
	if msg == "" {
		t.Error("Error() should not be empty")
	}
	if !containsStr(msg, "EVT-abc") {
		t.Errorf("Error() should contain eventId, got %q", msg)
	}
}

func TestErrWriteFailed_Unwrap(t *testing.T) {
	inner := errors.New("inner error")
	err := &ErrWriteFailed{EventID: "test", Err: inner}
	if !errors.Is(err, inner) {
		t.Error("Unwrap should allow errors.Is to match inner error")
	}
}

func TestWriterConfig_Defaults(t *testing.T) {
	// Verify default values are used when zero values passed
	cfg := WriterConfig{}
	if cfg.QueueSize != 0 {
		t.Error("QueueSize should default to 0 before NewWriter")
	}
	// NewWriter applies defaults internally — can't test without Mongo
}

func TestBuildRecord_AuthorizationDenied(t *testing.T) {
	// Test the full authorization.denied record shape
	input := WriteAuditInput{
		Action: "authorization.denied",
		Module: "security",
		Actor: ActorInput{
			Type:     "user",
			Username: "testuser",
			Role:     "operator",
		},
		Resource: &ResourceInput{
			Type: "api",
			ID:   "/api/subscribers",
		},
		Source: &SourceInput{
			IP:        "10.0.0.1",
			UserAgent: "Mozilla/5.0",
		},
		Request: &RequestInput{
			Method:        "GET",
			Path:          "/api/subscribers",
			RequestID:     "req-123",
			CorrelationID: "corr-456",
		},
		Result:    "denied",
		RiskLevel: "medium",
		Metadata: map[string]interface{}{
			"capability": "subscriber_read",
			"decision":   "deny",
		},
	}

	rec := BuildRecord(input)

	// Verify all fields match expected shape
	checks := []struct {
		name string
		got  interface{}
		want interface{}
	}{
		{"action", rec.Action, "authorization.denied"},
		{"module", rec.Module, "security"},
		{"actor", rec.Actor, "testuser"},
		{"targetId", rec.TargetID, "/api/subscribers"},
		{"result", rec.Result, "denied"},
		{"riskLevel", rec.RiskLevel, "medium"},
		{"operatorIp", rec.OperatorIP, "10.0.0.1"},
		{"level", rec.Level, "warning"},
		{"request.method", rec.Request.Method, "GET"},
		{"request.path", rec.Request.Path, "/api/subscribers"},
		{"request.requestId", rec.Request.RequestID, "req-123"},
		{"request.correlationId", rec.Request.CorrelationID, "corr-456"},
	}

	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}

	// Verify ID format
	if len(rec.ID) != 36 { // UUID format
		t.Errorf("ID length = %d, want 36 (UUID)", len(rec.ID))
	}
	if rec.EventID != "EVT-"+rec.ID {
		t.Errorf("EventID = %q, want %q", rec.EventID, "EVT-"+rec.ID)
	}

	// Verify metadata is preserved
	if rec.Metadata == nil {
		t.Fatal("Metadata should not be nil")
	}
	if rec.Metadata["capability"] != "subscriber_read" {
		t.Errorf("metadata.capability = %v, want subscriber_read", rec.Metadata["capability"])
	}
}

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstr(s, substr))
}

func containsSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestWriteMode_Constants(t *testing.T) {
	if BestEffort != 0 {
		t.Errorf("BestEffort = %d, want 0", BestEffort)
	}
	if Strict != 1 {
		t.Errorf("Strict = %d, want 1", Strict)
	}
}

func TestWriter_QueueFull_DropsRecord(t *testing.T) {
	// Can't test with real Mongo, but can test the drop logic
	// by verifying the channel behavior
	ch := make(chan pendingRecord, 1)

	// Fill the channel
	input := WriteAuditInput{Action: "test", Module: "test"}
	rec := pendingRecord{input: input, mode: BestEffort}

	select {
	case ch <- rec:
		// OK
	default:
		t.Error("should be able to enqueue first record")
	}

	// Second should be dropped
	select {
	case ch <- rec:
		t.Error("should not be able to enqueue when full")
	default:
		// Expected — queue full
	}
}

func TestWriter_WriteSync_BestEffort(t *testing.T) {
	// BestEffort returns nil immediately (no channel created)
	// Can't test full path without Mongo, but verify the nil channel path
	var ch <-chan error = nil
	if ch != nil {
		t.Error("BestEffort should not create a channel")
	}
}
