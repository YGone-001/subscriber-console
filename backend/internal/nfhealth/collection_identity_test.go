package nfhealth

import (
	"context"
	"testing"
)

// ---------------------------------------------------------------------------
// Correction D — collection-time authoritative identity revalidation.
// ---------------------------------------------------------------------------

func resourceProjectionResolver(projection *ResourceProjection, lookups *int) func(ctx context.Context, resourceID string) (*ResourceProjection, error) {
	return func(_ context.Context, _ string) (*ResourceProjection, error) {
		if lookups != nil {
			*lookups++
		}
		return projection, nil
	}
}

func TestCollectionIdentityRejectsMissingInventoryResource(t *testing.T) {
	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	err := ValidateCollectionIdentity(context.Background(), target,
		resourceProjectionResolver(nil, nil), correctionBindings())
	assertCode(t, err, "NF_HEALTH_RESOURCE_NOT_FOUND")
}

func TestCollectionIdentityRejectsRetiredResource(t *testing.T) {
	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	err := ValidateCollectionIdentity(context.Background(), target, resourceProjectionResolver(&ResourceProjection{
		ResourceID: testResourceIMSBound, Kind: "network_function", Domain: "ims",
		Role: "pcscf", LifecycleState: "retired",
	}, nil), correctionBindings())
	assertCode(t, err, "NF_HEALTH_RESOURCE_RETIRED")
}

func TestCollectionIdentityRejectsUnsupportedKindAndDomain(t *testing.T) {
	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	err := ValidateCollectionIdentity(context.Background(), target, resourceProjectionResolver(&ResourceProjection{
		ResourceID: testResourceIMSBound, Kind: "host", Domain: "ims",
		Role: "pcscf", LifecycleState: "active",
	}, nil), correctionBindings())
	assertCode(t, err, "NF_HEALTH_RESOURCE_KIND_UNSUPPORTED")

	err = ValidateCollectionIdentity(context.Background(), target, resourceProjectionResolver(&ResourceProjection{
		ResourceID: testResourceIMSBound, Kind: "network_function", Domain: "platform",
		Role: "pcscf", LifecycleState: "active",
	}, nil), correctionBindings())
	assertCode(t, err, "NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED")
}

func TestCollectionIdentityFailsClosedWhenAuthoritativeIdentityChanged(t *testing.T) {
	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")

	// The Inventory role now resolves to a different NF type.
	err := ValidateCollectionIdentity(context.Background(), target, resourceProjectionResolver(&ResourceProjection{
		ResourceID: testResourceIMSBound, Kind: "network_function", Domain: "ims",
		Role: "scscf", LifecycleState: "active",
	}, nil), correctionBindings())
	assertCode(t, err, "NF_HEALTH_TARGET_IDENTITY_MISMATCH")

	// The Inventory domain moved out of the stored association.
	moved := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	moved.Domain = "epc"
	moved.NFType = NFTypeMME
	err = ValidateCollectionIdentity(context.Background(), moved, resourceProjectionResolver(&ResourceProjection{
		ResourceID: testResourceIMSBound, Kind: "network_function", Domain: "ims",
		Role: "pcscf", LifecycleState: "active",
	}, nil), correctionBindings())
	assertCode(t, err, "NF_HEALTH_TARGET_IDENTITY_MISMATCH")

	// The Inventory role lost its explicit NF type.
	err = ValidateCollectionIdentity(context.Background(), target, resourceProjectionResolver(&ResourceProjection{
		ResourceID: testResourceIMSBound, Kind: "network_function", Domain: "ims",
		Role: "", LifecycleState: "active",
	}, nil), correctionBindings())
	assertCode(t, err, "NF_HEALTH_NF_TYPE_UNRESOLVED")
}

func TestCollectionIdentityRejectsInvalidatedProcessBinding(t *testing.T) {
	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	resource := &ResourceProjection{
		ResourceID: testResourceIMSBound, Kind: "network_function", Domain: "ims",
		Role: "pcscf", LifecycleState: "active",
	}

	// The server binding was withdrawn.
	err := ValidateCollectionIdentity(context.Background(), target, resourceProjectionResolver(resource, nil), NewProcessBindingRegistry(""))
	assertCode(t, err, "NF_HEALTH_PROCESS_BINDING_MISSING")

	// The binding now points at an unrelated process.
	err = ValidateCollectionIdentity(context.Background(), target, resourceProjectionResolver(resource, nil),
		NewProcessBindingRegistry(testResourceIMSBound+"=scscfd"))
	assertCode(t, err, "NF_HEALTH_PROCESS_BINDING_MISMATCH")
}

