package nfhealth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

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

// RepositoryAPI is the handler-facing persistence surface.
type RepositoryAPI interface {
	CreateTarget(ctx context.Context, req *CreateTargetRequest, actor string) (*HealthTarget, error)
	GetTarget(ctx context.Context, targetID string) (*HealthTarget, error)
	ListTargets(ctx context.Context, filter TargetListFilter) ([]HealthTarget, *string, bool, error)
	UpdateTarget(ctx context.Context, targetID string, req *UpdateTargetRequest, actor string) (*HealthTarget, *HealthTarget, error)
	InsertRun(ctx context.Context, run *HealthRun) error
	GetRun(ctx context.Context, runID string) (*HealthRun, error)
	ListRuns(ctx context.Context, filter RunListFilter) ([]HealthRun, *string, bool, error)
	InsertSample(ctx context.Context, sample *HealthSample) error
	GetSample(ctx context.Context, sampleID string) (*HealthSample, error)
	ListSamples(ctx context.Context, filter SampleListFilter) ([]HealthSample, *string, bool, error)
	// LatestStatusForTargets is the bounded latest-evidence projection used by
	// read surfaces so they never issue one query per target.
	LatestStatusForTargets(ctx context.Context, targetIDs []string) (map[string]BatchTargetStatus, error)
	RecordCollection(ctx context.Context, target *HealthTarget, result *CollectionResult) error
}

// Handler serves the NF Health API surface.
type Handler struct {
	repo        RepositoryAPI
	collector   *Collector
	limiter     RateLimiter
	auditWriter AuditWriter
	dest        *DestinationAllowlist
	units       *ServiceUnitAllowlist
	bindings    *ProcessBindingRegistry
	// identity provides read-only Inventory and Discovery resolution. NF
	// Health never writes Inventory or Discovery through these resolvers.
	identity IdentityResolvers
}

// NewHandler constructs the NF Health HTTP handler.
func NewHandler(
	repo RepositoryAPI,
	collector *Collector,
	limiter RateLimiter,
	auditWriter AuditWriter,
	dest *DestinationAllowlist,
	units *ServiceUnitAllowlist,
	bindings *ProcessBindingRegistry,
) *Handler {
	return &Handler{
		repo:        repo,
		collector:   collector,
		limiter:     limiter,
		auditWriter: auditWriter,
		dest:        dest,
		units:       units,
		bindings:    bindings,
	}
}

// SetIdentityResolvers installs the read-only Inventory and Discovery
// resolvers used to derive canonical target identity server-side.
func (h *Handler) SetIdentityResolvers(resolvers IdentityResolvers) {
	h.identity = resolvers
}

const maxBodyBytes = 64 << 10

