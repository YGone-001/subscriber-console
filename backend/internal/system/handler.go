package system

import (
	"encoding/json"
	"net/http"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"

	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

// Handler handles HTTP requests for system diagnostics and health endpoints.
type Handler struct {
	xcloudDb *mongo.Database
	appDb    *mongo.Database
	limiter  *ratelimit.Limiter
}

// NewHandler creates a new system Handler.
func NewHandler(xcloudDb, appDb *mongo.Database, limiter *ratelimit.Limiter) *Handler {
	return &Handler{
		xcloudDb: xcloudDb,
		appDb:    appDb,
		limiter:  limiter,
	}
}

// MongoHealth handles GET /api/system/mongo/health.
// Returns HTTP 200 even on failure (with ok: false and degraded report).
func (h *Handler) MongoHealth(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "system:mongo-health:"+p.Username, 30, 60) {
		return
	}

	report, err := CheckMongoHealth(r.Context(), h.xcloudDb, h.appDb)
	if err != nil {
		errMsg := "MongoDB health check failed"
		response.JSON(w, http.StatusOK, MongoHealthReport{
			OK:                 false,
			Database:           nil,
			Databases:          nil,
			CheckedAt:          time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			LatencyMs:          nil,
			Collections:        []CollectionHealth{},
			MissingCollections: []string{},
			MissingIndexes:     []MissingIndexRef{},
			Error:              &errMsg,
		})
		return
	}

	response.JSON(w, http.StatusOK, report)
}

// SystemHealth handles GET /api/system/health.
func (h *Handler) SystemHealth(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "system:health:"+p.Username, 30, 60) {
		return
	}

	health, err := CheckComprehensiveSystemHealth(r.Context(), h.xcloudDb, h.appDb)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]interface{}{
			"status":    "critical",
			"score":     0,
			"checkedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			"error":     "Comprehensive system health check failed",
		})
		return
	}

	response.JSON(w, http.StatusOK, health)
}

// AuditStatus handles GET /api/system/audit/status.
func (h *Handler) AuditStatus(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "system:audit-status:"+p.Username, 60, 60) {
		return
	}

	response.JSON(w, http.StatusOK, map[string]int64{
		"lastSaveTime": time.Now().Unix(),
	})
}

// AuditScan handles POST /api/system/audit/scan.
// Accessible by admin and operator roles; viewer is denied.
func (h *Handler) AuditScan(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	normRole := auth.NormalizeRole(p.Role)
	if normRole != "admin" && normRole != "operator" {
		response.Error(w, http.StatusForbidden, "Forbidden: Insufficient permissions", "PERMISSION_DENIED")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "system:audit-scan:"+p.Username, 30, 60) {
		return
	}

	var req AuditScanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Audit scan failed",
		})
		return
	}

	cursor := "0"
	if req.Cursor != nil {
		cursor = *req.Cursor
	}
	phase := "sub"
	if req.Phase != nil {
		phase = *req.Phase
	}

	result, err := ScanSubscriberDocuments(r.Context(), h.xcloudDb, h.appDb, cursor, phase)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Audit scan failed",
		})
		return
	}

	response.JSON(w, http.StatusOK, result)
}
