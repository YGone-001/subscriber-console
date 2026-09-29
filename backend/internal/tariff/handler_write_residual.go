package tariff

import (
	"net/http"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// Disabled operation codes for the residual tariff write surfaces. The current
// Node implementation is the authoritative contract: the OCS governance
// registry classifies these operations as DISABLED, so after the RBAC
// permission boundary every authorized request receives HTTP 409 with the
// stable disabled code BEFORE body parsing, rate limiting, persistence, or
// audit side effects.
const (
	TariffCreateDisabledCode     = "OCS_TARIFF_CREATE_NOT_SUPPORTED"
	PlanMigrationDisabledCode    = "OCS_PLAN_MIGRATION_NOT_SUPPORTED"
	TariffRuleCreateDisabledCode = "OCS_TARIFF_RULE_CREATE_NOT_SUPPORTED"
	TariffRuleUpdateDisabledCode = "OCS_TARIFF_RULE_UPDATE_NOT_SUPPORTED"
	TariffRuleToggleDisabledCode = "OCS_TARIFF_RULE_TOGGLE_NOT_SUPPORTED"
	TariffRuleDeleteDisabledCode = "OCS_TARIFF_RULE_DELETE_NOT_SUPPORTED"
)

// Residual permissions matching Node requirePermission(definition.permission).
const (
	residualTariffWritePermission = "ocs.tariff.write"
	residualPlanAssignPermission  = "ocs.plan.assign"
)

// ResidualWriteHandler provides the production Go counterparts for residual
// tariff write endpoints:
//
//   - POST   /api/tariff-plans/import                    (TARIFF_PLAN_CREATE)
//   - POST   /api/tariff-plans/{planId}/migrate          (PLAN_MIGRATE)
//   - POST   /api/tariff-plans/{planId}/rules            (TARIFF_RULE_CREATE)
//   - PUT    /api/tariff-plans/{planId}/rules/{ruleId}   (TARIFF_RULE_UPDATE)
//   - PATCH  /api/tariff-plans/{planId}/rules/{ruleId}   (TARIFF_RULE_TOGGLE)
//   - DELETE /api/tariff-plans/{planId}/rules/{ruleId}   (TARIFF_RULE_DELETE)
//
// Shadow freeze: these handlers are registered by the production Go server but
// are NOT part of CUTOVER_TABLE, so the Node runtime remains the production
// owner until an approved cutover.
type ResidualWriteHandler struct {
	auditWriter *audit.Writer
}

// NewResidualWriteHandler creates a new residual tariff write handler.
func NewResidualWriteHandler(auditWriter *audit.Writer) *ResidualWriteHandler {
	return &ResidualWriteHandler{auditWriter: auditWriter}
}

// Import handles POST /api/tariff-plans/import.
func (h *ResidualWriteHandler) Import(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, residualTariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffCreateDisabledCode, TariffCreateDisabledCode)
}

// Migrate handles POST /api/tariff-plans/{planId}/migrate.
func (h *ResidualWriteHandler) Migrate(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, residualPlanAssignPermission) {
		return
	}
	response.Error(w, http.StatusConflict, PlanMigrationDisabledCode, PlanMigrationDisabledCode)
}

// CreateRule handles POST /api/tariff-plans/{planId}/rules.
func (h *ResidualWriteHandler) CreateRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, residualTariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleCreateDisabledCode, TariffRuleCreateDisabledCode)
}

// UpdateRule handles PUT /api/tariff-plans/{planId}/rules/{ruleId}.
func (h *ResidualWriteHandler) UpdateRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, residualTariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleUpdateDisabledCode, TariffRuleUpdateDisabledCode)
}

// ToggleRule handles PATCH /api/tariff-plans/{planId}/rules/{ruleId}.
func (h *ResidualWriteHandler) ToggleRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, residualTariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleToggleDisabledCode, TariffRuleToggleDisabledCode)
}

// DeleteRule handles DELETE /api/tariff-plans/{planId}/rules/{ruleId}.
func (h *ResidualWriteHandler) DeleteRule(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r, residualTariffWritePermission) {
		return
	}
	response.Error(w, http.StatusConflict, TariffRuleDeleteDisabledCode, TariffRuleDeleteDisabledCode)
}

// authorize enforces the shared authentication + permission boundary.
// Unauthenticated requests are intercepted by the auth middleware; the
// principal check mirrors the other Go handlers. Denials emit best-effort
// authorization.denied evidence matching Node recordPermissionDenied().
func (h *ResidualWriteHandler) authorize(w http.ResponseWriter, r *http.Request, permission string) bool {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return false
	}
	return audit.RequirePermissionWithAudit(w, r, p, permission, h.auditWriter)
}
