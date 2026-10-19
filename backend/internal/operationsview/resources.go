package operationsview

import (
	"context"
	"time"

	"subscriber/internal/inventory"
	"subscriber/internal/nfhealth"
)

// Resource projection bounds. The limit is the same envelope the Inventory list
// already enforces, so the projection can never request a wider page than the
// authority it reads.
const (
	ResourceDefaultLimit = 20
	ResourceMaxLimit     = 200
	// ResourceMaxRoles bounds the `roles` filter. The bound is sized for the
	// largest legitimate caller (the reference architecture asks for every role
	// token of its skeleton) while still refusing an unbounded query.
	ResourceMaxRoles = 64
)

// Association states for one Inventory resource.
//
//	confirmed  - an authoritative lookup succeeded and a monitoring target exists
//	absent     - an authoritative lookup succeeded and no target exists
//	unresolved - the lookup did not succeed; absence is NOT established
const (
	AssociationConfirmed  = "confirmed"
	AssociationAbsent     = "absent"
	AssociationUnresolved = "unresolved"
)

// Monitoring filter vocabulary. Every value is evaluated against the projection
// of the current page only; the response states that scope explicitly.
const (
	MonitoringMonitored   = "monitored"
	MonitoringUnmonitored = "unmonitored"
	MonitoringUnresolved  = "unresolved"
	MonitoringDegraded    = "degraded"
	MonitoringUnknown     = "unknown"
	MonitoringStale       = "stale"
)

// FilterScopePage marks a response whose list was narrowed by a predicate that
// cannot be evaluated by the Inventory query itself.
const FilterScopePage = "page"

// RuntimeBinding states for one resource.
const (
	RuntimeBindingBound   = "bound"
	RuntimeBindingUnbound = "unbound"
	RuntimeBindingUnknown = "unknown"
)

// ResourceCoverage mirrors the NF Health layer coverage projection.
type ResourceCoverage struct {
	L1Measured  bool `json:"l1Measured"`
	L2Measured  bool `json:"l2Measured"`
	L3Measured  bool `json:"l3Measured"`
	L3Available bool `json:"l3Available"`
}

// ResourceFreshness mirrors the NF Health freshness projection. PolicySeconds is
// the evaluation policy, never a measurement.
type ResourceFreshness struct {
	State         string `json:"state"`
	AgeSeconds    *int64 `json:"ageSeconds,omitempty"`
	PolicySeconds int    `json:"policySeconds"`
	Reason        string `json:"reason,omitempty"`
}

// ResourceMonitoring is the monitoring projection for one resource. It carries
// no target configuration secrets: no endpoint, no unit path and no command
// line ever leaves the health domain through this projection.
type ResourceMonitoring struct {
	TargetID       string            `json:"targetId"`
	Enabled        bool              `json:"enabled"`
	NFType         string            `json:"nfType,omitempty"`
	OverallState   string            `json:"overallState,omitempty"`
	StatusComplete bool              `json:"statusComplete"`
	Coverage       ResourceCoverage  `json:"coverage"`
	Freshness      ResourceFreshness `json:"freshness"`
	LatestSampleAt string            `json:"latestSampleAt,omitempty"`
	LastRunStatus  string            `json:"lastRunStatus,omitempty"`
	LastRunAt      string            `json:"lastRunAt,omitempty"`
	// ResourceMetrics carries the latest sample's resource-category metrics only
	// (CPU counter, resident memory). Absent means "not measured", never zero.
	ResourceMetrics []nfhealth.MetricSample `json:"resourceMetrics,omitempty"`
}

// RuntimeBindingSummary reports whether the runtime plane holds an approved
// local binding for this resource. A binding is evidence of an approved
// deployment mapping, not of connectivity or health.
type RuntimeBindingSummary struct {
	State string `json:"state"`
	Unit  string `json:"unit,omitempty"`
}

// OperationsResource is the lightweight list DTO shared by the inventory table
// and the architecture canvas.
type OperationsResource struct {
	ResourceID        string                `json:"resourceId"`
	Name              string                `json:"name"`
	DisplayName       string                `json:"displayName,omitempty"`
	Domain            string                `json:"domain"`
	Kind              string                `json:"kind"`
	Role              string                `json:"role,omitempty"`
	LifecycleState    string                `json:"lifecycleState"`
	IsNetworkFunction bool                  `json:"isNetworkFunction"`
	Association       string                `json:"association"`
	Monitoring        *ResourceMonitoring   `json:"monitoring,omitempty"`
	RuntimeBinding    RuntimeBindingSummary `json:"runtimeBinding"`
}

