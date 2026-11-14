package operationsview

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"subscriber/internal/inventory"
	"subscriber/internal/topology"
)

type fakeContainmentTopology struct {
	edges     []topology.Edge
	allEdges  []topology.Edge
	truncated bool
	err       error
}

func (f *fakeContainmentTopology) ListAllContains(context.Context, int) ([]topology.Edge, bool, error) {
	return f.edges, f.truncated, f.err
}

func (f *fakeContainmentTopology) ListAllActiveEdges(context.Context, int) ([]topology.Edge, bool, error) {
	if f.err != nil {
		return nil, false, f.err
	}
	if f.allEdges != nil {
		return f.allEdges, f.truncated, nil
	}
	return f.edges, f.truncated, nil
}

type fakeContainmentResolver struct {
	ids       []string
	truncated bool
	err       error
	lastRoot  string
}

func (f *fakeContainmentResolver) Descendants(_ context.Context, root string, _ int) ([]string, bool, error) {
	f.lastRoot = root
	return f.ids, f.truncated, f.err
}

func TestContainmentServiceBuildsBoundedProjection(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{
		resource("aaaaaaaa-0001-4001-8001-000000000001", "site-a", "site"),
		resource("aaaaaaaa-0002-4001-8001-000000000002", "amf-1", "network_function_instance"),
	}}
	topo := &fakeContainmentTopology{edges: []topology.Edge{{
		FromResourceID:   "aaaaaaaa-0001-4001-8001-000000000001",
		ToResourceID:     "aaaaaaaa-0002-4001-8001-000000000002",
		RelationshipType: "contains",
		LifecycleState:   "active",
	}}}

	resp := NewContainmentService(inv, topo, fixedNow).Build(context.Background(), "")
	if resp.Coverage != CompletenessComplete || resp.Truncated {
		t.Fatalf("unexpected coverage: %+v", resp)
	}
	// Root-level query: only the root node (site-a) is returned; amf-1 is a
	// child and must be loaded via parentId. ChildCount tells the tree to
	// expand. The unlinked count is zero because both resources are referenced
	// by the active contains edge.
	if len(resp.Resources) != 1 || len(resp.Edges) != 1 {
		t.Fatalf("unexpected root-level payload: %+v", resp)
	}
	if resp.Resources[0].ChildCount != 1 {
		t.Fatalf("root must report 1 child, got %d", resp.Resources[0].ChildCount)
	}
	if resp.UnlinkedCount != 0 {
		t.Fatalf("unlinked count must be 0, got %d", resp.UnlinkedCount)
	}

	// Child-level query: parentId=site-a returns amf-1.
	childResp := NewContainmentService(inv, topo, fixedNow).Build(context.Background(), "aaaaaaaa-0001-4001-8001-000000000001")
	if len(childResp.Resources) != 1 {
		t.Fatalf("unexpected child-level payload: %+v", childResp)
	}
	if childResp.Resources[0].Kind != inventory.KindNetworkFunctionInstance {
		t.Fatalf("resource kind must be projected: %+v", childResp.Resources[0])
	}
}

func TestContainmentServiceCountsUnlinkedResourcesExactly(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{
		resource("aaaaaaaa-0001-4001-8001-000000000001", "site-a", "site"),
		resource("aaaaaaaa-0002-4001-8001-000000000002", "amf-1", "network_function_instance"),
		resource("aaaaaaaa-0003-4001-8001-000000000003", "smf-1", "network_function_instance"),
		resource("aaaaaaaa-0004-4001-8001-000000000004", "upf-1", "network_function_instance"),
	}}
	topo := &fakeContainmentTopology{edges: []topology.Edge{{
		FromResourceID:   "aaaaaaaa-0001-4001-8001-000000000001",
		ToResourceID:     "aaaaaaaa-0002-4001-8001-000000000002",
		RelationshipType: "contains",
		LifecycleState:   "active",
	}}}

	resp := NewContainmentService(inv, topo, fixedNow).Build(context.Background(), "")
	// amf-1 is referenced by the edge; site-a is its parent. smf-1 and upf-1
	// are referenced by no edge at all, so they are unlinked.
	if resp.UnlinkedCount != 2 {
		t.Fatalf("unlinked count = %d, want 2", resp.UnlinkedCount)
	}
	if len(resp.UnlinkedResources) != 2 {
		t.Fatalf("unlinked list must match the count: %+v", resp.UnlinkedResources)
	}
	for _, r := range resp.UnlinkedResources {
		if r.Kind != inventory.KindNetworkFunctionInstance {
			t.Fatalf("only operational kinds count as unlinked: %+v", r)
		}
	}
}

