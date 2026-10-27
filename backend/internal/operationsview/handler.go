package operationsview

import (
	"errors"
	"net/http"
	"strings"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// RateLimiter defines the interface for rate limiting HTTP requests.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// AuditWriter defines the interface for recording audit log entries.
type AuditWriter interface {
	WriteBestEffort(input audit.WriteAuditInput)
}

// summaryRateLimit matches the NF health read endpoints: 120 requests per
// 60 seconds per authenticated user.
const (
	summaryRateLimit     = 120
	summaryRateWindowSec = 60
)

// Handler serves the operations summary API surface.
type Handler struct {
	service     *Service
	limiter     RateLimiter
	auditWriter AuditWriter
}

// NewHandler constructs the operations summary HTTP handler.
func NewHandler(service *Service, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{service: service, limiter: limiter, auditWriter: auditWriter}
}

// validSections is the accepted section vocabulary keyed for lookup.
func validSections() map[string]bool {
	return map[string]bool{
		SectionInventory: true,
		SectionDiscovery: true,
		SectionHealth:    true,
		SectionAlerts:    true,
		SectionTopology:  true,
	}
}

// parseSections resolves the requested sections. An absent parameter returns
// all sections; an empty value returns all sections; unknown or duplicated
// sections are rejected with 400.
func parseSections(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return append([]string(nil), AllSections...), nil
	}
	seen := make(map[string]bool, len(AllSections))
	sections := make([]string, 0, len(AllSections))
	valid := validSections()
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, errors.New("empty section name")
		}
		if !valid[part] {
			return nil, errors.New("unknown section: " + part)
		}
		if seen[part] {
			return nil, errors.New("duplicated section: " + part)
		}
		seen[part] = true
		sections = append(sections, part)
	}
	return sections, nil
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "operations_summary.denied",
		Module: "operations_summary",
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

// Summary serves GET /api/operations/summary.
func (h *Handler) Summary(w http.ResponseWriter, r *http.Request) {
	const method, path = http.MethodGet, "/api/operations/summary"
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
	if h.limiter != nil && !h.limiter.Enforce(w, r, "operations:summary:"+p.Username, summaryRateLimit, summaryRateWindowSec) {
		return
	}

	sections, err := parseSections(r.URL.Query().Get("sections"))
	if err != nil {
		response.BadRequest(w, err.Error(), ErrCodeInvalidSection)
		return
	}

	resp := h.service.Build(r.Context(), sections)
	response.JSON(w, http.StatusOK, resp)
}
