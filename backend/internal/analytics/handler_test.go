package analytics

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"subscriber/internal/auth"
)

func TestInitResponseSerialization(t *testing.T) {
	resp := InitResponse{
		Message: "MongoDB analytics are computed from subscriber documents on demand.",
		Metrics: &AnalyticsMetrics{
			TotalTraffic: 100,
			PlmnDist:     []NameValue{{Name: "00101", Value: 5}},
			RatesDist:    []NameValue{},
			Top5:         []Top5Entry{},
			Timestamp:    1234567890,
		},
	}

	bytes, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(bytes, &m); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if m["message"] != "MongoDB analytics are computed from subscriber documents on demand." {
		t.Errorf("unexpected message: %v", m["message"])
	}

	metrics, ok := m["metrics"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected metrics map")
	}

	if metrics["totalTraffic"] != float64(100) {
		t.Errorf("expected totalTraffic 100, got %v", metrics["totalTraffic"])
	}
}

func TestInitHandlerUnauthorized(t *testing.T) {
	h := NewHandler(nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/analytics/init", nil)
	w := httptest.NewRecorder()

	h.Init(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestInitHandlerForbiddenForViewer(t *testing.T) {
	h := NewHandler(nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/analytics/init", nil)
	principal := &auth.Principal{
		Username:       "viewer-user",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()

	h.Init(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}

	var errResp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&errResp); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if errResp["code"] != "PERMISSION_DENIED" {
		t.Errorf("expected code PERMISSION_DENIED, got %s", errResp["code"])
	}
	if errResp["error"] != "Forbidden: Insufficient permissions" {
		t.Errorf("expected error 'Forbidden: Insufficient permissions', got %s", errResp["error"])
	}
}
