package topology

import (
	"fmt"
	"strings"

	"subscriber/internal/inventory"
)

// CatalogVersion identifies the controlled interface vocabulary.
const CatalogVersion = "2026-10-23.1"

// MaxInterfaceNames bounds the number of interface names on one edge.
const MaxInterfaceNames = 8

// InterfaceCategory distinguishes a 3GPP reference point from an SBI service.
type InterfaceCategory string

const (
	InterfaceCategoryReferencePoint InterfaceCategory = "reference_point"
	InterfaceCategorySBI            InterfaceCategory = "sbi"
)

// InterfacePlane describes the traffic plane an interface carries.
type InterfacePlane string

const (
	InterfacePlaneControl InterfacePlane = "control"
	InterfacePlaneUser    InterfacePlane = "user"
	InterfacePlaneBoth    InterfacePlane = "both"
)

// InterfaceScope describes whether an interface connects two network functions
// or reaches a non-NF endpoint.
type InterfaceScope string

const (
	InterfaceScopeNFNF     InterfaceScope = "nf_nf"
	InterfaceScopeExternal InterfaceScope = "external"
)

var (
	CanonicalInterfaceCategories = []string{
		string(InterfaceCategoryReferencePoint),
		string(InterfaceCategorySBI),
	}
	CanonicalInterfaceScopes = []string{
		string(InterfaceScopeNFNF),
		string(InterfaceScopeExternal),
	}
	CanonicalInterfacePlanes = []string{
		string(InterfacePlaneControl),
		string(InterfacePlaneUser),
		string(InterfacePlaneBoth),
	}
)

// InterfaceEntry is one controlled interface name. Endpoints and ProducerRole
// are suggestions for the edge form; they are never hard compatibility checks.
type InterfaceEntry struct {
	Name         string            `json:"name"`
	Category     InterfaceCategory `json:"category"`
	Domains      []string          `json:"domains"`
	Plane        InterfacePlane    `json:"plane"`
	Scope        InterfaceScope    `json:"scope"`
	Endpoints    [][]string        `json:"endpoints,omitempty"`
	ProducerRole string            `json:"producerRole,omitempty"`
	Spec         string            `json:"spec"`
	Description  string            `json:"description"`
}

const (
	spec5GCReferencePoint = "3GPP TS 23.501 4.2"
	spec5GCService        = "3GPP TS 23.501 / TS 29.500"
	specN43               = "3GPP TS 23.503"
	specEPCReferencePoint = "3GPP TS 23.401 4.2"
	specEPCCUPS           = "3GPP TS 23.401 CUPS"
	specPCC               = "3GPP TS 23.203"
	specCharging          = "3GPP TS 32.240 / TS 32.299"
	specIMS               = "3GPP TS 23.228 / TS 24.229"
	specCx                = "3GPP TS 29.228 / TS 29.229"
	specRx                = "3GPP TS 29.214"
	specGq                = "3GPP TS 23.228 (legacy PDF)"
)

func interfaceDomains(values ...string) []string {
	return values
}

func referencePoint(name string, domains []string, plane InterfacePlane, spec, description string, endpoints ...[]string) InterfaceEntry {
	return InterfaceEntry{
		Name:        name,
		Category:    InterfaceCategoryReferencePoint,
		Domains:     domains,
		Plane:       plane,
		Scope:       InterfaceScopeNFNF,
		Endpoints:   endpoints,
		Spec:        spec,
		Description: description,
	}
}

func serviceInterface(name, producerRole, spec, description string) InterfaceEntry {
	return InterfaceEntry{
		Name:         name,
		Category:     InterfaceCategorySBI,
		Domains:      interfaceDomains(inventory.Domain5GC),
		Plane:        InterfacePlaneControl,
		Scope:        InterfaceScopeNFNF,
		ProducerRole: producerRole,
		Spec:         spec,
		Description:  description,
	}
}

