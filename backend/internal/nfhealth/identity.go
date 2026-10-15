package nfhealth

import (
	"context"
	"strings"

	"subscriber/internal/inventory"
)

// Canonical network function types. The registry below maps known process
// identities to these normalized types. NF type is never inferred by
// transforming a process name.
const (
	NFTypeAMF   = "AMF"
	NFTypeSMF   = "SMF"
	NFTypeUPF   = "UPF"
	NFTypeNRF   = "NRF"
	NFTypeAUSF  = "AUSF"
	NFTypeUDM   = "UDM"
	NFTypeUDR   = "UDR"
	NFTypePCF   = "PCF"
	NFTypeBSF   = "BSF"
	NFTypeNSSF  = "NSSF"
	NFTypeSCP   = "SCP"
	NFTypeSEPP  = "SEPP"
	NFTypeMME   = "MME"
	NFTypeSGWC  = "SGW-C"
	NFTypeSGWU  = "SGW-U"
	NFTypeHSS   = "HSS"
	NFTypePCRF  = "PCRF"
	NFTypeOCS   = "OCS"
	NFTypePCSCF = "P-CSCF"
	NFTypeSCSCF = "S-CSCF"
	NFTypeICSCF = "I-CSCF"
	NFTypeSMSC  = "SMSC"
)

// CanonicalNFTypes lists every normalized NF type in the registry.
var CanonicalNFTypes = []string{
	NFTypeAMF, NFTypeSMF, NFTypeUPF, NFTypeNRF, NFTypeAUSF, NFTypeUDM,
	NFTypeUDR, NFTypePCF, NFTypeBSF, NFTypeNSSF, NFTypeSCP, NFTypeSEPP,
	NFTypeMME, NFTypeSGWC, NFTypeSGWU, NFTypeHSS, NFTypePCRF, NFTypeOCS,
	NFTypePCSCF, NFTypeSCSCF, NFTypeICSCF, NFTypeSMSC,
}

// SupportedResourceDomains are the canonical Inventory network domains a
// resource-native NF Health target may reference. The values reuse the
// authoritative Inventory domain vocabulary directly; NF Health never declares
// a competing set of network-domain constants.
var SupportedResourceDomains = []string{
	inventory.DomainEPC,
	inventory.Domain5GC,
	inventory.DomainIMS,
	inventory.DomainCharging,
}

// MonitoredResourceKinds are the Inventory resource kinds eligible for
// monitoring association.
var MonitoredResourceKinds = []string{
	inventory.KindNetworkFunction,
	inventory.KindNetworkFunctionInstance,
}

// NFProcessIdentity maps one approved local process identity to a normalized
// network function type and the canonical network domains that permit it.
//
// The registry expresses recognized process identities, not claims that every
// process is installed, currently running, or exporting metrics. Domain
// qualification is explicit so a process name reused across network domains
// can never silently change the resolved NF type.
type NFProcessIdentity struct {
	// ProcessName is the exact /proc/<pid>/comm identity.
	ProcessName string
	// NFType is the canonical normalized network function type.
	NFType string
	// Domains lists the canonical Inventory domains that permit this NF type.
	Domains []string
}

