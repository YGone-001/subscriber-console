package runtimeinv

import (
	"fmt"
	"sort"
	"strings"
)

// Profile identifiers. The compatibility profile is the CNMS 24-component
// recognition set; the effective registry additionally keeps the xCloud-only
// identities that already existed before this phase.
const (
	ProfileCNMSCompat = "cnms_compat"
	ProfileVersion    = 1
)

// Deployment template identifiers. Templates are view and expectation profiles
// only: they never start, stop or reconfigure anything.
const (
	TemplateAuto = "auto"
	Template5G   = "5g"
	Template4G   = "4g"
	TemplateIMS  = "ims"
)

// TemplateIDs is the canonical template order exposed by the meta endpoint.
var TemplateIDs = []string{TemplateAuto, Template5G, Template4G, TemplateIMS}

// Component categories. The category drives grouping and template membership;
// the domain drives the canonical Inventory association.
const (
	Category5GC      = "5gc"
	CategoryEPC      = "epc"
	CategoryIMS      = "ims"
	CategoryCharging = "charging"
	CategorySupport  = "support"
)

// CanonicalCategories is the presentation order of component categories.
var CanonicalCategories = []string{CategoryEPC, Category5GC, CategoryIMS, CategoryCharging, CategorySupport}

// Process matching methods.
const (
	// MatchExactProcess requires /proc/<pid>/comm (or, above the 15-byte comm
	// limit, the verified executable basename) to equal the configured name.
	MatchExactProcess = "exact_process_name"
	// MatchJavaCommandLineIdentity requires a verified java executable plus an
	// approved launch identity in the bounded command-line projection.
	MatchJavaCommandLine = "java_command_line_identity"
)

// Monitoring eligibility. Runtime recognition never implies that a component
// can be adopted as an NF Health target.
const (
	MonitoringSupported    = "supported"
	MonitoringNotSupported = "not_supported"
)

// Component is one entry of the central process-recognition authority.
//
// The registry expresses recognized process identities. It is not a claim that
// a component is installed, running, expected or monitored.
type Component struct {
	// ID is the CNMS compatibility component identifier (for example "amf",
	// "sgwc", "imsHss"). xCloud-only identities use their own stable ids.
	ID string
	// DisplayName is the operator-facing component name.
	DisplayName string
	// ProcessName is the exact Linux process name, or the executable name for
	// command-line matched components.
	ProcessName string
	// ExeAliases lists additional executable basenames this component may run
	// under. Some SIP stacks set a per-role process title while sharing one
	// binary, so the exact-name rule alone can never verify them. An alias only
	// widens the executable check for a component that already matched by
	// process name; it never identifies a process on its own.
	ExeAliases []string
	// MatchMethod selects the identity verification strategy.
	MatchMethod string
	// Category groups the component for presentation and templates.
	Category string
	// Domain is the canonical Inventory network domain.
	Domain string
	// Role is the canonical Inventory role token for a created resource.
	Role string
	// NFTType is the normalized network function type. Support components carry
	// no NF type claim.
	NFTType string
	// Templates lists the deployment templates that include this component.
	Templates []string
	// CNMSCompatible marks the 24 components of the CNMS reference profile.
	CNMSCompatible bool
	// Monitoring is the NF Health eligibility of the component.
	Monitoring string
	// MonitoringReason explains a not_supported decision.
	MonitoringReason string
}

// Registry is the immutable, server-owned recognition authority. Every scanner,
// API projection and status model resolves components through one instance.
type Registry struct {
	components []Component
	byID       map[string]Component
	byProcess  map[string]Component
	java       []Component
}

// NewRegistry validates and indexes a component set. Duplicate identifiers and
// duplicate exact process names are rejected so no component can shadow
// another.
func NewRegistry(components []Component) (*Registry, error) {
	registry := &Registry{
		components: make([]Component, 0, len(components)),
		byID:       make(map[string]Component, len(components)),
		byProcess:  make(map[string]Component, len(components)),
	}
	for _, component := range components {
		component = normalizeComponent(component)
		if component.ID == "" || component.ProcessName == "" {
			return nil, fmt.Errorf("runtimeinv: component id and process name are required")
		}
		if _, exists := registry.byID[component.ID]; exists {
			return nil, fmt.Errorf("runtimeinv: duplicate component id %q", component.ID)
		}
		if component.MatchMethod == MatchExactProcess {
			if _, exists := registry.byProcess[component.ProcessName]; exists {
				return nil, fmt.Errorf("runtimeinv: duplicate exact process name %q", component.ProcessName)
			}
			registry.byProcess[component.ProcessName] = component
		} else if component.MatchMethod == MatchJavaCommandLine {
			registry.java = append(registry.java, component)
		} else {
			return nil, fmt.Errorf("runtimeinv: unsupported match method %q", component.MatchMethod)
		}
		registry.byID[component.ID] = component
		registry.components = append(registry.components, component)
	}
	for _, component := range registry.components {
		for _, alias := range component.ExeAliases {
			if owner, exists := registry.byProcess[alias]; exists && owner.ID != component.ID {
				return nil, fmt.Errorf("runtimeinv: alias %q of %s collides with the exact process name of %s", alias, component.ID, owner.ID)
			}
		}
	}
	sort.SliceStable(registry.components, func(i, j int) bool {
		return registry.components[i].ID < registry.components[j].ID
	})
	return registry, nil
}

