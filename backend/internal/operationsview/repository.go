package operationsview

import (
	"context"
	"time"

	"subscriber/internal/discovery"
	"subscriber/internal/inventory"
	"subscriber/internal/nfalert"
	"subscriber/internal/nfhealth"
	"subscriber/internal/topology"
)

// InventoryStats is the inventory statistics surface consumed by the summary.
type InventoryStats interface {
	ResourceCounts(ctx context.Context) (inventory.ResourceCounts, error)
}

// DiscoveryStats is the discovery statistics surface consumed by the summary.
// CountSources keeps its existing repository signature (int).
type DiscoveryStats interface {
	CountSources(ctx context.Context) (int, error)
	ObservationSummary(ctx context.Context) (discovery.ObservationSummary, error)
}

// HealthStats is the NF health statistics surface consumed by the summary.
type HealthStats interface {
	HealthTargetStateSummary(ctx context.Context, now time.Time) (nfhealth.HealthTargetStateSummary, error)
}

// AlertStats is the NF alert statistics surface consumed by the summary.
type AlertStats interface {
	AlertSummary(ctx context.Context) (nfalert.AlertSummary, error)
}

// TopologyStats is the topology statistics surface consumed by the summary.
type TopologyStats interface {
	EdgeSummary(ctx context.Context) (topology.EdgeSummary, error)
}

// Service aggregates per-domain full-collection statistics into the
// operations summary. Each section is independent: one failing source marks
// only its own section unavailable and never fails the whole response.
type Service struct {
	inventory InventoryStats
	discovery DiscoveryStats
	health    HealthStats
	alerts    AlertStats
	topology  TopologyStats
	now       func() time.Time
}

// NewService constructs the summary aggregator.
func NewService(inv InventoryStats, disc DiscoveryStats, health HealthStats, alerts AlertStats, topo TopologyStats, now func() time.Time) *Service {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{
		inventory: inv,
		discovery: disc,
		health:    health,
		alerts:    alerts,
		topology:  topo,
		now:       now,
	}
}

// Build computes the requested sections. Unrequested sections are never
// queried; a section source error degrades only that section.
func (s *Service) Build(ctx context.Context, sections []string) SummaryResponse {
	resp := SummaryResponse{
		GeneratedAt: s.now().UTC().Format(time.RFC3339Nano),
		Sections:    sections,
	}
	for _, section := range sections {
		switch section {
		case SectionInventory:
			resp.Inventory = s.buildInventory(ctx)
		case SectionDiscovery:
			resp.Discovery = s.buildDiscovery(ctx)
		case SectionHealth:
			resp.Health = s.buildHealth(ctx)
		case SectionAlerts:
			resp.Alerts = s.buildAlerts(ctx)
		case SectionTopology:
			resp.Topology = s.buildTopology(ctx)
		}
	}
	return resp
}

func (s *Service) buildInventory(ctx context.Context) *InventorySection {
	section := &InventorySection{
		Completeness: CompletenessComplete,
		Scope:        ScopeFullCollection,
	}
	counts, err := s.inventory.ResourceCounts(ctx)
	if err != nil {
		section.Completeness = CompletenessUnavailable
		section.Error = ErrCodeSectionUnavailable
		return section
	}
	section.Counts = &counts
	return section
}

func (s *Service) buildDiscovery(ctx context.Context) *DiscoverySection {
	section := &DiscoverySection{
		Completeness: CompletenessComplete,
		Scope:        ScopeFullCollection,
	}
	sources, err := s.discovery.CountSources(ctx)
	if err != nil {
		section.Completeness = CompletenessUnavailable
		section.Error = ErrCodeSectionUnavailable
		return section
	}
	candidates, err := s.discovery.ObservationSummary(ctx)
	if err != nil {
		section.Completeness = CompletenessUnavailable
		section.Error = ErrCodeSectionUnavailable
		return section
	}
	sources64 := int64(sources)
	section.Sources = &sources64
	section.Candidates = &candidates
	return section
}

func (s *Service) buildHealth(ctx context.Context) *HealthSection {
	section := &HealthSection{
		Completeness: CompletenessComplete,
		Scope:        ScopeFullCollection,
	}
	summary, err := s.health.HealthTargetStateSummary(ctx, s.now())
	if err != nil {
		section.Completeness = CompletenessUnavailable
		section.Error = ErrCodeSectionUnavailable
		return section
	}
	section.Targets = &summary
	return section
}

func (s *Service) buildAlerts(ctx context.Context) *AlertsSection {
	section := &AlertsSection{
		Completeness: CompletenessComplete,
		Scope:        ScopeFullCollection,
	}
	summary, err := s.alerts.AlertSummary(ctx)
	if err != nil {
		section.Completeness = CompletenessUnavailable
		section.Error = ErrCodeSectionUnavailable
		return section
	}
	section.Alerts = &summary
	return section
}

func (s *Service) buildTopology(ctx context.Context) *TopologySection {
	section := &TopologySection{
		Completeness: CompletenessComplete,
		Scope:        ScopeFullCollection,
	}
	summary, err := s.topology.EdgeSummary(ctx)
	if err != nil {
		section.Completeness = CompletenessUnavailable
		section.Error = ErrCodeSectionUnavailable
		return section
	}
	section.Edges = &summary
	return section
}
