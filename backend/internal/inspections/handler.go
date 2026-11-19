package inspections

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/response"
)

type RateLimiter interface {
	Enforce(http.ResponseWriter, *http.Request, string, int, int) bool
}
type Handler struct {
	service *Service
	limiter RateLimiter
}

func NewHandler(s *Service, l RateLimiter) *Handler { return &Handler{s, l} }
func replyError(w http.ResponseWriter, e error) {
	var f *Failure
	var g *governance.HTTPError
	switch {
	case errors.As(e, &f):
		response.Error(w, f.Status, f.Message, f.Code)
	case errors.As(e, &g):
		response.Error(w, g.Status, g.Message, g.Code)
	case errors.Is(e, ErrNotFound):
		response.Error(w, 404, "Inspection plan or run not found", "INSPECTION_NOT_FOUND")
	case errors.Is(e, ErrConflict):
		response.Error(w, 409, "Inspection revision or request conflict", "INSPECTION_CONFLICT")
	default:
		response.Error(w, 503, "Inspection storage or evidence is unavailable", "INSPECTION_UNAVAILABLE")
	}
}
func body(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		response.Error(w, 400, "Invalid bounded inspection JSON", "INSPECTION_INVALID_BODY")
		return false
	}
	return true
}

var groupKeys = []string{"networkKey", "siteResourceId", "hostResourceId", "operatorName", "plmn", "domain"}

