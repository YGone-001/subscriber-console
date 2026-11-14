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
	truncated bool
	err       error
}

func (f *fakeContainmentTopology) ListAllContains(context.Context, int) ([]topology.Edge, bool, error) {
	return f.edges, f.truncated, f.err
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

	resp := NewContainmentService(inv, topo, fixedNow).Build(context.Background())
	if resp.Coverage != CompletenessComplete || resp.Truncated {
		t.Fatalf("unexpected coverage: %+v", resp)
	}
	if len(resp.Resources) != 2 || len(resp.Edges) != 1 {
		t.Fatalf("unexpected containment payload: %+v", resp)
	}
	if resp.Resources[1].Kind != inventory.KindNetworkFunctionInstance {
		t.Fatalf("resource kind must be projected: %+v", resp.Resources[1])
	}
}

func TestContainmentServiceMarksUnavailableTopology(t *testing.T) {
	inv := &fakeInventory{}
	resp := NewContainmentService(inv, &fakeContainmentTopology{err: errors.New("read failed")}, fixedNow).Build(context.Background())
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
