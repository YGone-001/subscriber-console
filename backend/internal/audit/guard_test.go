package audit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
)

func TestRequireCapabilityWithAudit_NilPrincipal(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	result := RequireCapabilityWithAudit(w, r, nil, "audit_view", nil)
	if result {
		t.Error("should deny nil principal")
	}
}

func TestRequireCapabilityWithAudit_Allowed(t *testing.T) {
	p := &auth.Principal{
		Username:       "admin",
		Role:           "root",
		NormalizedRole: "super_admin",
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	result := RequireCapabilityWithAudit(w, r, p, "audit_view", nil)
	if !result {
		t.Error("super_admin should have audit_view capability")
	}
	if w.Code != 200 {
		t.Errorf("should not write response on allow, got status %d", w.Code)
	}
}

func TestRequireCapabilityWithAudit_Denied(t *testing.T) {
	p := &auth.Principal{
		Username:       "viewer",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	result := RequireCapabilityWithAudit(w, r, p, "subscriber_write", nil)
	if result {
		t.Error("viewer should not have subscriber_write capability")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
	}

	// Verify response shape
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["code"] != "PERMISSION_DENIED" {
		t.Errorf("code = %v, want PERMISSION_DENIED", resp["code"])
	}
	if resp["capability"] != "subscriber_write" {
		t.Errorf("capability = %v, want subscriber_write", resp["capability"])
	}
	if resp["decision"] != "deny" {
		t.Errorf("decision = %v, want deny", resp["decision"])
	}
}

func TestRequireCapabilityWithAudit_Approval(t *testing.T) {
	p := &auth.Principal{
		Username:       "operator",
		Role:           "operator",
		NormalizedRole: "operator",
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	result := RequireCapabilityWithAudit(w, r, p, "policy_approve", nil)
	if result {
		t.Error("operator should not have policy_approve (approval required)")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["decision"] != "approval" {
		t.Errorf("decision = %v, want approval", resp["decision"])
	}
	if resp["requiresApproval"] != true {
		t.Errorf("requiresApproval = %v, want true", resp["requiresApproval"])
	}
}

func TestRequirePermissionWithAudit_NilPrincipal(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	result := RequirePermissionWithAudit(w, r, nil, "audit.read", nil)
	if result {
		t.Error("should deny nil principal")
	}
}

func TestRequirePermissionWithAudit_Allowed(t *testing.T) {
	p := &auth.Principal{
		Username:       "admin",
		Role:           "root",
		NormalizedRole: "super_admin",
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	result := RequirePermissionWithAudit(w, r, p, "audit.read", nil)
	if !result {
		t.Error("super_admin should have audit.read permission")
	}
	if w.Code != 200 {
		t.Errorf("should not write response on allow, got status %d", w.Code)
	}
}

func TestRequirePermissionWithAudit_Denied(t *testing.T) {
	p := &auth.Principal{
		Username:       "viewer",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	// viewer does NOT have audit.source-ip.read-full permission
	result := RequirePermissionWithAudit(w, r, p, "audit.source-ip.read-full", nil)
	if result {
		t.Error("viewer should not have audit.source-ip.read-full permission")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["code"] != "PERMISSION_DENIED" {
		t.Errorf("code = %v, want PERMISSION_DENIED", resp["code"])
	}
	if resp["permission"] != "audit.source-ip.read-full" {
		t.Errorf("permission = %v, want audit.source-ip.read-full", resp["permission"])
	}
}

func TestDenialResponseShape_MatchesNode(t *testing.T) {
	// Test that the denial response matches the Node.js shape exactly
	p := &auth.Principal{
		Username:       "viewer",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/audit", nil)

	RequirePermissionWithAudit(w, r, p, "users.read", nil)

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	// Node returns: { error, code, permission }
	expected := map[string]string{
		"error":      "Forbidden: Insufficient permissions",
		"code":       "PERMISSION_DENIED",
		"permission": "users.read",
	}
	for key, want := range expected {
		got, ok := resp[key]
		if !ok {
			t.Errorf("missing key %q", key)
		} else if got != want {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}

	// Node does NOT include requiresApproval for permission denials
	if _, ok := resp["requiresApproval"]; ok {
		t.Error("permission denial should not include requiresApproval")
	}
}
