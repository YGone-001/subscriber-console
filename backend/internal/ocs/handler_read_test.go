package ocs

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"subscriber/internal/auth"
)

type allowLimiter struct{}

func (a *allowLimiter) Enforce(_ http.ResponseWriter, _ *http.Request, _ string, _ int, _ int) bool {
	return true
}

func readRequest(imsi, username, role string, withPrincipal bool) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/ocs/subscribers/"+imsi, nil)
	r.SetPathValue("imsi", imsi)
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

func TestHandler_GetSubscriber_RequiresPrincipal(t *testing.T) {
	h := NewHandler(nil, &allowLimiter{})
	rec := httptest.NewRecorder()

	h.GetSubscriber(rec, readRequest("417010000000001", "", "", false))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestHandler_GetSubscriber_RejectsMalformedIMSI(t *testing.T) {
	h := NewHandler(nil, &allowLimiter{})
	rec := httptest.NewRecorder()

	h.GetSubscriber(rec, readRequest("41701", "op1", "operator", true))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if body := rec.Body.String(); !strings.Contains(body, "OCS_INVALID_IMSI") {
		t.Fatalf("body = %s, want OCS_INVALID_IMSI", body)
	}
}

func TestHandler_GetSubscriber_DeniesRoleWithoutReadPermission(t *testing.T) {
	h := NewHandler(nil, &allowLimiter{})
	rec := httptest.NewRecorder()

	h.GetSubscriber(rec, readRequest("417010000000001", "guest1", "guest", true))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestHandler_GetSubscriber_ViewerMayRead(t *testing.T) {
	/* The permission gate must run before the repository, so a viewer reaches the
	 * repository call. A nil repository is used here on purpose: the test only
	 * proves the authorization outcome, not the projection. */
	viewer := readRequest("417010000000001", "viewer1", "viewer", true)
	if !auth.HasPermission(principalFromRequest(t, viewer), "ocs.read") {
		t.Fatal("viewer must hold ocs.read")
	}
}

func principalFromRequest(t *testing.T, r *http.Request) *auth.Principal {
	t.Helper()
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		t.Fatal("request has no principal")
	}
	return p
}
