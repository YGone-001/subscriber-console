package system

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"subscriber/internal/auth"
)

func TestMongoHealthReportDegradedSerialization(t *testing.T) {
	errMsg := "MongoDB health check failed"
	report := MongoHealthReport{
		OK:                 false,
		Database:           nil,
		Databases:          nil,
		CheckedAt:          "2026-09-27T12:00:00.000Z",
		LatencyMs:          nil,
		Collections:        []CollectionHealth{},
		MissingCollections: []string{},
		MissingIndexes:     []MissingIndexRef{},
		Error:              &errMsg,
	}

	data, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if m["ok"] != false {
		t.Errorf("expected ok false, got %v", m["ok"])
	}
	if m["database"] != nil {
		t.Errorf("expected database null, got %v", m["database"])
	}
	if m["databases"] != nil {
		t.Errorf("expected databases null, got %v", m["databases"])
	}
	if m["latencyMs"] != nil {
		t.Errorf("expected latencyMs null, got %v", m["latencyMs"])
	}
	if m["error"] != "MongoDB health check failed" {
		t.Errorf("expected error message, got %v", m["error"])
	}

	colls, ok := m["collections"].([]interface{})
	if !ok || len(colls) != 0 {
		t.Errorf("expected empty collections array, got %v", m["collections"])
	}
	missingColls, ok := m["missingCollections"].([]interface{})
	if !ok || len(missingColls) != 0 {
		t.Errorf("expected empty missingCollections array, got %v", m["missingCollections"])
	}
	missingIdx, ok := m["missingIndexes"].([]interface{})
	if !ok || len(missingIdx) != 0 {
		t.Errorf("expected empty missingIndexes array, got %v", m["missingIndexes"])
	}
}

func TestIndexMatches(t *testing.T) {
	exp := expectedIndexDef{
		database:   "xcloud",
		collection: "subscribers",
		name:       "uniq_imsi",
		key:        bson.D{{Key: "imsi", Value: 1}},
		unique:     &boolTrue,
	}

	matchingDoc := bson.M{
		"name":   "uniq_imsi",
		"key":    bson.D{{Key: "imsi", Value: int32(1)}},
		"unique": true,
	}
	if !indexMatches(matchingDoc, exp) {
		t.Errorf("expected matchingDoc to match")
	}

	wrongKeyDoc := bson.M{
		"name":   "uniq_imsi",
		"key":    bson.D{{Key: "imsi", Value: int32(-1)}},
		"unique": true,
	}
	if indexMatches(wrongKeyDoc, exp) {
		t.Errorf("expected wrongKeyDoc to fail")
	}

	notUniqueDoc := bson.M{
		"name":   "uniq_imsi",
		"key":    bson.D{{Key: "imsi", Value: int32(1)}},
		"unique": false,
	}
	if indexMatches(notUniqueDoc, exp) {
		t.Errorf("expected notUniqueDoc to fail")
	}
}

