package inventory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
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

// ResourceRepository defines the data access contract for inventory resources.
type ResourceRepository interface {
	Create(ctx context.Context, req *CreateResourceRequest, actor string) (*Resource, error)
	GetByID(ctx context.Context, id string) (*Resource, error)
	List(ctx context.Context, filter ListFilter) ([]Resource, *string, bool, error)
	Update(ctx context.Context, id string, req *UpdateResourceRequest, actor string) (*Resource, *Resource, error)
	Retire(ctx context.Context, id string, req *RetireResourceRequest, actor string) (*Resource, *Resource, error)
}

// Handler handles HTTP requests for inventory resources.
type Handler struct {
	repo        ResourceRepository
	limiter     RateLimiter
	auditWriter AuditWriter
}

// NewHandler creates a new inventory HTTP handler.
func NewHandler(repo ResourceRepository, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{
		repo:        repo,
		limiter:     limiter,
		auditWriter: auditWriter,
	}
}

// Meta handles GET /api/inventory/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, "GET", "/api/inventory/meta")
		response.Forbidden(w, "Forbidden")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "inventory:meta:"+p.Username, 120, 60) {
		return
	}

	res := MetaResponse{
		SchemaVersion:       SchemaVersion,
		Kinds:               CanonicalKinds,
		Domains:             CanonicalDomains,
		LifecycleStates:     CanonicalLifecycleStates,
		ManagementProtocols: CanonicalProtocols,
		AddressTypes:        CanonicalAddressTypes,
	}

	response.JSON(w, http.StatusOK, res)
}

// List handles GET /api/inventory/resources.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, "GET", "/api/inventory/resources")
		response.Forbidden(w, "Forbidden")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "inventory:list:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	allowedParams := map[string]bool{
		"kind":           true,
		"domain":         true,
		"lifecycleState": true,
		"q":              true,
		"limit":          true,
		"cursor":         true,
	}
	for param := range q {
		if !allowedParams[param] {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}

	kind := q.Get("kind")
	if kind != "" {
		if err := ValidateKind(kind); err != nil {
			response.BadRequest(w, err.Error(), "INVALID_KIND_FILTER")
			return
		}
	}

	domain := q.Get("domain")
	if domain != "" {
		if err := ValidateDomain(domain); err != nil {
			response.BadRequest(w, err.Error(), "INVALID_DOMAIN_FILTER")
			return
		}
	}

	lifecycleState := q.Get("lifecycleState")
	if lifecycleState != "" {
		if err := ValidateLifecycleState(lifecycleState, true); err != nil {
			response.BadRequest(w, err.Error(), "INVALID_LIFECYCLE_FILTER")
			return
		}
	}

	limit := 50
	if limitStr := q.Get("limit"); limitStr != "" {
		parsed, err := strconv.Atoi(limitStr)
		if err != nil || parsed < 1 || parsed > 200 {
			response.BadRequest(w, "limit must be an integer between 1 and 200", "INVALID_LIMIT")
			return
		}
		limit = parsed
	}

	filter := ListFilter{
		Kind:           kind,
		Domain:         domain,
		LifecycleState: lifecycleState,
		Query:          strings.TrimSpace(q.Get("q")),
		Limit:          limit,
		Cursor:         strings.TrimSpace(q.Get("cursor")),
	}

	items, nextCursor, hasMore, err := h.repo.List(r.Context(), filter)
	if err != nil {
		response.BadRequest(w, err.Error(), "INVALID_CURSOR")
		return
	}

	res := ListResourcesResponse{
		Resources: items,
		Page: PageInfo{
			Limit:      limit,
			NextCursor: nextCursor,
			HasMore:    hasMore,
		},
	}

	response.JSON(w, http.StatusOK, res)
}

// Get handles GET /api/inventory/resources/{resourceId}.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, "GET", r.URL.Path)
		response.Forbidden(w, "Forbidden")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "inventory:get:"+p.Username, 120, 60) {
		return
	}

	resourceID := r.PathValue("resourceId")
	if !uuidRegex.MatchString(resourceID) {
		response.BadRequest(w, "resourceId must be a valid UUID v4", "INVALID_RESOURCE_ID")
		return
	}

	item, err := h.repo.GetByID(r.Context(), resourceID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Resource not found", "INVENTORY_RESOURCE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, item)
}

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
	if err := CheckForbiddenServerFields(data); err != nil {
		return err
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

// Create handles POST /api/inventory/resources.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, "POST", "/api/inventory/resources")
		response.Forbidden(w, "Forbidden")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "inventory:create:"+p.Username, 30, 60) {
		return
	}

	var req CreateResourceRequest
	if err := decodeStrictJSON(r.Body, 128*1024, &req); err != nil {
		if strings.Contains(err.Error(), "forbidden") {
			response.BadRequest(w, err.Error(), "SERVER_OWNED_FIELD_FORBIDDEN")
			return
		}
		response.BadRequest(w, err.Error(), "INVALID_JSON")
		return
	}

	if err := ValidateCreateRequest(&req); err != nil {
		response.BadRequest(w, err.Error(), "VALIDATION_FAILED")
		return
	}

	res, err := h.repo.Create(r.Context(), &req, p.Username)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}

	if h.auditWriter != nil {
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "inventory.resource.create",
			Module: "inventory",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Resource: &audit.ResourceInput{
				Type: "inventory_resource",
				ID:   res.ResourceID,
				Name: res.Name,
			},
			TargetID: res.ResourceID,
			After:    res,
			Result:   "success",
		})
	}

	response.JSON(w, http.StatusCreated, res)
}

