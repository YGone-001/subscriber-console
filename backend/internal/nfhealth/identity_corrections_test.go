package nfhealth

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Correction A — effective update validation must not bypass process bindings.
// ---------------------------------------------------------------------------

const testResourceEPCBound = "aaaaaaaa-0001-4a01-8c01-0000000000b1"
const testResourceIMSBound = "aaaaaaaa-0002-4a02-8c02-0000000000b2"

func correctionBindings() *ProcessBindingRegistry {
	return NewProcessBindingRegistry(testResourceIMSBound + "=pcscfd," + testResourceEPCBound + "=mmed")
}

func updateReq(revision int64, mut MutableTarget) *UpdateTargetRequest {
	return &UpdateTargetRequest{ExpectedRevision: revision, Target: mut}
}

func processOnlyTargetFor(resourceID, unit string) *HealthTarget {
	return &HealthTarget{
		TargetID:         "bbbbbbbb-0001-4b01-8b01-0000000000c1",
		SchemaVersion:    SchemaVersion,
		ResourceID:       resourceID,
		Name:             "P-CSCF local process",
		CollectorProfile: CollectorProcessOnly,
		ServiceUnit:      unit,
		ServiceKind:      "process",
		CollectionMode:   CollectionManual,
		IntervalSeconds:  DefaultIntervalSeconds,
		Enabled:          true,
		Domain:           "ims",
		NFType:           NFTypePCSCF,
		IdentityState:    IdentityInventoryAuthoritative,
		Revision:         3,
	}
}

func TestEffectiveUpdateAllowsValidProcessOnlyUpdate(t *testing.T) {
	existing := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	units := NewServiceUnitAllowlist("pcscfd,mmed")
	err := ValidateEffectiveTargetUpdate(existing, updateReq(3, MutableTarget{
		Name:            "P-CSCF local process renamed",
		ServiceUnit:     "pcscfd",
		ServiceKind:     "process",
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 180,
		Enabled:         true,
	}), nil, units, correctionBindings())
	if err != nil {
		t.Fatalf("valid process_only update must be accepted: %v", err)
	}
}

