package operationsview

import (
	"context"
	"net/http"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/inventory"
	"subscriber/internal/response"
	"subscriber/internal/topology"
)

// Tree population bounds. A bounded tree is reported as partial; it is never
// presented as the complete inventory.
const (
	ContainmentMaxResources = 2000
	ContainmentMaxEdges     = 5000
)

// TreeKinds are the structural Inventory kinds that may appear as containers or
// leaves. Interfaces, IP addresses and services are attributes of these nodes,
// not tree nodes of their own.
var TreeKinds = []string{
	inventory.KindRegion,
	inventory.KindSite,
	inventory.KindCluster,
	inventory.KindHost,
	inventory.KindVirtualMachine,
	inventory.KindContainer,
	inventory.KindPod,
	inventory.KindNetworkElement,
	inventory.KindNetworkFunction,
	inventory.KindNetworkFunctionInstance,
	inventory.KindDeployment,
}

// ContainmentResource is the lightweight node projection consumed by the tree.
type ContainmentResource struct {
	ResourceID     string `json:"resourceId"`
	Name           string `json:"name"`
	DisplayName    string `json:"displayName,omitempty"`
	Domain         string `json:"domain"`
	Kind           string `json:"kind"`
	Role           string `json:"role,omitempty"`
	LifecycleState string `json:"lifecycleState"`
}

// ContainmentEdge is one active declared contains edge.
type ContainmentEdge struct {
	FromResourceID string `json:"fromResourceId"`
	ToResourceID   string `json:"toResourceId"`
}

// ContainmentResponse is the bounded tree projection.
type ContainmentResponse struct {
	GeneratedAt string                `json:"generatedAt"`
	Coverage    string                `json:"coverage"`
	Truncated   bool                  `json:"truncated"`
	Resources   []ContainmentResource `json:"resources"`
	Edges       []ContainmentEdge     `json:"edges"`
}

type ContainmentInventory interface {
	List(ctx context.Context, filter inventory.ListFilter) ([]inventory.Resource, *string, bool, error)
}

type ContainmentTopology interface {
	ListAllContains(ctx context.Context, maxEdges int) ([]topology.Edge, bool, error)
}

// ContainmentService composes the Inventory node population and the declared
// active contains edge set. It never writes either authority.
type ContainmentService struct {
	inventory ContainmentInventory
	topology  ContainmentTopology
	now       func() time.Time
}

func NewContainmentService(inv ContainmentInventory, topo ContainmentTopology, now func() time.Time) *ContainmentService {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &ContainmentService{inventory: inv, topology: topo, now: now}
}

func (s *ContainmentService) Build(ctx context.Context) ContainmentResponse {
	resp := ContainmentResponse{
		GeneratedAt: s.now().UTC().Format(time.RFC3339Nano),
		Coverage:    CompletenessComplete,
		Resources:   []ContainmentResource{},
		Edges:       []ContainmentEdge{},
	}

	cursor := ""
	for len(resp.Resources) < ContainmentMaxResources {
		page, next, hasMore, err := s.inventory.List(ctx, inventory.ListFilter{
			Kinds:  TreeKinds,
			Limit:  200,
			Cursor: cursor,
		})
		if err != nil {
			resp.Coverage = CompletenessUnavailable
			return resp
		}
		for _, item := range page {
			resp.Resources = append(resp.Resources, ContainmentResource{
				ResourceID:     item.ResourceID,
				Name:           item.Name,
				DisplayName:    item.DisplayName,
				Domain:         item.Domain,
				Kind:           item.Kind,
				Role:           item.Role,
				LifecycleState: item.LifecycleState,
			})
			if len(resp.Resources) >= ContainmentMaxResources {
				break
			}
		}
		if !hasMore || next == nil || *next == "" {
			break
		}
		resp.Truncated = true
		cursor = *next
	}

	if s.topology == nil {
		resp.Coverage = CompletenessUnavailable
		return resp
	}
	edges, edgesTruncated, err := s.topology.ListAllContains(ctx, ContainmentMaxEdges)
	if err != nil {
		resp.Coverage = CompletenessUnavailable
		return resp
	}
	if edgesTruncated {
		resp.Truncated = true
	}
	for _, edge := range edges {
		resp.Edges = append(resp.Edges, ContainmentEdge{
			FromResourceID: edge.FromResourceID,
			ToResourceID:   edge.ToResourceID,
		})
	}
	if resp.Truncated && resp.Coverage == CompletenessComplete {
		resp.Coverage = CompletenessPartial
	}
	return resp
}

// ContainmentHandler serves GET /api/operations/containment.
type ContainmentHandler struct {
	service     *ContainmentService
	limiter     RateLimiter
	auditWriter AuditWriter
}

func NewContainmentHandler(service *ContainmentService, limiter RateLimiter, auditWriter AuditWriter) *ContainmentHandler {
	return &ContainmentHandler{service: service, limiter: limiter, auditWriter: auditWriter}
}

func (h *ContainmentHandler) Get(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}
	if !auth.HasPermission(p, "core.read") {
		response.Forbidden(w, "Forbidden")
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "operations:containment:"+p.Username, summaryRateLimit, summaryRateWindowSec) {
		return
	}
	response.JSON(w, http.StatusOK, h.service.Build(r.Context()))
}
