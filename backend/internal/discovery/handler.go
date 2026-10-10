package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
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

// Repository surface used by the handler.
type RepositoryAPI interface {
	CreateSource(ctx context.Context, req *CreateSourceRequest, actor string) (*DiscoverySource, error)
	GetSource(ctx context.Context, sourceID string) (*DiscoverySource, error)
	ListSources(ctx context.Context, filter SourceListFilter) ([]DiscoverySource, *string, bool, error)
	UpdateSource(ctx context.Context, sourceID string, req *UpdateSourceRequest, actor string) (*DiscoverySource, *DiscoverySource, error)
	InsertRun(ctx context.Context, run *DiscoveryRun) error
	CompleteRun(ctx context.Context, run *DiscoveryRun) error
	GetRun(ctx context.Context, runID string) (*DiscoveryRun, error)
	ListRuns(ctx context.Context, filter RunListFilter) ([]DiscoveryRun, *string, bool, error)
	UpsertObservation(ctx context.Context, sourceID, adapterType string, profile *NormalizedProfile, now string) (bool, bool, bool, error)
	MarkMissing(ctx context.Context, sourceID string, seenIDs map[string]struct{}, now string) (int, error)
	GetCandidate(ctx context.Context, candidateID string) (*NFObservation, error)
	ListCandidates(ctx context.Context, filter CandidateListFilter) ([]NFObservation, *string, bool, error)
	SetCandidateLink(ctx context.Context, candidateID string, expectedRevision int64, resourceID *string, actor string) (*NFObservation, error)
	UpdateSourceScanMeta(ctx context.Context, sourceID, completedAt, lastError string) error
	CountSources(ctx context.Context) (int, error)
	CountCandidates(ctx context.Context, sourceID, linkedOnly string) (int, error)
	LatestRun(ctx context.Context) (*DiscoveryRun, error)
	ListSourceIDs(ctx context.Context) ([]string, error)
}

// Handler serves the discovery API surface.
type Handler struct {
	repo        RepositoryAPI
	limiter     RateLimiter
	auditWriter AuditWriter
	adapters    *AdapterRegistry
	allowlist   *DestinationAllowlist
	resolver    InventoryResolver

	scanMu      sync.Mutex
	activeScans map[string]string // sourceId -> runId
	lastScanAt  map[string]time.Time
	globalScan  bool
}

// NewHandler constructs the discovery HTTP handler.
func NewHandler(repo RepositoryAPI, limiter RateLimiter, auditWriter AuditWriter, adapters *AdapterRegistry, allowlist *DestinationAllowlist, resolver InventoryResolver) *Handler {
	return &Handler{
		repo:        repo,
		limiter:     limiter,
		auditWriter: auditWriter,
		adapters:    adapters,
		allowlist:   allowlist,
		resolver:    resolver,
		activeScans: map[string]string{},
		lastScanAt:  map[string]time.Time{},
	}
}

const maxBodyBytes = 64 << 10

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
		Action: "discovery.denied",
		Module: "discovery",
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
	case "DISCOVERY_TARGET_NOT_ALLOWED":
		status = http.StatusForbidden
	case "DISCOVERY_REVISION_CONFLICT":
		status = http.StatusConflict
	}
	response.Error(w, status, message, code)
}

// Meta handles GET /api/discovery/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/discovery/meta")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:meta:"+p.Username, 120, 60) {
		return
	}
	response.JSON(w, http.StatusOK, MetaResponse{
		SchemaVersion:            SchemaVersion,
		AdapterTypes:             CanonicalAdapterTypes,
		TransportModes:           CanonicalTransportModes,
		RunStatuses:              CanonicalRunStatuses,
		ObservedStates:           CanonicalObservationStates,
		MinScanIntervalSeconds:   MinScanIntervalSeconds,
		RequestTimeoutSeconds:    RequestTimeoutSeconds,
		TotalScanDeadlineSeconds: TotalScanDeadlineSec,
		MaxNFProfiles:            MaxNFProfiles,
	})
}

