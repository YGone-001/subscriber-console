// Package runtimewire adapts the canonical Inventory and NF Health modules to
// the narrow gateway interfaces used by runtime discovery.
//
// The adapters live here so neither module depends on the other's discovery
// concerns: Inventory stays the sole resource authority, NF Health stays the
// sole monitoring authority, and runtime discovery only proposes.
package runtimewire

import (
	"context"
	"strings"

	"subscriber/internal/inventory"
	"subscriber/internal/nfhealth"
	"subscriber/internal/runtimeinv"
)

// InventoryGateway adapts the Inventory repository.
type InventoryGateway struct {
	repo *inventory.Repository
}

// NewInventoryGateway constructs the adapter.
func NewInventoryGateway(repo *inventory.Repository) *InventoryGateway {
	return &InventoryGateway{repo: repo}
}

// FindDiscovered resolves resources by their server-owned provenance key.
func (g *InventoryGateway) FindDiscovered(ctx context.Context, system string, externalIDs []string) (map[string]runtimeinv.ResourceRef, error) {
	found, err := g.repo.FindByExternalIDs(ctx, system, externalIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[string]runtimeinv.ResourceRef, len(found))
	for key, resource := range found {
		out[key] = toRef(resource)
	}
	return out, nil
}

// FindCompatible resolves existing monitored resources for a domain and role.
func (g *InventoryGateway) FindCompatible(ctx context.Context, domain, role string) ([]runtimeinv.ResourceRef, error) {
	resources, err := g.repo.FindCompatible(ctx, domain, role)
	if err != nil {
		return nil, err
	}
	out := make([]runtimeinv.ResourceRef, 0, len(resources))
	for _, resource := range resources {
		out = append(out, toRef(resource))
	}
	return out, nil
}

// CreateDiscovered creates a resource with discovered provenance.
func (g *InventoryGateway) CreateDiscovered(ctx context.Context, spec runtimeinv.DiscoveredSpec, actor string) (runtimeinv.ResourceRef, bool, error) {
	resource, created, err := g.repo.CreateDiscovered(ctx, &inventory.DiscoveredCreateRequest{
		Kind:           spec.Kind,
		Name:           spec.Name,
		DisplayName:    spec.DisplayName,
		Description:    spec.Description,
		Domain:         spec.Domain,
		Role:           spec.Role,
		LifecycleState: spec.LifecycleState,
		Labels:         spec.Labels,
		Attributes:     spec.Attributes,
	}, actor, runtimeinv.SourceSystem, spec.ExternalID)
	if err != nil {
		return runtimeinv.ResourceRef{}, false, err
	}
	return toRef(*resource), created, nil
}

func toRef(resource inventory.Resource) runtimeinv.ResourceRef {
	return runtimeinv.ResourceRef{
		ResourceID:     resource.ResourceID,
		Name:           resource.Name,
		Kind:           resource.Kind,
		Domain:         resource.Domain,
		Role:           resource.Role,
		LifecycleState: resource.LifecycleState,
		ExternalID:     resource.Source.ExternalID,
		SourceKind:     resource.Source.Kind,
	}
}

// TargetGateway adapts the NF Health repository and its authorization chain.
type TargetGateway struct {
	repo      *nfhealth.Repository
	dest      *nfhealth.DestinationAllowlist
	units     *nfhealth.ServiceUnitAllowlist
	bindings  *nfhealth.ProcessBindingRegistry
	resolvers nfhealth.IdentityResolvers
}

// NewTargetGateway constructs the adapter.
func NewTargetGateway(
	repo *nfhealth.Repository,
	dest *nfhealth.DestinationAllowlist,
	units *nfhealth.ServiceUnitAllowlist,
	bindings *nfhealth.ProcessBindingRegistry,
	resolvers nfhealth.IdentityResolvers,
) *TargetGateway {
	return &TargetGateway{repo: repo, dest: dest, units: units, bindings: bindings, resolvers: resolvers}
}

