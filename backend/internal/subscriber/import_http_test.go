package subscriber

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/approval"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
)

// --- Import-specific mocks ---

type mockApprovalQuerier struct {
	activeApprovals map[string][]approval.ApprovalDocument
}

func (m *mockApprovalQuerier) ListApprovals(_ context.Context, _ approval.ListQuery) (*approval.ListResult, error) {
	return &approval.ListResult{}, nil
}

func (m *mockApprovalQuerier) ListActiveByAction(_ context.Context, action string) ([]approval.ApprovalDocument, error) {
	if m.activeApprovals == nil {
		return nil, nil
	}
	return m.activeApprovals[action], nil
}

type mockImportRepo struct {
	existingImsis map[string]bool
	tariffPlans   map[string]bool
	insertedDocs  []bson.M
	ocsInputs     []OcsProvisioningInput
}

func (m *mockImportRepo) FindSubscribersForImport(_ context.Context, imsis []string) (map[string]bool, error) {
	result := make(map[string]bool)
	for _, imsi := range imsis {
		result[imsi] = m.existingImsis[imsi]
	}
	return result, nil
}

func (m *mockImportRepo) InsertSubscriberImportCreateOnly(_ context.Context, doc bson.M) error {
	m.insertedDocs = append(m.insertedDocs, doc)
	return nil
}

func (m *mockImportRepo) ProvisionImportedSubscriberOcs(_ context.Context, input OcsProvisioningInput) error {
	m.ocsInputs = append(m.ocsInputs, input)
	return nil
}

func (m *mockImportRepo) ValidateTariffPlan(_ context.Context, planId string) error {
	if m.tariffPlans != nil && !m.tariffPlans[planId] {
		return &SubscriberGovernanceError{Code: "OCS_PLAN_NOT_FOUND"}
	}
	return nil
}

// --- Helper to build a WriteHandler with import test seam ---

func newImportTestHandler(importRepo ImportRepository, approvalQry ApprovalQuerier, role string) *WriteHandler {
	repo := &Repository{}
	limiter := &mockRateLimiter{allowed: true}
	userRepo := &mockUserRepo{identity: testUserIdentity("testuser", auth.NormalizeRole(role))}
	approvalSvc := &mockApprovalCreator{
		doc: &approval.ApprovalDocument{
			ID:     "approval-123",
			Action: "SUBSCRIBER_IMPORT",
			Status: "pending",
		},
	}
	auditWriter := testAuditWriter()

	h := NewWriteHandler(repo, limiter, userRepo, approvalSvc, approvalQry, auditWriter)
	h.importRepo = importRepo
	return h
}

func importRequest(mode string, body map[string]any, role string) *http.Request {
	data, _ := json.Marshal(body)
	url := "/api/subscribers/import?mode=" + mode
	req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	ctx := auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		Username:       "testuser",
		NormalizedRole: auth.NormalizeRole(role),
		SessionVersion: 1,
	})
	return req.WithContext(ctx)
}

func importResponse(w *httptest.ResponseRecorder) map[string]any {
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	return result
}

// ---------------------------------------------------------------------------
// Section 6: Go HTTP Acceptance Tests
// ---------------------------------------------------------------------------

func TestImport_Precheck(t *testing.T) {
	repo := &mockImportRepo{
		existingImsis: map[string]bool{"454000000000001": true},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"imsiList": []any{"454000000000001", "454000000000002"}}
	req := importRequest("precheck", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["total"].(float64) != 2 {
		t.Fatalf("expected total 2, got %v", resp["total"])
	}
	if resp["existing"].(float64) != 1 {
		t.Fatalf("expected existing 1, got %v", resp["existing"])
	}
}

func TestImport_EmptyRecords(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_InvalidImsi(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "invalid"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_DuplicateImsi(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{
		map[string]any{"imsi": "454000000000001"},
		map[string]any{"imsi": "454000000000001"},
	}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_UnknownField(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001", "unknown_field": "value"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_SensitiveKey(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	for _, key := range []string{"k", "op", "opc", "amf", "sqn"} {
		body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001", key: "00000000000000000000000000000000"}}}
		req := importRequest("import", body, "operator")
		w := httptest.NewRecorder()
		h.Import(w, req)
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("expected 422 for key %s, got %d: %s", key, w.Code, w.Body.String())
		}
		resp := importResponse(w)
		if resp["code"] != "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED" {
			t.Fatalf("expected SENSITIVE code for key %s, got %v", key, resp["code"])
		}
	}
}

func TestImport_Overwrite(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}, "overwrite": true}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_MissingTariff(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{}} // no plans
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_OperatorApproval(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["requiresApproval"] != true {
		t.Fatalf("expected requiresApproval=true, got %v", resp["requiresApproval"])
	}
}

func TestImport_SuperAdminDirect(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "super_admin")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["outcome"] != "executed" {
		t.Fatalf("expected outcome=executed, got %v", resp["outcome"])
	}
	result := resp["result"].(map[string]any)
	if result["imported"].(float64) != 1 {
		t.Fatalf("expected imported=1, got %v", result["imported"])
	}
}

