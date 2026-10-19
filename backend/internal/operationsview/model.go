package operationsview

import (
	"subscriber/internal/discovery"
	"subscriber/internal/inventory"
	"subscriber/internal/nfalert"
	"subscriber/internal/nfhealth"
	"subscriber/internal/topology"
)

// Section names accepted by GET /api/operations/summary.
const (
	SectionInventory = "inventory"
	SectionDiscovery = "discovery"
	SectionHealth    = "health"
	SectionAlerts    = "alerts"
	SectionTopology  = "topology"
)

// AllSections is the canonical section order used when the request does not
// restrict the summary.
var AllSections = []string{
	SectionInventory,
	SectionDiscovery,
	SectionHealth,
	SectionAlerts,
	SectionTopology,
}

// Completeness values. `partial` describes a bounded read that is not the whole
// population; it never means "unknown".
const (
	CompletenessComplete    = "complete"
	CompletenessPartial     = "partial"
	CompletenessUnavailable = "unavailable"
)

// Scope values. Every summary count is a full-collection count, never a page
// count, so the scope label is explicit on every section.
const (
	ScopeFullCollection = "full_collection"
)

// Section error codes.
const (
	ErrCodeSectionUnavailable = "SECTION_UNAVAILABLE"
	ErrCodeInvalidSection     = "INVALID_SECTION"
)

// InventorySection is the platform-wide inventory population.
type InventorySection struct {
	Completeness string                   `json:"completeness"`
	Scope        string                   `json:"scope"`
	Error        string                   `json:"error,omitempty"`
	Counts       *inventory.ResourceCounts `json:"counts,omitempty"`
}

// DiscoverySection is the full discovery source and candidate observation
// population.
type DiscoverySection struct {
	Completeness string                       `json:"completeness"`
	Scope        string                       `json:"scope"`
	Error        string                       `json:"error,omitempty"`
	Sources      *int64                       `json:"sources,omitempty"`
	Candidates   *discovery.ObservationSummary `json:"candidates,omitempty"`
}

// HealthSection is the full NF health target population projected with the
// same freshness/overall semantics as the target list.
type HealthSection struct {
	Completeness string                              `json:"completeness"`
	Scope        string                              `json:"scope"`
	Error        string                              `json:"error,omitempty"`
	Targets      *nfhealth.HealthTargetStateSummary   `json:"targets,omitempty"`
}

// AlertsSection is the full alert instance population and rule totals.
type AlertsSection struct {
	Completeness string              `json:"completeness"`
	Scope        string              `json:"scope"`
	Error        string              `json:"error,omitempty"`
	Alerts       *nfalert.AlertSummary `json:"alerts,omitempty"`
}

// TopologySection is the declared-edge population. Declared relationships are
// operator-recorded facts, not connectivity truth.
type TopologySection struct {
	Completeness string               `json:"completeness"`
	Scope        string               `json:"scope"`
	Error        string               `json:"error,omitempty"`
	Edges        *topology.EdgeSummary `json:"edges,omitempty"`
}

// SummaryResponse is the payload of GET /api/operations/summary. Sections the
// request did not ask for are neither queried nor returned.
type SummaryResponse struct {
	GeneratedAt string            `json:"generatedAt"`
	Sections    []string          `json:"sections"`
	Inventory   *InventorySection `json:"inventory,omitempty"`
	Discovery   *DiscoverySection `json:"discovery,omitempty"`
	Health      *HealthSection    `json:"health,omitempty"`
	Alerts      *AlertsSection    `json:"alerts,omitempty"`
	Topology    *TopologySection  `json:"topology,omitempty"`
}
