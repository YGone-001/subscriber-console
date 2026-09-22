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
	"subscriber/internal/auth"
)

// --- Import-specific mocks ---

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

func newImportTestHandler(importRepo ImportRepository, role string) *WriteHandler {
	repo := &Repository{}
	limiter := &mockRateLimiter{allowed: true}
	userRepo := &mockUserRepo{identity: testUserIdentity("testuser", auth.NormalizeRole(role))}
	auditWriter := testAuditWriter()

	h := NewWriteHandler(repo, limiter, userRepo, auditWriter)
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestImport_OperatorDirect(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, "operator")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "operator")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["outcome"] != "executed" {
		t.Fatalf("expected outcome=executed, got %v", resp["outcome"])
	}
}

func TestImport_SuperAdminDirect(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, "super_admin")
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
	h := newImportTestHandler(repo, "root")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "root")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
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
	h := newImportTestHandler(repo, "super_admin")
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

func TestImport_OpsAdminDirect(t *testing.T) {
	repo := &mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}}
	h := newImportTestHandler(repo, "ops_admin")
	body := map[string]any{"records": []any{map[string]any{"imsi": "454000000000001"}}}
	req := importRequest("import", body, "ops_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["outcome"] != "executed" {
		t.Fatalf("expected outcome=executed, got %v", resp["outcome"])
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
	h := newImportTestHandler(repo, "operator")
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
	h := newImportTestHandler(repo, "read_only")
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
	h := newImportTestHandler(repo, "super_admin")
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
	if resp["mutationCommitted"] != false {
		t.Fatalf("expected mutationCommitted=false, got %v", resp["mutationCommitted"])
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
	h := newImportTestHandler(repo, "super_admin")
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
	if resp["partialMutation"] != true {
		t.Fatalf("expected partialMutation=true, got %v", resp["partialMutation"])
	}
	if resp["mutationCommitted"] != true {
		t.Fatalf("expected mutationCommitted=true, got %v", resp["mutationCommitted"])
	}
	ocsFailed := resp["ocsProvisioningFailedImsis"].([]any)
	if len(ocsFailed) != 1 {
		t.Fatalf("expected 1 OCS failure, got %d", len(ocsFailed))
	}
}

// --- Gate B: Go HTTP oversized production Prepare ---

type trackingImportRepo struct {
	mockImportRepo
	insertCalls int
	ocsCalls    int
}

func (t *trackingImportRepo) InsertSubscriberImportCreateOnly(_ context.Context, _ bson.M) error {
	t.insertCalls++
	return nil
}

func (t *trackingImportRepo) ProvisionImportedSubscriberOcs(_ context.Context, _ OcsProvisioningInput) error {
	t.ocsCalls++
	return nil
}

// --- Gate D: Two-target partial-insert ---

type partialInsertRepo struct {
	mockImportRepo
	callCount int
}

func (p *partialInsertRepo) InsertSubscriberImportCreateOnly(_ context.Context, doc bson.M) error {
	p.callCount++
	if p.callCount == 2 {
		// Second insert fails with duplicate key (simulates race)
		return &SubscriberGovernanceError{Code: ErrImportFailed}
	}
	return nil
}

func TestImport_TwoTargetPartialInsert_409(t *testing.T) {
	repo := &partialInsertRepo{
		mockImportRepo: mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}},
	}
	h := newImportTestHandler(repo, "super_admin")
	body := map[string]any{
		"records": []any{
			map[string]any{"imsi": "454000000000911"},
			map[string]any{"imsi": "454000000000912"},
		},
	}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["code"] != "SUBSCRIBER_IMPORT_PARTIAL_WRITE" {
		t.Fatalf("expected SUBSCRIBER_IMPORT_PARTIAL_WRITE, got %v", resp["code"])
	}
	// One created, one failed
	if resp["imported"].(float64) != 1 {
		t.Fatalf("expected imported=1, got %v", resp["imported"])
	}
	if resp["partialMutation"] != true {
		t.Fatalf("expected partialMutation=true, got %v", resp["partialMutation"])
	}
	if resp["mutationCommitted"] != true {
		t.Fatalf("expected mutationCommitted=true, got %v", resp["mutationCommitted"])
	}
}

func TestImport_OversizedSnapshot_HTTP413(t *testing.T) {
	repo := &trackingImportRepo{
		mockImportRepo: mockImportRepo{tariffPlans: map[string]bool{"plan_default_10gb": true}},
	}
	repo2 := &Repository{}
	limiter := &mockRateLimiter{allowed: true}
	userRepo := &mockUserRepo{identity: testUserIdentity("testuser", "super_admin")}
	auditWriter := testAuditWriter()

	h := NewWriteHandler(repo2, limiter, userRepo, auditWriter)
	h.importRepo = repo

	// Generate enough records to exceed 512KB
	records := make([]any, 2000)
	for i := range records {
		records[i] = map[string]any{
			"imsi":                    fmt.Sprintf("45400000%07d", i),
			"access_restriction_data": 32,
			"traffic_total":           10737418240,
			"traffic_balance":         10737418240,
			"sms_total":               100,
			"sms_balance":             100,
			"plan_id":                 "plan_default_10gb",
		}
	}
	body := map[string]any{"records": records}
	req := importRequest("import", body, "super_admin")
	w := httptest.NewRecorder()
	h.Import(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", w.Code, w.Body.String())
	}
	resp := importResponse(w)
	if resp["code"] != ErrApprovalSnapshotTooLarge {
		t.Fatalf("expected %s, got %v", ErrApprovalSnapshotTooLarge, resp["code"])
	}

	// Side-effect gate: none of these should have been called
	if repo.insertCalls != 0 {
		t.Fatalf("Subscriber insert must not be called, got %d", repo.insertCalls)
	}
	if repo.ocsCalls != 0 {
		t.Fatalf("OCS provisioning must not be called, got %d", repo.ocsCalls)
	}
}