func TestCollectionIdentitySkipsLegacyTargetsWithoutInventoryAssociation(t *testing.T) {
	legacy := &HealthTarget{
		TargetID:         "bbbbbbbb-0003-4b03-8b03-0000000000c3",
		SchemaVersion:    SchemaVersion,
		CandidateID:      testCandidateID,
		Name:             "legacy candidate-only",
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  "http://127.0.0.5:9090/metrics",
		ServiceUnit:      "mockd",
		ServiceKind:      "process",
		CollectionMode:   CollectionManual,
		IntervalSeconds:  DefaultIntervalSeconds,
		Enabled:          true,
		IdentityState:    IdentityLegacyUnbound,
	}
	lookups := 0
	if err := ValidateCollectionIdentity(context.Background(), legacy, resourceProjectionResolver(nil, &lookups), NewProcessBindingRegistry("")); err != nil {
		t.Fatalf("legacy target must keep its documented compatibility: %v", err)
	}
	if lookups != 0 {
		t.Fatal("no Inventory lookup may be performed without an established association")
	}
}

func TestCollectionIdentityRequiresResolverForResourceNativeTargets(t *testing.T) {
	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	assertCode(t, ValidateCollectionIdentity(context.Background(), target, nil, correctionBindings()), "NF_HEALTH_RESOURCE_UNAVAILABLE")
}

func TestCollectorFailsClosedWithoutIdentityCheck(t *testing.T) {
	root := t.TempDir()
	inspector := NewUnitInspector(NewServiceUnitAllowlist("pcscfd"), "")
	inspector.procRoot = root
	collector := NewCollector(nil, inspector, NewDestinationAllowlist(""), NewServiceUnitAllowlist("pcscfd"))

	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	_, err := collector.Collect(context.Background(), target, "operator1", false)
	assertCode(t, err, "NF_HEALTH_RESOURCE_UNAVAILABLE")
}

func TestCollectorEnforcesIdentityCheckOnEveryPath(t *testing.T) {
	root := t.TempDir()
	inspector := NewUnitInspector(NewServiceUnitAllowlist("pcscfd"), "")
	inspector.procRoot = root
	collector := NewCollector(nil, inspector, NewDestinationAllowlist(""), NewServiceUnitAllowlist("pcscfd"))
	calls := 0
	collector.SetCollectionIdentityCheck(func(_ context.Context, _ *HealthTarget) error {
		calls++
		return validationError("NF_HEALTH_RESOURCE_RETIRED", "inventory resource is retired")
	})

	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	// Manual path.
	if _, err := collector.Collect(context.Background(), target, "operator1", false); err == nil {
		t.Fatal("manual collection must enforce identity")
	}
	// Scheduled path (same collector entry point).
	if _, err := collector.Collect(context.Background(), target, "scheduler", true); err == nil {
		t.Fatal("scheduled collection must enforce identity")
	}
	if calls != 2 {
		t.Fatalf("identity must be revalidated on every collection, got %d calls", calls)
	}
}

func TestRejectedCollectionProducesNoSample(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	target := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	created, err := repo.CreateTarget(ctx, &CreateTargetRequest{
		ResourceID:       testResourceIMSBound,
		Name:             target.Name,
		CollectorProfile: CollectorProcessOnly,
		ServiceUnit:      "pcscfd",
		ServiceKind:      "process",
		CollectionMode:   CollectionManual,
		IntervalSeconds:  DefaultIntervalSeconds,
		ResolvedDomain:   "ims",
		ResolvedNFType:   NFTypePCSCF,
	}, "operator1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	root := t.TempDir()
	inspector := NewUnitInspector(NewServiceUnitAllowlist("pcscfd"), "")
	inspector.procRoot = root
	collector := NewCollector(nil, inspector, NewDestinationAllowlist(""), NewServiceUnitAllowlist("pcscfd"))
	collector.SetCollectionIdentityCheck(func(ctx context.Context, t *HealthTarget) error {
		return ValidateCollectionIdentity(ctx, t, resourceProjectionResolver(&ResourceProjection{
			ResourceID: testResourceIMSBound, Kind: "network_function", Domain: "ims",
			Role: "pcscf", LifecycleState: "retired",
		}, nil), correctionBindings())
	})

	loaded, err := repo.GetTarget(ctx, created.TargetID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if _, err := collector.Collect(ctx, loaded, "operator1", false); err == nil {
		t.Fatal("collection against a retired resource must be rejected")
	}
	samples, _, _, err := repo.ListSamples(ctx, SampleListFilter{TargetID: created.TargetID, Limit: 10})
	if err != nil {
		t.Fatalf("list samples: %v", err)
	}
	if len(samples) != 0 {
		t.Fatal("a rejected collection must never produce a sample")
	}
	after, err := repo.GetTarget(ctx, created.TargetID)
	if err != nil {
		t.Fatalf("reload after rejection: %v", err)
	}
	if after.LastMeasuredAt != "" || after.LastSuccessAt != "" {
		t.Fatal("a rejected collection must not claim a successful measurement")
	}
}