// Update handles PUT /api/inventory/resources/{resourceId}.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, "PUT", r.URL.Path)
		response.Forbidden(w, "Forbidden")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "inventory:update:"+p.Username, 30, 60) {
		return
	}

	resourceID := r.PathValue("resourceId")
	if !uuidRegex.MatchString(resourceID) {
		response.BadRequest(w, "resourceId must be a valid UUID v4", "INVALID_RESOURCE_ID")
		return
	}

	var req UpdateResourceRequest
	if err := decodeStrictJSON(r.Body, 128*1024, &req); err != nil {
		if strings.Contains(err.Error(), "forbidden") {
			response.BadRequest(w, err.Error(), "SERVER_OWNED_FIELD_FORBIDDEN")
			return
		}
		response.BadRequest(w, err.Error(), "INVALID_JSON")
		return
	}

	if err := ValidateUpdateRequest(&req); err != nil {
		response.BadRequest(w, err.Error(), "VALIDATION_FAILED")
		return
	}

	before, after, err := h.repo.Update(r.Context(), resourceID, &req, p.Username)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Resource not found", "INVENTORY_RESOURCE_NOT_FOUND")
			return
		}
		if errors.Is(err, ErrRevisionConflict) {
			response.Error(w, http.StatusConflict, "Concurrency conflict: expectedRevision does not match current resource revision", "INVENTORY_REVISION_CONFLICT")
			return
		}
		if errors.Is(err, ErrRetiredConflict) {
			response.Error(w, http.StatusConflict, "Resource is retired and cannot be modified", "INVENTORY_RESOURCE_RETIRED")
			return
		}
		if errors.Is(err, ErrKindImmutable) {
			response.BadRequest(w, "Resource kind is immutable and cannot be changed", "INVENTORY_KIND_IMMUTABLE")
			return
		}
		response.Error(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}

	if h.auditWriter != nil {
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "inventory.resource.update",
			Module: "inventory",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Resource: &audit.ResourceInput{
				Type: "inventory_resource",
				ID:   after.ResourceID,
				Name: after.Name,
			},
			TargetID: after.ResourceID,
			Before:   before,
			After:    after,
			Result:   "success",
		})
	}

	response.JSON(w, http.StatusOK, after)
}

// Retire handles POST /api/inventory/resources/{resourceId}/retire.
func (h *Handler) Retire(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, "POST", r.URL.Path)
		response.Forbidden(w, "Forbidden")
		return
	}

	if h.limiter != nil && !h.limiter.Enforce(w, r, "inventory:retire:"+p.Username, 30, 60) {
		return
	}

	resourceID := r.PathValue("resourceId")
	if !uuidRegex.MatchString(resourceID) {
		response.BadRequest(w, "resourceId must be a valid UUID v4", "INVALID_RESOURCE_ID")
		return
	}

	var req RetireResourceRequest
	if err := decodeStrictJSON(r.Body, 64*1024, &req); err != nil {
		if strings.Contains(err.Error(), "forbidden") {
			response.BadRequest(w, err.Error(), "SERVER_OWNED_FIELD_FORBIDDEN")
			return
		}
		response.BadRequest(w, err.Error(), "INVALID_JSON")
		return
	}

	if err := ValidateRetireRequest(&req); err != nil {
		response.BadRequest(w, err.Error(), "VALIDATION_FAILED")
		return
	}

	before, after, err := h.repo.Retire(r.Context(), resourceID, &req, p.Username)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Resource not found", "INVENTORY_RESOURCE_NOT_FOUND")
			return
		}
		if errors.Is(err, ErrRevisionConflict) {
			response.Error(w, http.StatusConflict, "Concurrency conflict: expectedRevision does not match current resource revision", "INVENTORY_REVISION_CONFLICT")
			return
		}
		if errors.Is(err, ErrRetiredConflict) {
			response.Error(w, http.StatusConflict, "Resource is already retired", "INVENTORY_RESOURCE_RETIRED")
			return
		}
		response.Error(w, http.StatusInternalServerError, err.Error(), "INTERNAL_ERROR")
		return
	}

	if h.auditWriter != nil {
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "inventory.resource.retire",
			Module: "inventory",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Resource: &audit.ResourceInput{
				Type: "inventory_resource",
				ID:   after.ResourceID,
				Name: after.Name,
			},
			TargetID: after.ResourceID,
			Reason:   req.Reason,
			Before:   before,
			After:    after,
			Result:   "success",
		})
	}

	response.JSON(w, http.StatusOK, after)
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "authorization.denied",
		Module: "inventory",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Result: "denied",
		Metadata: map[string]any{
			"method": method,
			"path":   path,
		},
	})
}