// nfProcessRegistry is the bounded, server-owned process-to-NF mapping.
// Total reference mapping: 22 processes across 5GC, EPC, charging and IMS.
var nfProcessRegistry = []NFProcessIdentity{
	// 5GC (12 processes).
	{ProcessName: "amfd", NFType: NFTypeAMF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "smfd", NFType: NFTypeSMF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "upfd", NFType: NFTypeUPF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "nrfd", NFType: NFTypeNRF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "ausfd", NFType: NFTypeAUSF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "udmd", NFType: NFTypeUDM, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "udrd", NFType: NFTypeUDR, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "pcfd", NFType: NFTypePCF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "bsfd", NFType: NFTypeBSF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "nssfd", NFType: NFTypeNSSF, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "scpd", NFType: NFTypeSCP, Domains: []string{inventory.Domain5GC}},
	{ProcessName: "seppd", NFType: NFTypeSEPP, Domains: []string{inventory.Domain5GC}},
	// EPC (5 processes).
	{ProcessName: "mmed", NFType: NFTypeMME, Domains: []string{inventory.DomainEPC}},
	{ProcessName: "sgwcd", NFType: NFTypeSGWC, Domains: []string{inventory.DomainEPC}},
	{ProcessName: "sgwud", NFType: NFTypeSGWU, Domains: []string{inventory.DomainEPC}},
	{ProcessName: "hssd", NFType: NFTypeHSS, Domains: []string{inventory.DomainEPC}},
	{ProcessName: "pcrfd", NFType: NFTypePCRF, Domains: []string{inventory.DomainEPC}},
	// Charging (1 process). OCS belongs to the canonical charging domain.
	{ProcessName: "ocsd", NFType: NFTypeOCS, Domains: []string{inventory.DomainCharging}},
	// IMS (4 processes).
	{ProcessName: "pcscfd", NFType: NFTypePCSCF, Domains: []string{inventory.DomainIMS}},
	{ProcessName: "scscfd", NFType: NFTypeSCSCF, Domains: []string{inventory.DomainIMS}},
	{ProcessName: "icscfd", NFType: NFTypeICSCF, Domains: []string{inventory.DomainIMS}},
	{ProcessName: "smscd", NFType: NFTypeSMSC, Domains: []string{inventory.DomainIMS}},
}