// ListSources handles GET /api/discovery/sources.
func (h *Handler) ListSources(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/discovery/sources")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:sources:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		if param != "q" && param != "limit" && param != "cursor" {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	items, next, hasMore, err := h.repo.ListSources(r.Context(), SourceListFilter{
		Query:  strings.TrimSpace(q.Get("q")),
		Limit:  limit,
		Cursor: strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	response.JSON(w, http.StatusOK, ListSourcesResponse{
		Sources: items,
		Page:    PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// GetSource handles GET /api/discovery/sources/{sourceId}.
func (h *Handler) GetSource(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:sources:get:"+p.Username, 120, 60) {
		return
	}
	sourceID := r.PathValue("sourceId")
	if err := ValidateUUIDv4(sourceID); err != nil {
		writeValidation(w, err)
		return
	}
	src, err := h.repo.GetSource(r.Context(), sourceID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Discovery source not found", "DISCOVERY_SOURCE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, src)
}

// CreateSource handles POST /api/discovery/sources.
func (h *Handler) CreateSource(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/discovery/sources")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:sources:create:"+p.Username, 20, 60) {
		return
	}
	var req CreateSourceRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	if err := ValidateCreateSourceRequest(&req, h.allowlist); err != nil {
		writeValidation(w, err)
		return
	}
	src, err := h.repo.CreateSource(r.Context(), &req, p.Username)
	if err != nil {
		response.InternalError(w)
		return
	}
	h.auditWrite(p, "discovery.source.create", src.SourceID, nil, src)
	response.JSON(w, http.StatusCreated, src)
}

// UpdateSource handles PUT /api/discovery/sources/{sourceId}.
func (h *Handler) UpdateSource(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "PUT", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:sources:update:"+p.Username, 30, 60) {
		return
	}
	sourceID := r.PathValue("sourceId")
	if err := ValidateUUIDv4(sourceID); err != nil {
		writeValidation(w, err)
		return
	}
	var req UpdateSourceRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	if err := ValidateUpdateSourceRequest(&req, h.allowlist); err != nil {
		writeValidation(w, err)
		return
	}
	before, after, err := h.repo.UpdateSource(r.Context(), sourceID, &req, p.Username)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Discovery source not found", "DISCOVERY_SOURCE_NOT_FOUND")
			return
		}
		if errors.Is(err, ErrConflict) {
			response.Error(w, http.StatusConflict, "revision conflict", "DISCOVERY_REVISION_CONFLICT")
			return
		}
		response.InternalError(w)
		return
	}
	h.auditWrite(p, "discovery.source.update", sourceID, before, after)
	response.JSON(w, http.StatusOK, after)
}

