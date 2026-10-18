package nfhealth

import (
	"context"
	"errors"
	"testing"
)

type stubRuntimeRepo struct {
	byResource map[string]*HealthTarget
	created    []CreateTargetRequest
}

func newStubRuntimeRepo() *stubRuntimeRepo {
	return &stubRuntimeRepo{byResource: map[string]*HealthTarget{}}
}

func (s *stubRuntimeRepo) CreateTarget(ctx context.Context, req *CreateTargetRequest, actor string) (*HealthTarget, error) {
	s.created = append(s.created, *req)
	target := &HealthTarget{
		TargetID:         "11111111-1111-4111-8111-111111111111",
		ResourceID:       req.ResourceID,
		Name:             req.Name,
		CollectorProfile: req.CollectorProfile,
		ServiceUnit:      req.ServiceUnit,
		ServiceKind:      req.ServiceKind,
		CollectionMode:   req.CollectionMode,
		IntervalSeconds:  req.IntervalSeconds,
		Enabled:          true,
		Domain:           req.ResolvedDomain,
		NFType:           req.ResolvedNFType,
	}
	s.byResource[req.ResourceID] = target
	return target, nil
}

func (s *stubRuntimeRepo) GetTargetByResourceID(ctx context.Context, resourceID string) (*HealthTarget, error) {
	if target, ok := s.byResource[resourceID]; ok {
		return target, nil
	}
	return nil, ErrNotFound
}

func TestProcessBindingRegistryPrecedence(t *testing.T) {
	registry := NewProcessBindingRegistry("res-a=amfd")
	if err := registry.InstallDynamic("res-b", "smfd"); err != nil {
		t.Fatalf("dynamic install: %v", err)
	}
	if unit, ok := registry.BoundUnit("res-a"); !ok || unit != "amfd" {
		t.Fatalf("static binding must resolve, got %q/%v", unit, ok)
	}
	if unit, ok := registry.BoundUnit("res-b"); !ok || unit != "smfd" {
		t.Fatalf("dynamic binding must resolve, got %q/%v", unit, ok)
	}
	if registry.StaticSize() != 1 || registry.DynamicSize() != 1 || registry.Size() != 2 {
		t.Fatalf("unexpected sizes: static=%d dynamic=%d total=%d",
			registry.StaticSize(), registry.DynamicSize(), registry.Size())
	}

	// A dynamic binding may never override a static one.
	if err := registry.InstallDynamic("res-a", "smfd"); !errors.Is(err, ErrBindingConflict) {
		t.Fatalf("static precedence must reject a contradicting dynamic binding, got %v", err)
	}
	// A second, contradicting dynamic binding is rejected.
	if err := registry.InstallDynamic("res-b", "upfd"); !errors.Is(err, ErrBindingConflict) {
		t.Fatalf("a contradicting dynamic binding must be rejected, got %v", err)
	}
	// Repeating the identical binding is idempotent.
	if err := registry.InstallDynamic("res-b", "smfd"); err != nil {
		t.Fatalf("an identical binding must be idempotent, got %v", err)
	}
	// A static binding is still enforced by CheckBinding.
	if err := registry.CheckBinding("res-a", "smfd"); err == nil {
		t.Fatal("a mismatched unit must fail closed")
	}
}

func TestProcessBindingRegistryMissingBindingFailsClosed(t *testing.T) {
	registry := NewProcessBindingRegistry("")
	err := registry.CheckBinding("22222222-2222-4222-8222-222222222222", "amfd")
	if err == nil {
		t.Fatal("a missing binding must fail closed")
	}
	var validation *ErrValidation
	if !errors.As(err, &validation) || validation.Code != "NF_HEALTH_PROCESS_BINDING_MISSING" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestEnsureRuntimeTargetRequiresBinding(t *testing.T) {
	repo := newStubRuntimeRepo()
	dest := NewDestinationAllowlist("")
	units := NewServiceUnitAllowlist("amfd")
	bindings := NewProcessBindingRegistry("")
	resolvers := IdentityResolvers{
		Resource: func(ctx context.Context, resourceID string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID:     resourceID,
				Kind:           "network_function",
				Domain:         "5gc",
				Role:           "amf",
				LifecycleState: "planned",
			}, nil
		},
	}
	_, _, err := EnsureRuntimeTarget(context.Background(), repo, dest, units, bindings, resolvers, RuntimeTargetRequest{
		ResourceID:      "33333333-3333-4333-8333-333333333333",
		Name:            "AMF local process",
		ServiceUnit:     "amfd",
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 120,
	}, "operator")
	if err == nil {
		t.Fatal("a missing server-owned binding must fail closed")
	}
	if len(repo.created) != 0 {
		t.Fatal("no target may be created without an authorized binding")
	}
}