// normalizeNFToken lowercases a type token and strips separators so that
// "P-CSCF", "p_cscf" and "pcscf" compare equal. It never derives a type from
// an arbitrary string; it only canonicalizes an explicitly configured token.
func normalizeNFToken(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch r {
		case '-', '_', ' ', '.':
			continue
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// roleToNFType maps normalized Inventory role tokens to canonical NF types.
// The Inventory role field keeps its existing free-form meaning; this map only
// recognizes the explicit NF role vocabulary. Unknown roles are rejected
// instead of being guessed from display names, executable suffixes or vendors.
var roleToNFType = map[string]string{
	"amf": NFTypeAMF, "smf": NFTypeSMF, "upf": NFTypeUPF, "nrf": NFTypeNRF,
	"ausf": NFTypeAUSF, "udm": NFTypeUDM, "udr": NFTypeUDR, "pcf": NFTypePCF,
	"bsf": NFTypeBSF, "nssf": NFTypeNSSF, "scp": NFTypeSCP, "sepp": NFTypeSEPP,
	"mme": NFTypeMME, "sgwc": NFTypeSGWC, "sgwu": NFTypeSGWU, "hss": NFTypeHSS,
	"pcrf": NFTypePCRF, "ocs": NFTypeOCS,
	"pcscf": NFTypePCSCF, "scscf": NFTypeSCSCF, "icscf": NFTypeICSCF,
	"smsc": NFTypeSMSC,
}

// ResolveNFTypeFromRole resolves the canonical NF type from an explicit
// Inventory role token. It reports false when the role is absent or is not an
// explicitly recognized NF role.
func ResolveNFTypeFromRole(role string) (string, bool) {
	key := normalizeNFToken(role)
	if key == "" {
		return "", false
	}
	nfType, ok := roleToNFType[key]
	return nfType, ok
}

// LookupNFProcessIdentity resolves the exact approved process identity.
// Prefix or suffix variants never match.
func LookupNFProcessIdentity(processName string) (NFProcessIdentity, bool) {
	name := strings.TrimSpace(processName)
	for _, entry := range nfProcessRegistry {
		if entry.ProcessName == name {
			return entry, true
		}
	}
	return NFProcessIdentity{}, false
}

// LookupNFProcessIdentityForDomain resolves an approved process identity and
// verifies the resulting NF type is permitted in the canonical domain.
func LookupNFProcessIdentityForDomain(domain, processName string) (NFProcessIdentity, bool) {
	entry, ok := LookupNFProcessIdentity(processName)
	if !ok {
		return NFProcessIdentity{}, false
	}
	if !NFTypePermittedInDomain(entry.NFType, domain) {
		return NFProcessIdentity{}, false
	}
	return entry, true
}

// NFTypePermittedInDomain reports whether a canonical NF type is permitted in
// a canonical Inventory network domain.
func NFTypePermittedInDomain(nfType, domain string) bool {
	for _, entry := range nfProcessRegistry {
		if entry.NFType != nfType {
			continue
		}
		for _, d := range entry.Domains {
			if d == domain {
				return true
			}
		}
	}
	return false
}

// CompatibleNFTypes reports whether two NF type tokens denote the same
// canonical network function type. Comparison is separator-insensitive so a
// Discovery candidate nfType of "P-CSCF" matches the canonical type "P-CSCF".
func CompatibleNFTypes(a, b string) bool {
	na, nb := normalizeNFToken(a), normalizeNFToken(b)
	if na == "" || nb == "" {
		return false
	}
	return na == nb
}

// ResourceProjection is the read-only Inventory view NF Health consumes.
// NF Health never writes Inventory documents through this projection.
type ResourceProjection struct {
	ResourceID     string
	Kind           string
	Domain         string
	Role           string
	LifecycleState string
}

// CandidateProjection is the read-only Discovery view NF Health consumes.
// NF Health never creates, links, unlinks or mutates Discovery candidates.
type CandidateProjection struct {
	CandidateID      string
	NFType           string
	LinkedResourceID string
	Exists           bool
}

// ResolvedIdentity is the server-derived identity projection for one target.
type ResolvedIdentity struct {
	ResourceID    string
	CandidateID   string
	Domain        string
	NFType        string
	IdentityState string
}

// IdentityResolvers provides the read-only Inventory and Discovery lookups.
// A missing resolver fails closed when its reference is actually requested.
type IdentityResolvers struct {
	Resource  func(ctx context.Context, resourceID string) (*ResourceProjection, error)
	Candidate func(ctx context.Context, candidateID string) (*CandidateProjection, error)
}

// ResolveTargetIdentity derives the authoritative identity for a create
// request. Rules:
//   - resourceId, when supplied, must reference an existing, non-retired
//     Inventory resource of a monitored kind in a supported domain.
//   - domain and NF type derive from validated Inventory metadata only.
//   - candidateId, when supplied, must exist; when both identifiers are
//     supplied the candidate must be explicitly linked to the same resource
//     and its observed NF type must be compatible.
//   - candidate-only requests adopt the candidate link when it resolves to a
//     valid resource; otherwise they are transitional legacy_unbound targets.
func ResolveTargetIdentity(req *CreateTargetRequest, resolvers IdentityResolvers) (*ResolvedIdentity, error) {
	if req == nil {
		return nil, validationError("INVALID_TARGET", "target request is required")
	}
	resourceID := strings.TrimSpace(req.ResourceID)
	candidateID := strings.TrimSpace(req.CandidateID)
	if resourceID == "" && candidateID == "" {
		return nil, validationError("INVALID_TARGET", "resourceId or candidateId is required")
	}
	if resourceID != "" {
		if err := ValidateUUIDv4(resourceID); err != nil {
			return nil, err
		}
	}
	if candidateID != "" {
		if err := ValidateUUIDv4(candidateID); err != nil {
			return nil, err
		}
	}

	resolved := &ResolvedIdentity{ResourceID: resourceID, CandidateID: candidateID}

	if resourceID != "" {
		if resolvers.Resource == nil {
			return nil, validationError("NF_HEALTH_RESOURCE_UNAVAILABLE", "inventory resolution is unavailable")
		}
		resource, err := resolvers.Resource(context.Background(), resourceID)
		if err != nil {
			return nil, err
		}
		if resource == nil {
			return nil, validationError("NF_HEALTH_RESOURCE_NOT_FOUND", "inventory resource not found")
		}
		if !isMonitoredResourceKind(resource.Kind) {
			return nil, validationError("NF_HEALTH_RESOURCE_KIND_UNSUPPORTED", "inventory resource kind does not support monitoring association")
		}
		if resource.LifecycleState == inventory.LifecycleRetired {
			return nil, validationError("NF_HEALTH_RESOURCE_RETIRED", "inventory resource is retired")
		}
		if !isSupportedResourceDomain(resource.Domain) {
			return nil, validationError("NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED", "inventory resource domain does not support monitoring association")
		}
		nfType, ok := ResolveNFTypeFromRole(resource.Role)
		if !ok {
			return nil, validationError("NF_HEALTH_NF_TYPE_UNRESOLVED", "inventory resource role must declare an explicit supported network function type")
		}
		if !NFTypePermittedInDomain(nfType, resource.Domain) {
			return nil, validationError("NF_HEALTH_DOMAIN_TYPE_MISMATCH", "resolved network function type is not valid for the inventory resource domain")
		}
		resolved.Domain = resource.Domain
		resolved.NFType = nfType
		resolved.IdentityState = IdentityInventoryAuthoritative
	}

	if candidateID != "" {
		if resolvers.Candidate == nil {
			return nil, validationError("NF_HEALTH_CANDIDATE_UNAVAILABLE", "discovery candidate resolution is unavailable")
		}
		candidate, err := resolvers.Candidate(context.Background(), candidateID)
		if err != nil {
			return nil, err
		}
		if candidate == nil || !candidate.Exists {
			return nil, validationError("NF_HEALTH_TARGET_NOT_FOUND", "Discovery candidate not found")
		}
		if resourceID != "" {
			if strings.TrimSpace(candidate.LinkedResourceID) != resourceID {
				return nil, validationError("NF_HEALTH_CANDIDATE_RESOURCE_MISMATCH", "Discovery candidate is not linked to the requested Inventory resource")
			}
			if resolved.NFType != "" && !CompatibleNFTypes(candidate.NFType, resolved.NFType) {
				return nil, validationError("NF_HEALTH_CANDIDATE_TYPE_MISMATCH", "Discovery candidate network function type does not match the Inventory resource")
			}
		} else if linked := strings.TrimSpace(candidate.LinkedResourceID); linked != "" {
			// Deterministic resolution through the explicit Discovery link.
			// Never a name-, address- or type-based guess.
			if resolvers.Resource == nil {
				return nil, validationError("NF_HEALTH_RESOURCE_UNAVAILABLE", "inventory resolution is unavailable")
			}
			resource, rerr := resolvers.Resource(context.Background(), linked)
			if rerr != nil {
				return nil, rerr
			}
			if resource == nil || !isMonitoredResourceKind(resource.Kind) ||
				resource.LifecycleState == inventory.LifecycleRetired ||
				!isSupportedResourceDomain(resource.Domain) {
				resolved.IdentityState = IdentityLegacyUnbound
				return resolved, nil
			}
			nfType, ok := ResolveNFTypeFromRole(resource.Role)
			if !ok || !NFTypePermittedInDomain(nfType, resource.Domain) {
				resolved.IdentityState = IdentityLegacyUnbound
				return resolved, nil
			}
			resolved.ResourceID = linked
			resolved.Domain = resource.Domain
			resolved.NFType = nfType
			resolved.IdentityState = IdentityInventoryAuthoritative
		} else {
			resolved.IdentityState = IdentityLegacyUnbound
		}
	}

	return resolved, nil
}

func isMonitoredResourceKind(kind string) bool {
	for _, k := range MonitoredResourceKinds {
		if k == kind {
			return true
		}
	}
	return false
}

func isSupportedResourceDomain(domain string) bool {
	for _, d := range SupportedResourceDomains {
		if d == domain {
			return true
		}
	}
	return false
}

// ProjectIdentityState fills the read-time identity state for targets stored
// before the unified identity foundation. Absent resource identity is
// presented honestly instead of being hidden.
func ProjectIdentityState(target *HealthTarget) {
	if target == nil || target.IdentityState != "" {
		return
	}
	if target.ResourceID != "" {
		target.IdentityState = IdentityInventoryAuthoritative
		return
	}
	if target.CandidateID != "" {
		target.IdentityState = IdentityLegacyUnresolved
	}
}
