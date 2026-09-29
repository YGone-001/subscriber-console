package ocs

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"subscriber/internal/auth"
)

// fakeNodeParityLimiter records EnforceNodeParity invocations and optionally
// emits the Node-parity 429 response.
type fakeNodeParityLimiter struct {
	allowed    bool
	calls      int
	lastIdent  string
	lastLimit  int
	lastWindow int
}

func (f *fakeNodeParityLimiter) EnforceNodeParity(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	f.calls++
	f.lastIdent = identifier
	f.lastLimit = limit
	f.lastWindow = windowSeconds
	if !f.allowed {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"Too many requests"}`))
	}
	return f.allowed
}

// residualReq builds a request with an optional authenticated principal.
func residualReq(method, path, username, role string, withPrincipal bool) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	if !withPrincipal {
		return r
	}
	p := &auth.Principal{
		Username:       username,
		Role:           role,
		NormalizedRole: auth.NormalizeRole(role),
	}
	return r.WithContext(auth.ContextWithPrincipal(r.Context(), p))
}

// TestResidualHandler_AssignPolicy_AdminConflict verifies the disabled contract
// for POST /api/subscribers/policy (OCS_PLAN_ASSIGN is DISABLED in the OCS
// governance registry; rate limiting is unreachable behind the disabled gate).
func TestResidualHandler_AssignPolicy_AdminConflict(t *testing.T) {
	limiter := &fakeNodeParityLimiter{allowed: true}
	h := NewResidualHandler(limiter, nil)

	req := residualReq("POST", "/api/subscribers/policy", "admin", "admin", true)
	w := httptest.NewRecorder()

	h.AssignPolicy(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected status 409, got %d", w.Code)
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["error"] != PlanAssignDisabledCode || resp["code"] != PlanAssignDisabledCode {
		t.Errorf("expected error/code %q, got %q/%q", PlanAssignDisabledCode, resp["error"], resp["code"])
	}
	if limiter.calls != 0 {
		t.Errorf("expected rate limiter not called for disabled operation, got %d calls", limiter.calls)
	}
}

// TestResidualHandler_AssignPolicy_ViewerDenied verifies the 403 permission
// boundary for the plan-assign permission.
func TestResidualHandler_AssignPolicy_ViewerDenied(t *testing.T) {
	h := NewResidualHandler(nil, nil)

	req := residualReq("POST", "/api/subscribers/policy", "viewer1", "viewer", true)
	w := httptest.NewRecorder()

	h.AssignPolicy(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", w.Code)
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["code"] != "PERMISSION_DENIED" || resp["permission"] != planAssignPermission {
		t.Errorf("expected PERMISSION_DENIED/%s, got %q/%q", planAssignPermission, resp["code"], resp["permission"])
	}
}

// TestResidualHandler_AssignPolicy_Unauthenticated verifies the 401 guard.
func TestResidualHandler_AssignPolicy_Unauthenticated(t *testing.T) {
	h := NewResidualHandler(nil, nil)

	req := residualReq("POST", "/api/subscribers/policy", "", "", false)
	w := httptest.NewRecorder()

	h.AssignPolicy(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401, got %d", w.Code)
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["code"] != "AUTH_INVALID_TOKEN" {
		t.Errorf("expected code AUTH_INVALID_TOKEN, got %q", resp["code"])
	}
}

// TestResidualHandler_TrafficAdjustments_AdminAllowed verifies the Node
// compatible allow response and the Node-parity rate limit identity.
func TestResidualHandler_TrafficAdjustments_AdminAllowed(t *testing.T) {
	limiter := &fakeNodeParityLimiter{allowed: true}
	h := NewResidualHandler(limiter, nil)

	req := residualReq("POST", "/api/subscribers/417010000000001/traffic-adjustments", "admin", "admin", true)
	req.SetPathValue("imsi", "417010000000001")
	w := httptest.NewRecorder()

	h.TrafficAdjustments(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["error"] != "Routed to Go backend" {
		t.Errorf("expected error message 'Routed to Go backend', got %q", resp["error"])
	}
	if resp["imsi"] != "417010000000001" {
		t.Errorf("expected imsi echoed, got %q", resp["imsi"])
	}
	if limiter.calls != 1 {
		t.Fatalf("expected rate limiter called once, got %d", limiter.calls)
	}
	if limiter.lastIdent != "traffic-adjustments:admin" {
		t.Errorf("expected identifier traffic-adjustments:admin, got %q", limiter.lastIdent)
	}
	if limiter.lastLimit != 30 || limiter.lastWindow != 60 {
		t.Errorf("expected limit/window 30/60, got %d/%d", limiter.lastLimit, limiter.lastWindow)
	}
}

// TestResidualHandler_TrafficAdjustments_ViewerDenied verifies that the
// permission boundary runs before the rate limiter.
func TestResidualHandler_TrafficAdjustments_ViewerDenied(t *testing.T) {
	limiter := &fakeNodeParityLimiter{allowed: true}
	h := NewResidualHandler(limiter, nil)

	req := residualReq("POST", "/api/subscribers/417010000000001/traffic-adjustments", "viewer1", "viewer", true)
	req.SetPathValue("imsi", "417010000000001")
	w := httptest.NewRecorder()

	h.TrafficAdjustments(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", w.Code)
	}
	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["code"] != "PERMISSION_DENIED" || resp["permission"] != balanceAdjustPermission {
		t.Errorf("expected PERMISSION_DENIED/%s, got %q/%q", balanceAdjustPermission, resp["code"], resp["permission"])
	}
	if limiter.calls != 0 {
		t.Errorf("expected rate limiter not called after denial, got %d calls", limiter.calls)
	}
}

// TestResidualHandler_TrafficAdjustments_RateLimited verifies the 429 stop.
func TestResidualHandler_TrafficAdjustments_RateLimited(t *testing.T) {
	limiter := &fakeNodeParityLimiter{allowed: false}
	h := NewResidualHandler(limiter, nil)

	req := residualReq("POST", "/api/subscribers/417010000000001/traffic-adjustments", "admin", "admin", true)
	req.SetPathValue("imsi", "417010000000001")
	w := httptest.NewRecorder()

	h.TrafficAdjustments(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected status 429, got %d", w.Code)
	}
	if limiter.calls != 1 {
		t.Errorf("expected rate limiter called once, got %d", limiter.calls)
	}
}