// ResourceCompleteness is reported per dimension. A single boolean cannot
// represent several independently incomplete sources.
type ResourceCompleteness struct {
	Inventory  string `json:"inventory"`
	Monitoring string `json:"monitoring"`
	Telemetry  string `json:"telemetry"`
	Overall    string `json:"overall"`
}

// ResourcePage carries the cursor envelope plus the filter scope declaration.
type ResourcePage struct {
	Limit         int     `json:"limit"`
	HasMore       bool    `json:"hasMore"`
	NextCursor    *string `json:"nextCursor,omitempty"`
	FilterScope   string  `json:"filterScope,omitempty"`
	FilteredCount *int    `json:"filteredCount,omitempty"`
}

// ResourcesResponse is the payload of GET /api/operations/resources.
type ResourcesResponse struct {
	GeneratedAt  string               `json:"generatedAt"`
	Completeness ResourceCompleteness `json:"completeness"`
	Page         ResourcePage         `json:"page"`
	Resources    []OperationsResource `json:"resources"`
}

// ResourceInventory is the Inventory read authority consumed by the projection.
type ResourceInventory interface {
	List(ctx context.Context, filter inventory.ListFilter) ([]inventory.Resource, *string, bool, error)
}

// ResourceHealth is the NF Health read authority consumed by the projection.
type ResourceHealth interface {
	ListTargets(ctx context.Context, filter nfhealth.TargetListFilter) ([]nfhealth.HealthTarget, *string, bool, error)
	LatestStatusForTargets(ctx context.Context, targetIDs []string) (map[string]nfhealth.BatchTargetStatus, error)
}

// RuntimeBindings exposes the approved local binding for a resource identifier.
type RuntimeBindings interface {
	BoundUnit(resourceID string) (string, bool)
}

// ResourceQuery is the validated, bounded query for one page.
type ResourceQuery struct {
	Query      string
	Domain     string
	Kind       string
	Monitoring string
	Roles      []string
	Cursor     string
	Limit      int
}

// ResourceService projects one page of Inventory resources with their
// authoritative monitoring association. It owns no writes and calls no remote
// network action.
type ResourceService struct {
	inventory ResourceInventory
	health    ResourceHealth
	bindings  RuntimeBindings
	now       func() time.Time
}

// NewResourceService constructs the resource projection service.
func NewResourceService(inv ResourceInventory, health ResourceHealth, bindings RuntimeBindings, now func() time.Time) *ResourceService {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &ResourceService{inventory: inv, health: health, bindings: bindings, now: now}
}

