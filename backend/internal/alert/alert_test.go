package alert

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/auth"
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

func TestAlertHandlerFailureTable(t *testing.T) {
	cli, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("failed to create mongo client: %v", err)
	}
	_ = cli.Disconnect(context.Background())

	failingCol := cli.Database("dummy_db").Collection("app_alerts")
	repo := NewRepository(failingCol)
	h := NewHandler(repo, nil)

	roles := []string{"admin", "operator", "viewer"}
	for _, role := range roles {
		t.Run("role_"+role, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/alerts", nil)
			p := &auth.Principal{
				Username:       "test_" + role,
				Role:           role,
				NormalizedRole: role,
			}
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), p))

			w := httptest.NewRecorder()
			h.List(w, req)

			if w.Code != http.StatusInternalServerError {
				t.Errorf("expected 500, got %d", w.Code)
			}
			var m map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
				t.Fatalf("unmarshal error: %v", err)
			}
			if m["error"] != "Alert fetch failed" {
				t.Errorf("expected 'Alert fetch failed', got %q", m["error"])
			}
		})
	}
}

func TestAlertHandler_Acknowledge_RBAC(t *testing.T) {
	h := NewHandler(nil, nil)

	// 1. Unauthorized
	req := httptest.NewRequest(http.MethodPost, "/api/alerts/acknowledge", bytes.NewBufferString(`{"id":"alert-1"}`))
	w := httptest.NewRecorder()
	h.Acknowledge(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}

	// 2. Forbidden (viewer)
	reqViewer := httptest.NewRequest(http.MethodPost, "/api/alerts/acknowledge", bytes.NewBufferString(`{"id":"alert-1"}`))
	reqViewer = reqViewer.WithContext(auth.ContextWithPrincipal(reqViewer.Context(), &auth.Principal{
		Username:       "viewer1",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}))
	wViewer := httptest.NewRecorder()
	h.Acknowledge(wViewer, reqViewer)
	if wViewer.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", wViewer.Code)
	}
	var errResp map[string]string
	_ = json.Unmarshal(wViewer.Body.Bytes(), &errResp)
	if errResp["code"] != "PERMISSION_DENIED" {
		t.Errorf("expected code PERMISSION_DENIED, got %q", errResp["code"])
	}
}

func TestAlertHandler_Acknowledge_Validation(t *testing.T) {
	h := NewHandler(nil, nil)

	testCases := []struct {
		name       string
		body       string
		wantStatus int
		wantError  string
	}{
		{
			name:       "malformed json returns 500",
			body:       `{invalid-json`,
			wantStatus: http.StatusInternalServerError,
			wantError:  "Failed to acknowledge alert",
		},
		{
			name:       "null json returns 500",
			body:       `null`,
			wantStatus: http.StatusInternalServerError,
			wantError:  "Failed to acknowledge alert",
		},
		{
			name:       "empty body returns 400",
			body:       `{}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Alert ID(s) required",
		},
		{
			name:       "whitespace only id returns 400",
			body:       `{"id":"   "}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Alert ID(s) required",
		},
		{
			name:       "empty ids array returns 400",
			body:       `{"ids":[]}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Alert ID(s) required",
		},
		{
			name:       "ids with only non-strings and whitespace returns 400",
			body:       `{"ids":[123, null, "   "]}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Alert ID(s) required",
		},
		{
			name: "exceeding 200 ids returns 400",
			body: func() string {
				ids := make([]string, 201)
				for i := 0; i < 201; i++ {
					ids[i] = fmt.Sprintf(`"alert-%d"`, i)
				}
				return fmt.Sprintf(`{"ids":[%s]}`, strings.Join(ids, ","))
			}(),
			wantStatus: http.StatusBadRequest,
			wantError:  "At most 200 alerts can be acknowledged at once",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/alerts/acknowledge", bytes.NewBufferString(tc.body))
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
				Username:       "operator1",
				Role:           "operator",
				NormalizedRole: "operator",
			}))
			w := httptest.NewRecorder()
			h.Acknowledge(w, req)

			if w.Code != tc.wantStatus {
				t.Errorf("status %d != %d", w.Code, tc.wantStatus)
			}
			var m map[string]string
			_ = json.Unmarshal(w.Body.Bytes(), &m)
			if m["error"] != tc.wantError {
				t.Errorf("error %q != %q", m["error"], tc.wantError)
			}
		})
	}
}