func TestContainmentServiceCountsUnlinkedAcrossAllRelationshipTypes(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{
		resource("aaaaaaaa-0001-4001-8001-000000000001", "site-a", "site"),
		resource("aaaaaaaa-0002-4001-8001-000000000002", "amf-1", "network_function_instance"),
		resource("aaaaaaaa-0003-4001-8001-000000000003", "smf-1", "network_function_instance"),
	}}
	topo := &fakeContainmentTopology{
		edges: []topology.Edge{{
			FromResourceID:   "aaaaaaaa-0001-4001-8001-000000000001",
			ToResourceID:     "aaaaaaaa-0002-4001-8001-000000000002",
			RelationshipType: "contains",
			LifecycleState:   "active",
		}},
		// A `depends_on` edge is not containment, but the canvas draws it, so
		// the resource must not be reported as unlinked.
		allEdges: []topology.Edge{
			{
				FromResourceID:   "aaaaaaaa-0001-4001-8001-000000000001",
				ToResourceID:     "aaaaaaaa-0002-4001-8001-000000000002",
				RelationshipType: "contains",
				LifecycleState:   "active",
			},
			{
				FromResourceID:   "aaaaaaaa-0002-4001-8001-000000000002",
				ToResourceID:     "aaaaaaaa-0003-4001-8001-000000000003",
				RelationshipType: "depends_on",
				LifecycleState:   "active",
			},
		},
	}

	resp := NewContainmentService(inv, topo, fixedNow).Build(context.Background(), "")
	if resp.UnlinkedCount != 0 {
		t.Fatalf("a resource linked by any relationship type is not unlinked: %+v", resp)
	}
}

func TestContainmentServiceMarksUnavailableTopology(t *testing.T) {
	inv := &fakeInventory{}
	resp := NewContainmentService(inv, &fakeContainmentTopology{err: errors.New("read failed")}, fixedNow).Build(context.Background(), "")
	if resp.Coverage != CompletenessUnavailable {
		t.Fatalf("topology failure must be unavailable, got %q", resp.Coverage)
	}
}

func TestResourceServiceResolvesSubtreeRootServerSide(t *testing.T) {
	root := "aaaaaaaa-0001-4001-8001-000000000001"
	inv := &fakeInventory{resources: []inventory.Resource{resource(root, "site-a", "site")}}
	resolver := &fakeContainmentResolver{ids: []string{root, "aaaaaaaa-0002-4001-8001-000000000002"}}
	service := NewResourceService(inv, &fakeHealth{}, nil, fixedNow, resolver)

	if _, err := service.Build(context.Background(), ResourceQuery{SubtreeRoot: root, Limit: 20}); err != nil {
		t.Fatalf("build: %v", err)
	}
	if resolver.lastRoot != root {
		t.Fatalf("resolver root = %q, want %q", resolver.lastRoot, root)
	}
	if inv.lastFilter.ResourceIDs == nil || len(inv.lastFilter.ResourceIDs) != 2 {
		t.Fatalf("subtree ids must reach inventory: %#v", inv.lastFilter.ResourceIDs)
	}
}

func TestContainmentHandlerRejectsBadSubtreeRoot(t *testing.T) {
	handler := NewResourceHandler(newService(&fakeInventory{}, &fakeHealth{}, nil), stubLimiter{}, nil)
	recorder := requestResources(handler, "/api/operations/resources?subtreeRoot=not-a-uuid", "viewer")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("bad subtreeRoot status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}