// ScanSource handles POST /api/discovery/sources/{sourceId}/scan.
func (h *Handler) ScanSource(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:scan:"+p.Username, 10, 60) {
		return
	}
	sourceID := r.PathValue("sourceId")
	if err := ValidateUUIDv4(sourceID); err != nil {
		writeValidation(w, err)
		return
	}

	src, err := h.repo.GetSource(r.Context(), sourceID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Discovery source not found", "DISCOVERY_SOURCE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	if !src.Enabled {
		response.Error(w, http.StatusConflict, "Discovery source is disabled", "DISCOVERY_SOURCE_DISABLED")
		return
	}

	adapter, err := h.adapters.Get(src.AdapterType)
	if err != nil {
		response.Error(w, http.StatusUnprocessableEntity, "unsupported adapter type", "DISCOVERY_PROTOCOL_ERROR")
		return
	}

	// One active scan per source and globally.
	h.scanMu.Lock()
	if h.globalScan {
		h.scanMu.Unlock()
		response.Error(w, http.StatusConflict, "a discovery scan is already in progress", "DISCOVERY_SCAN_IN_PROGRESS")
		return
	}
	if _, busy := h.activeScans[sourceID]; busy {
		h.scanMu.Unlock()
		response.Error(w, http.StatusConflict, "a discovery scan is already in progress", "DISCOVERY_SCAN_IN_PROGRESS")
		return
	}
	if last, ok := h.lastScanAt[sourceID]; ok {
		if time.Since(last) < time.Duration(MinScanIntervalSeconds)*time.Second {
			h.scanMu.Unlock()
			w.Header().Set("Retry-After", strconv.Itoa(MinScanIntervalSeconds))
			response.Error(w, http.StatusTooManyRequests, "discovery scan rate limited", "DISCOVERY_SCAN_RATE_LIMITED")
			return
		}
	}

	run := &DiscoveryRun{
		RunID:         audit.GenerateUUID(),
		SchemaVersion: SchemaVersion,
		SourceID:      sourceID,
		StartedAt:     CurrentTimestamp(),
		Status:        RunStatusRunning,
		InitiatedBy:   p.Username,
	}
	h.activeScans[sourceID] = run.RunID
	h.globalScan = true
	h.lastScanAt[sourceID] = time.Now()
	h.scanMu.Unlock()

	defer func() {
		h.scanMu.Lock()
		delete(h.activeScans, sourceID)
		h.globalScan = false
		h.scanMu.Unlock()
	}()

	if err := h.repo.InsertRun(r.Context(), run); err != nil {
		response.InternalError(w)
		return
	}
	h.auditWrite(p, "discovery.scan.request", sourceID, nil, map[string]any{"runId": run.RunID})

	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(TotalScanDeadlineSec)*time.Second)
	defer cancel()

	batch, scanErr := adapter.Discover(ctx, *src)
	completedAt := CurrentTimestamp()
	run.CompletedAt = completedAt

	if scanErr != nil {
		run.Status = RunStatusFailed
		run.ErrorCode, run.ErrorSummary = classifyScanError(scanErr)
		_ = h.repo.UpdateSourceScanMeta(context.Background(), sourceID, completedAt, run.ErrorSummary)
		_ = h.repo.CompleteRun(context.Background(), run)
		h.auditWrite(p, "discovery.scan.complete", sourceID, nil, map[string]any{
			"runId":     run.RunID,
			"outcome":   "failed",
			"errorCode": run.ErrorCode,
		})
		// Never report an NRF failure as a successful empty discovery.
		status := http.StatusBadGateway
		switch run.ErrorCode {
		case "DISCOVERY_SCAN_RATE_LIMITED":
			status = http.StatusTooManyRequests
		case "DISCOVERY_RESPONSE_LIMIT_EXCEEDED":
			status = http.StatusUnprocessableEntity
		case "DISCOVERY_TARGET_NOT_ALLOWED":
			status = http.StatusForbidden
		case "DISCOVERY_RESPONSE_INVALID":
			status = http.StatusUnprocessableEntity
		}
		response.Error(w, status, run.ErrorSummary, run.ErrorCode)
		return
	}

	seen := map[string]struct{}{}
	for _, profile := range batch.Profiles {
		seen[profile.ExternalNfInstanceID] = struct{}{}
		created, updated, _, upsertErr := h.repo.UpsertObservation(context.Background(), sourceID, src.AdapterType, profile, completedAt)
		if upsertErr != nil {
			run.Status = RunStatusFailed
			run.ErrorCode = "DISCOVERY_RESPONSE_INVALID"
			run.ErrorSummary = SanitizeSummary(upsertErr.Error())
			_ = h.repo.UpdateSourceScanMeta(context.Background(), sourceID, completedAt, run.ErrorSummary)
			_ = h.repo.CompleteRun(context.Background(), run)
			response.InternalError(w)
			return
		}
		run.DiscoveredCount++
		if created {
			run.CreatedCount++
		} else if updated {
			run.UpdatedCount++
		} else {
			run.UnchangedCount++
		}
	}

	// Missing is inferred only from a complete, untruncated successful scan.
	// lastSuccessAt likewise moves only on that path: partial and failed attempts
	// refresh lastScanAt and record lastError without claiming a success time.
	if batch.Complete {
		missing, missErr := h.repo.MarkMissing(context.Background(), sourceID, seen, completedAt)
		if missErr == nil {
			run.MissingCount = missing
		}
		run.Status = RunStatusSuccess
		_ = h.repo.UpdateSourceScanMeta(context.Background(), sourceID, completedAt, "")
	} else {
		run.Status = RunStatusPartial
		run.ErrorCode = "DISCOVERY_RESPONSE_LIMIT_EXCEEDED"
		run.ErrorSummary = "scan truncated; absence not inferred"
		_ = h.repo.UpdateSourceScanMeta(context.Background(), sourceID, completedAt, run.ErrorSummary)
	}

	_ = h.repo.CompleteRun(context.Background(), run)
	h.auditWrite(p, "discovery.scan.complete", sourceID, nil, map[string]any{
		"runId":      run.RunID,
		"outcome":    run.Status,
		"discovered": run.DiscoveredCount,
	})
	response.JSON(w, http.StatusOK, ScanResult{Run: *run})
}

