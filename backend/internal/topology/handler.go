package topology

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

// EdgeRepository is the data access contract for topology edges.
type EdgeRepository interface {
	Create(ctx context.Context, req *CreateEdgeRequest, actor string) (*Edge, error)
	GetByID(ctx context.Context, edgeID string) (*Edge, error)
	List(ctx context.Context, filter ListFilter) ([]Edge, *string, bool, error)
	Update(ctx context.Context, edgeID string, req *UpdateEdgeRequest, actor string) (*Edge, *Edge, error)
	Retire(ctx context.Context, edgeID string, req *RetireEdgeRequest, actor string) (*Edge, *Edge, error)
	Neighbors(ctx context.Context, filter NeighborFilter) (*NeighborsResponse, error)
}

// Handler handles HTTP requests for the topology relationship foundation.
type Handler struct {
	repo        EdgeRepository
	limiter     RateLimiter
	auditWriter AuditWriter
}

// NewHandler creates a new topology HTTP handler.
func NewHandler(repo EdgeRepository, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{repo: repo, limiter: limiter, auditWriter: auditWriter}
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

// Meta handles GET /api/topology/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, "GET", "/api/topology/meta")
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:meta:"+p.Username, 120, 60) {
		return
	}

	response.JSON(w, http.StatusOK, MetaResponse{
		SchemaVersion:     SchemaVersion,
		RelationshipTypes: CanonicalRelationshipTypes,
		LifecycleStates:   CanonicalLifecycleStates,
	})
}

// List handles GET /api/topology/edges.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, "GET", "/api/topology/edges")
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:list:"+p.Username, 120, 60) {
		return
	}

	q := r.URL.Query()
	allowed := map[string]bool{
		"fromResourceId":   true,
		"toResourceId":     true,
		"relationshipType": true,
		"lifecycleState":   true,
		"limit":            true,
		"cursor":           true,
	}
	for param := range q {
		if !allowed[param] {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}

	fromResourceID := strings.TrimSpace(q.Get("fromResourceId"))
	if fromResourceID != "" && !uuidRegex.MatchString(fromResourceID) {
		response.BadRequest(w, "fromResourceId must be a valid UUID v4", "INVALID_RESOURCE_ID")
		return
	}
	toResourceID := strings.TrimSpace(q.Get("toResourceId"))
	if toResourceID != "" && !uuidRegex.MatchString(toResourceID) {
		response.BadRequest(w, "toResourceId must be a valid UUID v4", "INVALID_RESOURCE_ID")
		return
	}
	relationshipType := strings.TrimSpace(q.Get("relationshipType"))
	if relationshipType != "" {
		if err := ValidateRelationshipType(relationshipType); err != nil {
			response.BadRequest(w, err.Error(), "INVALID_RELATIONSHIP_TYPE")
			return
		}
	}

	lifecycleState := strings.TrimSpace(q.Get("lifecycleState"))
	if lifecycleState == "" {
		lifecycleState = LifecycleActive
	}
	if err := ValidateLifecycleState(lifecycleState); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_LIFECYCLE_FILTER")
		return
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
		FromResourceID:   fromResourceID,
		ToResourceID:     toResourceID,
		RelationshipType: relationshipType,
		LifecycleState:   lifecycleState,
		Limit:            limit,
		Cursor:           strings.TrimSpace(q.Get("cursor")),
	}

	items, nextCursor, hasMore, err := h.repo.List(r.Context(), filter)
	if err != nil {
		if errors.Is(err, ErrInvalidCursor) {
			response.BadRequest(w, "invalid pagination cursor", "INVALID_CURSOR")
			return
		}
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ListEdgesResponse{
		Edges: items,
		Page:  PageInfo{Limit: limit, NextCursor: nextCursor, HasMore: hasMore},
	})
}