// InterfaceCatalog is the authoritative v1 vocabulary. Role tokens use the
// compact values stored in Inventory (for example sgwc, pgwc, pcscf).
var InterfaceCatalog = []InterfaceEntry{
	// 5GC reference points (20).
	referencePoint("N4", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "SMF to UPF; PFCP reference point.", []string{"smf", "upf"}),
	referencePoint("N7", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "SMF to PCF policy association.", []string{"smf", "pcf"}),
	referencePoint("N8", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "AMF to UDM.", []string{"amf", "udm"}),
	referencePoint("N9", interfaceDomains(inventory.Domain5GC), InterfacePlaneUser, spec5GCReferencePoint, "UPF to UPF for 5G LAN or ULCL.", []string{"upf", "upf"}),
	referencePoint("N10", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "SMF to UDM.", []string{"smf", "udm"}),
	referencePoint("N11", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "AMF to SMF.", []string{"amf", "smf"}),
	referencePoint("N12", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "AMF to AUSF.", []string{"amf", "ausf"}),
	referencePoint("N13", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "UDM to AUSF.", []string{"udm", "ausf"}),
	referencePoint("N14", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "AMF to AMF.", []string{"amf", "amf"}),
	referencePoint("N15", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "PCF to AMF policy association.", []string{"pcf", "amf"}),
	referencePoint("N16", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "SMF to SMF.", []string{"smf", "smf"}),
	referencePoint("N19", interfaceDomains(inventory.Domain5GC), InterfacePlaneUser, spec5GCReferencePoint, "UPF to UPF for 5G LAN PSA.", []string{"upf", "upf"}),
	referencePoint("N22", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "AMF to NSSF reference point.", []string{"amf", "nssf"}),
	referencePoint("N24", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "Visited PCF to home PCF roaming.", []string{"pcf", "pcf"}),
	referencePoint("N26", interfaceDomains(inventory.Domain5GC, inventory.DomainEPC), InterfacePlaneControl, spec5GCReferencePoint, "AMF to MME interworking between 5GC and EPC.", []string{"amf", "mme"}),
	referencePoint("N27", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "Visited NRF to home NRF roaming.", []string{"nrf", "nrf"}),
	referencePoint("N31", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "Visited NSSF to home NSSF roaming.", []string{"nssf", "nssf"}),
	referencePoint("N35", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "UDM to UDR reference point.", []string{"udm", "udr"}),
	referencePoint("N36", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, spec5GCReferencePoint, "PCF to UDR policy data.", []string{"pcf", "udr"}),
	referencePoint("N43", interfaceDomains(inventory.Domain5GC), InterfacePlaneControl, specN43, "PCF to PCF policy interaction within a PLMN.", []string{"pcf", "pcf"}),

	// 5GC SBI service interfaces (9).
	serviceInterface("Nnrf", "nrf", spec5GCService, "NRF service interface for NF registration and discovery."),
	serviceInterface("Namf", "amf", spec5GCService, "AMF service interface."),
	serviceInterface("Nsmf", "smf", spec5GCService, "SMF service interface."),
	serviceInterface("Nudm", "udm", spec5GCService, "UDM service interface."),
	serviceInterface("Nausf", "ausf", spec5GCService, "AUSF service interface."),
	serviceInterface("Npcf", "pcf", spec5GCService, "PCF service interface."),
	serviceInterface("Nnssf", "nssf", spec5GCService, "NSSF service interface."),
	serviceInterface("Nbsf", "bsf", spec5GCService, "BSF service interface."),
	serviceInterface("Nudr", "udr", spec5GCService, "UDR service interface."),

	// EPC reference points (12).
	referencePoint("S5", interfaceDomains(inventory.DomainEPC), InterfacePlaneBoth, specEPCReferencePoint, "Intra-PLMN SGW to PGW reference point.", []string{"sgwc", "pgwc"}, []string{"sgwu", "pgwu"}),
	referencePoint("S8", interfaceDomains(inventory.DomainEPC), InterfacePlaneBoth, specEPCReferencePoint, "Inter-PLMN SGW to PGW roaming reference point; separate from S5.", []string{"sgwc", "pgwc"}, []string{"sgwu", "pgwu"}),
	referencePoint("S6a", interfaceDomains(inventory.DomainEPC), InterfacePlaneControl, specEPCReferencePoint, "MME to HSS.", []string{"mme", "hss"}),
	referencePoint("S10", interfaceDomains(inventory.DomainEPC), InterfacePlaneControl, specEPCReferencePoint, "MME to MME.", []string{"mme", "mme"}),
	referencePoint("S11", interfaceDomains(inventory.DomainEPC), InterfacePlaneControl, specEPCReferencePoint, "MME to SGW-C.", []string{"mme", "sgwc"}),
	referencePoint("Sxa", interfaceDomains(inventory.DomainEPC), InterfacePlaneControl, specEPCCUPS, "SGW-C to SGW-U.", []string{"sgwc", "sgwu"}),
	referencePoint("Sxb", interfaceDomains(inventory.DomainEPC), InterfacePlaneControl, specEPCCUPS, "PGW-C to PGW-U.", []string{"pgwc", "pgwu"}),
	referencePoint("Gx", interfaceDomains(inventory.DomainEPC, inventory.DomainCharging), InterfacePlaneControl, specPCC, "PCRF to PGW-C PCC policy and charging rules.", []string{"pcrf", "pgwc"}),
	referencePoint("Gy", interfaceDomains(inventory.DomainEPC, inventory.DomainCharging), InterfacePlaneControl, specCharging, "PGW-C to OCS online charging.", []string{"pgwc", "ocs"}),
	referencePoint("Sy", interfaceDomains(inventory.DomainEPC, inventory.DomainCharging), InterfacePlaneControl, specCharging, "PCRF to OCS policy and charging linkage.", []string{"pcrf", "ocs"}),
	referencePoint("Gxc", interfaceDomains(inventory.DomainEPC), InterfacePlaneControl, specPCC, "PCRF to SGW-C for PMIP and BBERF.", []string{"pcrf", "sgwc"}),
	referencePoint("S9", interfaceDomains(inventory.DomainEPC), InterfacePlaneControl, specPCC, "Visited PCRF to home PCRF roaming.", []string{"pcrf", "pcrf"}),

	// IMS reference points (5).
	referencePoint("Mw", interfaceDomains(inventory.DomainIMS), InterfacePlaneControl, specIMS, "SIP reference point between CSCFs.", []string{"pcscf", "icscf"}, []string{"icscf", "scscf"}, []string{"pcscf", "scscf"}),
	referencePoint("Cx", interfaceDomains(inventory.DomainIMS), InterfacePlaneControl, specCx, "Diameter reference point between CSCF and HSS.", []string{"icscf", "hss"}, []string{"scscf", "hss"}),
	referencePoint("Rx", interfaceDomains(inventory.DomainIMS, inventory.DomainEPC), InterfacePlaneControl, specRx, "Diameter policy reference point between P-CSCF and PCRF.", []string{"pcscf", "pcrf"}),
	referencePoint("Gq", interfaceDomains(inventory.DomainIMS), InterfacePlaneControl, specGq, "Legacy PDF policy reference point between P-CSCF and PCRF.", []string{"pcscf", "pcrf"}),
	referencePoint("Ro", interfaceDomains(inventory.DomainIMS, inventory.DomainCharging), InterfacePlaneControl, specCharging, "IMS charging trigger point to OCS; endpoint roles vary by deployment."),
}