func allowed(r *http.Request, keys ...string) error {
	_, e := parseQuery(r.URL.Query(), keys...)
	return e
}
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, 401, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	permission, limit := "core.read", 120
	if r.Method != "GET" {
		permission = "core.configure"
		limit = 30
	}
	if strings.HasSuffix(r.URL.Path, "/runs") && r.Method == "POST" {
		limit = 10
	}
	if strings.HasSuffix(r.URL.Path, "/export") {
		limit = 10
	}
	if !auth.HasPermission(p, permission) {
		if h.service.audit != nil {
			h.service.audit.WriteBestEffort(audit.WriteAuditInput{Action: "inspection.denied", Module: "inspections", Result: "denied", RiskLevel: "low", Actor: audit.ActorInput{Type: "user", Username: p.Username, Role: p.NormalizedRole}})
		}
		response.Error(w, 403, "Forbidden", "PERMISSION_DENIED")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "inspections:"+r.Pattern+":"+p.Username, limit, 60) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	var out any
	var err error
	status := 200
	switch r.Pattern {
	case "GET /api/inspections/meta":
		err = allowed(r)
		if err == nil {
			out = h.service.Meta(ctx)
		}
	case "POST /api/inspection-plans/preview":
		var req Definition
		if err = allowed(r); err == nil {
			if !body(w, r, &req) {
				return
			}
			out, err = h.service.Preview(ctx, req)
		}
	case "POST /api/inspection-plans":
		var req CreateRequest
		if err = allowed(r); err == nil {
			if !body(w, r, &req) {
				return
			}
			out, err = h.service.Create(ctx, p, req)
			status = 201
		}
	case "GET /api/inspection-plans":
		var q Query
		q, err = parseQuery(r.URL.Query(), append([]string{"q", "archived", "cursor", "limit"}, groupKeys...)...)
		if err == nil {
			out, err = h.service.ListPlans(ctx, q)
		}
	case "GET /api/inspection-plans/{planId}":
		if err = allowed(r); err == nil {
			out, err = h.service.GetPlan(ctx, r.PathValue("planId"))
		}
	case "PUT /api/inspection-plans/{planId}":
		var req UpdateRequest
		if err = allowed(r); err == nil {
			if !body(w, r, &req) {
				return
			}
			out, err = h.service.Update(ctx, p, r.PathValue("planId"), req)
		}
	case "POST /api/inspection-plans/{planId}/runs":
		var req RunRequest
		if err = allowed(r); err == nil {
			if !body(w, r, &req) {
				return
			}
			out, err = h.service.Trigger(ctx, p, r.PathValue("planId"), req)
			status = 202
		}
	case "GET /api/inspection-runs":
		var q Query
		q, err = parseQuery(r.URL.Query(), append([]string{"q", "planId", "state", "conclusion", "cursor", "limit"}, groupKeys...)...)
		if err == nil {
			out, err = h.service.ListRuns(ctx, q)
		}
	case "GET /api/inspection-runs/{runId}":
		if err = allowed(r); err == nil {
			var v *Run
			v, err = h.service.GetRun(ctx, r.PathValue("runId"))
			if err == nil {
				copy := *v
				copy.Items = nil
				out = &copy
			}
		}
	case "GET /api/inspection-runs/{runId}/items":
		var q Query
		q, err = parseQuery(r.URL.Query(), "kind", "result", "cursor", "limit")
		if err == nil {
			out, err = h.service.Items(ctx, r.PathValue("runId"), q)
		}
	case "GET /api/inspection-runs/{runId}/export":
		if err = allowed(r, "format"); err == nil {
			var v *Run
			v, err = h.service.GetRun(ctx, r.PathValue("runId"))
			if err == nil {
				var b []byte
				var contentType string
				b, contentType, err = exportRun(v, r.URL.Query().Get("format"))
				if err == nil {
					w.Header().Set("Content-Type", contentType)
					w.Header().Set("X-Content-Type-Options", "nosniff")
					format := r.URL.Query().Get("format")
					if format == "" {
						format = "csv"
					}
					w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="xcloud-inspection-%s.%s"`, v.ID, format))
					_, _ = w.Write(b)
					return
				}
			}
		}
	default:
		response.NotFound(w)
		return
	}
	if err != nil {
		replyError(w, err)
		return
	}
	encoded, e := json.Marshal(out)
	if e != nil {
		response.InternalError(w)
		return
	}
	if len(encoded) > MaxRunBytes {
		response.Error(w, 503, "Inspection response exceeds its bounded size", "INSPECTION_RESPONSE_LIMIT")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(encoded)
}
func csvText(v string) string {
	trimmed := strings.TrimLeftFunc(v, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + v
	}
	return v
}
func exportRun(v *Run, format string) ([]byte, string, error) {
	if !terminal(v.State) {
		return nil, "", fail(409, "INSPECTION_REPORT_PENDING", "Wait for the fixed inspection report to finish")
	}
	if format == "json" {
		b, e := json.MarshalIndent(v, "", "  ")
		if e != nil {
			return nil, "", e
		}
		if len(b) > 10<<20 {
			return nil, "", fail(413, "INSPECTION_EXPORT_LIMIT", "Export size exceeded")
		}
		return b, "application/json; charset=utf-8", nil
	}
	if format != "" && format != "csv" {
		return nil, "", fail(400, "INSPECTION_INVALID_FORMAT", "Select csv or json")
	}
	if len(v.Items) > 10000 {
		return nil, "", fail(413, "INSPECTION_EXPORT_LIMIT", "Export row count exceeded")
	}
	var b bytes.Buffer
	b.Write([]byte{0xef, 0xbb, 0xbf})
	w := csv.NewWriter(&b)
	header := []string{"runId", "planId", "planRevision", "planName", "executionState", "conclusion", "scheduledFor", "queuedAt", "startedAt", "finishedAt", "scopeMode", "scopeSelectors", "scopeFingerprint", "scopeResources", "scopeAgents", "scopeCoverage", "agentScopeCoverage", "sourceCoverage", "comparison", "checkKind", "subjectId", "resourceId", "name", "result", "severity", "reason", "readAt", "evidenceAt", "ageSeconds", "maxAgeSeconds", "evidenceId", "layers", "count", "change"}
	_ = w.Write(header)
	stringify := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	at := func(t *time.Time) string {
		if t == nil {
			return ""
		}
		return t.Format(time.RFC3339Nano)
	}
	prefix := []string{v.ID, v.PlanID, strconv.FormatInt(v.PlanRevision, 10), v.Definition.Name, v.State, v.Conclusion, at(v.ScheduledFor), v.QueuedAt.Format(time.RFC3339Nano), at(v.StartedAt), at(v.FinishedAt), v.Definition.Scope.Mode, stringify(v.Definition.Scope), v.Scope.Fingerprint, strconv.Itoa(len(v.Scope.Resources)), strconv.Itoa(len(v.Scope.AgentIDs)), stringify(v.Scope.Coverage), stringify(v.Scope.AgentCoverage), stringify(v.Coverage), stringify(v.Comparison)}
	items := v.Items
	if len(items) == 0 {
		items = []Item{{Reason: v.Reason}}
	}
	for _, i := range items {
		age, count := "", ""
		if i.AgeSeconds != nil {
			age = strconv.FormatInt(*i.AgeSeconds, 10)
		}
		if i.Count != nil {
			count = strconv.Itoa(*i.Count)
		}
		readAt := ""
		if !i.ReadAt.IsZero() {
			readAt = i.ReadAt.Format(time.RFC3339Nano)
		}
		row := append(append([]string{}, prefix...), i.Kind, i.SubjectID, i.ResourceID, i.Name, i.Result, i.Severity, i.Reason, readAt, at(i.EvidenceAt), age, strconv.Itoa(i.MaxAgeSeconds), i.EvidenceID, stringify(i.Layers), count, i.Change)
		for n := range row {
			row[n] = csvText(row[n])
		}
		if e := w.Write(row); e != nil {
			return nil, "", e
		}
	}
	w.Flush()
	if e := w.Error(); e != nil {
		return nil, "", e
	}
	if b.Len() > 10<<20 {
		return nil, "", fail(413, "INSPECTION_EXPORT_LIMIT", "Export size exceeded")
	}
	return b.Bytes(), "text/csv; charset=utf-8", nil
}
