package analytics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

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

func TestAnalyticsInitFailureTable(t *testing.T) {
	cli, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("failed to create mongo client: %v", err)
	}
	_ = cli.Disconnect(context.Background())

	dummyDb := cli.Database("dummy_xcloud")
	repo := NewRepository(
		dummyDb.Collection("subscribers"),
		dummyDb.Collection("ocs_balances"),
		dummyDb.Collection("ocs_sessions"),
		dummyDb.Collection("ocs_reservations"),
		dummyDb.Collection("ocs_usage_records"),
		dummyDb.Collection("ocs_subscribers"),
		dummyDb.Collection("ocs_tariff_plans"),
	)
	h := NewHandler(repo, nil)

	roles := []string{"admin", "operator"}
	for _, role := range roles {
		t.Run("role_"+role, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/analytics/init", nil)
			p := &auth.Principal{
				Username:       "test_" + role,
				Role:           role,
				NormalizedRole: role,
			}
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), p))

			w := httptest.NewRecorder()
			h.Init(w, req)

			if w.Code != http.StatusInternalServerError {
				t.Errorf("expected 500, got %d", w.Code)
			}
			var m map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
				t.Fatalf("unmarshal error: %v", err)
			}
			if m["error"] != "Internal server error" {
				t.Errorf("expected 'Internal server error', got %q", m["error"])
			}
			if m["code"] != "INTERNAL_ERROR" {
				t.Errorf("expected 'INTERNAL_ERROR', got %q", m["code"])
			}

			// Verify that no sensitive internal diagnostics are leaked
			raw := w.Body.String()
			disallowed := []string{"mongodb://", "replicaSet", "MongoError", "BSON", "panic:", "Topology"}
			for _, d := range disallowed {
				if strings.Contains(strings.ToLower(raw), strings.ToLower(d)) {
					t.Errorf("response must not contain sensitive diagnostic %q: %s", d, raw)
				}
			}
		})
	}
}