var interfaceCatalogByName = func() map[string]InterfaceEntry {
	index := make(map[string]InterfaceEntry, len(InterfaceCatalog))
	for _, entry := range InterfaceCatalog {
		index[entry.Name] = entry
	}
	return index
}()

var canonicalInterfaceRoleTokens = map[string]struct{}{
	"amf": {}, "smf": {}, "upf": {}, "nrf": {}, "nssf": {}, "bsf": {},
	"udm": {}, "udr": {}, "ausf": {}, "pcf": {}, "mme": {}, "sgwc": {},
	"sgwu": {}, "pgwc": {}, "pgwu": {}, "hss": {}, "pcrf": {}, "ocs": {},
	"pcscf": {}, "icscf": {}, "scscf": {},
}

func lookupInterface(name string) (InterfaceEntry, bool) {
	entry, ok := interfaceCatalogByName[name]
	return entry, ok
}

// ValidateInterfaceNames trims and deduplicates names, then requires exact
// membership in the controlled catalog. An empty list means unannotated.
func ValidateInterfaceNames(names []string) ([]string, error) {
	if len(names) == 0 {
		return []string{}, nil
	}
	normalized := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, fmt.Errorf("%w: interface name must not be blank", ErrInvalidInterfaceName)
		}
		if _, ok := interfaceCatalogByName[name]; !ok {
			return nil, fmt.Errorf("%w: unknown interface name %q", ErrInvalidInterfaceName, name)
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		normalized = append(normalized, name)
	}
	if len(normalized) > MaxInterfaceNames {
		return nil, fmt.Errorf("%w: at most %d interface names are allowed", ErrInvalidInterfaceName, MaxInterfaceNames)
	}
	return normalized, nil
}

func normalizeInterfaceNames(names []string) []string {
	if len(names) == 0 {
		return []string{}
	}
	return append([]string{}, names...)
}