// decodeStrictJSON rejects unknown fields and trailing content.
func decodeStrictJSON(r io.Reader, maxBytes int64, dst any) error {
	limited := io.LimitReader(r, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("failed to read request body: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return errors.New("request body is empty")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("unexpected trailing content after JSON")
	}
	return nil
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "nf_health.denied",
		Module: "nf_health",
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

func (h *Handler) requireRead(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

func (h *Handler) requireConfigure(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

func writeValidation(w http.ResponseWriter, err error) {
	code, message := MapValidationError(err)
	status := http.StatusBadRequest
	switch code {
	case "NF_HEALTH_DESTINATION_NOT_ALLOWED", "NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED",
		"NF_HEALTH_PROCESS_BINDING_MISSING", "NF_HEALTH_PROCESS_BINDING_MISMATCH":
		status = http.StatusForbidden
	case "NF_HEALTH_REVISION_CONFLICT":
		status = http.StatusConflict
	case "NF_HEALTH_RESOURCE_RETIRED":
		status = http.StatusConflict
	case "NF_HEALTH_TARGET_IDENTITY_MISMATCH":
		status = http.StatusConflict
	case "NF_HEALTH_RESOURCE_UNAVAILABLE":
		status = http.StatusServiceUnavailable
	}
	response.Error(w, status, message, code)
}

// writeCollectionIdentityError maps a collection-time identity revalidation
// failure. A stored target whose authoritative Inventory association is gone,
// retired or no longer matching is an identity conflict (HTTP 409); a withdrawn
// or mismatched local process binding keeps its 403 semantics.
func writeCollectionIdentityError(w http.ResponseWriter, ve *ErrValidation) {
	switch ve.Code {
	case "NF_HEALTH_RESOURCE_NOT_FOUND", "NF_HEALTH_RESOURCE_RETIRED",
		"NF_HEALTH_RESOURCE_KIND_UNSUPPORTED", "NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED",
		"NF_HEALTH_NF_TYPE_UNRESOLVED", "NF_HEALTH_DOMAIN_TYPE_MISMATCH",
		"NF_HEALTH_TARGET_IDENTITY_MISMATCH":
		response.Error(w, http.StatusConflict, ve.Message, ve.Code)
	default:
		// Binding and availability codes keep their contract statuses.
		writeValidation(w, ve)
	}
}

func (h *Handler) auditWrite(p *auth.Principal, action, targetID string, revision *int64, meta map[string]any) {
	if h.auditWriter == nil {
		return
	}
	input := audit.WriteAuditInput{
		Action: action,
		Module: "nf_health",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Resource: &audit.ResourceInput{
			Type: "nf_health_target",
			ID:   targetID,
		},
		Result:    "success",
		RiskLevel: "low",
		Metadata:  meta,
	}
	if revision != nil {
		input.Metadata["revision"] = *revision
	}
	h.auditWriter.WriteBestEffort(input)
}

// MetaResponse is the GET /api/nf-health/meta payload.
type MetaResponse struct {
	SchemaVersion            int                `json:"schemaVersion"`
	CollectorProfiles        []string           `json:"collectorProfiles"`
	CollectionModes          []string           `json:"collectionModes"`
	RunStatuses              []string           `json:"runStatuses"`
	LayerStates              []string           `json:"layerStates"`
	FreshnessStates          []string           `json:"freshnessStates"`
	EvidenceKinds            []string           `json:"evidenceKinds"`
	ProcessOutcomes          []string           `json:"processOutcomes"`
	InterfaceOutcomes        []string           `json:"interfaceOutcomes"`
	ServiceKinds             []string           `json:"serviceKinds"`
	IdentityStates           []string           `json:"identityStates"`
	SupportedResourceDomains []string           `json:"supportedResourceDomains"`
	MetricCategories         []string           `json:"metricCategories"`
	MetricEvidenceClasses    []string           `json:"metricEvidenceClasses"`
	ServiceReasons           []string           `json:"serviceReasons"`
	MinIntervalSeconds       int                `json:"minIntervalSeconds"`
	MaxIntervalSeconds       int                `json:"maxIntervalSeconds"`
	DefaultIntervalSeconds   int                `json:"defaultIntervalSeconds"`
	RequestTimeoutSeconds    int                `json:"requestTimeoutSeconds"`
	TotalDeadlineSeconds     int                `json:"totalDeadlineSeconds"`
	MaxGlobalConcurrent      int                `json:"maxGlobalConcurrent"`
	StalenessGraceSeconds    int                `json:"stalenessGraceSeconds"`
	ManualFreshnessSeconds   int                `json:"manualFreshnessWindowSeconds"`
	RetentionDays            int                `json:"retentionDays"`
	MaxRetentionDays         int                `json:"maxRetentionDays"`
	SupportedMetrics         []MetricDefinition `json:"supportedMetrics"`
	AllowedDestinations      []string           `json:"allowedDestinations"`
	AllowedServiceUnits      []string           `json:"allowedServiceUnits"`
}

// Meta handles GET /api/nf-health/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-health/meta")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:meta:"+p.Username, 120, 60) {
		return
	}
	response.JSON(w, http.StatusOK, MetaResponse{
		SchemaVersion:            SchemaVersion,
		CollectorProfiles:        CanonicalCollectorProfiles,
		CollectionModes:          CanonicalCollectionModes,
		RunStatuses:              CanonicalRunStatuses,
		LayerStates:              CanonicalLayerStates,
		FreshnessStates:          CanonicalFreshnessStates,
		EvidenceKinds:            CanonicalEvidenceKinds,
		ProcessOutcomes:          CanonicalProcessOutcomes,
		InterfaceOutcomes:        CanonicalInterfaceOutcomes,
		ServiceKinds:             []string{"systemd", "process", "none"},
		IdentityStates:           CanonicalIdentityStates,
		SupportedResourceDomains: SupportedResourceDomains,
		MetricCategories:         CanonicalMetricCategories,
		MetricEvidenceClasses:    CanonicalMetricEvidenceClasses,
		ServiceReasons:           CanonicalServiceReasons,
		MinIntervalSeconds:       MinIntervalSeconds,
		MaxIntervalSeconds:       MaxIntervalSeconds,
		DefaultIntervalSeconds:   DefaultIntervalSeconds,
		RequestTimeoutSeconds:    RequestTimeoutSeconds,
		TotalDeadlineSeconds:     TotalDeadlineSeconds,
		MaxGlobalConcurrent:      MaxGlobalConcurrent,
		StalenessGraceSeconds:    StalenessGraceSeconds,
		ManualFreshnessSeconds:   ManualFreshnessWindowSeconds,
		RetentionDays:            DefaultRetentionDays,
		MaxRetentionDays:         MaxRetentionDays,
		SupportedMetrics:         SupportedMetrics(),
		AllowedDestinations:      h.destEntries(),
		AllowedServiceUnits:      h.unitEntries(),
	})
}

func (h *Handler) destEntries() []string {
	if h.dest == nil {
		return []string{}
	}
	return h.dest.Entries()
}

func (h *Handler) unitEntries() []string {
	if h.units == nil {
		return []string{}
	}
	return h.units.Entries()
}

// ListTargetsResponse is the GET /api/nf-health/targets payload.
type ListTargetsResponse struct {
	Targets []HealthTargetSummary `json:"targets"`
	Page    PageInfo              `json:"page"`
}

// ListTargets handles GET /api/nf-health/targets.
func (h *Handler) ListTargets(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-health/targets")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:targets:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		if param != "q" && param != "limit" && param != "cursor" && param != "enabled" && param != "resourceIds" {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	enabled := strings.TrimSpace(q.Get("enabled"))
	if enabled != "" && enabled != "true" && enabled != "false" {
		response.BadRequest(w, "enabled must be true or false", "INVALID_QUERY_PARAMETER")
		return
	}

	// Bounded authoritative association lookup. The resource filter answers
	// "which of these Inventory resources have a monitoring target?" and must
	// therefore never be paginated or combined with filters that could hide a
	// target: a hidden target would look like a confirmed absence.
	_, resourceFilterPresent := q["resourceIds"]
	resourceIDs, filtered, ferr := parseResourceIDFilter(q.Get("resourceIds"), resourceFilterPresent)
	if ferr != nil {
		writeValidation(w, ferr)
		return
	}
	if filtered {
		if q.Get("cursor") != "" || strings.TrimSpace(q.Get("q")) != "" || enabled != "" {
			response.BadRequest(w,
				"resourceIds cannot be combined with cursor, q or enabled",
				"UNSUPPORTED_QUERY_COMBINATION")
			return
		}
		if q.Get("limit") != "" {
			response.BadRequest(w,
				"resourceIds resolves the requested set in one bounded response; limit is not accepted",
				"UNSUPPORTED_QUERY_COMBINATION")
			return
		}
	}

	items, next, hasMore, err := h.repo.ListTargets(r.Context(), TargetListFilter{
		Query:       strings.TrimSpace(q.Get("q")),
		Enabled:     enabled,
		Limit:       limit,
		Cursor:      strings.TrimSpace(q.Get("cursor")),
		ResourceIDs: resourceIDs,
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	summaries := make([]HealthTargetSummary, 0, len(items))
	now := time.Now().UTC()

	// Bounded batch projection: one aggregation per collection for the whole
	// page, never one request (or one query) per target. When the projection
	// cannot be read, the summaries report statusComplete=false instead of an
	// empty coverage that would look like "nothing was measured".
	targetIDs := make([]string, 0, len(items))
	for i := range items {
		targetIDs = append(targetIDs, items[i].TargetID)
	}
	statuses, statusErr := h.repo.LatestStatusForTargets(r.Context(), targetIDs)

	for i := range items {
		target := items[i]
		summary := HealthTargetSummary{
			HealthTarget: target,
			Freshness:    EvaluateFreshness(&target, now),
		}
		if statusErr != nil {
			// The projection failed: the page is still returned, but the
			// status fields are explicitly incomplete and never look like
			// "nothing was measured".
			summary.Coverage = CoverageSummary{}
			summary.StatusComplete = false
			summaries = append(summaries, summary)
			continue
		}
		// The projection succeeded: a target without a stored sample is a
		// configured target with no accepted measurement yet, not a read
		// failure. Completeness therefore describes the read, not the evidence.
		status, ok := statuses[target.TargetID]
		summary.StatusComplete = true
		var layers *LayerSet
		if ok && status.Sample != nil {
			sample := status.Sample
			summary.LatestSampleAt = sample.CollectedAt
			summary.Coverage = CoverageFromLayers(sample.Layers)
			sampleLayers := sample.Layers
			layers = &sampleLayers
			summary.Layers = layers
			summary.ResourceMetrics = resourceCategoryMetrics(sample.Metrics)
		}
		if ok && status.Run != nil {
			summary.LastRunStatus = status.Run.Status
			summary.LastRunAt = status.Run.StartedAt
		}
		// The same freshness-gated projection the detail endpoint uses: a stale
		// or missing measurement is never presented as current health.
		summary.OverallState = ProjectOverallState(summary.Freshness, layers)
		summaries = append(summaries, summary)
	}
	response.JSON(w, http.StatusOK, ListTargetsResponse{
		Targets: summaries,
		Page:    PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// parseResourceIDFilter validates the bounded resourceIds association lookup.
//
// Contract:
//   - comma-separated canonical Inventory resource UUID v4 values;
//   - at least one and at most MaxTargetResourceFilterIDs identifiers;
//   - empty entries, malformed values and oversized lists are rejected (never
//     silently truncated);
//   - repeated identifiers are deduplicated while preserving request order.
func parseResourceIDFilter(raw string, present bool) ([]string, bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if present {
			// An explicitly supplied empty filter is malformed, not "no filter".
			return nil, true, validationError("INVALID_RESOURCE_ID",
				"resourceIds must contain at least one identifier")
		}
		return nil, false, nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) > MaxTargetResourceFilterIDs {
		return nil, true, validationError("RESOURCE_ID_FILTER_TOO_LARGE",
			fmt.Sprintf("resourceIds accepts at most %d identifiers", MaxTargetResourceFilterIDs))
	}
	seen := make(map[string]struct{}, len(parts))
	ids := make([]string, 0, len(parts))
	for _, part := range parts {
		id := strings.TrimSpace(part)
		if id == "" {
			return nil, true, validationError("INVALID_RESOURCE_ID",
				"resourceIds must not contain empty identifiers")
		}
		if err := ValidateUUIDv4(id); err != nil {
			return nil, true, validationError("INVALID_RESOURCE_ID",
				"resourceIds must contain canonical Inventory resource UUID v4 values")
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil, true, validationError("INVALID_RESOURCE_ID",
			"resourceIds must contain at least one identifier")
	}
	return ids, true, nil
}

// resourceCategoryMetrics keeps only exporter-process measurements so a resource
// view can show validated CPU/memory evidence without loading full metric sets.
func resourceCategoryMetrics(samples []MetricSample) []MetricSample {
	if len(samples) == 0 {
		return nil
	}
	out := make([]MetricSample, 0, 8)
	for _, sample := range samples {
		if sample.Category == CategoryResource {
			out = append(out, sample)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// GetTargetResponse is the GET /api/nf-health/targets/{targetId} payload.
//
// OverallState is server-derived from layer evidence plus measurement
// freshness. A stale or unknown measurement never presents as healthy, and the
// latest sample is retained as historical evidence rather than current proof.
type GetTargetResponse struct {
	Target    HealthTargetSummary `json:"target"`
	Latest    *HealthSample       `json:"latestSample,omitempty"`
	LastRun   *HealthRun          `json:"lastRun,omitempty"`
	Overall   string              `json:"overallState"`
	Freshness FreshnessProjection `json:"freshness"`
}

// GetTarget handles GET /api/nf-health/targets/{targetId}.
func (h *Handler) GetTarget(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:targets:get:"+p.Username, 120, 60) {
		return
	}
	targetID := r.PathValue("targetId")
	if err := ValidateUUIDv4(targetID); err != nil {
		writeValidation(w, err)
		return
	}
	target, err := h.repo.GetTarget(r.Context(), targetID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "NF Health target not found", "NF_HEALTH_TARGET_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	resp := GetTargetResponse{Target: HealthTargetSummary{HealthTarget: *target}}
	resp.Freshness = EvaluateFreshness(target, time.Now().UTC())
	// The nested target summary carries the same projection the overview uses,
	// so detail and list views cannot disagree about measurement freshness.
	resp.Target.Freshness = resp.Freshness
	samples, _, _, serr := h.repo.ListSamples(r.Context(), SampleListFilter{TargetID: targetID, Limit: 1})
	// Completeness describes the read: a target with no sample history is a
	// configured, unmeasured target, not a failed projection.
	resp.Target.StatusComplete = serr == nil
	if serr == nil && len(samples) > 0 {
		latest := samples[0]
		resp.Latest = &latest
		resp.Target.Coverage = CoverageFromLayers(latest.Layers)
		resp.Target.LatestSampleAt = latest.CollectedAt
		layers := latest.Layers
		resp.Target.Layers = &layers
		resp.Target.ResourceMetrics = resourceCategoryMetrics(latest.Metrics)
		// Historical samples remain readable, but current evidence is gated
		// by freshness so an old sample is never presented as live health.
		resp.Overall = ProjectOverallState(resp.Freshness, &latest.Layers)
	} else {
		resp.Overall = ProjectOverallState(resp.Freshness, nil)
	}
	// The summary carries the same overall projection the list projection uses.
	resp.Target.OverallState = resp.Overall
	runs, _, _, rerr := h.repo.ListRuns(r.Context(), RunListFilter{TargetID: targetID, Limit: 1})
	if rerr == nil && len(runs) > 0 {
		last := runs[0]
		resp.LastRun = &last
		resp.Target.LastRunStatus = last.Status
		resp.Target.LastRunAt = last.StartedAt
	}
	response.JSON(w, http.StatusOK, resp)
}

// GetTargetHistory handles GET /api/nf-health/targets/{targetId}/history.
func (h *Handler) GetTargetHistory(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:targets:history:"+p.Username, 120, 60) {
		return
	}
	targetID := r.PathValue("targetId")
	if err := ValidateUUIDv4(targetID); err != nil {
		writeValidation(w, err)
		return
	}
	if _, err := h.repo.GetTarget(r.Context(), targetID); err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "NF Health target not found", "NF_HEALTH_TARGET_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	q := r.URL.Query()
	for param := range q {
		switch param {
		case "from", "to", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	samples, next, hasMore, err := h.repo.ListSamples(r.Context(), SampleListFilter{
		TargetID: targetID,
		From:     strings.TrimSpace(q.Get("from")),
		To:       strings.TrimSpace(q.Get("to")),
		Limit:    limit,
		Cursor:   strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	if samples == nil {
		samples = []HealthSample{}
	}
	response.JSON(w, http.StatusOK, map[string]any{
		"samples": samples,
		"page":    PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// ListSamples handles GET /api/nf-health/samples.
func (h *Handler) ListSamples(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-health/samples")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:samples:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		switch param {
		case "targetId", "from", "to", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	targetID := strings.TrimSpace(q.Get("targetId"))
	if targetID != "" {
		if err := ValidateUUIDv4(targetID); err != nil {
			writeValidation(w, err)
			return
		}
	}
	samples, next, hasMore, err := h.repo.ListSamples(r.Context(), SampleListFilter{
		TargetID: targetID,
		From:     strings.TrimSpace(q.Get("from")),
		To:       strings.TrimSpace(q.Get("to")),
		Limit:    limit,
		Cursor:   strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	if samples == nil {
		samples = []HealthSample{}
	}
	response.JSON(w, http.StatusOK, map[string]any{
		"samples": samples,
		"page":    PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// ListRuns handles GET /api/nf-health/runs.
func (h *Handler) ListRuns(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-health/runs")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:runs:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		switch param {
		case "targetId", "status", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	targetID := strings.TrimSpace(q.Get("targetId"))
	if targetID != "" {
		if err := ValidateUUIDv4(targetID); err != nil {
			writeValidation(w, err)
			return
		}
	}
	status := strings.TrimSpace(q.Get("status"))
	if status != "" {
		valid := false
		for _, allowed := range CanonicalRunStatuses {
			if status == allowed {
				valid = true
				break
			}
		}
		if !valid {
			response.BadRequest(w, "status must be success, partial, or failed", "INVALID_QUERY_PARAMETER")
			return
		}
	}
	runs, next, hasMore, err := h.repo.ListRuns(r.Context(), RunListFilter{
		TargetID: targetID,
		Status:   status,
		Limit:    limit,
		Cursor:   strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	if runs == nil {
		runs = []HealthRun{}
	}
	response.JSON(w, http.StatusOK, map[string]any{
		"runs": runs,
		"page": PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// GetRun handles GET /api/nf-health/runs/{runId}.
func (h *Handler) GetRun(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:runs:get:"+p.Username, 120, 60) {
		return
	}
	runID := r.PathValue("runId")
	if err := ValidateUUIDv4(runID); err != nil {
		writeValidation(w, err)
		return
	}
	run, err := h.repo.GetRun(r.Context(), runID)
	if err != nil {
		if errors.Is(err, ErrRunNotFound) {
			response.Error(w, http.StatusNotFound, "NF Health run not found", "NF_HEALTH_SAMPLE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, run)
}

// CreateTarget handles POST /api/nf-health/targets.
func (h *Handler) CreateTarget(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/nf-health/targets")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:targets:create:"+p.Username, 20, 60) {
		return
	}
	var req CreateTargetRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	if err := ValidateCreateTargetRequest(&req, h.dest, h.units, h.bindings); err != nil {
		writeValidation(w, err)
		return
	}
	// Canonical identity is resolved server-side from authoritative Inventory
	// and Discovery documents using the request context, so cancellation stops
	// pending resolution work. A client-supplied domain or NF type is never
	// accepted: the request struct has no such fields.
	resolved, err := ResolveTargetIdentity(r.Context(), &req, h.identity)
	if err != nil {
		writeValidation(w, err)
		return
	}
	// A configured local inspection source must correspond to the resolved
	// authoritative Inventory identity.
	if err := ValidateResolvedTargetCompatibility(&req, resolved, h.bindings); err != nil {
		writeValidation(w, err)
		return
	}
	req.ResourceID = resolved.ResourceID
	req.CandidateID = resolved.CandidateID
	req.ResolvedDomain = resolved.Domain
	req.ResolvedNFType = resolved.NFType
	target, err := h.repo.CreateTarget(r.Context(), &req, p.Username)
	if err != nil {
		if errors.Is(err, ErrDuplicate) {
			response.Error(w, http.StatusConflict, "NF Health target already exists for this identity", "NF_HEALTH_TARGET_CONFLICT")
			return
		}
		response.InternalError(w)
		return
	}
	rev := target.Revision
	h.auditWrite(p, "nf_health.target.create", target.TargetID, &rev, map[string]any{
		"resourceId":    target.ResourceID,
		"candidateId":   target.CandidateID,
		"name":          target.Name,
		"identityState": target.IdentityState,
	})
	response.JSON(w, http.StatusCreated, target)
}

// UpdateTarget handles PUT /api/nf-health/targets/{targetId}.
func (h *Handler) UpdateTarget(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "PUT", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:targets:update:"+p.Username, 30, 60) {
		return
	}
	targetID := r.PathValue("targetId")
	if err := ValidateUUIDv4(targetID); err != nil {
		writeValidation(w, err)
		return
	}
	var req UpdateTargetRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	// The effective configuration is validated against the stored target: the
	// immutable identity comes from storage and the stored collector profile
	// governs which rules apply. A rejected update performs no write.
	existing, err := h.repo.GetTarget(r.Context(), targetID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "NF Health target not found", "NF_HEALTH_TARGET_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	if err := ValidateEffectiveTargetUpdate(existing, &req, h.dest, h.units, h.bindings); err != nil {
		writeValidation(w, err)
		return
	}
	updated, before, err := h.repo.UpdateTarget(r.Context(), targetID, &req, p.Username)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			response.Error(w, http.StatusNotFound, "NF Health target not found", "NF_HEALTH_TARGET_NOT_FOUND")
		case errors.Is(err, ErrRevisionConflict):
			response.Error(w, http.StatusConflict, "revision conflict", "NF_HEALTH_REVISION_CONFLICT")
		default:
			response.InternalError(w)
		}
		return
	}
	rev := updated.Revision
	h.auditWrite(p, "nf_health.target.update", targetID, &rev, map[string]any{
		"resourceId":     updated.ResourceID,
		"name":           updated.Name,
		"previousName":   before.Name,
		"collectionMode": updated.CollectionMode,
		"enabled":        updated.Enabled,
	})
	response.JSON(w, http.StatusOK, updated)
}

// CollectTarget handles POST /api/nf-health/targets/{targetId}/collect.
func (h *Handler) CollectTarget(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-health:targets:collect:"+p.Username, 10, 60) {
		return
	}
	targetID := r.PathValue("targetId")
	if err := ValidateUUIDv4(targetID); err != nil {
		writeValidation(w, err)
		return
	}
	target, err := h.repo.GetTarget(r.Context(), targetID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "NF Health target not found", "NF_HEALTH_TARGET_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	if !target.Enabled {
		response.Error(w, http.StatusConflict, "NF Health target collection is disabled", "NF_HEALTH_TARGET_DISABLED")
		return
	}

	result, err := h.collector.Collect(r.Context(), target, p.Username, false)
	if err != nil {
		switch {
		case errors.Is(err, ErrInProgress):
			response.Error(w, http.StatusConflict, "collection already in progress", "NF_HEALTH_COLLECTION_IN_PROGRESS")
		case errors.Is(err, ErrRateLimited):
			w.Header().Set("Retry-After", strconv.Itoa(MinIntervalSeconds))
			response.Error(w, http.StatusTooManyRequests, "collection rate limited", "NF_HEALTH_COLLECTION_RATE_LIMITED")
		case errors.Is(err, ErrResourceRetired):
			response.Error(w, http.StatusConflict, "Inventory resource is retired; monitoring history is preserved", "NF_HEALTH_RESOURCE_RETIRED")
		default:
			// Identity revalidation failures are deterministic contract errors,
			// never server errors.
			var ve *ErrValidation
			if errors.As(err, &ve) {
				writeCollectionIdentityError(w, ve)
				return
			}
			response.InternalError(w)
		}
		return
	}

	if err := h.repo.RecordCollection(r.Context(), target, result); err != nil {
		response.InternalError(w)
		return
	}

	h.auditWrite(p, "nf_health.collection.request", targetID, nil, map[string]any{
		"runId":   result.Run.RunID,
		"status":  result.Run.Status,
		"outcome": "success",
	})

	response.JSON(w, http.StatusOK, map[string]any{
		"run":    result.Run,
		"sample": result.Sample,
	})
}

// unused keeps the strconv import intentional for Retry-After formatting.
var _ = time.RFC3339