// normalizeAliases trims an alias list and drops blanks plus anything that would
// repeat the component's own exact process name.
func normalizeAliases(aliases []string, processName string) []string {
	if len(aliases) == 0 {
		return nil
	}
	out := make([]string, 0, len(aliases))
	seen := map[string]struct{}{}
	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		if alias == "" || alias == processName {
			continue
		}
		if _, ok := seen[alias]; ok {
			continue
		}
		seen[alias] = struct{}{}
		out = append(out, alias)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// MatchesExecutable reports whether an executable basename identifies the
// component, either as its own process name or as one of its approved aliases.
func (c Component) MatchesExecutable(exeName string) bool {
	exeName = strings.TrimSpace(exeName)
	if exeName == "" {
		return false
	}
	if exeName == c.ProcessName {
		return true
	}
	for _, alias := range c.ExeAliases {
		if alias == exeName {
			return true
		}
	}
	return false
}

func normalizeComponent(component Component) Component {
	component.ID = strings.TrimSpace(component.ID)
	component.DisplayName = strings.TrimSpace(component.DisplayName)
	component.ProcessName = strings.TrimSpace(component.ProcessName)
	component.ExeAliases = normalizeAliases(component.ExeAliases, component.ProcessName)
	component.MatchMethod = strings.TrimSpace(component.MatchMethod)
	component.Category = strings.TrimSpace(component.Category)
	component.Domain = strings.TrimSpace(component.Domain)
	component.Role = strings.TrimSpace(component.Role)
	component.NFTType = strings.TrimSpace(component.NFTType)
	component.Monitoring = strings.TrimSpace(component.Monitoring)
	component.MonitoringReason = strings.TrimSpace(component.MonitoringReason)
	if component.MatchMethod == "" {
		component.MatchMethod = MatchExactProcess
	}
	if component.Monitoring == "" {
		component.Monitoring = MonitoringNotSupported
	}
	templates := make([]string, 0, len(component.Templates))
	seen := map[string]struct{}{}
	for _, template := range component.Templates {
		template = strings.TrimSpace(template)
		if template == "" {
			continue
		}
		if _, ok := seen[template]; ok {
			continue
		}
		seen[template] = struct{}{}
		templates = append(templates, template)
	}
	sort.Strings(templates)
	component.Templates = templates
	return component
}

// Components returns the registry entries in stable identifier order.
func (r *Registry) Components() []Component {
	if r == nil {
		return nil
	}
	out := make([]Component, len(r.components))
	copy(out, r.components)
	return out
}

// Lookup resolves one component by identifier.
func (r *Registry) Lookup(id string) (Component, bool) {
	if r == nil {
		return Component{}, false
	}
	component, ok := r.byID[strings.TrimSpace(id)]
	return component, ok
}

// LookupProcess resolves an exact process name to its component.
func (r *Registry) LookupProcess(processName string) (Component, bool) {
	if r == nil {
		return Component{}, false
	}
	component, ok := r.byProcess[strings.TrimSpace(processName)]
	return component, ok
}

// CommandLineComponents returns the components matched through the bounded
// command-line identity strategy.
func (r *Registry) CommandLineComponents() []Component {
	if r == nil {
		return nil
	}
	out := make([]Component, len(r.java))
	copy(out, r.java)
	return out
}

// ExactProcessNames returns the approved exact process names in stable order.
func (r *Registry) ExactProcessNames() []string {
	if r == nil {
		return nil
	}
	names := make([]string, 0, len(r.byProcess))
	for name := range r.byProcess {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// MonitoredProcessNames returns the process identities of components that are
// eligible for NF Health adoption.
//
// Only components whose process identity can become a monitoring target are
// returned, so a support component or a command-line matched component never
// enters the local inspection allowlist as a side effect of recognition.
func (r *Registry) MonitoredProcessNames() []string {
	if r == nil {
		return nil
	}
	names := make([]string, 0, len(r.components))
	for _, component := range r.components {
		if component.Monitoring != MonitoringSupported {
			continue
		}
		if component.MatchMethod != MatchExactProcess {
			continue
		}
		names = append(names, component.ProcessName)
	}
	sort.Strings(names)
	return names
}

// Counts summarizes registry coverage.
type Counts struct {
	// CNMSComponents is the number of CNMS-compatible component definitions.
	CNMSComponents int `json:"cnmsComponents"`
	// XCloudOnlyComponents is the number of additive xCloud-only identities.
	XCloudOnlyComponents int `json:"xCloudOnlyComponents"`
	// EffectiveEntries is the total recognition entry count.
	EffectiveEntries int `json:"effectiveEntries"`
	// ByCategory maps each category to its entry count.
	ByCategory map[string]int `json:"byCategory"`
	// MonitoringSupported is the number of components eligible for NF Health
	// adoption; MonitoringNotSupported is the remainder.
	MonitoringSupported    int `json:"monitoringSupported"`
	MonitoringNotSupported int `json:"monitoringNotSupported"`
}

// Counts derives coverage counts from the registry itself. No total is
// hardcoded: the numbers always describe the registry that is actually loaded.
func (r *Registry) Counts() Counts {
	counts := Counts{ByCategory: map[string]int{}}
	if r == nil {
		return counts
	}
	for _, component := range r.components {
		if component.CNMSCompatible {
			counts.CNMSComponents++
		} else {
			counts.XCloudOnlyComponents++
		}
		counts.ByCategory[component.Category]++
		if component.Monitoring == MonitoringSupported {
			counts.MonitoringSupported++
		} else {
			counts.MonitoringNotSupported++
		}
	}
	counts.EffectiveEntries = len(r.components)
	return counts
}

// InTemplate reports whether a component belongs to a deployment template.
// Unknown templates match nothing.
func InTemplate(component Component, template string) bool {
	template = strings.TrimSpace(template)
	for _, candidate := range component.Templates {
		if candidate == template {
			return true
		}
	}
	return false
}

// FilterTemplate returns the components included by a template in stable order.
func (r *Registry) FilterTemplate(template string) []Component {
	if r == nil {
		return nil
	}
	if strings.TrimSpace(template) == "" || strings.TrimSpace(template) == TemplateAuto {
		return r.Components()
	}
	out := make([]Component, 0, len(r.components))
	for _, component := range r.components {
		if InTemplate(component, template) {
			out = append(out, component)
		}
	}
	return out
}

// ValidTemplate reports whether a template identifier is canonical.
func ValidTemplate(template string) bool {
	for _, candidate := range TemplateIDs {
		if candidate == template {
			return true
		}
	}
	return false
}

// DefaultComponents is the mandatory primary recognition profile.
//
// Source of truth: the CNMS getAllComponents() registry (24 components across
// 5GC, EPC, IMS, charging and support) plus the two xCloud-only identities that
// already existed in the xCloud NF process registry and must be preserved:
// seppd (5GC SEPP) and smscd (IMS SMSC).
//
// IMS HSS is a java process, not a literal executable named "imsHss". It is
// matched through the bounded command-line identity strategy and is never
// classified as an EPC HSS instance.
func DefaultComponents() []Component {
	return []Component{
		// -- 5GC (11) --
		{ID: "amf", DisplayName: "AMF", ProcessName: "amfd", Category: Category5GC, Domain: "5gc", Role: "amf", NFTType: "AMF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "ausf", DisplayName: "AUSF", ProcessName: "ausfd", Category: Category5GC, Domain: "5gc", Role: "ausf", NFTType: "AUSF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "nssf", DisplayName: "NSSF", ProcessName: "nssfd", Category: Category5GC, Domain: "5gc", Role: "nssf", NFTType: "NSSF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "nrf", DisplayName: "NRF", ProcessName: "nrfd", Category: Category5GC, Domain: "5gc", Role: "nrf", NFTType: "NRF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "smf", DisplayName: "SMF", ProcessName: "smfd", Category: Category5GC, Domain: "5gc", Role: "smf", NFTType: "SMF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "upf", DisplayName: "UPF", ProcessName: "upfd", Category: Category5GC, Domain: "5gc", Role: "upf", NFTType: "UPF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "pcf", DisplayName: "PCF", ProcessName: "pcfd", Category: Category5GC, Domain: "5gc", Role: "pcf", NFTType: "PCF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "udm", DisplayName: "UDM", ProcessName: "udmd", Category: Category5GC, Domain: "5gc", Role: "udm", NFTType: "UDM", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "udr", DisplayName: "UDR", ProcessName: "udrd", Category: Category5GC, Domain: "5gc", Role: "udr", NFTType: "UDR", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "bsf", DisplayName: "BSF", ProcessName: "bsfd", Category: Category5GC, Domain: "5gc", Role: "bsf", NFTType: "BSF", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "scp", DisplayName: "SCP", ProcessName: "scpd", Category: Category5GC, Domain: "5gc", Role: "scp", NFTType: "SCP", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: true, Monitoring: MonitoringSupported},

		// -- EPC (7) --
		{ID: "mme", DisplayName: "MME", ProcessName: "mmed", Category: CategoryEPC, Domain: "epc", Role: "mme", NFTType: "MME", Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "hss", DisplayName: "HSS", ProcessName: "hssd", Category: CategoryEPC, Domain: "epc", Role: "hss", NFTType: "HSS", Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "sgwc", DisplayName: "SGW-C", ProcessName: "sgwcd", Category: CategoryEPC, Domain: "epc", Role: "sgwc", NFTType: "SGW-C", Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "sgwu", DisplayName: "SGW-U", ProcessName: "sgwud", Category: CategoryEPC, Domain: "epc", Role: "sgwu", NFTType: "SGW-U", Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "pgwc", DisplayName: "PGW-C", ProcessName: "pgwcd", Category: CategoryEPC, Domain: "epc", Role: "pgwc", NFTType: "PGW-C", Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "pgwu", DisplayName: "PGW-U", ProcessName: "pgwud", Category: CategoryEPC, Domain: "epc", Role: "pgwu", NFTType: "PGW-U", Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "pcrf", DisplayName: "PCRF", ProcessName: "pcrfd", Category: CategoryEPC, Domain: "epc", Role: "pcrf", NFTType: "PCRF", Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true, Monitoring: MonitoringSupported},

		// -- IMS (4) --
		{ID: "pcscf", DisplayName: "P-CSCF", ProcessName: "pcscfd", ExeAliases: []string{"kamailio"}, Category: CategoryIMS, Domain: "ims", Role: "pcscf", NFTType: "P-CSCF", Templates: []string{TemplateAuto, Template5G, Template4G, TemplateIMS}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "icscf", DisplayName: "I-CSCF", ProcessName: "icscfd", ExeAliases: []string{"kamailio"}, Category: CategoryIMS, Domain: "ims", Role: "icscf", NFTType: "I-CSCF", Templates: []string{TemplateAuto, Template5G, Template4G, TemplateIMS}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{ID: "scscf", DisplayName: "S-CSCF", ProcessName: "scscfd", Category: CategoryIMS, Domain: "ims", Role: "scscf", NFTType: "S-CSCF", Templates: []string{TemplateAuto, Template5G, Template4G, TemplateIMS}, CNMSCompatible: true, Monitoring: MonitoringSupported},
		{
			ID: "imsHss", DisplayName: "IMS HSS", ProcessName: "java",
			MatchMethod: MatchJavaCommandLine, Category: CategoryIMS, Domain: "ims", Role: "hss", NFTType: "HSS",
			Templates: []string{TemplateAuto, Template5G, Template4G, TemplateIMS}, CNMSCompatible: true,
			Monitoring:       MonitoringNotSupported,
			MonitoringReason: "ambiguous_java_identity_and_domain_role_contract",
		},

		// -- Charging (1) --
		{ID: "ocs", DisplayName: "OCS", ProcessName: "ocsd", Category: CategoryCharging, Domain: "charging", Role: "ocs", NFTType: "OCS", Templates: []string{TemplateAuto}, CNMSCompatible: true, Monitoring: MonitoringSupported},

		// -- Support (1) --
		{
			ID: "dra", DisplayName: "DRA", ProcessName: "drad", Category: CategorySupport, Domain: "shared", Role: "dra", NFTType: "",
			Templates: []string{TemplateAuto, Template4G}, CNMSCompatible: true,
			Monitoring:       MonitoringNotSupported,
			MonitoringReason: "support_component_not_a_monitorable_network_function",
		},

		// -- xCloud-only identities preserved from the existing registry (2) --
		{ID: "sepp", DisplayName: "SEPP", ProcessName: "seppd", Category: Category5GC, Domain: "5gc", Role: "sepp", NFTType: "SEPP", Templates: []string{TemplateAuto, Template5G}, CNMSCompatible: false, Monitoring: MonitoringSupported},
		{ID: "smsc", DisplayName: "SMSC", ProcessName: "smscd", Category: CategoryIMS, Domain: "ims", Role: "smsc", NFTType: "SMSC", Templates: []string{TemplateAuto, Template4G, TemplateIMS}, CNMSCompatible: false, Monitoring: MonitoringSupported},
	}
}

// DefaultRegistry builds the server-owned registry. It panics only on a
// programming error in the compile-time definition above.
func DefaultRegistry() *Registry {
	registry, err := NewRegistry(DefaultComponents())
	if err != nil {
		panic("runtimeinv: invalid default component registry: " + err.Error())
	}
	return registry
}
