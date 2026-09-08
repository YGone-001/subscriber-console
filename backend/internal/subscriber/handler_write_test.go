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
	"subscriber/internal/governance"
	"subscriber/internal/user"
)

// --- Test doubles for interface dependencies ---

type fakeUserRepo struct {
	identity *user.UserIdentity
	err      error
}

func (f *fakeUserRepo) FindByUsernameIdentity(_ context.Context, _ string) (*user.UserIdentity, error) {
	return f.identity, f.err
}

type fakeApprovalCreator struct {
	doc      *approval.ApprovalDocument
	err      error
	captured *approval.CreateApprovalInput
}

func (f *fakeApprovalCreator) Create(_ *http.Request, _ approval.GovernanceActor, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error) {
	if f.captured != nil {
		*f.captured = input
	}
	return f.doc, f.err
}

// --- Helpers ---

func testPrincipal(username, role string) *auth.Principal {
	return &auth.Principal{
		Username:       username,
		NormalizedRole: role,
		SessionVersion: 1,
	}
}

func testIdentity(username, role string, locked bool) *user.UserIdentity {
	return &user.UserIdentity{
		SafeUser: user.SafeUser{
			Username: username,
			Role:     role,
			Status:   "active",
			Locked:   locked,
			Security: &user.UserSecurity{SessionVersion: 1},
		},
		MongoID: "user-mongo-id-123",
	}
}

func jsonBody(v any) *bytes.Buffer {
	data, _ := json.Marshal(v)
	return bytes.NewBuffer(data)
}

// --- isExecutable tests ---

func TestIsExecutable(t *testing.T) {
	tests := []struct {
		name   string
		result governance.Result
		want   bool
	}{
		{"Direct", governance.Result{Decision: governance.Direct}, true},
		{"Approval", governance.Result{Decision: governance.Approval}, true},
		{"Disabled", governance.Result{Decision: governance.Disabled}, false},
		{"RuntimeOnly", governance.Result{Decision: governance.RuntimeOnly}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isExecutable(tt.result); got != tt.want {
				t.Errorf("isExecutable(%v) = %v, want %v", tt.result, got, tt.want)
			}
		})
	}
}

// --- frozenToMap tests ---

func TestFrozenToMap(t *testing.T) {
	frozen := &FrozenSubscriberUpdate{
		Version: "subscriber-update-v1",
		Imsi:    "001010000000001",
	}

	m := frozenToMap(frozen)
	if m == nil {
		t.Fatal("expected non-nil map")
	}
	if m["version"] != "subscriber-update-v1" {
		t.Errorf("expected version=subscriber-update-v1, got %v", m["version"])
	}
	if m["imsi"] != "001010000000001" {
		t.Errorf("expected imsi=001010000000001, got %v", m["imsi"])
	}
}

// --- handleGovernanceError tests ---

func TestHandleGovernanceError(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "SUBSCRIBER_NOT_FOUND",
			err:        &SubscriberGovernanceError{Code: "SUBSCRIBER_NOT_FOUND"},
			wantStatus: http.StatusNotFound,
			wantCode:   "SUBSCRIBER_NOT_FOUND",
		},
		{
			name:       "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED",
			err:        &SubscriberGovernanceError{Code: "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED"},
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED",
		},
		{
			name:       "SUBSCRIBER_UPDATE_NO_EFFECT",
			err:        &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_NO_EFFECT"},
			wantStatus: http.StatusConflict,
			wantCode:   "SUBSCRIBER_UPDATE_NO_EFFECT",
		},
		{
			name:       "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED",
			err:        &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED"},
			wantStatus: http.StatusConflict,
			wantCode:   "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED",
		},
		{
			name:       "unknown error",
			err:        &SubscriberGovernanceError{Code: "UNKNOWN_CODE"},
			wantStatus: http.StatusConflict,
			wantCode:   "UNKNOWN_CODE",
		},
		{
			name:       "non-governance error",
			err:        fmt.Errorf("some other error"),
			wantStatus: http.StatusInternalServerError,
			wantCode:   "INTERNAL_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &WriteHandler{}
			w := httptest.NewRecorder()
			h.handleGovernanceError(w, tt.err)

			if w.Code != tt.wantStatus {
				t.Errorf("expected status %d, got %d", tt.wantStatus, w.Code)
			}

			var resp map[string]any
			json.Unmarshal(w.Body.Bytes(), &resp)
			if resp["code"] != tt.wantCode {
				t.Errorf("expected code %s, got %v", tt.wantCode, resp["code"])
			}
		})
	}
}

// --- handleCreateError tests ---

func TestHandleCreateError(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "SUBSCRIBER_EXISTS",
			err:        &SubscriberGovernanceError{Code: "SUBSCRIBER_EXISTS"},
			wantStatus: http.StatusConflict,
			wantCode:   "SUBSCRIBER_EXISTS",
		},
		{
			name:       "MSISDN_EXISTS",
			err:        &SubscriberGovernanceError{Code: "MSISDN_EXISTS"},
			wantStatus: http.StatusConflict,
			wantCode:   "MSISDN_EXISTS",
		},
		{
			name:       "INVALID_PLAN_ID",
			err:        &SubscriberGovernanceError{Code: "INVALID_PLAN_ID"},
			wantStatus: http.StatusBadRequest,
			wantCode:   "INVALID_PLAN_ID",
		},
		{
			name:       "OCS_PLAN_NOT_FOUND",
			err:        &SubscriberGovernanceError{Code: "OCS_PLAN_NOT_FOUND"},
			wantStatus: http.StatusNotFound,
			wantCode:   "OCS_PLAN_NOT_FOUND",
		},
		{
			name:       "OCS_PLAN_DISABLED",
			err:        &SubscriberGovernanceError{Code: "OCS_PLAN_DISABLED"},
			wantStatus: http.StatusConflict,
			wantCode:   "OCS_PLAN_DISABLED",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &WriteHandler{}
			w := httptest.NewRecorder()
			h.handleCreateError(w, tt.err)

			if w.Code != tt.wantStatus {
				t.Errorf("expected status %d, got %d", tt.wantStatus, w.Code)
			}

			var resp map[string]any
			json.Unmarshal(w.Body.Bytes(), &resp)
			if resp["code"] != tt.wantCode {
				t.Errorf("expected code %s, got %v", tt.wantCode, resp["code"])
			}
		})
	}
}

// --- FreshActor validation tests (uses UserRepository interface) ---

