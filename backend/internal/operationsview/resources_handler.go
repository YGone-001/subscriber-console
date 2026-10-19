package operationsview

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/inventory"
	"subscriber/internal/response"
)

// Validation error codes for GET /api/operations/resources.
const (
	ErrCodeInvalidMonitoring = "INVALID_MONITORING_FILTER"
	ErrCodeInvalidRoles      = "INVALID_ROLES"
)

// resourceAllowedParams is the complete accepted query vocabulary. Anything
// else is rejected instead of silently ignored, so a typo cannot look like an
// applied filter.
func resourceAllowedParams() map[string]bool {
	return map[string]bool{
		"q":          true,
		"domain":     true,
		"kind":       true,
		"monitoring": true,
		"roles":      true,
		"cursor":     true,
		"limit":      true,
	}
}

func validMonitoringFilters() map[string]bool {
	return map[string]bool{
		MonitoringMonitored:   true,
		MonitoringUnmonitored: true,
		MonitoringUnresolved:  true,
		MonitoringDegraded:    true,
		MonitoringUnknown:     true,
		MonitoringStale:       true,
	}
}

// parseRoles validates, de-duplicates and bounds the canonical role filter.
// Duplicates are folded (the filter is a set), while empty, malformed and
// over-limit input is rejected.
func parseRoles(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	seen := make(map[string]bool)
	roles := make([]string, 0, ResourceMaxRoles)
	for _, part := range strings.Split(raw, ",") {
		role := strings.TrimSpace(part)
		if role == "" {
			return nil, errors.New("roles must not contain an empty value")
		}
		if len(role) > 64 {
			return nil, errors.New("role value is too long")
		}
		for _, r := range role {
			if unicode.IsControl(r) {
				return nil, errors.New("role value contains a control character")
			}
		}
		if seen[role] {
			continue
		}
		seen[role] = true
		roles = append(roles, role)
	}
	if len(roles) > ResourceMaxRoles {
		return nil, errors.New("too many roles requested")
	}
	return roles, nil
}

// ResourceHandler serves GET /api/operations/resources.
type ResourceHandler struct {
	service     *ResourceService
	limiter     RateLimiter
	auditWriter AuditWriter
}

// NewResourceHandler constructs the operations resource projection handler.
func NewResourceHandler(service *ResourceService, limiter RateLimiter, auditWriter AuditWriter) *ResourceHandler {
	return &ResourceHandler{service: service, limiter: limiter, auditWriter: auditWriter}
}

func (h *ResourceHandler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "operations_resources.denied",
		Module: "operations_resources",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Request:   &audit.RequestInput{Method: method, Path: path},
		Result:    "denied",
		RiskLevel: "low",
	})
}

// Resources serves the read-only operations resource projection.
//
// It requires core.read only: the projection performs no write, no Fresh Actor
// revalidation and no operation log.
func (h *ResourceHandler) Resources(w http.ResponseWriter, r *http.Request) {
	const method, path = http.MethodGet, "/api/operations/resources"

	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "operations:resources:"+p.Username, summaryRateLimit, summaryRateWindowSec) {
		return
	}

	q := r.URL.Query()
	allowed := resourceAllowedParams()
	for param := range q {
		if !allowed[param] {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}

	kind := q.Get("kind")
	if kind != "" {
		if err := inventory.ValidateKind(kind); err != nil {
			response.BadRequest(w, err.Error(), "INVALID_KIND_FILTER")
			return
		}
	}

	domain := q.Get("domain")
	if domain != "" {
		if err := inventory.ValidateDomain(domain); err != nil {
			response.BadRequest(w, err.Error(), "INVALID_DOMAIN_FILTER")
			return
		}
	}

	monitoring := strings.TrimSpace(q.Get("monitoring"))
	if monitoring != "" && !validMonitoringFilters()[monitoring] {
		response.BadRequest(w, "unsupported monitoring filter", ErrCodeInvalidMonitoring)
		return
	}

	roles, err := parseRoles(q.Get("roles"))
	if err != nil {
		response.BadRequest(w, err.Error(), ErrCodeInvalidRoles)
		return
	}

	limit := ResourceDefaultLimit
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		parsed, perr := strconv.Atoi(raw)
		if perr != nil || parsed < 1 || parsed > ResourceMaxLimit {
			response.BadRequest(w, "limit must be an integer between 1 and 200", "INVALID_LIMIT")
			return
		}
		limit = parsed
	}

	resp, err := h.service.Build(r.Context(), ResourceQuery{
		Query:      strings.TrimSpace(q.Get("q")),
		Domain:     domain,
		Kind:       kind,
		Monitoring: monitoring,
		Roles:      roles,
		Cursor:     strings.TrimSpace(q.Get("cursor")),
		Limit:      limit,
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}

	response.JSON(w, http.StatusOK, resp)
}