// Build resolves one bounded page. The Inventory page is read first; the health
// association is then resolved for exactly those resource identifiers in one
// batch call, so the projection never performs a per-row query.
func (s *ResourceService) Build(ctx context.Context, q ResourceQuery) (ResourcesResponse, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = ResourceDefaultLimit
	}
	if limit > ResourceMaxLimit {
		limit = ResourceMaxLimit
	}

	items, nextCursor, hasMore, err := s.inventory.List(ctx, inventory.ListFilter{
		Kind:   q.Kind,
		Domain: q.Domain,
		Roles:  q.Roles,
		Query:  q.Query,
		Limit:  limit,
		Cursor: q.Cursor,
	})
	if err != nil {
		return ResourcesResponse{}, err
	}

	resp := ResourcesResponse{
		GeneratedAt: s.now().UTC().Format(time.RFC3339Nano),
		Page: ResourcePage{
			Limit:      limit,
			HasMore:    hasMore,
			NextCursor: nextCursor,
		},
		Completeness: ResourceCompleteness{
			Inventory:  CompletenessComplete,
			Monitoring: CompletenessComplete,
			Telemetry:  CompletenessComplete,
		},
		Resources: make([]OperationsResource, 0, len(items)),
	}
	// A bounded page is not the population: the inventory dimension is partial
	// whenever more rows exist behind the cursor.
	if hasMore {
		resp.Completeness.Inventory = CompletenessPartial
	}

	resourceIDs := make([]string, 0, len(items))
	for i := range items {
		resourceIDs = append(resourceIDs, items[i].ResourceID)
	}

	targetsByResource := map[string]nfhealth.HealthTarget{}
	statuses := map[string]nfhealth.BatchTargetStatus{}
	monitoringResolved := len(resourceIDs) == 0
	telemetryResolved := len(resourceIDs) == 0
	targetsTruncated := false

	if len(resourceIDs) > 0 {
		// One bounded $in lookup for the whole page. The association read is
		// deliberately not paginated by the caller: a hidden target would look
		// like a confirmed absence.
		targets, _, targetsTruncatedResult, terr := s.health.ListTargets(ctx, nfhealth.TargetListFilter{
			ResourceIDs: resourceIDs,
			Limit:       nfhealth.MaxPageLimit,
		})
		if terr != nil {
			resp.Completeness.Monitoring = CompletenessUnavailable
			resp.Completeness.Telemetry = CompletenessUnavailable
		} else {
			monitoringResolved = true
			targetsTruncated = targetsTruncatedResult
			if targetsTruncated {
				// The association set exceeded the bounded read: absence is not
				// established for resources without a returned target. Their
				// telemetry is correspondingly incomplete as well.
				resp.Completeness.Monitoring = CompletenessPartial
				resp.Completeness.Telemetry = CompletenessPartial
			}
			targetIDs := make([]string, 0, len(targets))
			for i := range targets {
				target := targets[i]
				if target.ResourceID == "" {
					continue
				}
				if existing, ok := targetsByResource[target.ResourceID]; ok {
					// Deterministic choice under duplicate associations: an
					// enabled target wins, otherwise the first one stays.
					if !existing.Enabled && target.Enabled {
						targetsByResource[target.ResourceID] = target
					}
					continue
				}
				targetsByResource[target.ResourceID] = target
			}
			for _, target := range targetsByResource {
				targetIDs = append(targetIDs, target.TargetID)
			}
			status, serr := s.health.LatestStatusForTargets(ctx, targetIDs)
			if serr != nil {
				resp.Completeness.Telemetry = CompletenessUnavailable
			} else {
				statuses = status
				telemetryResolved = true
			}
		}
	}

	now := s.now().UTC()
	telemetryPartial := false
	for i := range items {
		resource := items[i]
		entry := OperationsResource{
			ResourceID:        resource.ResourceID,
			Name:              resource.Name,
			DisplayName:       resource.DisplayName,
			Domain:            resource.Domain,
			Kind:              resource.Kind,
			Role:              resource.Role,
			LifecycleState:    resource.LifecycleState,
			IsNetworkFunction: isNetworkFunctionKind(resource.Kind),
			Association:       AssociationAbsent,
			RuntimeBinding:    s.runtimeBinding(resource.ResourceID),
		}

		target, associated := targetsByResource[resource.ResourceID]
		if !monitoringResolved || (targetsTruncated && !associated) {
			// Absence was never established. An unresolved association is never
			// reported as unmonitored, including when a bounded association read
			// ended before this resource's target could be observed.
			entry.Association = AssociationUnresolved
		} else if associated {
			entry.Association = AssociationConfirmed
			entry.Monitoring = buildResourceMonitoring(target, statuses[target.TargetID], telemetryResolved, now)
			if !entry.Monitoring.StatusComplete {
				telemetryPartial = true
			}
		}
		resp.Resources = append(resp.Resources, entry)
	}
	if telemetryPartial && resp.Completeness.Telemetry == CompletenessComplete {
		resp.Completeness.Telemetry = CompletenessPartial
	}

	if q.Monitoring != "" {
		filtered := make([]OperationsResource, 0, len(resp.Resources))
		for _, entry := range resp.Resources {
			if matchesMonitoringFilter(entry, q.Monitoring) {
				filtered = append(filtered, entry)
			}
		}
		count := len(filtered)
		resp.Resources = filtered
		// The predicate depends on the association of the loaded page, so the
		// scope is declared instead of being presented as a population filter.
		resp.Page.FilterScope = FilterScopePage
		resp.Page.FilteredCount = &count
	}

	resp.Completeness.Overall = combineResourceCompleteness(
		resp.Completeness.Inventory,
		resp.Completeness.Monitoring,
		resp.Completeness.Telemetry,
	)
	return resp, nil
}

