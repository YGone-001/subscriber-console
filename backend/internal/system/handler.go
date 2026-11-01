package system

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"

	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
	"subscriber/internal/response"
)

const comprehensiveHealthCacheTTL = 30 * time.Second

// Handler handles HTTP requests for system diagnostics and health endpoints.
type Handler struct {
	xcloudDb *mongo.Database
	appDb    *mongo.Database
	limiter  *ratelimit.Limiter

	probes []PlatformProbe

	cacheMu       sync.Mutex
	cachedHealth  *ComprehensiveSystemHealth
	cachedAt      time.Time
	cacheDuration time.Duration
}

// NewHandler creates a new system Handler.
func NewHandler(xcloudDb, appDb *mongo.Database, limiter *ratelimit.Limiter) *Handler {
	return &Handler{
		xcloudDb:      xcloudDb,
		appDb:         appDb,
		limiter:       limiter,
		cacheDuration: comprehensiveHealthCacheTTL,
	}
}

// SetPlatformProbes registers the runtime probes owned by the process. It must
// be called after all background components have been constructed.
func (h *Handler) SetPlatformProbes(probes []PlatformProbe) {
	h.probes = probes
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
//
// The response carries two presentation sections:
//   - platform: runtime probes owned by this process;
//   - dataConsistency: the business-document anomaly evaluation.
//
// The legacy subsystems field stays for compatibility. A failed evaluation
// returns HTTP 500 with a body that carries no healthy default; the console
// must render an explicit unavailable state instead.
func (h *Handler) SystemHealth(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		response.Error(w, http.StatusForbidden, "Forbidden", "PERMISSION_DENIED")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "system:health:"+p.Username, 30, 60) {
		return
	}

	now := time.Now()
	h.cacheMu.Lock()
	if h.cachedHealth != nil && h.cacheDuration > 0 && now.Sub(h.cachedAt) < h.cacheDuration {
		cached := *h.cachedHealth
		h.cacheMu.Unlock()
		response.JSON(w, http.StatusOK, cached)
		return
	}
	h.cacheMu.Unlock()

	health, err := CheckComprehensiveSystemHealth(r.Context(), h.xcloudDb, h.appDb)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]interface{}{
			"status":    "unavailable",
			"checkedAt": now.UTC().Format("2006-01-02T15:04:05.000Z"),
			"error":     "Comprehensive system health check failed",
			"platform":  nil,
		})
		return
	}

	platform := CheckPlatformHealth(r.Context(), h.probes)
	health.Platform = &platform
	health.DataConsistency = &DataConsistencyReport{
		Status:     dataConsistencyStatus(health),
		Sampled:    false,
		SampleSize: 0,
		CheckedAt:  health.CheckedAt,
	}

	h.cacheMu.Lock()
	h.cachedHealth = health
	h.cachedAt = now
	h.cacheMu.Unlock()

	response.JSON(w, http.StatusOK, health)
}

func dataConsistencyStatus(health *ComprehensiveSystemHealth) SubsystemStatus {
	if health == nil {
		return StatusUnavailable
	}
	switch health.Status {
	case StatusHealthy, StatusDegraded, StatusCritical:
		return health.Status
	default:
		return StatusUnavailable
	}
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
