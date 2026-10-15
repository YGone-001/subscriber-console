package nfhealth

import (
	"context"
	"strings"
	"testing"
)

const (
	testResourceEPC = "11111111-1111-4111-8111-111111111111"
	testResourceIMS = "22222222-2222-4222-8222-222222222222"
	testResource5GC = "33333333-3333-4333-8333-333333333333"
	testResourceOCS = "44444444-4444-4444-8444-444444444444"
)

// Group A: canonical Inventory identity.
func TestResolveTargetIdentityAcceptsInventoryOnly(t *testing.T) {
	for _, tc := range []struct {
		name     string
		domain   string
		role     string
		nfType   string
		resource string
	}{
		{"epc mme", "epc", "mme", NFTypeMME, testResourceEPC},
		{"ims pcscf", "ims", "pcscf", NFTypePCSCF, testResourceIMS},
		{"5gc amf", "5gc", "amf", NFTypeAMF, testResource5GC},
		{"charging ocs", "charging", "ocs", NFTypeOCS, testResourceOCS},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolved, err := ResolveTargetIdentity(&CreateTargetRequest{
				ResourceID: tc.resource,
			}, IdentityResolvers{
				Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
					return &ResourceProjection{
						ResourceID: id, Kind: "network_function_instance",
						Domain: tc.domain, Role: tc.role, LifecycleState: "active",
					}, nil
				},
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if resolved.ResourceID != tc.resource || resolved.Domain != tc.domain || resolved.NFType != tc.nfType {
				t.Fatalf("unexpected identity: %+v", resolved)
			}
			if resolved.IdentityState != IdentityInventoryAuthoritative {
				t.Fatalf("expected authoritative identity, got %s", resolved.IdentityState)
			}
			if resolved.CandidateID != "" {
				t.Fatal("candidate must stay absent for Inventory-only targets")
			}
		})
	}
}

func TestResolveTargetIdentityRejectsMissingResource(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{ResourceID: testResourceEPC}, IdentityResolvers{
		Resource: func(_ context.Context, _ string) (*ResourceProjection, error) { return nil, nil },
	})
	assertCode(t, err, "NF_HEALTH_RESOURCE_NOT_FOUND")
}

func TestResolveTargetIdentityRejectsRetiredResource(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{ResourceID: testResourceEPC}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "epc",
				Role: "mme", LifecycleState: "retired",
			}, nil
		},
	})
	assertCode(t, err, "NF_HEALTH_RESOURCE_RETIRED")
}

func TestResolveTargetIdentityRejectsNonNFKind(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{ResourceID: testResourceEPC}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "host", Domain: "epc",
				Role: "mme", LifecycleState: "active",
			}, nil
		},
	})
	assertCode(t, err, "NF_HEALTH_RESOURCE_KIND_UNSUPPORTED")
}

func TestResolveTargetIdentityRejectsUnsupportedDomain(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{ResourceID: testResourceEPC}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "platform",
				Role: "amf", LifecycleState: "active",
			}, nil
		},
	})
	assertCode(t, err, "NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED")
}

func TestResolveTargetIdentityRejectsDomainTypeMismatch(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{ResourceID: testResourceEPC}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "epc",
				Role: "amf", LifecycleState: "active",
			}, nil
		},
	})
	assertCode(t, err, "NF_HEALTH_DOMAIN_TYPE_MISMATCH")
}

func TestResolveTargetIdentityRejectsUnresolvedNFType(t *testing.T) {
	for _, role := range []string{"", "router", "vendor-x", "some gnb thing"} {
		_, err := ResolveTargetIdentity(&CreateTargetRequest{ResourceID: testResourceEPC}, IdentityResolvers{
			Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
				return &ResourceProjection{
					ResourceID: id, Kind: "network_function", Domain: "epc",
					Role: role, LifecycleState: "active",
				}, nil
			},
		})
		assertCode(t, err, "NF_HEALTH_NF_TYPE_UNRESOLVED")
	}
}

func TestResolveTargetIdentityRequiresOneIdentity(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{}, IdentityResolvers{})
	assertCode(t, err, "INVALID_TARGET")
}

// Group B: Discovery compatibility.
func TestResolveTargetIdentityAcceptsMatchingLinkedCandidate(t *testing.T) {
	resolved, err := ResolveTargetIdentity(&CreateTargetRequest{
		ResourceID:  testResource5GC,
		CandidateID: "55555555-5555-4555-8555-555555555555",
	}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function_instance", Domain: "5gc",
				Role: "amf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "AMF", Exists: true,
				LinkedResourceID: testResource5GC,
			}, nil
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved.ResourceID != testResource5GC || resolved.NFType != NFTypeAMF {
		t.Fatalf("unexpected identity: %+v", resolved)
	}
}