func (s *ResourceService) runtimeBinding(resourceID string) RuntimeBindingSummary {
	if s.bindings == nil {
		return RuntimeBindingSummary{State: RuntimeBindingUnknown}
	}
	unit, ok := s.bindings.BoundUnit(resourceID)
	if !ok || unit == "" {
		return RuntimeBindingSummary{State: RuntimeBindingUnbound}
	}
	return RuntimeBindingSummary{State: RuntimeBindingBound, Unit: unit}
}

// buildResourceMonitoring projects the latest evidence for one target using the
// same freshness-gated semantics as the NF Health detail endpoint.
func buildResourceMonitoring(
	target nfhealth.HealthTarget,
	status nfhealth.BatchTargetStatus,
	telemetryResolved bool,
	now time.Time,
) *ResourceMonitoring {
	freshness := nfhealth.EvaluateFreshness(&target, now)
	monitoring := &ResourceMonitoring{
		TargetID: target.TargetID,
		Enabled:  target.Enabled,
		NFType:   target.NFType,
		Freshness: ResourceFreshness{
			State:         freshness.State,
			AgeSeconds:    freshness.AgeSeconds,
			PolicySeconds: freshness.PolicySeconds,
			Reason:        freshness.Reason,
		},
	}
	if !telemetryResolved {
		// The latest-evidence projection could not be read. The fields above stay
		// unknown rather than empty measurements.
		monitoring.StatusComplete = false
		monitoring.OverallState = nfhealth.ProjectOverallState(freshness, nil)
		return monitoring
	}

	monitoring.StatusComplete = true
	var layers *nfhealth.LayerSet
	if status.Sample != nil {
		sample := status.Sample
		monitoring.LatestSampleAt = sample.CollectedAt
		coverage := nfhealth.CoverageFromLayers(sample.Layers)
		monitoring.Coverage = ResourceCoverage{
			L1Measured:  coverage.L1Measured,
			L2Measured:  coverage.L2Measured,
			L3Measured:  coverage.L3Measured,
			L3Available: coverage.L3Available,
		}
		sampleLayers := sample.Layers
		layers = &sampleLayers
		monitoring.ResourceMetrics = resourceCategoryMetrics(sample.Metrics)
	}
	if status.Run != nil {
		monitoring.LastRunStatus = status.Run.Status
		monitoring.LastRunAt = status.Run.StartedAt
	}
	monitoring.OverallState = nfhealth.ProjectOverallState(freshness, layers)
	return monitoring
}

// resourceCategoryMetrics keeps only exporter-process measurements (category
// "resource") so a list projection never ships full metric sets.
func resourceCategoryMetrics(samples []nfhealth.MetricSample) []nfhealth.MetricSample {
	out := make([]nfhealth.MetricSample, 0, len(samples))
	for _, sample := range samples {
		if sample.Category == nfhealth.CategoryResource {
			out = append(out, sample)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func isNetworkFunctionKind(kind string) bool {
	return kind == "network_function" || kind == "network_function_instance"
}

// matchesMonitoringFilter applies the page-scoped monitoring predicate.
func matchesMonitoringFilter(entry OperationsResource, filter string) bool {
	switch filter {
	case MonitoringMonitored:
		return entry.Association == AssociationConfirmed
	case MonitoringUnmonitored:
		return entry.Association == AssociationAbsent
	case MonitoringUnresolved:
		return entry.Association == AssociationUnresolved
	case MonitoringDegraded:
		return entry.Association == AssociationConfirmed && entry.Monitoring != nil &&
			(entry.Monitoring.OverallState == "degraded" || entry.Monitoring.OverallState == "unhealthy")
	case MonitoringStale:
		return entry.Association == AssociationConfirmed && entry.Monitoring != nil &&
			(entry.Monitoring.OverallState == "stale" || entry.Monitoring.Freshness.State == "stale")
	case MonitoringUnknown:
		// No positive claim: unknown, unprojected, or a configured-but-disabled
		// target. It is never folded into "unmonitored", because a target exists.
		return entry.Association == AssociationConfirmed && entry.Monitoring != nil &&
			(entry.Monitoring.OverallState == "" ||
				entry.Monitoring.OverallState == "unknown" ||
				entry.Monitoring.OverallState == "not_configured")
	default:
		return true
	}
}

func combineResourceCompleteness(dimensions ...string) string {
	overall := CompletenessComplete
	for _, dimension := range dimensions {
		if dimension == CompletenessUnavailable {
			return CompletenessUnavailable
		}
		if dimension == CompletenessPartial {
			overall = CompletenessPartial
		}
	}
	return overall
}