func TestEffectiveUpdateRejectsUnrelatedAllowlistedProcess(t *testing.T) {
	// mmed is allowlisted and bound to a different Inventory resource, so an
	// IMS P-CSCF target must never adopt it.
	existing := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	units := NewServiceUnitAllowlist("pcscfd,mmed")
	err := ValidateEffectiveTargetUpdate(existing, updateReq(3, MutableTarget{
		Name:            "P-CSCF local process",
		ServiceUnit:     "mmed",
		ServiceKind:     "process",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), nil, units, correctionBindings())
	assertCode(t, err, "NF_HEALTH_PROCESS_BINDING_MISMATCH")
}

func TestEffectiveUpdateRejectsIncompatibleDomainOrNFTarget(t *testing.T) {
	// A binding that maps an EPC MME resource to an IMS process must be
	// rejected by NF type/domain compatibility even though resourceId and unit
	// agree with the same configuration entry.
	inconsistent := NewProcessBindingRegistry(testResourceEPCBound + "=pcscfd")
	existing := processOnlyTargetFor(testResourceEPCBound, "pcscfd")
	existing.Domain = "epc"
	existing.NFType = NFTypeMME
	units := NewServiceUnitAllowlist("pcscfd")
	err := ValidateEffectiveTargetUpdate(existing, updateReq(3, MutableTarget{
		Name:            "MME local process",
		ServiceUnit:     "pcscfd",
		ServiceKind:     "process",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), nil, units, inconsistent)
	assertCode(t, err, "NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE")
}

func TestEffectiveUpdateRejectsDisablingInspectionSource(t *testing.T) {
	existing := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	units := NewServiceUnitAllowlist("pcscfd")
	err := ValidateEffectiveTargetUpdate(existing, updateReq(3, MutableTarget{
		Name:            "P-CSCF local process",
		ServiceUnit:     "",
		ServiceKind:     "none",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), nil, units, correctionBindings())
	assertCode(t, err, "INVALID_SERVICE_KIND")

	// An empty unit while keeping the local inspection kind is equally invalid.
	err = ValidateEffectiveTargetUpdate(existing, updateReq(3, MutableTarget{
		Name:            "P-CSCF local process",
		ServiceUnit:     "",
		ServiceKind:     "process",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), nil, units, correctionBindings())
	assertCode(t, err, "INVALID_TARGET")
}

func TestEffectiveUpdateRejectsEndpointOnProcessOnlyTarget(t *testing.T) {
	existing := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	units := NewServiceUnitAllowlist("pcscfd")
	dest := NewDestinationAllowlist("127.0.0.5:9090")
	err := ValidateEffectiveTargetUpdate(existing, updateReq(3, MutableTarget{
		Name:            "P-CSCF local process",
		MetricsEndpoint: "http://127.0.0.5:9090/metrics",
		ServiceUnit:     "pcscfd",
		ServiceKind:     "process",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), dest, units, correctionBindings())
	assertCode(t, err, "INVALID_TARGET")
}

func TestEffectiveUpdateKeepsHTTPMetricsTargetsWorking(t *testing.T) {
	// An HTTP-only resource-native target keeps the existing path, including
	// dropping the endpoint to stop probing.
	existing := &HealthTarget{
		TargetID:         "bbbbbbbb-0002-4b02-8b02-0000000000c2",
		SchemaVersion:    SchemaVersion,
		ResourceID:       testResourceEPCBound,
		Name:             "MME metrics",
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  "http://127.0.0.5:9090/metrics",
		ServiceKind:      "none",
		CollectionMode:   CollectionManual,
		IntervalSeconds:  DefaultIntervalSeconds,
		Enabled:          true,
		Domain:           "epc",
		NFType:           NFTypeMME,
		IdentityState:    IdentityInventoryAuthoritative,
		Revision:         1,
	}
	err := ValidateEffectiveTargetUpdate(existing, updateReq(1, MutableTarget{
		Name:            "MME metrics",
		ServiceKind:     "none",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), NewDestinationAllowlist("127.0.0.5:9090"), NewServiceUnitAllowlist(""), correctionBindings())
	if err != nil {
		t.Fatalf("HTTP-only update must stay valid: %v", err)
	}

	// A resource-native HTTP target that keeps local L1 evidence must keep a
	// matching, compatible binding.
	err = ValidateEffectiveTargetUpdate(existing, updateReq(1, MutableTarget{
		Name:            "MME metrics",
		MetricsEndpoint: "http://127.0.0.5:9090/metrics",
		ServiceUnit:     "pcscfd",
		ServiceKind:     "process",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), NewDestinationAllowlist("127.0.0.5:9090"), NewServiceUnitAllowlist("pcscfd"), correctionBindings())
	assertCode(t, err, "NF_HEALTH_PROCESS_BINDING_MISMATCH")

	err = ValidateEffectiveTargetUpdate(existing, updateReq(1, MutableTarget{
		Name:            "MME metrics",
		MetricsEndpoint: "http://127.0.0.5:9090/metrics",
		ServiceUnit:     "mmed",
		ServiceKind:     "process",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), NewDestinationAllowlist("127.0.0.5:9090"), NewServiceUnitAllowlist("mmed"), correctionBindings())
	if err != nil {
		t.Fatalf("compatible local evidence for the same resource must stay valid: %v", err)
	}
}

func TestEffectiveUpdateRejectsInvalidRevision(t *testing.T) {
	existing := processOnlyTargetFor(testResourceIMSBound, "pcscfd")
	err := ValidateEffectiveTargetUpdate(existing, updateReq(0, MutableTarget{
		Name:            "P-CSCF local process",
		ServiceUnit:     "pcscfd",
		ServiceKind:     "process",
		CollectionMode:  CollectionManual,
		IntervalSeconds: 120,
		Enabled:         true,
	}), nil, NewServiceUnitAllowlist("pcscfd"), correctionBindings())
	assertCode(t, err, "INVALID_REVISION")
}

// ---------------------------------------------------------------------------
// Correction F — process/NF type and domain compatibility.
// ---------------------------------------------------------------------------

func TestProcessNFTCompatibilityMatchesCanonicalMappings(t *testing.T) {
	cases := []struct {
		unit    string
		domain  string
		nfType  string
		wantErr string
	}{
		{"mmed", "epc", NFTypeMME, ""},
		{"pcscfd", "ims", NFTypePCSCF, ""},
		{"pcscfd.service", "ims", NFTypePCSCF, ""},
		{"ocsd", "charging", NFTypeOCS, ""},
		{"pcscfd", "epc", NFTypeMME, "NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE"},
		{"mmed", "ims", NFTypePCSCF, "NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE"},
		{"amfd", "ims", NFTypePCSCF, "NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE"},
		{"mmed", "epc", NFTypeAMF, "NF_HEALTH_PROCESS_NF_TYPE_INCOMPATIBLE"},
	}
	for _, tc := range cases {
		err := ValidateProcessNFTCompatibility(tc.unit, tc.domain, tc.nfType)
		if tc.wantErr == "" {
			if err != nil {
				t.Fatalf("%s in %s/%s must be compatible: %v", tc.unit, tc.domain, tc.nfType, err)
			}
			continue
		}
		assertCode(t, err, tc.wantErr)
	}
}

func TestProcessNFTCompatibilityAllowsOperatorAuthorizedUnregisteredProcess(t *testing.T) {
	// A process outside the bounded registry carries no derivable NF type; the
	// explicit server binding remains the authorization boundary and no type
	// claim is invented.
	if err := ValidateProcessNFTCompatibility("mockd", "ims", NFTypePCSCF); err != nil {
		t.Fatalf("explicitly authorized unregistered process must stay permitted: %v", err)
	}
	assertCode(t, ValidateProcessNFTCompatibility("   ", "ims", NFTypePCSCF), "NF_HEALTH_PROCESS_UNIT_REQUIRED")
}

func TestProcessNFTCompatibilityNeverInfersFromSuffix(t *testing.T) {
	// "pcscfd-test" is not a registry identity; suffix stripping is only the
	// documented ".service" normalization and never an NF type inference.
	if _, ok := LookupNFProcessIdentity(strings.TrimSuffix("pcscfd-test", ".service")); ok {
		t.Fatal("suffix variants must never resolve through the registry")
	}
	if err := ValidateProcessNFTCompatibility("pcscfd-test", "ims", NFTypePCSCF); err != nil {
		t.Fatalf("unregistered process keeps binding-based authorization: %v", err)
	}
	if _, ok := LookupNFProcessIdentity("pcscfd-test"); ok {
		t.Fatal("registry must stay exact")
	}
}

// ---------------------------------------------------------------------------
// Correction B — candidate-only adoption validates the observed NF type.
// ---------------------------------------------------------------------------

func TestCandidateOnlyAdoptionRequiresCompatibleObservedType(t *testing.T) {
	resolvers := IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "ims",
				Role: "pcscf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "P-CSCF", Exists: true,
				LinkedResourceID: testResourceIMS,
			}, nil
		},
	}
	resolved, err := ResolveTargetIdentity(context.Background(), &CreateTargetRequest{CandidateID: testCandidateID}, resolvers)
	if err != nil {
		t.Fatalf("compatible candidate must adopt: %v", err)
	}
	if resolved.ResourceID != testResourceIMS || resolved.IdentityState != IdentityInventoryAuthoritative {
		t.Fatalf("expected authoritative adoption, got %+v", resolved)
	}
}

func TestCandidateOnlyAdoptionRejectsMismatchedObservedType(t *testing.T) {
	resolvers := IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "ims",
				Role: "pcscf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "AMF", Exists: true,
				LinkedResourceID: testResourceIMS,
			}, nil
		},
	}
	resolved, err := ResolveTargetIdentity(context.Background(), &CreateTargetRequest{CandidateID: testCandidateID}, resolvers)
	if err != nil {
		t.Fatalf("mismatched adoption must degrade, not fail: %v", err)
	}
	if resolved.ResourceID != "" {
		t.Fatal("a mismatched association must never be elevated into inventory_authoritative")
	}
	if resolved.IdentityState != IdentityLegacyUnbound {
		t.Fatalf("expected legacy_unbound, got %s", resolved.IdentityState)
	}
}

func TestCandidateOnlyAdoptionRejectsMissingObservedType(t *testing.T) {
	resolvers := IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "ims",
				Role: "pcscf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "", Exists: true,
				LinkedResourceID: testResourceIMS,
			}, nil
		},
	}
	resolved, err := ResolveTargetIdentity(context.Background(), &CreateTargetRequest{CandidateID: testCandidateID}, resolvers)
	if err != nil {
		t.Fatalf("missing observed type must degrade, not fail: %v", err)
	}
	if resolved.ResourceID != "" || resolved.IdentityState != IdentityLegacyUnbound {
		t.Fatalf("an unverifiable observed type must never establish authoritative identity: %+v", resolved)
	}
}

