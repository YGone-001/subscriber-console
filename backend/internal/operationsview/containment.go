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
	// ContainmentMaxUnlinked bounds the readable sample of unlinked resources
	// returned alongside the exact count.
	ContainmentMaxUnlinked = 50
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

// operationalKinds are the kinds that count as an unlinked network element
// in the topology tray: NF instances and standalone network elements. The
// structural kinds above are containers, not network functions.
var operationalKinds = map[string]bool{
	inventory.KindNetworkFunctionInstance: true,
	inventory.KindNetworkElement:         true,
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
	// ChildCount is the number of direct declared contains children. The tree
	// uses it to decide whether an expand affordance is needed before the
	// children are loaded.
	ChildCount int `json:"childCount"`
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
	// UnlinkedCount is the exact number of non-retired NF instances and
	// standalone network elements that no active relationship references. It is
	// computed server-side so the frontend tray never infers it from a bounded
	// page.
	UnlinkedCount int `json:"unlinkedCount"`
	// UnlinkedResources carries the same population as UnlinkedCount, bounded
	// to a readable sample. Count and list always agree.
	UnlinkedResources []ContainmentResource `json:"unlinkedResources"`
	Resources         []ContainmentResource `json:"resources"`
	Edges             []ContainmentEdge     `json:"edges"`
}

type ContainmentInventory interface {
	List(ctx context.Context, filter inventory.ListFilter) ([]inventory.Resource, *string, bool, error)
}

type ContainmentTopology interface {
	ListAllContains(ctx context.Context, maxEdges int) ([]topology.Edge, bool, error)
	ListAllActiveEdges(ctx context.Context, maxEdges int) ([]topology.Edge, bool, error)
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

// Build assembles one level of the containment tree. When parentID is empty
// the response carries the root-level nodes (resources with no active contains
// parent); when set it carries the direct children of that node. Each resource
// reports ChildCount so the tree can render an expand affordance before the
// children are loaded. The full edge set is always included so the client can
// derive cross-links without a second round-trip.
func (s *ContainmentService) Build(ctx context.Context, parentID string) ContainmentResponse {
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

	// Build parent→child count map and track referenced resources for the
	// unlinked count. A resource is "unlinked" when no active relationship
	// references it at all — neither as parent nor child. The reference set
	// covers every relationship type, because the topology canvas draws them
	// all; counting only `contains` edges would report a visibly linked
	// resource as unlinked.
	childCount := make(map[string]int)
	referenced := make(map[string]bool)
	childrenOf := make(map[string][]string)
	for _, edge := range edges {
		childCount[edge.FromResourceID]++
		referenced[edge.FromResourceID] = true
		referenced[edge.ToResourceID] = true
		if edge.RelationshipType == "contains" && edge.LifecycleState == "active" {
			childrenOf[edge.FromResourceID] = append(childrenOf[edge.FromResourceID], edge.ToResourceID)
		}
	}

	allEdges, allEdgesTruncated, err := s.topology.ListAllActiveEdges(ctx, ContainmentMaxEdges)
	if err != nil {
		resp.Coverage = CompletenessUnavailable
		return resp
	}
	if allEdgesTruncated {
		resp.Truncated = true
	}
	for _, edge := range allEdges {
		referenced[edge.FromResourceID] = true
		referenced[edge.ToResourceID] = true
	}

	unlinked := 0
	unlinkedResources := make([]ContainmentResource, 0, ContainmentMaxUnlinked)
	for i := range resp.Resources {
		resp.Resources[i].ChildCount = childCount[resp.Resources[i].ResourceID]
		if resp.Resources[i].LifecycleState == "retired" {
			continue
		}
		/* The unlinked count covers the operational population — NF instances
		 * and standalone network elements — because that is the population
		 * the topology tray lists. Structural kinds (sites, hosts) are
		 * containers and are not themselves "unlinked network functions". */
		if !operationalKinds[resp.Resources[i].Kind] {
			continue
		}
		if !referenced[resp.Resources[i].ResourceID] {
			unlinked++
			if len(unlinkedResources) < ContainmentMaxUnlinked {
				unlinkedResources = append(unlinkedResources, resp.Resources[i])
			}
		}
	}
	resp.UnlinkedCount = unlinked
	resp.UnlinkedResources = unlinkedResources

	// Select the requested level. Root level = resources with no active
	// contains parent; a parent level = its direct children.
	levelIDs := make(map[string]bool)
	if parentID != "" {
		for _, id := range childrenOf[parentID] {
			levelIDs[id] = true
		}
	} else {
		// A resource is a child when an active contains edge points at it. Its
		// parent may be outside the population (for example a retired parent),
		// so an orphan still becomes a root instead of disappearing.
		isChild := make(map[string]bool)
		for _, edge := range edges {
			isChild[edge.ToResourceID] = true
		}
		for _, r := range resp.Resources {
			if !isChild[r.ResourceID] {
				levelIDs[r.ResourceID] = true
			}
		}
	}

	level := make([]ContainmentResource, 0, len(levelIDs))
	for _, r := range resp.Resources {
		if levelIDs[r.ResourceID] {
			level = append(level, r)
		}
	}
	resp.Resources = level

	// Only the level's own outgoing edges are returned, so the payload stays
	// proportional to the level rather than to the whole declared graph.
	scopedEdges := make([]ContainmentEdge, 0, len(level))
	for _, edge := range edges {
		if levelIDs[edge.FromResourceID] {
			scopedEdges = append(scopedEdges, ContainmentEdge{
				FromResourceID: edge.FromResourceID,
				ToResourceID:   edge.ToResourceID,
			})
		}
	}
	resp.Edges = scopedEdges

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
	parentID := r.URL.Query().Get("parentId")
	response.JSON(w, http.StatusOK, h.service.Build(r.Context(), parentID))
}
