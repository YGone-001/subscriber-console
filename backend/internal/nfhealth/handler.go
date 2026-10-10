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
	// candidateLookup optionally verifies Discovery candidate references.
	candidateLookup func(ctx context.Context, candidateID string) (bool, error)
}

// NewHandler constructs the NF Health HTTP handler.
func NewHandler(
	repo RepositoryAPI,
	collector *Collector,
	limiter RateLimiter,
	auditWriter AuditWriter,
	dest *DestinationAllowlist,
	units *ServiceUnitAllowlist,
) *Handler {
	return &Handler{
		repo:        repo,
		collector:   collector,
		limiter:     limiter,
		auditWriter: auditWriter,
		dest:        dest,
		units:       units,
	}
}

// SetCandidateLookup installs an optional Discovery candidate existence check.
func (h *Handler) SetCandidateLookup(fn func(ctx context.Context, candidateID string) (bool, error)) {
	h.candidateLookup = fn
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
	case "NF_HEALTH_DESTINATION_NOT_ALLOWED", "NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED":
		status = http.StatusForbidden
	case "NF_HEALTH_REVISION_CONFLICT":
		status = http.StatusConflict
	}
	response.Error(w, status, message, code)
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
	SchemaVersion          int                `json:"schemaVersion"`
	CollectorProfiles      []string           `json:"collectorProfiles"`
	CollectionModes        []string           `json:"collectionModes"`
	RunStatuses            []string           `json:"runStatuses"`
	LayerStates            []string           `json:"layerStates"`
	EvidenceKinds          []string           `json:"evidenceKinds"`
	ProcessOutcomes        []string           `json:"processOutcomes"`
	InterfaceOutcomes      []string           `json:"interfaceOutcomes"`
	ServiceKinds           []string           `json:"serviceKinds"`
	MinIntervalSeconds     int                `json:"minIntervalSeconds"`
	MaxIntervalSeconds     int                `json:"maxIntervalSeconds"`
	DefaultIntervalSeconds int                `json:"defaultIntervalSeconds"`
	RequestTimeoutSeconds  int                `json:"requestTimeoutSeconds"`
	TotalDeadlineSeconds   int                `json:"totalDeadlineSeconds"`
	MaxGlobalConcurrent    int                `json:"maxGlobalConcurrent"`
	RetentionDays          int                `json:"retentionDays"`
	MaxRetentionDays       int                `json:"maxRetentionDays"`
	SupportedMetrics       []MetricDefinition `json:"supportedMetrics"`
	AllowedDestinations    []string           `json:"allowedDestinations"`
	AllowedServiceUnits    []string           `json:"allowedServiceUnits"`
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
		SchemaVersion:          SchemaVersion,
		CollectorProfiles:      CanonicalCollectorProfiles,
		CollectionModes:        CanonicalCollectionModes,
		RunStatuses:            CanonicalRunStatuses,
		LayerStates:            CanonicalLayerStates,
		EvidenceKinds:          CanonicalEvidenceKinds,
		ProcessOutcomes:        CanonicalProcessOutcomes,
		InterfaceOutcomes:      CanonicalInterfaceOutcomes,
		ServiceKinds:           []string{"systemd", "process", "none"},
		MinIntervalSeconds:     MinIntervalSeconds,
		MaxIntervalSeconds:     MaxIntervalSeconds,
		DefaultIntervalSeconds: DefaultIntervalSeconds,
		RequestTimeoutSeconds:  RequestTimeoutSeconds,
		TotalDeadlineSeconds:   TotalDeadlineSeconds,
		MaxGlobalConcurrent:    MaxGlobalConcurrent,
		RetentionDays:          DefaultRetentionDays,
		MaxRetentionDays:       MaxRetentionDays,
		SupportedMetrics:       SupportedMetrics(),
		AllowedDestinations:    h.destEntries(),
		AllowedServiceUnits:    h.unitEntries(),
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
		if param != "q" && param != "limit" && param != "cursor" && param != "enabled" {
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
	items, next, hasMore, err := h.repo.ListTargets(r.Context(), TargetListFilter{
		Query:   strings.TrimSpace(q.Get("q")),
		Enabled: enabled,
		Limit:   limit,
		Cursor:  strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	summaries := make([]HealthTargetSummary, 0, len(items))
	for i := range items {
		target := items[i]
		summaries = append(summaries, HealthTargetSummary{
			HealthTarget: target,
			Coverage:     CoverageSummary{},
		})
	}
	response.JSON(w, http.StatusOK, ListTargetsResponse{
		Targets: summaries,
		Page:    PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// GetTargetResponse is the GET /api/nf-health/targets/{targetId} payload.
type GetTargetResponse struct {
	Target  HealthTargetSummary `json:"target"`
	Latest  *HealthSample       `json:"latestSample,omitempty"`
	LastRun *HealthRun          `json:"lastRun,omitempty"`
	Overall string              `json:"overallState"`
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
	samples, _, _, serr := h.repo.ListSamples(r.Context(), SampleListFilter{TargetID: targetID, Limit: 1})
	if serr == nil && len(samples) > 0 {
		latest := samples[0]
		resp.Latest = &latest
		resp.Target.Coverage = CoverageFromLayers(latest.Layers)
		resp.Overall = OverallState(latest.Layers)
	} else {
		resp.Overall = StateUnknown
	}
	runs, _, _, rerr := h.repo.ListRuns(r.Context(), RunListFilter{TargetID: targetID, Limit: 1})
	if rerr == nil && len(runs) > 0 {
		last := runs[0]
		resp.LastRun = &last
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
	if err := ValidateCreateTargetRequest(&req, h.dest, h.units); err != nil {
		writeValidation(w, err)
		return
	}
	if h.candidateLookup != nil {
		ok, err := h.candidateLookup(r.Context(), req.CandidateID)
		if err != nil {
			response.InternalError(w)
			return
		}
		if !ok {
			response.Error(w, http.StatusBadRequest, "Discovery candidate not found", "NF_HEALTH_TARGET_NOT_FOUND")
			return
		}
	}
	target, err := h.repo.CreateTarget(r.Context(), &req, p.Username)
	if err != nil {
		if errors.Is(err, ErrDuplicate) {
			response.Error(w, http.StatusConflict, "NF Health target already exists for this candidate", "NF_HEALTH_TARGET_CONFLICT")
			return
		}
		response.InternalError(w)
		return
	}
	rev := target.Revision
	h.auditWrite(p, "nf_health.target.create", target.TargetID, &rev, map[string]any{
		"candidateId": target.CandidateID,
		"name":        target.Name,
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
	if err := ValidateUpdateTargetRequest(&req, h.dest, h.units); err != nil {
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
		default:
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