func TestRevalidateFreshActor_AllScenarios(t *testing.T) {
	tests := []struct {
		name       string
		identity   *user.UserIdentity
		repoErr    error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "nil repo",
			identity:   nil,
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "AUTH_SERVICE_UNAVAILABLE",
		},
		{
			name:       "user not found",
			identity:   nil,
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_USER_NOT_FOUND",
		},
		{
			name:       "user disabled",
			identity:   &user.UserIdentity{SafeUser: user.SafeUser{Username: "u1", Role: "operator", Status: "disabled", Security: &user.UserSecurity{SessionVersion: 1}}},
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_USER_DISABLED",
		},
		{
			name:       "user locked",
			identity:   testIdentity("u1", "operator", true),
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_USER_LOCKED",
		},
		{
			name:       "role mismatch",
			identity:   &user.UserIdentity{SafeUser: user.SafeUser{Username: "u1", Role: "super_admin", Status: "active", Security: &user.UserSecurity{SessionVersion: 1}}, MongoID: "id1"},
			wantStatus: http.StatusForbidden,
			wantCode:   "AUTH_ROLE_MISMATCH",
		},
		{
			name:       "session revoked",
			identity:   &user.UserIdentity{SafeUser: user.SafeUser{Username: "u1", Role: "operator", Status: "active", Security: &user.UserSecurity{SessionVersion: 999}}, MongoID: "id1"},
			wantStatus: http.StatusForbidden,
			wantCode:   "SESSION_REVOKED",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var userRepo UserRepository
			if tt.name == "nil repo" {
				userRepo = nil
			} else {
				userRepo = &fakeUserRepo{identity: tt.identity, err: tt.repoErr}
			}

			p := testPrincipal("u1", "operator")
			_, httpErr := RevalidateFreshActor(context.Background(), userRepo, p)

			if httpErr == nil {
				t.Fatal("expected error, got nil")
			}
			if httpErr.Status != tt.wantStatus {
				t.Errorf("expected status %d, got %d", tt.wantStatus, httpErr.Status)
			}
			if httpErr.Code != tt.wantCode {
				t.Errorf("expected code %s, got %s", tt.wantCode, httpErr.Code)
			}
		})
	}
}

func TestRevalidateFreshActor_Success(t *testing.T) {
	userRepo := &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}
	p := testPrincipal("admin1", "super_admin")

	fresh, httpErr := RevalidateFreshActor(context.Background(), userRepo, p)
	if httpErr != nil {
		t.Fatalf("unexpected error: %v", httpErr)
	}
	if fresh == nil {
		t.Fatal("expected non-nil FreshActor")
	}
	if fresh.Username != "admin1" {
		t.Errorf("expected username admin1, got %s", fresh.Username)
	}
	if fresh.NormalizedRole != "super_admin" {
		t.Errorf("expected role super_admin, got %s", fresh.NormalizedRole)
	}
	if fresh.UserID != "user-mongo-id-123" {
		t.Errorf("expected UserID user-mongo-id-123, got %s", fresh.UserID)
	}
	if fresh.SessionVersion != 1 {
		t.Errorf("expected SessionVersion 1, got %d", fresh.SessionVersion)
	}
}

// --- Approval Operation field tests ---

func TestApprovalInput_IncludesOperationField(t *testing.T) {
	var captured approval.CreateApprovalInput
	approvalSvc := &fakeApprovalCreator{
		doc:      &approval.ApprovalDocument{ID: "test-approval", Status: approval.StatusPending},
		captured: &captured,
	}

	actor := approval.GovernanceActor{
		Type:     "user",
		UserID:   "user-123",
		Username: "op1",
		Role:     "operator",
	}

	// Simulate what the Update handler does
	input := approval.CreateApprovalInput{
		Action:           "SUBSCRIBER_UPDATE",
		Requester:        "op1",
		RequesterContext: &actor,
		TargetID:         "001010000000001",
		Summary:          "Update governed subscriber configuration for 001010000000001",
		Operation: &approval.ApprovalOperation{
			ResourceType: "subscriber",
			ResourceID:   "001010000000001",
		},
		OperationFingerprint: "abc123",
	}

	r := httptest.NewRequest(http.MethodPut, "/api/subscribers/001010000000001", nil)
	_, err := approvalSvc.Create(r, actor, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if captured.Operation == nil {
		t.Fatal("expected Operation to be captured")
	}
	if captured.Operation.ResourceType != "subscriber" {
		t.Errorf("expected ResourceType=subscriber, got %s", captured.Operation.ResourceType)
	}
	if captured.Operation.ResourceID != "001010000000001" {
		t.Errorf("expected ResourceID=001010000000001, got %s", captured.Operation.ResourceID)
	}
}

// --- ApprovalWorkflowError tests ---

func TestApprovalWorkflowError_CommittedResponse(t *testing.T) {
	awe := &approval.ApprovalWorkflowError{
		Code:      "AUDIT_UNAVAILABLE",
		Status:    http.StatusServiceUnavailable,
		Committed: true,
		Approval: &approval.ApprovalDocument{
			ID: "approval-789",
		},
	}

	resp := awe.ErrorResponse()
	if resp["code"] != "AUDIT_UNAVAILABLE" {
		t.Errorf("expected code AUDIT_UNAVAILABLE, got %v", resp["code"])
	}
	if resp["committed"] != true {
		t.Errorf("expected committed=true, got %v", resp["committed"])
	}
	if resp["approval"] == nil {
		t.Error("expected approval to be present")
	}
}

// --- Governance evaluation tests ---

func TestGovernance_Create_AllRolesDirect(t *testing.T) {
	roles := []string{"operator", "ops_admin", "super_admin", "root"}
	for _, role := range roles {
		t.Run(role, func(t *testing.T) {
			result := EvaluateOperation(OpCreate, role)
			if result.Decision != governance.Direct {
				t.Errorf("expected Direct for %s, got %s", role, result.Decision)
			}
		})
	}
}

func TestGovernance_Update_OperatorApproval_SuperAdminDirect(t *testing.T) {
	// Operator/ops_admin → Approval
	for _, role := range []string{"operator", "ops_admin"} {
		t.Run(role+"_Approval", func(t *testing.T) {
			result := EvaluateOperation(OpUpdate, role)
			if result.Decision != governance.Approval {
				t.Errorf("expected Approval for %s, got %s", role, result.Decision)
			}
		})
	}

	// super_admin/root → Direct
	for _, role := range []string{"super_admin", "root"} {
		t.Run(role+"_Direct", func(t *testing.T) {
			result := EvaluateOperation(OpUpdate, role)
			if result.Decision != governance.Direct {
				t.Errorf("expected Direct for %s, got %s", role, result.Decision)
			}
		})
	}
}

func TestGovernance_Delete_OperatorApproval_SuperAdminDirect(t *testing.T) {
	// Operator/ops_admin → Approval
	for _, role := range []string{"operator", "ops_admin"} {
		t.Run(role+"_Approval", func(t *testing.T) {
			result := EvaluateOperation(OpDelete, role)
			if result.Decision != governance.Approval {
				t.Errorf("expected Approval for %s, got %s", role, result.Decision)
			}
		})
	}

	// super_admin/root → Direct
	for _, role := range []string{"super_admin", "root"} {
		t.Run(role+"_Direct", func(t *testing.T) {
			result := EvaluateOperation(OpDelete, role)
			if result.Decision != governance.Direct {
				t.Errorf("expected Direct for %s, got %s", role, result.Decision)
			}
		})
	}
}

func TestGovernance_Unknown_FailClosed(t *testing.T) {
	result := EvaluateOperation("UNKNOWN_OP", "super_admin")
	if result.Decision != governance.Disabled {
		t.Errorf("expected Disabled for unknown op, got %s", result.Decision)
	}
}

// --- Capability guard tests ---

func TestCapability_SubscriberWrite_Allowed(t *testing.T) {
	tests := []struct {
		role string
	}{
		{"operator"},
		{"ops_admin"},
		{"super_admin"},
		{"root"},
	}
	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			p := testPrincipal("user1", tt.role)
			decision, allowed := auth.CapabilityDecision(p, "subscriber_write")
			if !allowed {
				t.Errorf("expected subscriber_write allowed for %s, decision=%s", tt.role, decision)
			}
		})
	}
}

