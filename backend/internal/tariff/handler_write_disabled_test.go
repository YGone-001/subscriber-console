package tariff

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"subscriber/internal/auth"
)

type disabledTariffCase struct {
	name       string
	method     string
	path       string
	permission string
	code       string
	call       func(h *DisabledWriteHandler, w http.ResponseWriter, r *http.Request)
}

func disabledTariffCases() []disabledTariffCase {
	return []disabledTariffCase{
		{"import", "POST", "/api/tariff-plans/import", tariffWritePermission, TariffCreateDisabledCode,
			func(h *DisabledWriteHandler, w http.ResponseWriter, r *http.Request) { h.Import(w, r) }},
		{"migrate", "POST", "/api/tariff-plans/plan_a/migrate", planAssignPermission, PlanMigrationDisabledCode,
			func(h *DisabledWriteHandler, w http.ResponseWriter, r *http.Request) { h.Migrate(w, r) }},
		{"create_rule", "POST", "/api/tariff-plans/plan_a/rules", tariffWritePermission, TariffRuleCreateDisabledCode,
			func(h *DisabledWriteHandler, w http.ResponseWriter, r *http.Request) { h.CreateRule(w, r) }},
		{"update_rule", "PUT", "/api/tariff-plans/plan_a/rules/rule_1", tariffWritePermission, TariffRuleUpdateDisabledCode,
			func(h *DisabledWriteHandler, w http.ResponseWriter, r *http.Request) { h.UpdateRule(w, r) }},
		{"toggle_rule", "PATCH", "/api/tariff-plans/plan_a/rules/rule_1", tariffWritePermission, TariffRuleToggleDisabledCode,
			func(h *DisabledWriteHandler, w http.ResponseWriter, r *http.Request) { h.ToggleRule(w, r) }},
		{"delete_rule", "DELETE", "/api/tariff-plans/plan_a/rules/rule_1", tariffWritePermission, TariffRuleDeleteDisabledCode,
			func(h *DisabledWriteHandler, w http.ResponseWriter, r *http.Request) { h.DeleteRule(w, r) }},
	}
}

// disabledTariffReq builds a request with an optional authenticated principal.
func disabledTariffReq(method, path, username, role string, withPrincipal bool) *http.Request {
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

// TestDisabledWriteHandler_AdminDisabledConflict verifies that authorized admin
// requests receive the exact disabled contract (HTTP 409, error==code)
// before any body parsing or rate limiting.
func TestDisabledWriteHandler_AdminDisabledConflict(t *testing.T) {
	h := NewDisabledWriteHandler(nil)

	for _, tc := range disabledTariffCases() {
		t.Run(tc.name, func(t *testing.T) {
			req := disabledTariffReq(tc.method, tc.path, "admin", "admin", true)
			w := httptest.NewRecorder()

			tc.call(h, w, req)

			if w.Code != http.StatusConflict {
				t.Fatalf("expected status 409, got %d", w.Code)
			}
			var resp map[string]string
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if resp["error"] != tc.code || resp["code"] != tc.code {
				t.Errorf("expected error/code %q, got %q/%q", tc.code, resp["error"], resp["code"])
			}
		})
	}
}

// TestDisabledWriteHandler_ViewerPermissionDenied verifies the 403 permission
// boundary and the per-endpoint permission identity.
func TestDisabledWriteHandler_ViewerPermissionDenied(t *testing.T) {
	h := NewDisabledWriteHandler(nil)

	for _, tc := range disabledTariffCases() {
		t.Run(tc.name, func(t *testing.T) {
			req := disabledTariffReq(tc.method, tc.path, "viewer1", "viewer", true)
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
			if resp["permission"] != tc.permission {
				t.Errorf("expected permission %q, got %q", tc.permission, resp["permission"])
			}
		})
	}
}

// TestDisabledWriteHandler_Unauthenticated verifies the 401 principal guard.
func TestDisabledWriteHandler_Unauthenticated(t *testing.T) {
	h := NewDisabledWriteHandler(nil)

	for _, tc := range disabledTariffCases() {
		t.Run(tc.name, func(t *testing.T) {
			req := disabledTariffReq(tc.method, tc.path, "", "", false)
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