func TestImport_RootDirect(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "root")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "root")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_ExactDuplicateApproval(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	// Compute the fingerprint that Prepare will produce
	rawRec := map[string]any{"imsi": "454000000000001"}
	normalized := NormalizeImportRecord(rawRec)
	recHash := ComputeRecordIntentHash(normalized)
	targets := []ImportTarget{{Imsi: "454000000000001", State: "absent", RecordIntentHash: recHash}}
	fileHash := ComputeFileHash([]ImportRecord{normalized})
	fp := ComputeImportFingerprint(targets, "skip-existing-create-only", fileHash)

	approvals := map[string][]approval.ApprovalDocument{
		"SUBSCRIBER_IMPORT": {
			{ID: "existing-approval", Action: "SUBSCRIBER_IMPORT", Status: "pending", OperationFingerprint: fp},
		},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{activeApprovals: approvals}, "operator")
	body := map[string]any{"records": []any{rawRec}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["idempotent"] != true {
		t.Fatalf("expected idempotent=true, got %v", resp["idempotent"])
	}
}

func TestImport_OverlapConflict(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	// Active approval targeting same IMSI we want to create
	approvals := map[string][]approval.ApprovalDocument{
		"SUBSCRIBER_BATCH_CREATE": {
			{
				ID:     "other-approval",
				Action: "SUBSCRIBER_BATCH_CREATE",
				Status: "pending",
				Payload: map[string]any{
					"targets": []any{map[string]any{"imsi": "454000000000001"}},
				},
			},
		},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{activeApprovals: approvals}, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["error"] != "ACTIVE_CHANGE_CONFLICT" {
		t.Fatalf("expected ACTIVE_CHANGE_CONFLICT, got %v", resp["error"])
	}
}

func TestImport_DirectOverlapConflict(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	approvals := map[string][]approval.ApprovalDocument{
		"SUBSCRIBER_BATCH_CREATE": {
			{
				ID:     "other-approval",
				Action: "SUBSCRIBER_BATCH_CREATE",
				Status: "pending",
				Payload: map[string]any{
					"targets": []any{map[string]any{"imsi": "454000000000001"}},
				},
			},
		},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{activeApprovals: approvals}, "super_admin")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

// driftImportRepo returns different results on second call to simulate precondition drift.
type driftImportRepo struct {
	mockImportRepo
	callCount int
}

func (d *driftImportRepo) FindSubscribersForImport(_ context.Context, imsis []string) (map[string]bool, error) {
	d.callCount++
	result := make(map[string]bool)
	if d.callCount >= 2 {
		// Second call (execute): IMSI now exists (drift)
		for _, imsi := range imsis {
			result[imsi] = true
		}
	} else {
		// First call (prepare): IMSI absent
		for _, imsi := range imsis {
			result[imsi] = false
		}
	}
	return result, nil
}

func TestImport_PreconditionDrift(t *testing.T) {
	repo := &driftImportRepo{
		mockImportRepo: mockImportRepo{
			tariffPlans: map[string]bool{"plan_default_10gb": true},
		},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "super_admin")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	// Prepare says absent, execute says present → 409
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["error"] != "SUBSCRIBER_IMPORT_PRECONDITION_CHANGED" {
		t.Fatalf("expected SUBSCRIBER_IMPORT_PRECONDITION_CHANGED, got %v", resp["error"])
	}
}

func TestImport_OpsAdminApproval(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "ops_admin")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "ops_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["requiresApproval"] != true {
		t.Fatalf("expected requiresApproval=true, got %v", resp["requiresApproval"])
	}
}

// disabledTariffRepo returns OCS_PLAN_DISABLED for all plans.
type disabledTariffRepo struct {
	mockImportRepo
}

func (d *disabledTariffRepo) ValidateTariffPlan(_ context.Context, planId string) error {
	return &SubscriberGovernanceError{Code: "OCS_PLAN_DISABLED"}
}

func TestImport_DisabledTariff(t *testing.T) {
	repo := &disabledTariffRepo{
		mockImportRepo: mockImportRepo{
			tariffPlans: map[string]bool{"plan_default_10gb": true},
		},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["code"] != "OCS_PLAN_DISABLED" {
		t.Fatalf("expected OCS_PLAN_DISABLED, got %v", resp["code"])
	}
}

func TestImport_InsufficientPermissions(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "read_only")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "read_only")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

// --- Zero storage / partial insert / OCS failure / audit unavailable ---

type failingInsertRepo struct {
	mockImportRepo
}

func (f *failingInsertRepo) InsertSubscriberImportCreateOnly(_ context.Context, _ bson.M) error {
	return &SubscriberGovernanceError{Code: ErrImportFailed}
}

func TestImport_ZeroStorage_500(t *testing.T) {
	repo := &failingInsertRepo{
		mockImportRepo: mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "super_admin")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["code"] != ErrImportFailed {
		t.Fatalf("expected %s, got %v", ErrImportFailed, resp["code"])
	}
}

type failingOcsRepo struct {
	mockImportRepo
}

func (f *failingOcsRepo) ProvisionImportedSubscriberOcs(_ context.Context, _ OcsProvisioningInput) error {
	return fmt.Errorf("OCS provisioning failed")
}

func TestImport_OcsFailure_PartialWrite(t *testing.T) {
	repo := &failingOcsRepo{
		mockImportRepo: mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}},
	}
	h := newImportTestHandler(repo, &mockApprovalQuerier{}, "super_admin")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	// OCS failure → PARTIAL_WRITE → 409
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["code"] != "SUBSCRIBER_IMPORT_PARTIAL_WRITE" {
		t.Fatalf("expected SUBSCRIBER_IMPORT_PARTIAL_WRITE, got %v", resp["code"])
	}
	// Record was created but OCS failed
	if resp["imported"].(float64) != 1 {
		t.Fatalf("expected imported=1, got %v", resp["imported"])
	}
	ocsFailed := resp["ocsProvisioningFailedImsis"].([]any)
	if len(ocsFailed) != 1 {
		t.Fatalf("expected 1 OCS failure, got %d", len(ocsFailed))
	}
}

type failingEvidenceStore struct{}

func (f *failingEvidenceStore) Insert(_ context.Context, _ audit.AuditWriteRecord) error {
	return fmt.Errorf("audit store unavailable")
}
func (f *failingEvidenceStore) FindByMongoID(_ context.Context, _ string) (*audit.AuditWriteRecord, error) {
	return nil, fmt.Errorf("audit store unavailable")
}

func TestImport_AuditUnavailable_503(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	repo2 := &Repository{}
	limiter := &mockRateLimiter{allowed: true}
	userRepo := &mockUserRepo{identity: testUserIdentity("testuser", "super_admin")}
	approvalSvc := &mockApprovalCreator{
		doc: &approval.ApprovalDocument{
			ID:     "approval-123",
			Action: "SUBSCRIBER_IMPORT",
			Status: "pending",
		},
	}
	auditWriter := audit.NewWriter(&failingEvidenceStore{}, audit.WriterConfig{})

	h := NewWriteHandler(repo2, limiter, userRepo, approvalSvc, &mockApprovalQuerier{}, auditWriter)
	h.importRepo = repo

	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["code"] != "AUDIT_UNAVAILABLE" {
		t.Fatalf("expected AUDIT_UNAVAILABLE, got %v", resp["code"])
	}
}