func TestEnsureRuntimeTargetCreatesOnceAndReuses(t *testing.T) {
	repo := newStubRuntimeRepo()
	dest := NewDestinationAllowlist("")
	units := NewServiceUnitAllowlist("")
	units.AddServerOwned("amfd")
	bindings := NewProcessBindingRegistry("")
	resourceID := "44444444-4444-4444-8444-444444444444"
	if err := bindings.InstallDynamic(resourceID, "amfd"); err != nil {
		t.Fatalf("install binding: %v", err)
	}
	resolvers := IdentityResolvers{
		Resource: func(ctx context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID:     id,
				Kind:           "network_function",
				Domain:         "5gc",
				Role:           "amf",
				LifecycleState: "planned",
			}, nil
		},
	}
	request := RuntimeTargetRequest{
		ResourceID:      resourceID,
		Name:            "AMF local process",
		ServiceUnit:     "amfd",
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 120,
	}
	targetID, created, err := EnsureRuntimeTarget(context.Background(), repo, dest, units, bindings, resolvers, request, "operator")
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	if !created || targetID == "" {
		t.Fatalf("first ensure must create a target, got %q/%v", targetID, created)
	}
	again, createdAgain, err := EnsureRuntimeTarget(context.Background(), repo, dest, units, bindings, resolvers, request, "operator")
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if createdAgain || again != targetID {
		t.Fatalf("second ensure must reuse the target, got %q/%v", again, createdAgain)
	}
	if len(repo.created) != 1 {
		t.Fatalf("exactly one target must be created, got %d", len(repo.created))
	}
	if repo.created[0].CollectorProfile != CollectorProcessOnly {
		t.Fatalf("the bootstrapped target must be process_only, got %s", repo.created[0].CollectorProfile)
	}
	if repo.created[0].CollectionMode != CollectionScheduled {
		t.Fatalf("the bootstrapped target must be scheduled, got %s", repo.created[0].CollectionMode)
	}
	if repo.created[0].ResolvedNFType != NFTypeAMF {
		t.Fatalf("the target must carry the resolved NF type, got %s", repo.created[0].ResolvedNFType)
	}
}

func TestEnsureRuntimeTargetRejectsCrossDomainBinding(t *testing.T) {
	repo := newStubRuntimeRepo()
	dest := NewDestinationAllowlist("")
	units := NewServiceUnitAllowlist("")
	units.AddServerOwned("pcscfd")
	bindings := NewProcessBindingRegistry("")
	resourceID := "55555555-5555-4555-8555-555555555555"
	if err := bindings.InstallDynamic(resourceID, "pcscfd"); err != nil {
		t.Fatalf("install binding: %v", err)
	}
	resolvers := IdentityResolvers{
		Resource: func(ctx context.Context, id string) (*ResourceProjection, error) {
			// An EPC MME resource must never accept an IMS process.
			return &ResourceProjection{
				ResourceID:     id,
				Kind:           "network_function",
				Domain:         "epc",
				Role:           "mme",
				LifecycleState: "planned",
			}, nil
		},
	}
	_, _, err := EnsureRuntimeTarget(context.Background(), repo, dest, units, bindings, resolvers, RuntimeTargetRequest{
		ResourceID:      resourceID,
		Name:            "MME local process",
		ServiceUnit:     "pcscfd",
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 120,
	}, "operator")
	if err == nil {
		t.Fatal("a cross-domain process binding must be rejected")
	}
	if len(repo.created) != 0 {
		t.Fatal("no target may be created for an incompatible identity")
	}
}