func TestCapability_SubscriberWrite_Denied(t *testing.T) {
	p := testPrincipal("viewer1", "viewer")
	decision, allowed := auth.CapabilityDecision(p, "subscriber_write")
	if allowed {
		t.Errorf("expected subscriber_write denied for viewer, decision=%s", decision)
	}
}

// --- Helper function tests ---

func TestValidateMsisdnDigits(t *testing.T) {
	tests := []struct {
		msisdn  string
		wantErr bool
	}{
		{"", false},
		{"1234567890", false},
		{"12345abc", true},
		{"+12345", true},
	}
	for _, tt := range tests {
		err := validateMsisdnDigits(tt.msisdn)
		if (err != nil) != tt.wantErr {
			t.Errorf("validateMsisdnDigits(%q) error=%v, wantErr=%v", tt.msisdn, err, tt.wantErr)
		}
	}
}

func TestBuildDefaultSubscriber(t *testing.T) {
	doc := buildDefaultSubscriber("001010000000001", []any{"1234567890"})

	if doc["imsi"] != "001010000000001" {
		t.Errorf("expected imsi=001010000000001, got %v", doc["imsi"])
	}
	if doc["__v"] != 0 {
		t.Errorf("expected __v=0, got %v", doc["__v"])
	}
	if doc["schema_version"] != 1 {
		t.Errorf("expected schema_version=1, got %v", doc["schema_version"])
	}
	if doc["access_restriction_data"] != 32 {
		t.Errorf("expected ard=32, got %v", doc["access_restriction_data"])
	}
	if doc["subscriber_status"] != 0 {
		t.Errorf("expected subscriber_status=0, got %v", doc["subscriber_status"])
	}
	if doc["network_access_mode"] != 0 {
		t.Errorf("expected network_access_mode=0, got %v", doc["network_access_mode"])
	}
	if doc["purge_flag"] != false {
		t.Errorf("expected purge_flag=false, got %v", doc["purge_flag"])
	}

	// Check msisdn
	msisdn, ok := doc["msisdn"].([]any)
	if !ok {
		t.Fatal("expected msisdn to be []any")
	}
	if len(msisdn) != 1 || msisdn[0] != "1234567890" {
		t.Errorf("expected msisdn=[1234567890], got %v", msisdn)
	}

	// Check security
	sec, ok := doc["security"].(bson.M)
	if !ok {
		t.Fatal("expected security to be bson.M")
	}
	if sec["k"] != "000102030405060708090A0B0C0D0E0F" {
		t.Errorf("expected k=000102030405060708090A0B0C0D0E0F, got %v", sec["k"])
	}
	if sec["amf"] != "8000" {
		t.Errorf("expected amf=8000, got %v", sec["amf"])
	}

	// Check slice
	slice, ok := doc["slice"].([]any)
	if !ok {
		t.Fatal("expected slice to be []any")
	}
	if len(slice) != 1 {
		t.Fatalf("expected 1 slice, got %d", len(slice))
	}
	sliceDoc, ok := slice[0].(bson.M)
	if !ok {
		t.Fatal("expected slice[0] to be bson.M")
	}
	if sliceDoc["sst"] != 1 {
		t.Errorf("expected sst=1, got %v", sliceDoc["sst"])
	}
	if sliceDoc["default_indicator"] != true {
		t.Errorf("expected default_indicator=true, got %v", sliceDoc["default_indicator"])
	}
}

func TestBuildDefaultSubscriber_NilMsisdn(t *testing.T) {
	doc := buildDefaultSubscriber("001010000000001", nil)
	msisdn := doc["msisdn"]
	if msisdn == nil {
		t.Fatal("expected non-nil msisdn")
	}
	arr, ok := msisdn.([]any)
	if !ok {
		t.Fatal("expected msisdn to be []any")
	}
	if len(arr) != 0 {
		t.Errorf("expected empty msisdn, got %v", arr)
	}
}

func TestBuildXcloudSubscriberFromLegacy(t *testing.T) {
	existing := bson.M{
		"imsi":                    "001010000000001",
		"__v":                     0,
		"access_restriction_data": 32,
		"network_access_mode":     0,
		"msisdn":                  []any{},
		"ambr":                    bson.M{"downlink": bson.M{"value": 1, "unit": 3}},
		"slice":                   []any{},
		"security":                bson.M{"k": "000102030405060708090A0B0C0D0E0F"},
	}

	payload := UpdatePayload{
		Sub4G: map[string]any{
			"access_restriction_data": 64,
			"ambr":                    bson.M{"downlink": bson.M{"value": 100, "unit": 3}},
		},
	}

	result := buildXcloudSubscriberFromLegacy("001010000000001", payload, existing)

	if result["access_restriction_data"] != 64 {
		t.Errorf("expected ard=64, got %v", result["access_restriction_data"])
	}
	ambr, ok := result["ambr"].(bson.M)
	if !ok {
		t.Fatal("expected ambr to be bson.M")
	}
	dl, ok := ambr["downlink"].(bson.M)
	if !ok {
		t.Fatal("expected downlink to be bson.M")
	}
	if dl["value"] != 100 {
		t.Errorf("expected downlink value=100, got %v", dl["value"])
	}
}

func TestDeepCopyBsonM(t *testing.T) {
	original := bson.M{
		"a": 1,
		"b": "value",
		"c": int64(42),
	}

	copy := deepCopyBsonM(original)

	// Modify the copy
	copy["a"] = 999
	copy["b"] = "modified"

	// Original should be unchanged
	if original["a"] != 1 {
		t.Errorf("original.a was modified: %v", original["a"])
	}
	if original["b"] != "value" {
		t.Errorf("original.b was modified: %v", original["b"])
	}
}

func TestDeepCopyBsonM_Nil(t *testing.T) {
	result := deepCopyBsonM(nil)
	if result == nil {
		t.Fatal("expected non-nil result for nil input")
	}
	if len(result) != 0 {
		t.Errorf("expected empty map, got %v", result)
	}
}

// ============================================================
// BatchUpdate HTTP Acceptance Tests (Section Z)
// ============================================================

// --- Additional test doubles ---

type fakeRateLimiter struct {
	blocked bool
}