// validateInterfaceCatalog is a static integrity check used by tests and kept
// close to the catalog so new entries cannot silently bypass the contract.
func validateInterfaceCatalog() error {
	if strings.TrimSpace(CatalogVersion) == "" {
		return fmt.Errorf("catalogVersion must not be empty")
	}
	if len(InterfaceCatalog) != 46 {
		return fmt.Errorf("interface catalog must contain exactly 46 entries, got %d", len(InterfaceCatalog))
	}
	categories := map[InterfaceCategory]struct{}{
		InterfaceCategoryReferencePoint: {},
		InterfaceCategorySBI:            {},
	}
	planes := map[InterfacePlane]struct{}{
		InterfacePlaneControl: {},
		InterfacePlaneUser:    {},
		InterfacePlaneBoth:    {},
	}
	scopes := map[InterfaceScope]struct{}{
		InterfaceScopeNFNF:     {},
		InterfaceScopeExternal: {},
	}
	domains := map[string]struct{}{
		inventory.Domain5GC:      {},
		inventory.DomainEPC:      {},
		inventory.DomainIMS:      {},
		inventory.DomainCharging: {},
	}
	seen := map[string]struct{}{}
	categoryCounts := map[InterfaceCategory]int{}
	for _, entry := range InterfaceCatalog {
		categoryCounts[entry.Category]++
		if entry.Name == "" || strings.TrimSpace(entry.Name) != entry.Name {
			return fmt.Errorf("interface name %q must be non-empty and trimmed", entry.Name)
		}
		if _, ok := seen[entry.Name]; ok {
			return fmt.Errorf("duplicate interface name %q", entry.Name)
		}
		seen[entry.Name] = struct{}{}
		if _, ok := categories[entry.Category]; !ok {
			return fmt.Errorf("interface %s has invalid category %q", entry.Name, entry.Category)
		}
		if len(entry.Domains) == 0 {
			return fmt.Errorf("interface %s must declare at least one domain", entry.Name)
		}
		for _, domain := range entry.Domains {
			if _, ok := domains[domain]; !ok {
				return fmt.Errorf("interface %s has invalid domain %q", entry.Name, domain)
			}
		}
		if _, ok := planes[entry.Plane]; !ok {
			return fmt.Errorf("interface %s has invalid plane %q", entry.Name, entry.Plane)
		}
		if _, ok := scopes[entry.Scope]; !ok {
			return fmt.Errorf("interface %s has invalid scope %q", entry.Name, entry.Scope)
		}
		if strings.TrimSpace(entry.Spec) == "" {
			return fmt.Errorf("interface %s must declare a 3GPP spec", entry.Name)
		}
		if strings.TrimSpace(entry.Description) == "" {
			return fmt.Errorf("interface %s must declare a description", entry.Name)
		}
		switch entry.Category {
		case InterfaceCategorySBI:
			if entry.ProducerRole == "" {
				return fmt.Errorf("SBI interface %s must declare a producerRole", entry.Name)
			}
			if _, ok := canonicalInterfaceRoleTokens[entry.ProducerRole]; !ok {
				return fmt.Errorf("SBI interface %s has invalid producerRole %q", entry.Name, entry.ProducerRole)
			}
			if len(entry.Endpoints) != 0 {
				return fmt.Errorf("SBI interface %s must not declare fixed endpoints", entry.Name)
			}
		case InterfaceCategoryReferencePoint:
			if entry.ProducerRole != "" {
				return fmt.Errorf("reference point %s must not declare a producerRole", entry.Name)
			}
			for _, pair := range entry.Endpoints {
				if len(pair) != 2 {
					return fmt.Errorf("interface %s endpoint pair must contain exactly two roles", entry.Name)
				}
				for _, role := range pair {
					if _, ok := canonicalInterfaceRoleTokens[role]; !ok {
						return fmt.Errorf("interface %s has invalid endpoint role %q", entry.Name, role)
					}
				}
			}
		}
	}
	if categoryCounts[InterfaceCategoryReferencePoint] != 37 {
		return fmt.Errorf("interface catalog must contain 37 reference points, got %d", categoryCounts[InterfaceCategoryReferencePoint])
	}
	if categoryCounts[InterfaceCategorySBI] != 9 {
		return fmt.Errorf("interface catalog must contain 9 SBI interfaces, got %d", categoryCounts[InterfaceCategorySBI])
	}
	return nil
}