func classifyScanError(err error) (string, string) {
	msg := SanitizeSummary(err.Error())
	switch {
	case errors.Is(err, ErrDestinationNotAllowed):
		return "DISCOVERY_TARGET_NOT_ALLOWED", msg
	case errors.Is(err, ErrResponseTooLarge):
		return "DISCOVERY_RESPONSE_LIMIT_EXCEEDED", msg
	case errors.Is(err, ErrProtocol):
		return "DISCOVERY_PROTOCOL_ERROR", msg
	case errors.Is(err, ErrSourceDisabled):
		return "DISCOVERY_SOURCE_DISABLED", msg
	case strings.Contains(msg, "transport error") || strings.Contains(msg, "connection refused") || strings.Contains(msg, "timeout"):
		return "DISCOVERY_TRANSPORT_ERROR", msg
	case strings.Contains(msg, "status"):
		return "DISCOVERY_PROTOCOL_ERROR", msg
	default:
		return "DISCOVERY_RESPONSE_INVALID", msg
	}
}

// ListRuns handles GET /api/discovery/runs.
func (h *Handler) ListRuns(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/discovery/runs")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:runs:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		switch param {
		case "sourceId", "status", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	if sid := q.Get("sourceId"); sid != "" {
		if err := ValidateUUIDv4(sid); err != nil {
			writeValidation(w, err)
			return
		}
	}
	if err := ValidateRunStatusFilter(q.Get("status")); err != nil {
		writeValidation(w, err)
		return
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	items, next, hasMore, err := h.repo.ListRuns(r.Context(), RunListFilter{
		SourceID: strings.TrimSpace(q.Get("sourceId")),
		Status:   strings.TrimSpace(q.Get("status")),
		Limit:    limit,
		Cursor:   strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	response.JSON(w, http.StatusOK, ListRunsResponse{
		Runs: items,
		Page: PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// GetRun handles GET /api/discovery/runs/{runId}.
func (h *Handler) GetRun(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:runs:get:"+p.Username, 120, 60) {
		return
	}
	runID := r.PathValue("runId")
	if err := ValidateUUIDv4(runID); err != nil {
		writeValidation(w, err)
		return
	}
	run, err := h.repo.GetRun(r.Context(), runID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Discovery run not found", "DISCOVERY_RUN_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, run)
}

// ListCandidates handles GET /api/discovery/candidates.
func (h *Handler) ListCandidates(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/discovery/candidates")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:candidates:list:"+p.Username, 120, 60) {
		return
	}
	q := r.URL.Query()
	for param := range q {
		switch param {
		case "sourceId", "nfType", "nfStatus", "observationState", "linkedResourceId", "limit", "cursor":
		default:
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}
	if sid := q.Get("sourceId"); sid != "" {
		if err := ValidateUUIDv4(sid); err != nil {
			writeValidation(w, err)
			return
		}
	}
	if lrid := q.Get("linkedResourceId"); lrid != "" {
		if err := ValidateUUIDv4(lrid); err != nil {
			writeValidation(w, err)
			return
		}
	}
	if err := ValidateNfTypeFilter(q.Get("nfType")); err != nil {
		writeValidation(w, err)
		return
	}
	if err := ValidateObservationStateFilter(q.Get("observationState")); err != nil {
		writeValidation(w, err)
		return
	}
	limit, err := ValidateLimit(q.Get("limit"))
	if err != nil {
		writeValidation(w, err)
		return
	}
	items, next, hasMore, err := h.repo.ListCandidates(r.Context(), CandidateListFilter{
		SourceID:         strings.TrimSpace(q.Get("sourceId")),
		NfType:           strings.TrimSpace(q.Get("nfType")),
		NfStatus:         strings.TrimSpace(q.Get("nfStatus")),
		ObservationState: strings.TrimSpace(q.Get("observationState")),
		LinkedResourceID: strings.TrimSpace(q.Get("linkedResourceId")),
		Limit:            limit,
		Cursor:           strings.TrimSpace(q.Get("cursor")),
	})
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}
	response.JSON(w, http.StatusOK, ListCandidatesResponse{
		Candidates: items,
		Page:       PageInfo{Limit: limit, NextCursor: next, HasMore: hasMore},
	})
}

// GetCandidate handles GET /api/discovery/candidates/{candidateId}.
func (h *Handler) GetCandidate(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:candidates:get:"+p.Username, 120, 60) {
		return
	}
	candidateID := r.PathValue("candidateId")
	if err := ValidateUUIDv4(candidateID); err != nil {
		writeValidation(w, err)
		return
	}
	item, err := h.repo.GetCandidate(r.Context(), candidateID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Discovery candidate not found", "DISCOVERY_CANDIDATE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, item)
}

// LinkCandidate handles POST /api/discovery/candidates/{candidateId}/link.
func (h *Handler) LinkCandidate(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:candidates:link:"+p.Username, 30, 60) {
		return
	}
	candidateID := r.PathValue("candidateId")
	if err := ValidateUUIDv4(candidateID); err != nil {
		writeValidation(w, err)
		return
	}
	var req LinkCandidateRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	if err := ValidateLinkRequest(&req); err != nil {
		writeValidation(w, err)
		return
	}

	candidate, err := h.repo.GetCandidate(r.Context(), candidateID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Discovery candidate not found", "DISCOVERY_CANDIDATE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	exists, linkable, err := h.resolver.ExistsAndLinkable(r.Context(), req.ResourceID)
	if err != nil {
		response.InternalError(w)
		return
	}
	if !exists || !linkable {
		response.Error(w, http.StatusConflict, "Inventory resource cannot be linked", "DISCOVERY_INVENTORY_LINK_CONFLICT")
		return
	}

	resourceID := req.ResourceID
	after, err := h.repo.SetCandidateLink(r.Context(), candidateID, req.ExpectedRevision, &resourceID, p.Username)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			response.Error(w, http.StatusConflict, "revision conflict", "DISCOVERY_REVISION_CONFLICT")
			return
		}
		response.InternalError(w)
		return
	}
	h.auditWrite(p, "discovery.candidate.link", candidateID, candidate, after)
	response.JSON(w, http.StatusOK, after)
}

// UnlinkCandidate handles POST /api/discovery/candidates/{candidateId}/unlink.
func (h *Handler) UnlinkCandidate(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", r.URL.Path)
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "discovery:candidates:unlink:"+p.Username, 30, 60) {
		return
	}
	candidateID := r.PathValue("candidateId")
	if err := ValidateUUIDv4(candidateID); err != nil {
		writeValidation(w, err)
		return
	}
	var req UnlinkCandidateRequest
	if err := decodeStrictJSON(r.Body, maxBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_REQUEST")
		return
	}
	if err := ValidateUnlinkRequest(&req); err != nil {
		writeValidation(w, err)
		return
	}
	candidate, err := h.repo.GetCandidate(r.Context(), candidateID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Discovery candidate not found", "DISCOVERY_CANDIDATE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	after, err := h.repo.SetCandidateLink(r.Context(), candidateID, req.ExpectedRevision, nil, p.Username)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			response.Error(w, http.StatusConflict, "revision conflict", "DISCOVERY_REVISION_CONFLICT")
			return
		}
		response.InternalError(w)
		return
	}
	h.auditWrite(p, "discovery.candidate.unlink", candidateID, candidate, after)
	response.JSON(w, http.StatusOK, after)
}

func (h *Handler) auditWrite(p *auth.Principal, action, targetID string, before, after any) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: action,
		Module: "discovery",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Resource:  &audit.ResourceInput{Type: "discovery", ID: targetID},
		TargetID:  targetID,
		Before:    before,
		After:     after,
		Result:    "success",
		RiskLevel: "low",
	})
}