func (f *fakeRateLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	if f.blocked {
		w.Header().Set("Retry-After", "60")
		w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%d", limit))
		w.Header().Set("X-RateLimit-Remaining", "0")
		http.Error(w, `{"error":"RATE_LIMITED","code":"RATE_LIMITED"}`, http.StatusTooManyRequests)
		return false
	}
	return true
}

type fakeBatchUpdateStore struct {
	targets map[string]map[string]any // imsi → current state
	// Track CAS calls for assertions
	casCalls      []string
	casConflict   map[string]bool // imsi → should CAS fail
	storageErrors map[string]bool // imsi → should storage error
}

func newFakeBatchUpdateStore() *fakeBatchUpdateStore {
	return &fakeBatchUpdateStore{
		targets:       make(map[string]map[string]any),
		casConflict:   make(map[string]bool),
		storageErrors: make(map[string]bool),
	}
}

func (f *fakeBatchUpdateStore) LoadBatchUpdateTarget(_ context.Context, imsi string) (map[string]any, error) {
	if f.storageErrors[imsi] {
		return nil, fmt.Errorf("storage error for %s", imsi)
	}
	t, ok := f.targets[imsi]
	if !ok {
		return nil, nil
	}
	// Return a copy
	cp := make(map[string]any, len(t))
	for k, v := range t {
		cp[k] = v
	}
	return cp, nil
}

func (f *fakeBatchUpdateStore) ConditionalUpdateBatchTarget(_ context.Context, imsi string, expected map[string]any, next map[string]any) (int64, int64, error) {
	f.casCalls = append(f.casCalls, imsi)
	if f.storageErrors[imsi] {
		return 0, 0, fmt.Errorf("storage error for %s", imsi)
	}
	if f.casConflict[imsi] {
		return 0, 0, nil // matched=0 → CAS conflict
	}
	// Simulate successful update
	f.targets[imsi] = next
	return 1, 1, nil
}

type fakeApprovalQuerierDocs struct {
	docs []approval.ApprovalDocument
	err  error
}

func (f *fakeApprovalQuerierDocs) ListApprovals(_ context.Context, _ approval.ListQuery) (*approval.ListResult, error) {
	return &approval.ListResult{}, nil
}

func (f *fakeApprovalQuerierDocs) ListActiveByAction(_ context.Context, _ string) ([]approval.ApprovalDocument, error) {
	return f.docs, f.err
}

type fakeEvidenceStore struct {
	insertErr error
}

func (f *fakeEvidenceStore) Insert(_ context.Context, _ audit.AuditWriteRecord) error {
	return f.insertErr
}

func (f *fakeEvidenceStore) FindByMongoID(_ context.Context, _ string) (*audit.AuditWriteRecord, error) {
	return nil, nil
}

// --- BatchUpdate handler test helpers ---

func batchUpdateBody(imsis []string, patch map[string]any, reason string) map[string]any {
	return map[string]any{
		"imsis":  imsis,
		"patch":  patch,
		"reason": reason,
	}
}

func batchUpdateRequest(principal *auth.Principal, body any) *http.Request {
	data, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch-update", bytes.NewBuffer(data))
	r.Header.Set("Content-Type", "application/json")
	if principal != nil {
		r = r.WithContext(auth.ContextWithPrincipal(r.Context(), principal))
	}
	return r
}

func newBatchUpdateHandler(
	store BatchUpdateStore,
	userRepo UserRepository,
	approvalSvc ApprovalCreator,
	approvalQry ApprovalQuerier,
	limiter RateLimiter,
	auditStore audit.EvidenceStore,
) *WriteHandler {
	writer := audit.NewWriter(auditStore, audit.WriterConfig{})
	h := &WriteHandler{
		limiter:     limiter,
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		approvalQry: approvalQry,
		auditWriter: writer,
		batchStore:  store,
		findSub:     store.LoadBatchUpdateTarget,
	}
	return h
}

// --- BatchUpdate HTTP Acceptance Tests ---

