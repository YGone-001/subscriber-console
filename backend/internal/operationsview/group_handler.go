package operationsview

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
)

type GroupHandler struct {
	service *GroupService
	limiter RateLimiter
	audit   AuditWriter
}

func NewGroupHandler(service *GroupService, limiter RateLimiter, writer AuditWriter) *GroupHandler {
	return &GroupHandler{service: service, limiter: limiter, audit: writer}
}
func (h *GroupHandler) Handle(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, 401, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		if h.audit != nil {
			h.audit.WriteBestEffort(audit.WriteAuditInput{Action: "operations.groups.denied", Module: "operations", Actor: audit.ActorInput{Type: "user", Username: p.Username, Role: p.Role}, Result: "denied"})
		}
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "operations:groups:"+r.URL.Path+":"+p.Username, 120, 60) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	q, e := ParseGroupQuery(r.URL.Query())
	if e != nil {
		response.BadRequest(w, e.Error(), "GROUP_INVALID_QUERY")
		return
	}
	if r.URL.Path == "/api/operations/groups/summary" {
		for _, key := range []string{"groupBy", "section", "kind", "severity", "q", "cursor", "limit"} {
			if r.URL.Query().Has(key) {
				response.BadRequest(w, "Summary accepts scope selectors only", "GROUP_INVALID_QUERY")
				return
			}
		}
	}
	if r.URL.Path == "/api/operations/groups/members" && (q.Kind != "" && q.Section != "resources" || q.Severity != "" && q.Section != "alerts") {
		response.BadRequest(w, "Section filter is not supported by this section", "GROUP_INVALID_QUERY")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var result any
	switch r.URL.Path {
	case "/api/operations/groups":
		result, e = h.service.Directory(ctx, q)
	case "/api/operations/groups/summary":
		result, e = h.service.Summary(ctx, q.GroupFilter)
	case "/api/operations/groups/members":
		result, e = h.service.Members(ctx, q)
	default:
		response.Error(w, 404, "Not found", "NOT_FOUND")
		return
	}
	if e != nil {
		var actor *governance.HTTPError
		if errors.As(e, &actor) {
			response.Error(w, actor.Status, actor.Message, actor.Code)
		} else if strings.Contains(e.Error(), "scope_changed") {
			response.Error(w, 409, "The group scope changed; restart pagination", "GROUP_SCOPE_CHANGED")
		} else {
			response.BadRequest(w, "Invalid group cursor", "GROUP_INVALID_CURSOR")
		}
		return
	}
	response.JSON(w, 200, result)
}
