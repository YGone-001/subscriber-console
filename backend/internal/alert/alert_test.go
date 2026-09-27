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

func TestAlertWorkflowFieldsTable(t *testing.T) {
	tests := []struct {
		name       string
		doc        AlertDocument
		shouldHave []string
		shouldOmit []string
	}{
		{
			name: "all workflow fields populated",
			doc: AlertDocument{
				ID:                "alt-1",
				Timestamp:         "2026-09-27T12:00:00.000Z",
				Level:             "WARNING",
				IMSI:              "001010000000001",
				Reason:            "Test reason",
				IsAcknowledged:    true,
				WorkflowStatus:    "in_progress",
				AssignedTo:        "operator1",
				HandlingNote:      "Investigating anomaly",
				WorkflowUpdatedAt: "2026-09-27T12:05:00.000Z",
			},
			shouldHave: []string{"workflow_status", "assigned_to", "handling_note", "workflow_updated_at"},
			shouldOmit: []string{},
		},
		{
			name: "workflow fields omitted when empty",
			doc: AlertDocument{
				ID:             "alt-2",
				Timestamp:      "2026-09-27T12:00:00.000Z",
				Level:          "INFO",
				IMSI:           "001010000000002",
				Reason:         "Heartbeat",
				IsAcknowledged: false,
			},
			shouldHave: []string{},
			shouldOmit: []string{"workflow_status", "assigned_to", "handling_note", "workflow_updated_at"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.doc)
			if err != nil {
				t.Fatalf("marshal error: %v", err)
			}
			var m map[string]interface{}
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatalf("unmarshal error: %v", err)
			}
			for _, k := range tc.shouldHave {
				if _, ok := m[k]; !ok {
					t.Errorf("expected key %s to be present", k)
				}
			}
			for _, k := range tc.shouldOmit {
				if _, ok := m[k]; ok {
					t.Errorf("expected key %s to be omitted", k)
				}
			}
		})
	}
}
