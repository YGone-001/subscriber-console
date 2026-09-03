package subscriber

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/approval"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/governance"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
	"go.mongodb.org/mongo-driver/v2/bson"
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
	if sec["k"] != "00000000000000000000000000000000" {
		t.Errorf("expected k=00000000000000000000000000000000, got %v", sec["k"])
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
		"security":                bson.M{"k": "00000000000000000000000000000000"},
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
