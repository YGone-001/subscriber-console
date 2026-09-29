package rating

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"subscriber/internal/auth"
)

// ratingReq builds a request with an optional authenticated principal.
func ratingReq(method, path, username, role string, withPrincipal bool) *http.Request {
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

type ratingCase struct {
	name   string
	method string
	path   string
	code   string
	call   func(h *WriteHandler, w http.ResponseWriter, r *http.Request)
}

func ratingCases() []ratingCase {
	return []ratingCase{
		{"create", "POST", "/api/ratings", RatingCreateDisabledCode, func(h *WriteHandler, w http.ResponseWriter, r *http.Request) { h.Create(w, r) }},
		{"update", "PUT", "/api/ratings/1001", RatingUpdateDisabledCode, func(h *WriteHandler, w http.ResponseWriter, r *http.Request) { h.Update(w, r) }},
		{"delete", "DELETE", "/api/ratings/1001", RatingDeleteDisabledCode, func(h *WriteHandler, w http.ResponseWriter, r *http.Request) { h.Delete(w, r) }},
	}
}

// TestWriteHandler_AdminDisabledConflict verifies that an authorized admin
// request receives the exact Node disabled contract (HTTP 409, error==code).
func TestWriteHandler_AdminDisabledConflict(t *testing.T) {
	h := NewWriteHandler(nil)

	for _, tc := range ratingCases() {
		t.Run(tc.name, func(t *testing.T) {
			req := ratingReq(tc.method, tc.path, "admin", "admin", true)
			w := httptest.NewRecorder()

			tc.call(h, w, req)

			if w.Code != http.StatusConflict {
				t.Fatalf("expected status 409, got %d", w.Code)
			}
			var resp map[string]string
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if resp["error"] != tc.code {
				t.Errorf("expected error %q, got %q", tc.code, resp["error"])
			}
			if resp["code"] != tc.code {
				t.Errorf("expected code %q, got %q", tc.code, resp["code"])
			}
		})
	}
}

// TestWriteHandler_ViewerPermissionDenied verifies the 403 permission boundary
// matching Node requirePermission() denial evidence shape.
func TestWriteHandler_ViewerPermissionDenied(t *testing.T) {
	h := NewWriteHandler(nil)

	for _, tc := range ratingCases() {
		t.Run(tc.name, func(t *testing.T) {
			req := ratingReq(tc.method, tc.path, "viewer1", "viewer", true)
			w := httptest.NewRecorder()

			tc.call(h, w, req)

			if w.Code != http.StatusForbidden {
				t.Fatalf("expected status 403, got %d", w.Code)
			}
			var resp map[string]string
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if resp["code"] != "PERMISSION_DENIED" {
				t.Errorf("expected code PERMISSION_DENIED, got %q", resp["code"])
			}
			if resp["permission"] != ratingWritePermission {
				t.Errorf("expected permission %q, got %q", ratingWritePermission, resp["permission"])
			}
		})
	}
}

// TestWriteHandler_Unauthenticated verifies the 401 principal guard.
func TestWriteHandler_Unauthenticated(t *testing.T) {
	h := NewWriteHandler(nil)

	for _, tc := range ratingCases() {
		t.Run(tc.name, func(t *testing.T) {
			req := ratingReq(tc.method, tc.path, "", "", false)
			w := httptest.NewRecorder()

			tc.call(h, w, req)

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
		})
	}
}
