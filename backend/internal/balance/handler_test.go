package balance

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/approval"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/user"
)

type mockRateLimiter struct {
	allowed bool
}

func (m *mockRateLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	return m.allowed
}

type mockUserRepo struct {
	identity *user.UserIdentity
	err      error
}

func (m *mockUserRepo) FindByUsernameIdentity(_ context.Context, _ string) (*user.UserIdentity, error) {
	return m.identity, m.err
}

func testUserIdentity(username, role string) *user.UserIdentity {
	return &user.UserIdentity{
		SafeUser: user.SafeUser{
			Username: username,
			Role:     role,
			Status:   "active",
		},
		MongoID: "usr_" + username,
	}
}

type noopEvidenceStore struct{}

func (n *noopEvidenceStore) Insert(_ context.Context, _ audit.AuditWriteRecord) error { return nil }
func (n *noopEvidenceStore) FindByMongoID(_ context.Context, _ string) (*audit.AuditWriteRecord, error) {
	return nil, nil
}

func testAuditWriter() *audit.Writer {
	return audit.NewWriter(&noopEvidenceStore{}, audit.WriterConfig{})
}

type mockApprovalCreator struct {
	createdDoc *approval.ApprovalDocument
	err        error
	lastInput  *approval.CreateApprovalInput
}

func (m *mockApprovalCreator) Create(r *http.Request, actor approval.GovernanceActor, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error) {
	m.lastInput = &input
	if m.err != nil {
		return nil, m.err
	}
	doc := &approval.ApprovalDocument{
		ID:       "app-test-123",
		Action:   input.Action,
		Status:   approval.StatusPending,
		TargetID: input.TargetID,
		Payload:  input.Payload,
	}
	m.createdDoc = doc
	return doc, nil
}

func reqWithPrincipal(method, path string, body []byte, username, role string) *http.Request {
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	normRole := auth.NormalizeRole(role)
	p := &auth.Principal{
		Username:       username,
		Role:           role,
		NormalizedRole: normRole,
	}
	ctx := auth.ContextWithPrincipal(r.Context(), p)
	return r.WithContext(ctx)
}

// ── Test Reset Permanently Disabled ─────────────────────────────────────────

func TestHandler_Reset_PermanentlyDisabled(t *testing.T) {
	h := NewHandler(nil, &mockRateLimiter{allowed: true}, nil, nil, testAuditWriter())

	req := reqWithPrincipal("POST", "/api/ocs/balances/417010000000001/reset", nil, "admin", "super_admin")
	req.SetPathValue("imsi", "417010000000001")
	w := httptest.NewRecorder()

	h.Reset(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", w.Code)
	}

	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp["error"] != "BALANCE_RESET_DISABLED" {
		t.Errorf("expected error BALANCE_RESET_DISABLED, got %q", resp["error"])
	}
}

// ── Test Adjust Validation ──────────────────────────────────────────────────

