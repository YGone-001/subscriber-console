package rating

import (
	"net/http"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// Disabled operation codes for the rating write surfaces. The current Node
// implementation is the authoritative contract: the OCS governance registry
// classifies rating create/update/delete as DISABLED, so after the RBAC
// permission boundary every authorized request receives HTTP 409 with the
// stable disabled code BEFORE body parsing, rate limiting, persistence, or
// audit side effects.
const (
	RatingCreateDisabledCode = "OCS_RATING_CREATE_NOT_SUPPORTED"
	RatingUpdateDisabledCode = "OCS_RATING_UPDATE_NOT_SUPPORTED"
	RatingDeleteDisabledCode = "OCS_RATING_DELETE_NOT_SUPPORTED"
)

// ratingWritePermission is the RBAC permission required by all three rating
// write surfaces (matches Node requirePermission()).
const ratingWritePermission = "ocs.rating.write"

// WriteHandler provides the production Go counterparts for the rating write
// endpoints (POST /api/ratings, PUT/DELETE /api/ratings/{id}).
//
// Shadow freeze: these handlers are registered by the production Go server but
// are NOT part of CUTOVER_TABLE, so the Node runtime remains the production
// owner until an approved cutover.
type WriteHandler struct {
	auditWriter *audit.Writer
}

// NewWriteHandler creates a new rating WriteHandler.
func NewWriteHandler(auditWriter *audit.Writer) *WriteHandler {
	return &WriteHandler{auditWriter: auditWriter}
}

// Create handles POST /api/ratings.
func (h *WriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}
	response.Error(w, http.StatusConflict, RatingCreateDisabledCode, RatingCreateDisabledCode)
}

// Update handles PUT /api/ratings/{id}.
func (h *WriteHandler) Update(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}
	response.Error(w, http.StatusConflict, RatingUpdateDisabledCode, RatingUpdateDisabledCode)
}

// Delete handles DELETE /api/ratings/{id}.
func (h *WriteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if !h.authorize(w, r) {
		return
	}
	response.Error(w, http.StatusConflict, RatingDeleteDisabledCode, RatingDeleteDisabledCode)
}

// authorize enforces the shared authentication + permission boundary.
// Unauthenticated requests are intercepted by the auth middleware; the
// principal check mirrors the other Go handlers. Denials emit best-effort
// authorization.denied evidence matching Node recordPermissionDenied().
func (h *WriteHandler) authorize(w http.ResponseWriter, r *http.Request) bool {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return false
	}
	return audit.RequirePermissionWithAudit(w, r, p, ratingWritePermission, h.auditWriter)
}
