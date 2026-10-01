package tariff

import (
	"net/http"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// Disabled operation codes for the tariff write surfaces that the governance
// registry classifies as DISABLED. After the RBAC permission boundary every
// authorized request receives HTTP 409 with the stable disabled code BEFORE
// body parsing, rate limiting, persistence, or audit side effects.
const (
	TariffCreateDisabledCode     = "OCS_TARIFF_CREATE_NOT_SUPPORTED"
	PlanMigrationDisabledCode    = "OCS_PLAN_MIGRATION_NOT_SUPPORTED"
	TariffRuleCreateDisabledCode = "OCS_TARIFF_RULE_CREATE_NOT_SUPPORTED"
	TariffRuleUpdateDisabledCode = "OCS_TARIFF_RULE_UPDATE_NOT_SUPPORTED"
	TariffRuleToggleDisabledCode = "OCS_TARIFF_RULE_TOGGLE_NOT_SUPPORTED"
	TariffRuleDeleteDisabledCode = "OCS_TARIFF_RULE_DELETE_NOT_SUPPORTED"
)

// Permissions matching requirePermission(definition.permission) for the
// governance registry entries covered by this handler.
const (
	tariffWritePermission = "ocs.tariff.write"
	planAssignPermission  = "ocs.plan.assign"
)

// DisabledWriteHandler provides the Go production handlers for the tariff write
// endpoints whose governance mode is DISABLED:
//
//   - POST   /api/tariff-plans/import                    (TARIFF_PLAN_CREATE)
//   - POST   /api/tariff-plans/{planId}/migrate          (PLAN_MIGRATE)
//   - POST   /api/tariff-plans/{planId}/rules            (TARIFF_RULE_CREATE)
//   - PUT    /api/tariff-plans/{planId}/rules/{ruleId}   (TARIFF_RULE_UPDATE)
//   - PATCH  /api/tariff-plans/{planId}/rules/{ruleId}   (TARIFF_RULE_TOGGLE)
//   - DELETE /api/tariff-plans/{planId}/rules/{ruleId}   (TARIFF_RULE_DELETE)
//
// These handlers are registered by the Go server and are Go production-owned at
// the Nginx edge.
type DisabledWriteHandler struct {
	auditWriter *audit.Writer
}

// NewDisabledWriteHandler creates a new disabled tariff write handler.
func NewDisabledWriteHandler(auditWriter *audit.Writer) *DisabledWriteHandler {
	return &DisabledWriteHandler{auditWriter: auditWriter}
}

// Import handles POST /api/tariff-plans/import.
func (h *DisabledWriteHandler) Import(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, tariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffCreateDisabledCode, TariffCreateDisabledCode)
}

// Migrate handles POST /api/tariff-plans/{planId}/migrate.
func (h *DisabledWriteHandler) Migrate(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, planAssignPermission) {
		return
	}
	response.Error(w, http.StatusConflict, PlanMigrationDisabledCode, PlanMigrationDisabledCode)
}

// CreateRule handles POST /api/tariff-plans/{planId}/rules.
func (h *DisabledWriteHandler) CreateRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, tariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleCreateDisabledCode, TariffRuleCreateDisabledCode)
}

// UpdateRule handles PUT /api/tariff-plans/{planId}/rules/{ruleId}.
func (h *DisabledWriteHandler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, tariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleUpdateDisabledCode, TariffRuleUpdateDisabledCode)
}

// ToggleRule handles PATCH /api/tariff-plans/{planId}/rules/{ruleId}.
func (h *DisabledWriteHandler) ToggleRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, tariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleToggleDisabledCode, TariffRuleToggleDisabledCode)
}

// DeleteRule handles DELETE /api/tariff-plans/{planId}/rules/{ruleId}.
func (h *DisabledWriteHandler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, tariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleDeleteDisabledCode, TariffRuleDeleteDisabledCode)
}

// authorize enforces the shared authentication + permission boundary.
// Unauthenticated requests are intercepted by the auth middleware; the
// principal check mirrors the other Go handlers. Denials emit best-effort
// authorization.denied evidence.
func (h *DisabledWriteHandler) authorize(w http.ResponseWriter, r *http.Request, permission string) bool {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return false
	}
	return audit.RequirePermissionWithAudit(w, r, p, permission, h.auditWriter)
}