func TestAuditStatusUnauthorized(t *testing.T) {
	h := NewHandler(nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/system/audit/status", nil)
	w := httptest.NewRecorder()

	h.AuditStatus(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestAuditScanForbiddenForViewer(t *testing.T) {
	h := NewHandler(nil, nil, nil)

	body := bytes.NewBufferString(`{"cursor":"0","phase":"sub"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/system/audit/scan", body)
	principal := &auth.Principal{
		Username:       "viewer-user",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	h.AuditScan(w, req)

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
}

func TestAuditScanInvalidJSON(t *testing.T) {
	h := NewHandler(nil, nil, nil)

	body := bytes.NewBufferString(`invalid json`)
	req := httptest.NewRequest(http.MethodPost, "/api/system/audit/scan", body)
	principal := &auth.Principal{
		Username:       "admin-user",
		Role:           "admin",
		NormalizedRole: "admin",
	}
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	h.AuditScan(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 on malformed json, got %d", w.Code)
	}

	var errResp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&errResp); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if errResp["error"] != "Audit scan failed" {
		t.Errorf("expected error 'Audit scan failed', got %s", errResp["error"])
	}
}

func TestIndexOptionsTable(t *testing.T) {
	ttlZero := int32(0)
	tests := []struct {
		name     string
		exp      expectedIndexDef
		doc      bson.M
		expected bool
	}{
		{
			name: "unique option match",
			exp: expectedIndexDef{
				database:   "app",
				collection: "app_users",
				name:       "uniq_username",
				key:        bson.D{{Key: "username", Value: 1}},
				unique:     &boolTrue,
			},
			doc: bson.M{
				"name":   "uniq_username",
				"key":    bson.D{{Key: "username", Value: int32(1)}},
				"unique": true,
			},
			expected: true,
		},
		{
			name: "unique option mismatch when missing",
			exp: expectedIndexDef{
				database:   "app",
				collection: "app_users",
				name:       "uniq_username",
				key:        bson.D{{Key: "username", Value: 1}},
				unique:     &boolTrue,
			},
			doc: bson.M{
				"name": "uniq_username",
				"key":  bson.D{{Key: "username", Value: int32(1)}},
			},
			expected: false,
		},
		{
			name: "ttl expireAfterSeconds match",
			exp: expectedIndexDef{
				database:           "app",
				collection:         "app_rate_limits",
				name:               "ttl_rate_limit_reset_at",
				key:                bson.D{{Key: "reset_at", Value: 1}},
				expireAfterSeconds: &ttlZero,
			},
			doc: bson.M{
				"name":               "ttl_rate_limit_reset_at",
				"key":                bson.D{{Key: "reset_at", Value: int32(1)}},
				"expireAfterSeconds": int32(0),
			},
			expected: true,
		},
		{
			name: "ttl expireAfterSeconds mismatch",
			exp: expectedIndexDef{
				database:           "app",
				collection:         "app_rate_limits",
				name:               "ttl_rate_limit_reset_at",
				key:                bson.D{{Key: "reset_at", Value: 1}},
				expireAfterSeconds: &ttlZero,
			},
			doc: bson.M{
				"name":               "ttl_rate_limit_reset_at",
				"key":                bson.D{{Key: "reset_at", Value: int32(1)}},
				"expireAfterSeconds": int32(60),
			},
			expected: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := indexMatches(tc.doc, tc.exp)
			if res != tc.expected {
				t.Errorf("expected %v, got %v", tc.expected, res)
			}
		})
	}
}

func TestSystemHandlersUnauthorizedTable(t *testing.T) {
	h := NewHandler(nil, nil, nil)
	endpoints := []struct {
		method string
		path   string
		fn     func(w http.ResponseWriter, r *http.Request)
	}{
		{"GET", "/api/system/health", h.SystemHealth},
		{"GET", "/api/system/mongo/health", h.MongoHealth},
		{"GET", "/api/system/audit/status", h.AuditStatus},
		{"POST", "/api/system/audit/scan", h.AuditScan},
	}

	for _, ep := range endpoints {
		t.Run(ep.method+" "+ep.path, func(t *testing.T) {
			req := httptest.NewRequest(ep.method, ep.path, nil)
			w := httptest.NewRecorder()
			ep.fn(w, req)
			if w.Code != http.StatusUnauthorized {
				t.Errorf("expected 401 for %s, got %d", ep.path, w.Code)
			}
		})
	}
}

func TestSystemHandlersFailureTable(t *testing.T) {
	cli, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("failed to create mongo client: %v", err)
	}
	_ = cli.Disconnect(context.Background())

	xcloudDb := cli.Database("dummy_xcloud")
	appDb := cli.Database("dummy_ops")
	h := NewHandler(xcloudDb, appDb, nil)

	adminPrincipal := &auth.Principal{
		Username:       "admin_user",
		Role:           "admin",
		NormalizedRole: "admin",
	}

	t.Run("GET /api/system/health failure", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/system/health", nil)
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), adminPrincipal))
		w := httptest.NewRecorder()
		h.SystemHealth(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("expected 500, got %d", w.Code)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if m["status"] != "critical" {
			t.Errorf("expected status 'critical', got %v", m["status"])
		}
		if m["score"] != float64(0) {
			t.Errorf("expected score 0, got %v", m["score"])
		}
		if m["error"] != "Comprehensive system health check failed" {
			t.Errorf("expected error 'Comprehensive system health check failed', got %v", m["error"])
		}
		if checkedAt, ok := m["checkedAt"].(string); !ok || checkedAt == "" {
			t.Errorf("expected non-empty checkedAt string, got %v", m["checkedAt"])
		}
	})

	t.Run("GET /api/system/mongo/health degraded failure", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/system/mongo/health", nil)
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), adminPrincipal))
		w := httptest.NewRecorder()
		h.MongoHealth(w, req)

		// Mongo health degrades to HTTP 200 with ok: false
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if m["ok"] != false {
			t.Errorf("expected ok false, got %v", m["ok"])
		}
		if m["database"] != nil {
			t.Errorf("expected database null, got %v", m["database"])
		}
		if m["error"] != "MongoDB health check failed" {
			t.Errorf("expected error 'MongoDB health check failed', got %v", m["error"])
		}
		if colls, ok := m["collections"].([]interface{}); !ok || len(colls) != 0 {
			t.Errorf("expected empty collections array, got %v", m["collections"])
		}
	})

	t.Run("POST /api/system/audit/scan valid json database failure", func(t *testing.T) {
		body := bytes.NewBufferString(`{"cursor":"0","phase":"sub"}`)
		req := httptest.NewRequest(http.MethodPost, "/api/system/audit/scan", body)
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), adminPrincipal))
		w := httptest.NewRecorder()
		h.AuditScan(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("expected 500, got %d", w.Code)
		}
		var m map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if m["error"] != "Audit scan failed" {
			t.Errorf("expected 'Audit scan failed', got %v", m["error"])
		}
	})

	t.Run("POST /api/system/audit/scan malformed json decoder failure", func(t *testing.T) {
		body := strings.NewReader(`invalid-json-body`)
		req := httptest.NewRequest(http.MethodPost, "/api/system/audit/scan", body)
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), adminPrincipal))
		w := httptest.NewRecorder()
		h.AuditScan(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("expected 500, got %d", w.Code)
		}
		var m map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		if m["error"] != "Audit scan failed" {
			t.Errorf("expected 'Audit scan failed', got %v", m["error"])
		}
	})
}