// Get handles GET /api/topology/edges/{edgeId}.
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
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:get:"+p.Username, 120, 60) {
		return
	}

	edgeID := r.PathValue("edgeId")
	if !uuidRegex.MatchString(edgeID) {
		response.BadRequest(w, "edgeId must be a valid UUID v4", "INVALID_EDGE_ID")
		return
	}

	edge, err := h.repo.GetByID(r.Context(), edgeID)
	if err != nil {
		if errors.Is(err, ErrEdgeNotFound) {
			response.Error(w, http.StatusNotFound, "Topology edge not found", "TOPOLOGY_EDGE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, edge)
}

// Neighbors handles GET /api/topology/resources/{resourceId}/neighbors.
func (h *Handler) Neighbors(w http.ResponseWriter, r *http.Request) {
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
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:neighbors:"+p.Username, 120, 60) {
		return
	}

	resourceID := r.PathValue("resourceId")
	if !uuidRegex.MatchString(resourceID) {
		response.BadRequest(w, "resourceId must be a valid UUID v4", "INVALID_RESOURCE_ID")
		return
	}

	q := r.URL.Query()
	allowed := map[string]bool{
		"direction":        true,
		"relationshipType": true,
		"lifecycleState":   true,
		"limit":            true,
		"cursor":           true,
	}
	for param := range q {
		if !allowed[param] {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}

	direction := strings.TrimSpace(q.Get("direction"))
	if direction == "" {
		direction = DirectionBoth
	}
	if err := ValidateDirection(direction); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_DIRECTION")
		return
	}

	relationshipType := strings.TrimSpace(q.Get("relationshipType"))
	if relationshipType != "" {
		if err := ValidateRelationshipType(relationshipType); err != nil {
			response.BadRequest(w, err.Error(), "INVALID_RELATIONSHIP_TYPE")
			return
		}
	}

	lifecycleState := strings.TrimSpace(q.Get("lifecycleState"))
	if lifecycleState == "" {
		lifecycleState = LifecycleActive
	}
	if err := ValidateLifecycleState(lifecycleState); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_LIFECYCLE_FILTER")
		return
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

	filter := NeighborFilter{
		RootResourceID:   resourceID,
		Direction:        direction,
		RelationshipType: relationshipType,
		LifecycleState:   lifecycleState,
		Limit:            limit,
		Cursor:           strings.TrimSpace(q.Get("cursor")),
	}

	res, err := h.repo.Neighbors(r.Context(), filter)
	if err != nil {
		switch {
		case errors.Is(err, ErrRootResourceNotFound):
			response.Error(w, http.StatusNotFound, "Inventory resource not found", "TOPOLOGY_ROOT_RESOURCE_NOT_FOUND")
		case errors.Is(err, ErrInvalidCursor):
			response.BadRequest(w, "invalid pagination cursor", "INVALID_CURSOR")
		default:
			response.InternalError(w)
		}
		return
	}

	response.JSON(w, http.StatusOK, res)
}

// Create handles POST /api/topology/edges.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, "POST", "/api/topology/edges")
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:create:"+p.Username, 30, 60) {
		return
	}

	var req CreateEdgeRequest
	if err := decodeStrictJSON(r.Body, 128*1024, &req); err != nil {
		if strings.Contains(err.Error(), "forbidden") {
			response.BadRequest(w, err.Error(), "SERVER_OWNED_FIELD_FORBIDDEN")
			return
		}
		response.BadRequest(w, err.Error(), "INVALID_JSON")
		return
	}

	if err := ValidateCreateRequest(&req); err != nil {
		writeValidationError(w, err)
		return
	}

	edge, err := h.repo.Create(r.Context(), &req, p.Username)
	if err != nil {
		switch {
		case errors.Is(err, ErrEndpointNotFound):
			response.Error(w, http.StatusNotFound, "Referenced Inventory resource does not exist", "TOPOLOGY_ENDPOINT_NOT_FOUND")
		case errors.Is(err, ErrEndpointRetired):
			response.Error(w, http.StatusConflict, "Referenced Inventory resource is retired", "TOPOLOGY_ENDPOINT_RETIRED")
		case errors.Is(err, ErrDuplicateActiveEdge):
			response.Error(w, http.StatusConflict, "An active relationship already exists for this directed tuple", "TOPOLOGY_DUPLICATE_ACTIVE_EDGE")
		default:
			response.InternalError(w)
		}
		return
	}

	if h.auditWriter != nil {
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "topology.edge.create",
			Module: "topology",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Resource: &audit.ResourceInput{
				Type: "topology_edge",
				ID:   edge.EdgeID,
			},
			TargetID: edge.EdgeID,
			After:    edge,
			Result:   "success",
		})
	}

	response.JSON(w, http.StatusCreated, edge)
}