func TestResolveTargetIdentityRejectsCandidateResourceMismatch(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{
		ResourceID:  testResource5GC,
		CandidateID: "55555555-5555-4555-8555-555555555555",
	}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function_instance", Domain: "5gc",
				Role: "amf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "AMF", Exists: true,
				LinkedResourceID: testResourceOCS,
			}, nil
		},
	})
	assertCode(t, err, "NF_HEALTH_CANDIDATE_RESOURCE_MISMATCH")
}

func TestResolveTargetIdentityRejectsCandidateTypeMismatch(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{
		ResourceID:  testResource5GC,
		CandidateID: "55555555-5555-4555-8555-555555555555",
	}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function_instance", Domain: "5gc",
				Role: "amf", LifecycleState: "active",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "SMF", Exists: true,
				LinkedResourceID: testResource5GC,
			}, nil
		},
	})
	assertCode(t, err, "NF_HEALTH_CANDIDATE_TYPE_MISMATCH")
}

func TestResolveTargetIdentityRejectsMissingCandidate(t *testing.T) {
	_, err := ResolveTargetIdentity(&CreateTargetRequest{
		CandidateID: "55555555-5555-4555-8555-555555555555",
	}, IdentityResolvers{
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{CandidateID: id}, nil
		},
	})
	assertCode(t, err, "NF_HEALTH_TARGET_NOT_FOUND")
}