func TestAlertHandler_Workflow_RBAC(t *testing.T) {
	h := NewHandler(nil, nil)

	// 1. Unauthorized
	req := httptest.NewRequest(http.MethodPost, "/api/alerts/workflow", bytes.NewBufferString(`{"id":"alert-1","status":"assigned"}`))
	w := httptest.NewRecorder()
	h.Workflow(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}

	// 2. Forbidden (viewer)
	reqViewer := httptest.NewRequest(http.MethodPost, "/api/alerts/workflow", bytes.NewBufferString(`{"id":"alert-1","status":"assigned"}`))
	reqViewer = reqViewer.WithContext(auth.ContextWithPrincipal(reqViewer.Context(), &auth.Principal{
		Username:       "viewer1",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}))
	wViewer := httptest.NewRecorder()
	h.Workflow(wViewer, reqViewer)
	if wViewer.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", wViewer.Code)
	}
	var errResp map[string]string
	_ = json.Unmarshal(wViewer.Body.Bytes(), &errResp)
	if errResp["code"] != "PERMISSION_DENIED" {
		t.Errorf("expected code PERMISSION_DENIED, got %q", errResp["code"])
	}
}

func TestAlertHandler_Workflow_Validation(t *testing.T) {
	h := NewHandler(nil, nil)

	testCases := []struct {
		name       string
		body       string
		wantStatus int
		wantError  string
	}{
		{
			name:       "malformed json returns 500",
			body:       `{bad-json`,
			wantStatus: http.StatusInternalServerError,
			wantError:  "Failed to update alert workflow",
		},
		{
			name:       "null json returns 500",
			body:       `null`,
			wantStatus: http.StatusInternalServerError,
			wantError:  "Failed to update alert workflow",
		},
		{
			name:       "missing id returns 400",
			body:       `{"status":"assigned"}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Alert ID required",
		},
		{
			name:       "whitespace only id returns 400",
			body:       `{"id":"   ","status":"assigned"}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Alert ID required",
		},
		{
			name:       "id checked before status when both invalid",
			body:       `{"id":"   ","status":"invalid"}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Alert ID required",
		},
		{
			name:       "invalid status returns 400",
			body:       `{"id":"alert-1","status":"unknown_status"}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Invalid alert workflow status",
		},
		{
			name:       "status uppercase returns 400 (case sensitive)",
			body:       `{"id":"alert-1","status":"RESOLVED"}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Invalid alert workflow status",
		},
		{
			name:       "status with surrounding whitespace returns 400",
			body:       `{"id":"alert-1","status":" resolved "}`,
			wantStatus: http.StatusBadRequest,
			wantError:  "Invalid alert workflow status",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/alerts/workflow", bytes.NewBufferString(tc.body))
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
				Username:       "operator1",
				Role:           "operator",
				NormalizedRole: "operator",
			}))
			w := httptest.NewRecorder()
			h.Workflow(w, req)

			if w.Code != tc.wantStatus {
				t.Errorf("status %d != %d", w.Code, tc.wantStatus)
			}
			var m map[string]string
			_ = json.Unmarshal(w.Body.Bytes(), &m)
			if m["error"] != tc.wantError {
				t.Errorf("error %q != %q", m["error"], tc.wantError)
			}
		})
	}
}

func TestCleanTextHelper(t *testing.T) {
	if cleanText(nil) != nil {
		t.Error("expected nil for nil input")
	}
	if cleanText(123) != nil {
		t.Error("expected nil for non-string input")
	}
	if cleanText("") != nil {
		t.Error("expected nil for empty string")
	}
	if cleanText("   ") != nil {
		t.Error("expected nil for whitespace string")
	}

	val := cleanText("  hello world  ")
	if val == nil || *val != "hello world" {
		t.Errorf("expected 'hello world', got %v", val)
	}

	longStr := strings.Repeat("a", 100)
	valLong := cleanText(longStr)
	if valLong == nil || len(*valLong) != 80 {
		t.Errorf("expected 80 chars, got length %d", len(*valLong))
	}
}

func TestIsValidWorkflowStatus(t *testing.T) {
	valid := []string{"acknowledged", "assigned", "recovering", "resolved"}
	for _, s := range valid {
		if !isValidWorkflowStatus(s) {
			t.Errorf("expected valid for %s", s)
		}
	}

	invalid := []string{"", " ", "unknown", "RESOLVED", " acknowledged", "resolved "}
	for _, s := range invalid {
		if isValidWorkflowStatus(s) {
			t.Errorf("expected invalid for %q", s)
		}
	}
}