// Update handles PUT /api/topology/edges/{edgeId}.
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
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:update:"+p.Username, 30, 60) {
		return
	}

	edgeID := r.PathValue("edgeId")
	if !uuidRegex.MatchString(edgeID) {
		response.BadRequest(w, "edgeId must be a valid UUID v4", "INVALID_EDGE_ID")
		return
	}

	var req UpdateEdgeRequest
	if err := decodeStrictJSON(r.Body, 128*1024, &req); err != nil {
		if strings.Contains(err.Error(), "forbidden") {
			response.BadRequest(w, err.Error(), "SERVER_OWNED_FIELD_FORBIDDEN")
			return
		}
		response.BadRequest(w, err.Error(), "INVALID_JSON")
		return
	}

	if err := ValidateUpdateRequest(&req); err != nil {
		writeValidationError(w, err)
		return
	}

	before, after, err := h.repo.Update(r.Context(), edgeID, &req, p.Username)
	if err != nil {
		switch {
		case errors.Is(err, ErrEdgeNotFound):
			response.Error(w, http.StatusNotFound, "Topology edge not found", "TOPOLOGY_EDGE_NOT_FOUND")
		case errors.Is(err, ErrRevisionConflict):
			response.Error(w, http.StatusConflict, "Concurrency conflict: expectedRevision does not match current edge revision", "TOPOLOGY_REVISION_CONFLICT")
		case errors.Is(err, ErrEdgeRetired):
			response.Error(w, http.StatusConflict, "Topology edge is retired and cannot be modified", "TOPOLOGY_EDGE_RETIRED")
		default:
			response.InternalError(w)
		}
		return
	}

	if h.auditWriter != nil {
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "topology.edge.update",
			Module: "topology",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Resource: &audit.ResourceInput{
				Type: "topology_edge",
				ID:   after.EdgeID,
			},
			TargetID: after.EdgeID,
			Before:   before,
			After:    after,
			Result:   "success",
		})
	}

	response.JSON(w, http.StatusOK, after)
}

// Retire handles POST /api/topology/edges/{edgeId}/retire.
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
	if h.limiter != nil && !h.limiter.Enforce(w, r, "topology:retire:"+p.Username, 30, 60) {
		return
	}

	edgeID := r.PathValue("edgeId")
	if !uuidRegex.MatchString(edgeID) {
		response.BadRequest(w, "edgeId must be a valid UUID v4", "INVALID_EDGE_ID")
		return
	}

	var req RetireEdgeRequest
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

	before, after, err := h.repo.Retire(r.Context(), edgeID, &req, p.Username)
	if err != nil {
		switch {
		case errors.Is(err, ErrEdgeNotFound):
			response.Error(w, http.StatusNotFound, "Topology edge not found", "TOPOLOGY_EDGE_NOT_FOUND")
		case errors.Is(err, ErrRevisionConflict):
			response.Error(w, http.StatusConflict, "Concurrency conflict: expectedRevision does not match current edge revision", "TOPOLOGY_REVISION_CONFLICT")
		case errors.Is(err, ErrEdgeRetired):
			response.Error(w, http.StatusConflict, "Topology edge is already retired", "TOPOLOGY_EDGE_RETIRED")
		default:
			response.InternalError(w)
		}
		return
	}

	if h.auditWriter != nil {
		h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
			Action: "topology.edge.retire",
			Module: "topology",
			Actor: audit.ActorInput{
				Type:     "user",
				Username: p.Username,
				Role:     p.Role,
			},
			Resource: &audit.ResourceInput{
				Type: "topology_edge",
				ID:   after.EdgeID,
			},
			TargetID: after.EdgeID,
			Reason:   strings.TrimSpace(req.Reason),
			Before:   before,
			After:    after,
			Result:   "success",
		})
	}

	response.JSON(w, http.StatusOK, after)
}

func writeValidationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidRelationshipType):
		response.BadRequest(w, err.Error(), "INVALID_RELATIONSHIP_TYPE")
	case errors.Is(err, ErrInvalidResourceID):
		response.BadRequest(w, err.Error(), "INVALID_RESOURCE_ID")
	case errors.Is(err, ErrSelfEdge):
		response.BadRequest(w, err.Error(), "TOPOLOGY_SELF_EDGE")
	default:
		response.BadRequest(w, err.Error(), "VALIDATION_FAILED")
	}
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "authorization.denied",
		Module: "topology",
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
