package ocs

import (
	"fmt"
	"net/http"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// PlanAssignDisabledCode is the stable disabled operation code emitted by the
// Go production authority for POST /api/subscribers/policy (OCS_PLAN_ASSIGN).
const PlanAssignDisabledCode = "OCS_PLAN_ASSIGN_NOT_SUPPORTED"

// Permissions matching requirePermission(definition.permission) for the OCS
// governance registry entries covered by this handler.
const (
	planAssignPermission    = "ocs.plan.assign"
	balanceAdjustPermission = "ocs.balance.adjust"
)

// NodeParityRateLimiter abstracts the contract-parity rate limit enforcement
// used by the traffic-adjustments surface.
type NodeParityRateLimiter interface {
	EnforceNodeParity(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// ManagementHandler provides the Go production handlers for OCS management
// write endpoints:
//
//   - POST /api/subscribers/policy                     (disabled contract)
//   - POST /api/subscribers/{imsi}/traffic-adjustments (allow contract)
//
// These handlers are registered by the Go server and are Go production-owned at
// the Nginx edge.
type ManagementHandler struct {
	limiter     NodeParityRateLimiter
	auditWriter *audit.Writer
}

// NewManagementHandler creates a new OCS management handler.
func NewManagementHandler(limiter NodeParityRateLimiter, auditWriter *audit.Writer) *ManagementHandler {
	return &ManagementHandler{limiter: limiter, auditWriter: auditWriter}
}

// AssignPolicy handles POST /api/subscribers/policy.
//
// Contract: the RBAC permission boundary runs first; the OCS governance
// registry classifies OCS_PLAN_ASSIGN as DISABLED, so every authorized request
// receives HTTP 409 with the stable disabled code before body parsing, rate
// limiting, persistence, or audit side effects.
func (h *ManagementHandler) AssignPolicy(w http.ResponseWriter, r *http.Request) {
	if h.authorize(w, r, planAssignPermission) == nil {
		return
	}
	response.Error(w, http.StatusConflict, PlanAssignDisabledCode, PlanAssignDisabledCode)
}

// TrafficAdjustments handles POST /api/subscribers/{imsi}/traffic-adjustments.
//
// Contract: permission boundary (ocs.balance.adjust), then contract-parity
// rate limit (`traffic-adjustments:<username>`, 30/60), then the allow response.
// OCS_BALANCE_ADJUST is DIRECT_GOVERNED (executable), so this surface answers
// with the routed acknowledgement instead of a disabled conflict.
func (h *ManagementHandler) TrafficAdjustments(w http.ResponseWriter, r *http.Request) {
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
// authorization.denied evidence.
func (h *ManagementHandler) authorize(w http.ResponseWriter, r *http.Request, permission string) *auth.Principal {
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
