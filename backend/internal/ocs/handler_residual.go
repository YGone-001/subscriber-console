package ocs

import (
	"fmt"
	"net/http"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// PlanAssignDisabledCode is the stable disabled operation code emitted by the
// Node authority for POST /api/subscribers/policy (OCS_PLAN_ASSIGN).
const PlanAssignDisabledCode = "OCS_PLAN_ASSIGN_NOT_SUPPORTED"

// Residual permissions matching Node requirePermission(definition.permission)
// for the OCS governance registry entries covered by this handler.
const (
	planAssignPermission    = "ocs.plan.assign"
	balanceAdjustPermission = "ocs.balance.adjust"
)

// NodeParityRateLimiter abstracts the Node-parity rate limit enforcement used by
// the residual traffic-adjustments surface.
type NodeParityRateLimiter interface {
	EnforceNodeParity(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// ResidualHandler provides the production Go counterparts for residual OCS
// management write endpoints:
//
//   - POST /api/subscribers/policy                     (disabled contract)
//   - POST /api/subscribers/{imsi}/traffic-adjustments (Node-compatible allow)
//
// Shadow freeze: these handlers are registered by the production Go server but
// are NOT part of CUTOVER_TABLE, so the Node runtime remains the production
// owner until an approved cutover.
type ResidualHandler struct {
	limiter     NodeParityRateLimiter
	auditWriter *audit.Writer
}

// NewResidualHandler creates a new residual OCS management handler.
func NewResidualHandler(limiter NodeParityRateLimiter, auditWriter *audit.Writer) *ResidualHandler {
	return &ResidualHandler{limiter: limiter, auditWriter: auditWriter}
}

// AssignPolicy handles POST /api/subscribers/policy.
//
// Node contract: the RBAC permission boundary runs first; the OCS governance
// registry classifies OCS_PLAN_ASSIGN as DISABLED, so every authorized request
// receives HTTP 409 with the stable disabled code before body parsing, rate
// limiting, persistence, or audit side effects.
func (h *ResidualHandler) AssignPolicy(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, planAssignPermission) == nil {
		return
	}
	response.Error(w, http.StatusConflict, PlanAssignDisabledCode, PlanAssignDisabledCode)
}

// TrafficAdjustments handles POST /api/subscribers/{imsi}/traffic-adjustments.
//
// Node contract: permission boundary (ocs.balance.adjust), then Node-parity
// rate limit (`traffic-adjustments:<username>`, 30/60), then the allow response.
// OCS_BALANCE_ADJUST is DIRECT_GOVERNED (executable), so this surface answers
// with the routed acknowledgement instead of a disabled conflict.
func (h *ResidualHandler) TrafficAdjustments(w http.ResponseWriter, r *http.Request) {
	p := h.authorize(w, r, balanceAdjustPermission)
	if p == nil {
		return
	}
	if h.limiter != nil {
		if !h.limiter.EnforceNodeParity(w, r, fmt.Sprintf("traffic-adjustments:%s", p.Username), 30, 60) {
			return
		}
	}
	response.JSON(w, http.StatusOK, map[string]string{
		"error": "Routed to Go backend",
		"imsi":  r.PathValue("imsi"),
	})
}

// authorize enforces the shared authentication + permission boundary.
// Unauthenticated requests are intercepted by the auth middleware; the
// principal check mirrors the other Go handlers. Denials emit best-effort
// authorization.denied evidence matching Node recordPermissionDenied().
func (h *ResidualHandler) authorize(w http.ResponseWriter, r *http.Request, permission string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !audit.RequirePermissionWithAudit(w, r, p, permission, h.auditWriter) {
		return nil
	}
	return p
}