func TestResolveTargetIdentityCandidateOnlyAdoptsExplicitLink(t *testing.T) {
	resolved, err := ResolveTargetIdentity(&CreateTargetRequest{
		CandidateID: "55555555-5555-4555-8555-555555555555",
	}, IdentityResolvers{
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
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved.ResourceID != testResourceIMS || resolved.NFType != NFTypePCSCF || resolved.Domain != "ims" {
		t.Fatalf("expected deterministic link resolution, got %+v", resolved)
	}
}

func TestResolveTargetIdentityCandidateOnlyWithoutLinkIsTransitional(t *testing.T) {
	resolved, err := ResolveTargetIdentity(&CreateTargetRequest{
		CandidateID: "55555555-5555-4555-8555-555555555555",
	}, IdentityResolvers{
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{CandidateID: id, NFType: "AMF", Exists: true}, nil
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved.ResourceID != "" || resolved.IdentityState != IdentityLegacyUnbound {
		t.Fatalf("expected transitional legacy identity, got %+v", resolved)
	}
}

func TestResolveTargetIdentityCandidateOnlyWithInvalidLinkStaysLegacy(t *testing.T) {
	resolved, err := ResolveTargetIdentity(&CreateTargetRequest{
		CandidateID: "55555555-5555-4555-8555-555555555555",
	}, IdentityResolvers{
		Resource: func(_ context.Context, id string) (*ResourceProjection, error) {
			// Retired resource: the link cannot establish authority.
			return &ResourceProjection{
				ResourceID: id, Kind: "network_function", Domain: "5gc",
				Role: "amf", LifecycleState: "retired",
			}, nil
		},
		Candidate: func(_ context.Context, id string) (*CandidateProjection, error) {
			return &CandidateProjection{
				CandidateID: id, NFType: "AMF", Exists: true,
				LinkedResourceID: testResource5GC,
			}, nil
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved.ResourceID != "" || resolved.IdentityState != IdentityLegacyUnbound {
		t.Fatalf("expected transitional legacy identity, got %+v", resolved)
	}
}

// Group C: process registry.
func TestNFProcessRegistryCoversAllReferenceMappings(t *testing.T) {
	expected := []struct {
		process string
		nfType  string
		domain  string
	}{
		{"amfd", NFTypeAMF, "5gc"}, {"smfd", NFTypeSMF, "5gc"}, {"upfd", NFTypeUPF, "5gc"},
		{"nrfd", NFTypeNRF, "5gc"}, {"ausfd", NFTypeAUSF, "5gc"}, {"udmd", NFTypeUDM, "5gc"},
		{"udrd", NFTypeUDR, "5gc"}, {"pcfd", NFTypePCF, "5gc"}, {"bsfd", NFTypeBSF, "5gc"},
		{"nssfd", NFTypeNSSF, "5gc"}, {"scpd", NFTypeSCP, "5gc"}, {"seppd", NFTypeSEPP, "5gc"},
		{"mmed", NFTypeMME, "epc"}, {"sgwcd", NFTypeSGWC, "epc"}, {"sgwud", NFTypeSGWU, "epc"},
		{"hssd", NFTypeHSS, "epc"}, {"pcrfd", NFTypePCRF, "epc"},
		{"ocsd", NFTypeOCS, "charging"},
		{"pcscfd", NFTypePCSCF, "ims"}, {"scscfd", NFTypeSCSCF, "ims"},
		{"icscfd", NFTypeICSCF, "ims"}, {"smscd", NFTypeSMSC, "ims"},
	}
	if len(expected) != 22 {
		t.Fatalf("reference mapping must declare 22 processes, got %d", len(expected))
	}
	for _, tc := range expected {
		entry, ok := LookupNFProcessIdentity(tc.process)
		if !ok {
			t.Fatalf("process %s missing from registry", tc.process)
		}
		if entry.NFType != tc.nfType {
			t.Fatalf("process %s must map to %s, got %s", tc.process, tc.nfType, entry.NFType)
		}
		if !NFTypePermittedInDomain(entry.NFType, tc.domain) {
			t.Fatalf("process %s must be permitted in domain %s", tc.process, tc.domain)
		}
	}
	if len(nfProcessRegistry) != 22 {
		t.Fatalf("registry must contain exactly 22 entries, got %d", len(nfProcessRegistry))
	}
}

func TestNFProcessRegistryRejectsSuffixAndPrefixVariants(t *testing.T) {
	for _, name := range []string{
		"pcscfd-test", "pcscfd-old", "pcscfd2", "pcscfdd", "mmed-helper",
		"amfd-debug", "amf", "amfd.service", " PCSCFD", "",
	} {
		if _, ok := LookupNFProcessIdentity(name); ok {
			t.Fatalf("process %q must not resolve through the registry", name)
		}
	}
}

func TestNFProcessRegistryRejectsCrossDomainQualification(t *testing.T) {
	// amfd is a 5GC identity; it must not resolve for an EPC resource.
	if _, ok := LookupNFProcessIdentityForDomain("epc", "amfd"); ok {
		t.Fatal("amfd must not resolve for the epc domain")
	}
	if _, ok := LookupNFProcessIdentityForDomain("ims", "mmed"); ok {
		t.Fatal("mmed must not resolve for the ims domain")
	}
	if _, ok := LookupNFProcessIdentityForDomain("ims", "unknown-processd"); ok {
		t.Fatal("unknown process must not resolve")
	}
	if _, ok := LookupNFProcessIdentityForDomain("ims", "pcscfd"); !ok {
		t.Fatal("pcscfd must resolve for the ims domain")
	}
}

func TestResolveNFTypeFromRoleNormalizesExplicitTokens(t *testing.T) {
	for role, want := range map[string]string{
		"amf": NFTypeAMF, "AMF": NFTypeAMF, "p-cscf": NFTypePCSCF,
		"P_CSCF": NFTypePCSCF, "sgw-c": NFTypeSGWC, "sgwc": NFTypeSGWC,
		"icscf": NFTypeICSCF, "smsc": NFTypeSMSC, "ocs": NFTypeOCS,
	} {
		got, ok := ResolveNFTypeFromRole(role)
		if !ok || got != want {
			t.Fatalf("role %q must resolve to %s, got %q (ok=%v)", role, want, got, ok)
		}
	}
	if _, ok := ResolveNFTypeFromRole("gnb"); ok {
		t.Fatal("role gnb must not resolve to an NF type")
	}
}

func TestCompatibleNFTypesSeparatorInsensitive(t *testing.T) {
	if !CompatibleNFTypes("P-CSCF", "pcscf") {
		t.Fatal("P-CSCF and pcscf must be compatible")
	}
	if CompatibleNFTypes("", "amf") || CompatibleNFTypes("amf", "") {
		t.Fatal("empty tokens are never compatible")
	}
	if CompatibleNFTypes("amf", "smf") {
		t.Fatal("distinct NF types are not compatible")
	}
}

func TestProjectIdentityStateMarksLegacyTargetsHonestly(t *testing.T) {
	target := &HealthTarget{CandidateID: "55555555-5555-4555-8555-555555555555"}
	ProjectIdentityState(target)
	if target.IdentityState != IdentityLegacyUnresolved {
		t.Fatalf("expected legacy_unresolved, got %s", target.IdentityState)
	}
	withResource := &HealthTarget{ResourceID: testResourceEPC}
	ProjectIdentityState(withResource)
	if withResource.IdentityState != IdentityInventoryAuthoritative {
		t.Fatalf("expected inventory_authoritative, got %s", withResource.IdentityState)
	}
}

func TestSupportedDomainsReuseInventoryVocabulary(t *testing.T) {
	joined := strings.Join(SupportedResourceDomains, ",")
	for _, domain := range []string{"epc", "5gc", "ims", "charging"} {
		if !strings.Contains(joined, domain) {
			t.Fatalf("supported domains must include %s", domain)
		}
	}
	if strings.Contains(joined, "platform") {
		t.Fatal("platform domain must not be a monitoring-supported domain")
	}
}

func assertCode(t *testing.T, err error, wantCode string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error code %s, got nil", wantCode)
	}
	ve, ok := err.(*ErrValidation)
	if !ok {
		t.Fatalf("expected ErrValidation for %s, got %T", wantCode, err)
	}
	if ve.Code != wantCode {
		t.Fatalf("expected error code %s, got %s", wantCode, ve.Code)
	}
}