// FindByResource returns the target associated with one Inventory resource.
func (g *TargetGateway) FindByResource(ctx context.Context, resourceID string) (string, bool, error) {
	target, err := g.repo.GetTargetByResourceID(ctx, resourceID)
	if err != nil {
		if err == nfhealth.ErrNotFound {
			return "", false, nil
		}
		return "", false, err
	}
	return target.TargetID, true, nil
}

// FindByResources is the bounded batch association lookup.
func (g *TargetGateway) FindByResources(ctx context.Context, resourceIDs []string) (map[string]string, error) {
	return g.repo.ListTargetsByResourceIDs(ctx, resourceIDs)
}

// EnsureTarget creates or reuses one monitoring target.
func (g *TargetGateway) EnsureTarget(ctx context.Context, spec runtimeinv.TargetSpec, actor string) (string, bool, error) {
	return nfhealth.EnsureRuntimeTarget(ctx, g.repo, g.dest, g.units, g.bindings, g.resolvers, nfhealth.RuntimeTargetRequest{
		ResourceID:      spec.ResourceID,
		Name:            spec.Name,
		ServiceUnit:     spec.ServiceUnit,
		CollectionMode:  spec.CollectionMode,
		IntervalSeconds: spec.IntervalSeconds,
	}, actor)
}

// BindingGateway adapts the governed persistent binding store.
type BindingGateway struct {
	store    *nfhealth.BindingStore
	registry *nfhealth.ProcessBindingRegistry
}

// NewBindingGateway constructs the adapter.
func NewBindingGateway(store *nfhealth.BindingStore, registry *nfhealth.ProcessBindingRegistry) *BindingGateway {
	return &BindingGateway{store: store, registry: registry}
}

// PreviewConflict reports a binding conflict without writing anything.
func (g *BindingGateway) PreviewConflict(ctx context.Context, spec runtimeinv.BindingSpec) (string, bool, error) {
	resourceID := strings.TrimSpace(spec.ResourceID)
	if resourceID != "" {
		if static, ok := g.registry.StaticUnit(resourceID); ok {
			if static != normalize(spec.Unit) {
				return runtimeinv.ConflictStaticBinding, true, nil
			}
			return "", false, nil
		}
		if existing, err := g.store.Get(ctx, resourceID); err == nil && existing != nil {
			if normalize(existing.Unit) != normalize(spec.Unit) {
				return runtimeinv.ConflictBindingMismatch, true, nil
			}
			return "", false, nil
		}
	}
	if existing, err := g.store.FindByKey(ctx, spec.BindingKey); err == nil && existing != nil {
		if existing.ResourceID != resourceID {
			return runtimeinv.ConflictBindingMismatch, true, nil
		}
	}
	return "", false, nil
}

// Install persists one binding and updates the in-process authorization view.
func (g *BindingGateway) Install(ctx context.Context, spec runtimeinv.BindingSpec, actor string) (bool, error) {
	if strings.TrimSpace(spec.ResourceID) == "" {
		return false, nfhealth.ErrBindingConflict
	}
	if static, ok := g.registry.StaticUnit(spec.ResourceID); ok && static != normalize(spec.Unit) {
		return false, nfhealth.ErrBindingConflict
	}
	created, err := g.store.Insert(ctx, &nfhealth.DynamicBinding{
		ResourceID:  spec.ResourceID,
		Unit:        normalize(spec.Unit),
		ProcessName: spec.ProcessName,
		Domain:      spec.Domain,
		NFType:      spec.NFType,
		HostID:      spec.HostID,
		BindingKey:  spec.BindingKey,
		Source:      spec.Source,
		CreatedBy:   actor,
	})
	if err != nil {
		return false, err
	}
	if err := g.registry.InstallDynamic(spec.ResourceID, spec.Unit); err != nil {
		return created, err
	}
	return created, nil
}

func normalize(unit string) string {
	return strings.TrimSuffix(strings.TrimSpace(unit), ".service")
}