func TestHandler_Adjust_Validation(t *testing.T) {
	tests := []struct {
		name       string
		imsi       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			name:       "invalid IMSI",
			imsi:       "abc",
			body:       `{"operation":"credit","bucket":"data","amount":100,"reason":"test"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_IMSI",
		},
		{
			name:       "invalid operation",
			imsi:       "417010000000001",
			body:       `{"operation":"multiply","bucket":"data","amount":100,"reason":"test"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_OPERATION",
		},
		{
			name:       "invalid bucket",
			imsi:       "417010000000001",
			body:       `{"operation":"credit","bucket":"gold","amount":100,"reason":"test"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_BUCKET",
		},
		{
			name:       "invalid amount",
			imsi:       "417010000000001",
			body:       `{"operation":"credit","bucket":"data","amount":0,"reason":"test"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_AMOUNT",
		},
		{
			name:       "missing reason",
			imsi:       "417010000000001",
			body:       `{"operation":"credit","bucket":"data","amount":100,"reason":""}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "REASON_REQUIRED",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			userRepo := &mockUserRepo{identity: testUserIdentity("admin", "super_admin")}
			h := NewHandler(nil, &mockRateLimiter{allowed: true}, userRepo, nil, testAuditWriter())

			req := reqWithPrincipal("POST", "/api/ocs/balances/"+tt.imsi+"/adjust", []byte(tt.body), "admin", "super_admin")
			req.SetPathValue("imsi", tt.imsi)
			w := httptest.NewRecorder()

			h.Adjust(w, req)

			if w.Code != tt.wantStatus {
				t.Fatalf("expected status %d, got %d, body: %s", tt.wantStatus, w.Code, w.Body.String())
			}

			var resp map[string]any
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if resp["code"] != tt.wantCode {
				t.Errorf("expected error code %q, got %v", tt.wantCode, resp["code"])
			}
		})
	}
}

// ── Test Fresh Actor Validation ─────────────────────────────────────────────

func TestHandler_Adjust_RoleMismatch_Rejected(t *testing.T) {
	// Token says super_admin, DB says viewer
	userRepo := &mockUserRepo{identity: testUserIdentity("admin", "viewer")}
	h := NewHandler(nil, &mockRateLimiter{allowed: true}, userRepo, nil, testAuditWriter())

	body := `{"operation":"credit","bucket":"data","amount":100,"reason":"test compensation"}`
	req := reqWithPrincipal("POST", "/api/ocs/balances/417010000000001/adjust", []byte(body), "admin", "super_admin")
	req.SetPathValue("imsi", "417010000000001")
	w := httptest.NewRecorder()

	h.Adjust(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected status 403 Forbidden for role mismatch, got %d", w.Code)
	}
}

func TestHandler_Adjust_Viewer_Forbidden(t *testing.T) {
	userRepo := &mockUserRepo{identity: testUserIdentity("viewer1", "viewer")}
	h := NewHandler(nil, &mockRateLimiter{allowed: true}, userRepo, nil, testAuditWriter())

	body := `{"operation":"credit","bucket":"data","amount":100,"reason":"test compensation"}`
	req := reqWithPrincipal("POST", "/api/ocs/balances/417010000000001/adjust", []byte(body), "viewer1", "viewer")
	req.SetPathValue("imsi", "417010000000001")
	w := httptest.NewRecorder()

	h.Adjust(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for viewer, got %d", w.Code)
	}
}

func TestHandler_Adjust_ApprovalCreation_Operator(t *testing.T) {
	repo, cleanup := setupTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()

	ctx := context.Background()
	testIMSI := "417018888888001"

	// Seed balance doc
	doc := bson.M{
		"imsi":            testIMSI,
		"data_total":      int64(1000),
		"data_used":       int64(0),
		"data_reserved":   int64(0),
		"data_available":  int64(1000),
		"voice_total":     int64(3600),
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": int64(3600),
		"sms_total":       int64(100),
		"sms_used":        int64(0),
		"sms_available":   int64(100),
		"version":         int64(1),
		"status":          "active",
	}
	_, err := repo.balances.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("failed to insert test doc: %v", err)
	}

	mockAppr := &mockApprovalCreator{}
	userRepo := &mockUserRepo{identity: testUserIdentity("op1", "operator")}
	h := NewHandler(repo, &mockRateLimiter{allowed: true}, userRepo, mockAppr, testAuditWriter())

	body := `{"operation":"credit","bucket":"data","amount":500,"reason":"customer compensation","ticketId":"INC1001"}`
	req := reqWithPrincipal("POST", "/api/ocs/balances/"+testIMSI+"/adjust", []byte(body), "op1", "operator")
	req.SetPathValue("imsi", testIMSI)
	w := httptest.NewRecorder()

	h.Adjust(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 Accepted for operator, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["outcome"] != "approval_required" {
		t.Errorf("expected outcome approval_required, got %v", resp["outcome"])
	}
	if resp["approvalId"] != "app-test-123" {
		t.Errorf("expected approvalId app-test-123, got %v", resp["approvalId"])
	}

	// Verify frozen payload schema
	if mockAppr.lastInput == nil {
		t.Fatalf("expected approval input to be captured")
	}
	payload := mockAppr.lastInput.Payload
	if payload["schema"] != "balance-adjustment-v1" {
		t.Errorf("expected schema balance-adjustment-v1, got %v", payload["schema"])
	}
	if payload["imsi"] != testIMSI {
		t.Errorf("expected imsi %s, got %v", testIMSI, payload["imsi"])
	}
	if payload["operation"] != "credit" || payload["bucket"] != "data" {
		t.Errorf("expected credit data, got %v %v", payload["operation"], payload["bucket"])
	}
}

func TestHandler_Adjust_DirectExecution_SuperAdmin(t *testing.T) {
	repo, cleanup := setupTestDB(t)
	if repo == nil {
		return
	}
	defer cleanup()

	ctx := context.Background()
	testIMSI := "417018888888002"

	doc := bson.M{
		"imsi":            testIMSI,
		"data_total":      int64(2000),
		"data_used":       int64(200),
		"data_reserved":   int64(0),
		"data_available":  int64(1800),
		"voice_total":     int64(3600),
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": int64(3600),
		"sms_total":       int64(100),
		"sms_used":        int64(0),
		"sms_available":   int64(100),
		"version":         int64(2),
		"status":          "active",
	}
	_, err := repo.balances.InsertOne(ctx, doc)
	if err != nil {
		t.Fatalf("failed to insert test doc: %v", err)
	}

	userRepo := &mockUserRepo{identity: testUserIdentity("admin", "super_admin")}
	h := NewHandler(repo, &mockRateLimiter{allowed: true}, userRepo, nil, testAuditWriter())

	body := `{"operation":"credit","bucket":"data","amount":1000,"reason":"direct grant","ticketId":"INC2002"}`
	req := reqWithPrincipal("POST", "/api/ocs/balances/"+testIMSI+"/adjust", []byte(body), "admin", "super_admin")
	req.SetPathValue("imsi", testIMSI)
	w := httptest.NewRecorder()

	h.Adjust(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for super_admin, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["outcome"] != "executed" {
		t.Errorf("expected outcome executed, got %v", resp["outcome"])
	}

	// Verify MongoDB was directly updated
	updated, err := repo.GetBalanceByIMSI(ctx, testIMSI)
	if err != nil || updated == nil {
		t.Fatalf("failed to load updated balance: %v", err)
	}
	if updated.DataTotal != 3000 || updated.DataAvailable != 2800 {
		t.Errorf("expected total 3000 avail 2800, got total %d avail %d", updated.DataTotal, updated.DataAvailable)
	}
	if updated.Version != 3 {
		t.Errorf("expected version 3, got %d", updated.Version)
	}
}