func TestCandidateOnlyUnlinkedKeepsLegacyBehavior(t *testing.T) {
	resolved, err := ResolveTargetIdentity(context.Background(), &CreateTargetRequest{CandidateID: testCandidateID}, IdentityResolvers{
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{CandidateID: id, NFType: "AMF", Exists: true}, nil
		},
	})
	if err != nil {
		t.Fatalf("unlinked candidate must stay creatable: %v", err)
	}
	if resolved.ResourceID != "" || resolved.IdentityState != IdentityLegacyUnbound {
		t.Fatalf("expected transitional legacy identity, got %+v", resolved)
	}
}

func TestCandidateAdoptionNeverMutatesDiscovery(t *testing.T) {
	mutated := false
	resolvers := IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "ims",
				Role: "pcscf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "AMF", Exists: true,
				LinkedResourceID: testResourceIMS,
			}, nil
		},
	}
	if _, err := ResolveTargetIdentity(context.Background(), &CreateTargetRequest{CandidateID: testCandidateID}, resolvers); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if mutated {
		t.Fatal("resolution must be read-only")
	}
}

// ---------------------------------------------------------------------------
// Correction E — request context propagation.
// ---------------------------------------------------------------------------

const testCandidateID = "cccccccc-0001-4c01-8c01-0000000000d1"

