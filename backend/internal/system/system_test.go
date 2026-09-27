package system

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"

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
