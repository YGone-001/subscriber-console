package alert

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAlertDocumentSerialization(t *testing.T) {
	doc := AlertDocument{
		ID:             "alert-123",
		Timestamp:      "2026-09-27T12:00:00.000Z",
		Level:          "CRITICAL",
		IMSI:           "001010000000001",
		Reason:         "High packet loss detected",
		IsAcknowledged: false,
	}

	bytes, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(bytes, &m); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if m["id"] != "alert-123" {
		t.Errorf("expected id alert-123, got %v", m["id"])
	}
	if m["level"] != "CRITICAL" {
		t.Errorf("expected level CRITICAL, got %v", m["level"])
	}
	if m["is_acknowledged"] != false {
		t.Errorf("expected is_acknowledged false, got %v", m["is_acknowledged"])
	}

	// Verify omitempty fields
	if _, ok := m["workflow_status"]; ok {
		t.Errorf("workflow_status should be omitted when empty")
	}
}

func TestListAlertsResponseEmptySlice(t *testing.T) {
	resp := ListAlertsResponse{
		Alerts:              []AlertDocument{},
		ActiveCriticalCount: 0,
		ActiveWarningCount:  0,
		ActiveCount:         0,
	}

	bytes, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	raw := string(bytes)
	if raw != `{"alerts":[],"activeCriticalCount":0,"activeWarningCount":0,"activeCount":0}` {
		t.Errorf("unexpected json: %s", raw)
	}
}

func TestHandlerUnauthorized(t *testing.T) {
	h := NewHandler(nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/alerts", nil)
	w := httptest.NewRecorder()

	h.List(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}