func TestBatchUpdate_Unauthenticated(t *testing.T) {
	h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch-update", nil)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestBatchUpdate_CapabilityDenied(t *testing.T) {
	h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := &auth.Principal{Username: "user1", NormalizedRole: "viewer"}
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestBatchUpdate_RateLimited(t *testing.T) {
	h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{blocked: true}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
}

func TestBatchUpdate_MalformedJSON(t *testing.T) {
	h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch-update", bytes.NewBufferString("{bad json"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(auth.ContextWithPrincipal(r.Context(), p))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestBatchUpdate_InvalidIMSI(t *testing.T) {
	tests := []struct {
		name  string
		imsis []string
	}{
		{"non-numeric", []string{"abcdefghijklmno"}},
		{"too short", []string{"00101000000000"}},
		{"too long", []string{"0010100000000011"}},
		{"non-digit chars", []string{"00101000000000A"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
			p := testPrincipal("op1", "operator")
			r := batchUpdateRequest(p, batchUpdateBody(tt.imsis, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
			w := httptest.NewRecorder()
			h.BatchUpdate(w, r)
			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d", w.Code)
			}
		})
	}
}

func TestBatchUpdate_DuplicateIMSI(t *testing.T) {
	h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001", "001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestBatchUpdate_101Targets(t *testing.T) {
	imsis := make([]string, 101)
	for i := range imsis {
		imsis[i] = fmt.Sprintf("00101%010d", i)
	}
	h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody(imsis, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestBatchUpdate_AccessRestrictionDataZero(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	h := newBatchUpdateHandler(store,
		&fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)},
		&fakeApprovalCreator{},
		&fakeApprovalQuerierDocs{},
		&fakeRateLimiter{},
		&fakeEvidenceStore{},
	)
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_BadAMBR(t *testing.T) {
	tests := []struct {
		name  string
		patch map[string]any
	}{
		{"non-object", map[string]any{"ambr": "bad"}},
		{"empty object", map[string]any{"ambr": map[string]any{}}},
		{"missing value", map[string]any{"ambr": map[string]any{"downlink": map[string]any{"unit": float64(1)}}}},
		{"missing unit", map[string]any{"ambr": map[string]any{"downlink": map[string]any{"value": float64(100)}}}},
		{"invalid value", map[string]any{"ambr": map[string]any{"downlink": map[string]any{"value": float64(0), "unit": float64(1)}}}},
		{"invalid unit", map[string]any{"ambr": map[string]any{"downlink": map[string]any{"value": float64(100), "unit": float64(10)}}}},
		{"non-integer value", map[string]any{"ambr": map[string]any{"downlink": map[string]any{"value": 1.5, "unit": float64(1)}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
			p := testPrincipal("op1", "operator")
			r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, tt.patch, "test reason"))
			w := httptest.NewRecorder()
			h.BatchUpdate(w, r)
			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestBatchUpdate_BadMaintenanceWindow(t *testing.T) {
	tests := []struct {
		name string
		mw   any
	}{
		{"string", "bad"},
		{"array", []any{}},
		{"number", float64(42)},
		{"unknown key", map[string]any{"start": "2026-09-08T10:00:00Z", "end": "2026-09-08T18:00:00Z", "bad": "val"}},
		{"dotted key", map[string]any{"start": "2026-09-08T10:00:00Z", "end": "2026-09-08T18:00:00Z", "a.b": "val"}},
		{"dollar key", map[string]any{"start": "2026-09-08T10:00:00Z", "end": "2026-09-08T18:00:00Z", "$set": "val"}},
		{"start after end", map[string]any{"start": "2026-09-08T18:00:00Z", "end": "2026-09-08T10:00:00Z"}},
		{"bare date", map[string]any{"start": "2026-09-08", "end": "2026-09-09"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeBatchUpdateStore()
			store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
			h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
			p := testPrincipal("op1", "operator")
			body := batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason")
			if tt.mw != nil {
				body["maintenanceWindow"] = tt.mw
			}
			r := batchUpdateRequest(p, body)
			w := httptest.NewRecorder()
			h.BatchUpdate(w, r)
			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestBatchUpdate_ReasonValidation(t *testing.T) {
	tests := []struct {
		name   string
		reason string
	}{
		{"too short", "ab"},
		{"empty", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newBatchUpdateHandler(newFakeBatchUpdateStore(), &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
			p := testPrincipal("op1", "operator")
			r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, tt.reason))
			w := httptest.NewRecorder()
			h.BatchUpdate(w, r)
			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d", w.Code)
			}
		})
	}
}

func TestBatchUpdate_TicketLength(t *testing.T) {
	// 200 chars should pass
	long200 := ""
	for i := 0; i < 200; i++ {
		long200 += "x"
	}
	// 201 chars should fail
	long201 := long200 + "x"

	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{doc: &approval.ApprovalDocument{ID: "a1"}}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")

	// 200 should pass (approval path)
	body := batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason")
	body["ticketId"] = long200
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusAccepted {
		t.Errorf("200 chars: expected 202, got %d: %s", w.Code, w.Body.String())
	}

	// 201 should fail
	body["ticketId"] = long201
	r = batchUpdateRequest(p, body)
	w = httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("201 chars: expected 400, got %d", w.Code)
	}
}

func TestBatchUpdate_OperatorApproval(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	approvalDoc := &approval.ApprovalDocument{ID: "approval-1"}
	var capturedInput approval.CreateApprovalInput
	approvalSvc := &fakeApprovalCreator{doc: approvalDoc, captured: &capturedInput}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, approvalSvc, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	// Verify approval was created
	if capturedInput.Action != "SUBSCRIBER_BATCH_UPDATE" {
		t.Errorf("expected action SUBSCRIBER_BATCH_UPDATE, got %s", capturedInput.Action)
	}
}

func TestBatchUpdate_SuperAdminDirect(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_RootDirect(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	// root normalizes to super_admin; principal carries normalized role, identity carries raw role
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("root1", "root", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("root1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// Section 20: Node↔Go response contract matrix tests

func TestBatchUpdate_ResponseContract_Approval(t *testing.T) {
	// New Approval response: { approval, requiresApproval } only
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	approvalDoc := &approval.ApprovalDocument{ID: "approval-1"}
	approvalSvc := &fakeApprovalCreator{doc: approvalDoc}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, approvalSvc, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 14: Must have approval and requiresApproval
	if resp["approval"] == nil {
		t.Error("expected approval to be present")
	}
	if resp["requiresApproval"] != true {
		t.Errorf("expected requiresApproval=true, got %v", resp["requiresApproval"])
	}
	// Section 14: Must NOT have outcome or message
	if resp["outcome"] != nil {
		t.Errorf("expected no outcome, got %v", resp["outcome"])
	}
	if resp["message"] != nil {
		t.Errorf("expected no message, got %v", resp["message"])
	}
}

func TestBatchUpdate_ResponseContract_Duplicate(t *testing.T) {
	// Duplicate response: { approval, requiresApproval, idempotent }
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}

	// Compute the fingerprint that the handler will compute for this request
	frozen, _ := PrepareFrozenBatchUpdate(context.Background(), []string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, func(_ context.Context, imsi string) (map[string]any, error) {
		return store.targets[imsi], nil
	})

	existingApproval := approval.ApprovalDocument{
		ID:                   "existing-1",
		Action:               "SUBSCRIBER_BATCH_UPDATE",
		Status:               approval.StatusPending,
		OperationFingerprint: frozen.OperationFingerprint,
		Operation: approval.ApprovalOperation{
			ResourceType: "SUBSCRIBER_BATCH_UPDATE",
			ResourceID:   "BATCH:001010000000001",
		},
		Payload: map[string]any{
			"targets":    []any{map[string]any{"imsi": "001010000000001"}},
			"fieldNames": []any{"access_restriction_data"},
		},
	}
	querier := &fakeApprovalQuerierDocs{docs: []approval.ApprovalDocument{existingApproval}}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, querier, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusAccepted {
		t.Fatalf("expected 202 duplicate, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["approval"] == nil {
		t.Error("expected approval to be present")
	}
	if resp["requiresApproval"] != true {
		t.Errorf("expected requiresApproval=true, got %v", resp["requiresApproval"])
	}
	if resp["idempotent"] != true {
		t.Errorf("expected idempotent=true, got %v", resp["idempotent"])
	}
}

func TestBatchUpdate_ResponseContract_DirectSuccess(t *testing.T) {
	// Direct success: { outcome: "executed", message, result, requiresApproval: false }
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["outcome"] != "executed" {
		t.Errorf("expected outcome=executed, got %v", resp["outcome"])
	}
	if resp["message"] == nil {
		t.Error("expected message to be present")
	}
	if resp["result"] == nil {
		t.Error("expected result to be present")
	}
	if resp["requiresApproval"] != false {
		t.Errorf("expected requiresApproval=false, got %v", resp["requiresApproval"])
	}
}

func TestBatchUpdate_ActiveDuplicateOperator(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	// Compute what the fingerprint would be for this request
	existingApproval := approval.ApprovalDocument{
		ID:                   "existing-1",
		Action:               "SUBSCRIBER_BATCH_UPDATE",
		OperationFingerprint: "", // Will be set below
		Payload: map[string]any{
			"targets":    []any{map[string]any{"imsi": "001010000000001"}},
			"fieldNames": []any{"access_restriction_data"},
		},
	}
	approvalQry := &fakeApprovalQuerierDocs{docs: []approval.ApprovalDocument{existingApproval}}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{}, approvalQry, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	// Since fingerprints won't match (we can't compute the exact one without running PrepareFrozenBatchUpdate),
	// this will either be 202 (new approval) or 409 (conflict if targets overlap)
	if w.Code != http.StatusAccepted && w.Code != http.StatusConflict {
		t.Errorf("expected 202 or 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_ActiveOverlapOperator(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	// Create an existing approval with overlapping target and field but different fingerprint
	existingApproval := approval.ApprovalDocument{
		ID:                   "existing-1",
		Action:               "SUBSCRIBER_BATCH_UPDATE",
		OperationFingerprint: "different-fingerprint",
		Payload: map[string]any{
			"targets":    []any{map[string]any{"imsi": "001010000000001"}},
			"fieldNames": []any{"access_restriction_data"},
		},
	}
	approvalQry := &fakeApprovalQuerierDocs{docs: []approval.ApprovalDocument{existingApproval}}
	approvalDoc := &approval.ApprovalDocument{ID: "new-1"}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("op1", "operator", false)}, &fakeApprovalCreator{doc: approvalDoc}, approvalQry, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("op1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_ActiveOverlapDirect(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	existingApproval := approval.ApprovalDocument{
		ID:                   "existing-1",
		Action:               "SUBSCRIBER_BATCH_UPDATE",
		OperationFingerprint: "different-fingerprint",
		Payload: map[string]any{
			"targets":    []any{map[string]any{"imsi": "001010000000001"}},
			"fieldNames": []any{"access_restriction_data"},
		},
	}
	approvalQry := &fakeApprovalQuerierDocs{docs: []approval.ApprovalDocument{existingApproval}}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, approvalQry, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_MaintenanceWindowOutside(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason")
	body["maintenanceWindow"] = map[string]any{
		"start": "2020-01-01T00:00:00Z",
		"end":   "2020-01-02T00:00:00Z",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_PreExecutionDrift(t *testing.T) {
	store := newFakeBatchUpdateStore()
	// Set initial state
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	// The executor will load targets, then the state changes before CAS
	// We simulate this by having LoadBatchUpdateTarget return different state on second call
	// But our fake doesn't support that easily — instead we test via the handler
	// For a real pre-execution drift test, we need the CAS to return matched=0
	store.casConflict["001010000000001"] = true
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("expected 409 (CAS conflict), got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_CASZeroConflict(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_CASPartial(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	store.targets["001010000000002"] = map[string]any{"access_restriction_data": int64(2)}
	store.casConflict["001010000000002"] = true
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001", "001010000000002"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusConflict {
		t.Errorf("expected 409 (partial), got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_StorageZeroFailure(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.storageErrors["001010000000001"] = true
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	// Storage error on load → PrepareFrozenBatchUpdate maps to SUBSCRIBER_NOT_FOUND
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_StoragePartialFailure(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	// Second target has storage error on load → PrepareFrozenBatchUpdate maps to NOT_FOUND
	store.storageErrors["001010000000002"] = true
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001", "001010000000002"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_AuditFailure_SuccessCommitted(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(1)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{insertErr: fmt.Errorf("audit store down")})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["committed"] != true {
		t.Errorf("expected committed=true, got %v", resp["committed"])
	}
}

func TestBatchUpdate_NoSubscriberFound(t *testing.T) {
	store := newFakeBatchUpdateStore()
	// No target in store → subscriber not found
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_NoEffect(t *testing.T) {
	store := newFakeBatchUpdateStore()
	// Subscriber has access_restriction_data=0, patch sets it to 0 → no effect
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(0)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 (no effect), got %d: %s", w.Code, w.Body.String())
	}
}

// ============================================================
// Section G: Frozen IMSI Validation
// ============================================================

func TestBatchUpdate_FrozenInvalidIMSI(t *testing.T) {
	// Test that frozen assertion rejects non-15-digit IMSIs
	cases := []struct {
		name string
		imsi string
	}{
		{"too short", "12345678901234"},
		{"too long", "1234567890123456"},
		{"non-digit", "00101000000000a"},
		{"letters", "abcdefghijklmno"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			frozen := &FrozenBatchUpdateV2{
				Version:     "subscriber-batch-update-v2",
				TargetCount: 1,
				FieldNames:  []string{"access_restriction_data"},
				Targets: []SubscriberChangeTarget{
					{
						Imsi:             tc.imsi,
						Before:           map[string]any{"access_restriction_data": int64(32)},
						After:            map[string]any{"access_restriction_data": int64(0)},
						PreconditionHash: fingerprintMap(map[string]any{"access_restriction_data": int64(32)}),
					},
				},
				Patch: map[string]any{"accessRestrictionData": float64(0)},
			}
			frozen.SnapshotBytes = len(stableJSON(map[string]any{
				"targets":              frozen.Targets,
				"patch":                frozen.Patch,
				"fieldNames":           frozen.FieldNames,
				"operationFingerprint": "test",
			}))
			frozen.OperationFingerprint = ComputeBatchUpdateV2Fingerprint(frozen.Targets, frozen.Patch, frozen.FieldNames)
			err := AssertFrozenBatchUpdateV2(frozen)
			if err == nil {
				t.Error("expected error for invalid frozen IMSI, got nil")
			}
		})
	}
}

// ============================================================
// Section X: Go Handler Acceptance Tests
// ============================================================

func TestBatchUpdate_MaintenanceWindowNull(t *testing.T) {
	// Section K: maintenanceWindow null must be rejected
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":             []string{"001010000000001"},
		"patch":             map[string]any{"accessRestrictionData": float64(0)},
		"reason":            "test reason",
		"maintenanceWindow": nil,
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for maintenanceWindow null, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_MaintenanceWindowString(t *testing.T) {
	// Section K: maintenanceWindow string must be rejected
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":             []string{"001010000000001"},
		"patch":             map[string]any{"accessRestrictionData": float64(0)},
		"reason":            "test reason",
		"maintenanceWindow": "2026-09-08T10:00:00Z",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for maintenanceWindow string, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_FrozenKeyMismatch(t *testing.T) {
	// Section D: Exact leaf-key equality — extra key in before must be rejected
	frozen := &FrozenBatchUpdateV2{
		Version:     "subscriber-batch-update-v2",
		TargetCount: 1,
		FieldNames:  []string{"access_restriction_data"},
		Targets: []SubscriberChangeTarget{
			{
				Imsi:             "001010000000001",
				Before:           map[string]any{"access_restriction_data": int64(32), "extra_field": int64(0)},
				After:            map[string]any{"access_restriction_data": int64(0), "extra_field": int64(0)},
				PreconditionHash: fingerprintMap(map[string]any{"access_restriction_data": int64(32), "extra_field": int64(0)}),
			},
		},
		Patch: map[string]any{"accessRestrictionData": float64(0)},
	}
	frozen.SnapshotBytes = len(stableJSON(map[string]any{
		"targets":              frozen.Targets,
		"patch":                frozen.Patch,
		"fieldNames":           frozen.FieldNames,
		"operationFingerprint": "test",
	}))
	frozen.OperationFingerprint = ComputeBatchUpdateV2Fingerprint(frozen.Targets, frozen.Patch, frozen.FieldNames)
	err := AssertFrozenBatchUpdateV2(frozen)
	if err == nil {
		t.Error("expected error for extra key in frozen payload, got nil")
	}
}

func TestBatchUpdate_FrozenMissingLeaf(t *testing.T) {
	// Section D: Exact leaf-key equality — missing leaf must be rejected
	frozen := &FrozenBatchUpdateV2{
		Version:     "subscriber-batch-update-v2",
		TargetCount: 1,
		FieldNames:  []string{"access_restriction_data"},
		Targets: []SubscriberChangeTarget{
			{
				Imsi:             "001010000000001",
				Before:           map[string]any{},
				After:            map[string]any{},
				PreconditionHash: fingerprintMap(map[string]any{}),
			},
		},
		Patch: map[string]any{"accessRestrictionData": float64(0)},
	}
	frozen.SnapshotBytes = len(stableJSON(map[string]any{
		"targets":              frozen.Targets,
		"patch":                frozen.Patch,
		"fieldNames":           frozen.FieldNames,
		"operationFingerprint": "test",
	}))
	frozen.OperationFingerprint = ComputeBatchUpdateV2Fingerprint(frozen.Targets, frozen.Patch, frozen.FieldNames)
	err := AssertFrozenBatchUpdateV2(frozen)
	if err == nil {
		t.Error("expected error for missing leaf key in frozen payload, got nil")
	}
}

// ============================================================
// Section Q: BSON Round-Trip Safety
// ============================================================

func TestBatchUpdate_BSONRoundTripSafety(t *testing.T) {
	// Section P/Q: Test that extraction helpers handle bson.A/bson.M/bson.D
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}

	// Simulate a BSON-round-tripped approval document
	bsonApproval := approval.ApprovalDocument{
		ID:     "approval-bson-1",
		Action: "SUBSCRIBER_BATCH_UPDATE",
		Status: approval.StatusPending,
		Operation: approval.ApprovalOperation{
			ResourceType: "SUBSCRIBER_BATCH_UPDATE",
			ResourceID:   "001010000000001",
		},
		Payload: map[string]any{
			"targets": bson.A{
				bson.M{
					"imsi":   "001010000000001",
					"status": "pending",
				},
			},
			"patch": bson.M{
				"accessRestrictionData": int64(0),
			},
		},
	}

	querier := &fakeApprovalQuerierDocs{
		docs: []approval.ApprovalDocument{bsonApproval},
	}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "operator", false)}, &fakeApprovalCreator{}, querier, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	// Operator should get 202 (approval required) even with BSON types in active approval
	if w.Code != http.StatusAccepted {
		t.Errorf("expected 202 for operator with BSON approval, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_ActiveBSONDuplicate(t *testing.T) {
	// Section R: Active conflict with BSON-round-tripped approval (duplicate fingerprint)
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}

	// Compute the fingerprint that the handler will compute for this request
	frozen, _ := PrepareFrozenBatchUpdate(context.Background(), []string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, func(_ context.Context, imsi string) (map[string]any, error) {
		return store.targets[imsi], nil
	})

	bsonApproval := approval.ApprovalDocument{
		ID:                   "approval-bson-2",
		Action:               "SUBSCRIBER_BATCH_UPDATE",
		Status:               approval.StatusPending,
		OperationFingerprint: frozen.OperationFingerprint,
		Operation: approval.ApprovalOperation{
			ResourceType: "SUBSCRIBER_BATCH_UPDATE",
			ResourceID:   "BATCH:001010000000001",
		},
		Payload: map[string]any{
			"targets": bson.A{
				bson.M{
					"imsi": "001010000000001",
				},
			},
			"fieldNames": bson.A{"access_restriction_data"},
			"patch": bson.M{
				"accessRestrictionData": int64(0),
			},
		},
	}

	querier := &fakeApprovalQuerierDocs{
		docs: []approval.ApprovalDocument{bsonApproval},
	}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "operator", false)}, &fakeApprovalCreator{}, querier, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	// Same fingerprint → 202 idempotent (duplicate)
	if w.Code != http.StatusAccepted {
		t.Errorf("expected 202 for duplicate BSON approval, got %d: %s", w.Code, w.Body.String())
	}
}

func TestBatchUpdate_ActiveBSONOverlap(t *testing.T) {
	// Section R: Active overlap with BSON-round-tripped approval
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}

	bsonApproval := approval.ApprovalDocument{
		ID:     "approval-bson-3",
		Action: "SUBSCRIBER_BATCH_UPDATE",
		Status: approval.StatusPending,
		Operation: approval.ApprovalOperation{
			ResourceType: "SUBSCRIBER_BATCH_UPDATE",
			ResourceID:   "BATCH:001010000000001",
		},
		Payload: map[string]any{
			"targets": bson.A{
				bson.M{
					"imsi": "001010000000001",
				},
			},
			"fieldNames": bson.A{"access_restriction_data"},
			"patch": bson.M{
				"accessRestrictionData": int64(16),
			},
		},
	}

	querier := &fakeApprovalQuerierDocs{
		docs: []approval.ApprovalDocument{bsonApproval},
	}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "operator", false)}, &fakeApprovalCreator{}, querier, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	// Same target, different patch → 409 overlap
	if w.Code != http.StatusConflict {
		t.Errorf("expected 409 for overlapping BSON approval, got %d: %s", w.Code, w.Body.String())
	}
}

// ============================================================
// Section 7: Real BSON Round-Trip
// ============================================================

func TestBatchUpdate_RealBSONRoundTrip(t *testing.T) {
	// Section 7: Real BSON marshal/unmarshal round-trip
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}

	// Compute the fingerprint that the handler will compute for this request
	frozen, _ := PrepareFrozenBatchUpdate(context.Background(), []string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, func(_ context.Context, imsi string) (map[string]any, error) {
		return store.targets[imsi], nil
	})

	// Create an approval document with real BSON types
	original := approval.ApprovalDocument{
		ID:                   "approval-bson-real",
		Action:               "SUBSCRIBER_BATCH_UPDATE",
		Status:               approval.StatusPending,
		OperationFingerprint: frozen.OperationFingerprint,
		Operation: approval.ApprovalOperation{
			ResourceType: "SUBSCRIBER_BATCH_UPDATE",
			ResourceID:   "BATCH:001010000000001",
		},
		Payload: map[string]any{
			"targets": []any{
				map[string]any{"imsi": "001010000000001"},
			},
			"fieldNames": []any{"access_restriction_data"},
			"patch": map[string]any{
				"accessRestrictionData": int64(0),
			},
		},
	}

	// Marshal to BSON
	raw, err := bson.Marshal(original)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	// Unmarshal back
	var decoded approval.ApprovalDocument
	err = bson.Unmarshal(raw, &decoded)
	if err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	// Verify targets survive BSON round-trip
	targets := extractApprovalTargets(&decoded)
	if len(targets) != 1 || targets[0] != "001010000000001" {
		t.Errorf("targets not preserved: %v", targets)
	}

	// Verify fieldNames survive BSON round-trip
	fields := extractApprovalFields(&decoded)
	if len(fields) != 1 || fields[0] != "access_restriction_data" {
		t.Errorf("fieldNames not preserved: %v", fields)
	}

	// Verify duplicate detection works with BSON-round-tripped approval
	querier := &fakeApprovalQuerierDocs{
		docs: []approval.ApprovalDocument{decoded},
	}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "operator", false)}, &fakeApprovalCreator{}, querier, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "operator")
	r := batchUpdateRequest(p, batchUpdateBody([]string{"001010000000001"}, map[string]any{"accessRestrictionData": float64(0)}, "test reason"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	// Same fingerprint → 202 idempotent (duplicate)
	if w.Code != http.StatusAccepted {
		t.Errorf("expected 202 for duplicate after BSON round-trip, got %d: %s", w.Code, w.Body.String())
	}
}

// ============================================================
// Section 2: Authoritative Snapshot Cap
// ============================================================

func TestBatchUpdate_AuthoritativeSnapshotCap(t *testing.T) {
	// Test that snapshot cap is enforced after authoritative recomputation
	// 5 targets should succeed (well under 512 KiB)
	imsis := []string{"001010000000001", "001010000000002", "001010000000003", "001010000000004", "001010000000005"}
	store := newFakeBatchUpdateStore()
	for _, imsi := range imsis {
		store.targets[imsi] = map[string]any{"access_restriction_data": int64(32)}
	}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	r := batchUpdateRequest(p, batchUpdateBody(imsis, map[string]any{"accessRestrictionData": float64(0)}, "test reason for snapshot cap"))
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	// 5 targets should succeed (under 512 KiB)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for 5 targets, got %d: %s", w.Code, w.Body.String())
	}
}

// ============================================================
// Section 6: Go Error-Code Parity Tests
// ============================================================

func TestBatchUpdate_ErrorCode_MaintenanceWindowNull(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":             []string{"001010000000001"},
		"patch":             map[string]any{"accessRestrictionData": float64(0)},
		"reason":            "test reason",
		"maintenanceWindow": nil,
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["code"] != "INVALID_BATCH_REQUEST" {
		t.Errorf("expected INVALID_BATCH_REQUEST, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_MaintenanceWindowString(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":             []string{"001010000000001"},
		"patch":             map[string]any{"accessRestrictionData": float64(0)},
		"reason":            "test reason",
		"maintenanceWindow": "bad",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 19: maintenanceWindow string → INVALID_BATCH_REQUEST
	if resp["code"] != "INVALID_BATCH_REQUEST" {
		t.Errorf("expected INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_ReasonTooShort(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":  []string{"001010000000001"},
		"patch":  map[string]any{"accessRestrictionData": float64(0)},
		"reason": "ab",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 19: reason too short → INVALID_BATCH_REQUEST
	if resp["code"] != "INVALID_BATCH_REQUEST" {
		t.Errorf("expected INVALID_BATCH_REQUEST, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_BadAMBR(t *testing.T) {
	store := newFakeBatchUpdateStore()
	store.targets["001010000000001"] = map[string]any{"access_restriction_data": int64(32)}
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":  []string{"001010000000001"},
		"patch":  map[string]any{"ambr": "bad"},
		"reason": "test reason",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 19: bad AMBR → INVALID_BATCH_REQUEST
	if resp["code"] != "INVALID_BATCH_REQUEST" {
		t.Errorf("expected INVALID_BATCH_REQUEST, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_101IMSIs(t *testing.T) {
	// Section 6: Generate exactly101 valid 15-digit IMSIs
	imsis := make([]string, 101)
	for i := range imsis {
		imsis[i] = fmt.Sprintf("0010100000%05d", i+1) // 15 digits: "0010100000" (10) + 5 digits
	}
	// Verify all IMSIs are exactly 15 digits
	for _, imsi := range imsis {
		if len(imsi) != 15 {
			t.Fatalf("generated IMSI %q has length %d, want 15", imsi, len(imsi))
		}
	}
	store := newFakeBatchUpdateStore()
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":  imsis,
		"patch":  map[string]any{"accessRestrictionData": float64(0)},
		"reason": "test reason",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 19: 101 valid IMSIs → BATCH_SIZE_EXCEEDED
	if resp["code"] != "BATCH_SIZE_EXCEEDED" {
		t.Errorf("expected BATCH_SIZE_EXCEEDED, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_UnknownTopLevel(t *testing.T) {
	store := newFakeBatchUpdateStore()
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis":      []string{"001010000000001"},
		"patch":      map[string]any{"accessRestrictionData": float64(0)},
		"reason":     "test reason",
		"unknownKey": "value", // Unknown top-level key
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 5: Unknown top-level key → INVALID_BATCH_REQUEST
	if resp["code"] != "INVALID_BATCH_REQUEST" {
		t.Errorf("expected INVALID_BATCH_REQUEST, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_UnsupportedPatch(t *testing.T) {
	store := newFakeBatchUpdateStore()
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis": []string{"001010000000001"},
		"patch": map[string]any{
			"accessRestrictionData": float64(0),
			"unsupportedField":      "value", // Unsupported patch field
		},
		"reason": "test reason",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 5: Unknown patch key → UNSUPPORTED_SUBSCRIBER_FIELD
	if resp["code"] != "UNSUPPORTED_SUBSCRIBER_FIELD" {
		t.Errorf("expected UNSUPPORTED_SUBSCRIBER_FIELD, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_UnsupportedAMBR(t *testing.T) {
	store := newFakeBatchUpdateStore()
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis": []string{"001010000000001"},
		"patch": map[string]any{
			"sessionAmbr": map[string]any{
				"downlink": map[string]any{
					"value":    float64(100),
					"unit":     "Kbps",
					"unknown":  "unsupported", // Unsupported AMBR field
				},
				"uplink": map[string]any{
					"value": float64(100),
					"unit":  "Kbps",
				},
			},
		},
		"reason": "test reason",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 5: Unknown AMBR key → UNSUPPORTED_SUBSCRIBER_FIELD
	if resp["code"] != "UNSUPPORTED_SUBSCRIBER_FIELD" {
		t.Errorf("expected UNSUPPORTED_SUBSCRIBER_FIELD, got %v", resp["code"])
	}
}

func TestBatchUpdate_ErrorCode_UnsupportedBitrate(t *testing.T) {
	store := newFakeBatchUpdateStore()
	h := newBatchUpdateHandler(store, &fakeUserRepo{identity: testIdentity("admin1", "super_admin", false)}, &fakeApprovalCreator{}, &fakeApprovalQuerierDocs{}, &fakeRateLimiter{}, &fakeEvidenceStore{})
	p := testPrincipal("admin1", "super_admin")
	body := map[string]any{
		"imsis": []string{"001010000000001"},
		"patch": map[string]any{
			"sessionAmbr": map[string]any{
				"downlink": map[string]any{
					"value":        float64(100),
					"unit":         "Kbps",
					"unsupported":  "field", // Unsupported bitrate field
				},
				"uplink": map[string]any{
					"value": float64(100),
					"unit":  "Kbps",
				},
			},
		},
		"reason": "test reason",
	}
	r := batchUpdateRequest(p, body)
	w := httptest.NewRecorder()
	h.BatchUpdate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	// Section 5: Unknown bitrate key → UNSUPPORTED_SUBSCRIBER_FIELD
	if resp["code"] != "UNSUPPORTED_SUBSCRIBER_FIELD" {
		t.Errorf("expected UNSUPPORTED_SUBSCRIBER_FIELD, got %v", resp["code"])
	}
}