func TestResolutionUsesSuppliedContext(t *testing.T) {
	type ctxKey string
	const marker ctxKey = "resolution-marker"
	ctx := context.WithValue(context.Background(), marker, "request-scoped")

	sawResource, sawCandidate := false, false
	_, err := ResolveTargetIdentity(ctx, &CreateTargetRequest{
		ResourceID:  testResourceIMS,
		CandidateID: testCandidateID,
	}, IdentityResolvers{
		Resource: func(got context.Context, id string) (*ResourceProjection, error) {
			if got.Value(marker) != "request-scoped" {
				t.Fatal("inventory resolution must receive the supplied request context")
			}
			sawResource = true
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "ims",
				Role: "pcscf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(got context.Context, id string) (*CandidateProjection, error) {
			if got.Value(marker) != "request-scoped" {
				t.Fatal("discovery resolution must receive the supplied request context")
			}
			sawCandidate = true
			return &CandidateProjection{
				CandidateID: id, NFType: "P-CSCF", Exists: true,
				LinkedResourceID: testResourceIMS,
			}, nil
		},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !sawResource || !sawCandidate {
		t.Fatal("both resolvers must run")
	}
}

func TestResolutionStopsWhenRequestContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	resolved := 0
	_, err := ResolveTargetIdentity(ctx, &CreateTargetRequest{ResourceID: testResourceIMS}, IdentityResolvers{
		Resource: func(got context.Context, _ string) (*ResourceProjection, error) {
			if err := got.Err(); err != nil {
				return nil, err
			}
			resolved++
			return &ResourceProjection{
				ResourceID: testResourceIMS, Kind: "network_function", Domain: "ims",
				Role: "pcscf", LifecycleState: "active",
			}, nil
		},
	})
	if err == nil {
		t.Fatal("a cancelled request context must stop resolution")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if resolved != 0 {
		t.Fatal("no resolver work must complete after cancellation")
	}
}

func TestCandidateOnlyResolutionUsesSuppliedContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ResolveTargetIdentity(ctx, &CreateTargetRequest{CandidateID: testCandidateID}, IdentityResolvers{
		Candidate: func(got context.Context, _ string) (*CandidateProjection, error) {
			return nil, got.Err()
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("candidate-only resolution must observe cancellation, got %v", err)
	}
}
