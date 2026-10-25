package runtimeinv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Bootstrap source provenance. Discovered resources are never labelled as
// manually authored.
const (
	SourceKindDiscovered = "discovered"
	SourceSystem         = "xcloud-runtime"
	SourceAuthority      = "authoritative"
	// BindingSourceRuntime records that a local process binding was installed by
	// the approved runtime bootstrap rather than by static configuration.
	BindingSourceRuntime = "runtime_bootstrap"
)

// Bootstrap action vocabulary.
const (
	ActionCreateResource   = "create_resource"
	ActionReuseResource    = "reuse_resource"
	ActionSkipAmbiguous    = "skip_ambiguous"
	ActionSkipNotRunning   = "skip_not_running"
	ActionSkipNotMonitored = "skip_monitoring_unsupported"
)

// Bootstrap conflict codes.
const (
	ConflictStaticBinding     = "static_binding_conflict"
	ConflictBindingMismatch   = "existing_binding_mismatch"
	ConflictResourceAmbiguous = "compatible_resource_ambiguous"
)

// MaxBootstrapComponents bounds one preview/apply plan.
const MaxBootstrapComponents = 64

// BootstrapIntervalSeconds is the scheduled L1 collection interval for adopted
// targets.
const BootstrapIntervalSeconds = 120

// RuntimeKey is the stable bootstrap identity key. It is derived from the
// trusted local host identity, the verified component identity and the verified
// process identity. A PID is never part of it.
func RuntimeKey(hostID, componentID, processName string) string {
	return "xrt:" + hostID + ":" + componentID + ":" + processName
}

// ResourceRef is the read projection of one canonical Inventory resource.
type ResourceRef struct {
	ResourceID     string
	Name           string
	Kind           string
	Domain         string
	Role           string
	LifecycleState string
	ExternalID     string
	SourceKind     string
}

// DiscoveredSpec is the server-owned description of a resource to create.
type DiscoveredSpec struct {
	ExternalID     string
	Kind           string
	Name           string
	DisplayName    string
	Description    string
	Domain         string
	Role           string
	LifecycleState string
	Labels         map[string]string
	Attributes     map[string]any
}

// InventoryGateway is the bounded Inventory surface the bootstrap needs.
//
// The bootstrap never mutates an existing resource: reuse means association
// only, so a manually maintained record keeps its attributes, revision and
// lifecycle untouched.
type InventoryGateway interface {
	FindDiscovered(ctx context.Context, system string, externalIDs []string) (map[string]ResourceRef, error)
	FindCompatible(ctx context.Context, domain, role string) ([]ResourceRef, error)
	CreateDiscovered(ctx context.Context, spec DiscoveredSpec, actor string) (ResourceRef, bool, error)
}

// TargetSpec is the server-generated NF Health target proposal.
type TargetSpec struct {
	ResourceID       string
	Name             string
	CollectorProfile string
	ServiceUnit      string
	ServiceKind      string
	CollectionMode   string
	IntervalSeconds  int
}

// TargetGateway is the bounded NF Health surface the bootstrap needs.
type TargetGateway interface {
	FindByResource(ctx context.Context, resourceID string) (string, bool, error)
	// FindByResources is the bounded batch association lookup used by the read
	// projection. It never issues one query per resource.
	FindByResources(ctx context.Context, resourceIDs []string) (map[string]string, error)
	EnsureTarget(ctx context.Context, spec TargetSpec, actor string) (string, bool, error)
}

// BindingSpec is the approved local process binding proposal.
type BindingSpec struct {
	ResourceID  string `json:"resourceId"`
	Unit        string `json:"unit"`
	ProcessName string `json:"processName"`
	Domain      string `json:"domain"`
	NFType      string `json:"nfType"`
	HostID      string `json:"hostId"`
	BindingKey  string `json:"bindingKey"`
	Source      string `json:"source"`
}

// BindingGateway is the governed persistent binding surface.
type BindingGateway interface {
	PreviewConflict(ctx context.Context, spec BindingSpec) (string, bool, error)
	Install(ctx context.Context, spec BindingSpec, actor string) (bool, error)
}

// ProposedResource is the previewed resource creation.
type ProposedResource struct {
	Kind           string `json:"kind"`
	Name           string `json:"name"`
	DisplayName    string `json:"displayName"`
	Domain         string `json:"domain"`
	Role           string `json:"role"`
	LifecycleState string `json:"lifecycleState"`
	ExternalID     string `json:"externalId"`
}

// ProposedTarget is the previewed NF Health target.
type ProposedTarget struct {
	CollectorProfile string `json:"collectorProfile"`
	ServiceUnit      string `json:"serviceUnit"`
	ServiceKind      string `json:"serviceKind"`
	CollectionMode   string `json:"collectionMode"`
	IntervalSeconds  int    `json:"intervalSeconds"`
}

// PlanEntry is one bounded, reviewable bootstrap decision.
type PlanEntry struct {
	ComponentID   string `json:"componentId"`
	DisplayName   string `json:"displayName"`
	ProcessName   string `json:"processName"`
	Domain        string `json:"domain"`
	Role          string `json:"role"`
	NFTType       string `json:"nfType,omitempty"`
	Category      string `json:"category"`
	RuntimeStatus string `json:"runtimeStatus"`
	Verified      bool   `json:"verified"`
	WorkerCount   int    `json:"workerCount"`
	PrimaryPID    int    `json:"primaryPid"`

	Action       string `json:"action"`
	Reason       string `json:"reason"`
	ResourceID   string `json:"resourceId,omitempty"`
	ResourceName string `json:"resourceName,omitempty"`
	TargetID     string `json:"targetId,omitempty"`
	TargetAction string `json:"targetAction,omitempty"`

	ProposedResource *ProposedResource `json:"proposedResource,omitempty"`
	ProposedTarget   *ProposedTarget   `json:"proposedTarget,omitempty"`
	Binding          *BindingSpec      `json:"binding,omitempty"`
	Conflicts        []string          `json:"conflicts"`
}

// PlanCounts summarizes a plan.
type PlanCounts struct {
	Total        int `json:"total"`
	Create       int `json:"create"`
	Reuse        int `json:"reuse"`
	Skipped      int `json:"skipped"`
	Conflicts    int `json:"conflicts"`
	TargetCreate int `json:"targetCreate"`
	TargetReuse  int `json:"targetReuse"`
}

// Plan is the bounded read-only bootstrap preview.
type Plan struct {
	PlanID      string      `json:"planId"`
	HostID      string      `json:"hostId"`
	Template    string      `json:"template"`
	GeneratedAt string      `json:"generatedAt"`
	Entries     []PlanEntry `json:"entries"`
	Counts      PlanCounts  `json:"counts"`
}

// ApplyEntryResult is the outcome of one applied entry.
type ApplyEntryResult struct {
	ComponentID      string   `json:"componentId"`
	Action           string   `json:"action"`
	ResourceID       string   `json:"resourceId,omitempty"`
	ResourceCreated  bool     `json:"resourceCreated"`
	TargetID         string   `json:"targetId,omitempty"`
	TargetCreated    bool     `json:"targetCreated"`
	BindingInstalled bool     `json:"bindingInstalled"`
	Reason           string   `json:"reason,omitempty"`
	Conflicts        []string `json:"conflicts"`
}

// ApplyResult is the outcome of one approved bootstrap.
type ApplyResult struct {
	PlanID    string             `json:"planId"`
	HostID    string             `json:"hostId"`
	AppliedAt string             `json:"appliedAt"`
	Entries   []ApplyEntryResult `json:"entries"`
	Counts    PlanCounts         `json:"counts"`
}

// ErrStalePreview reports that the approved plan no longer matches the current
// runtime identity.
var ErrStalePreview = errors.New("RUNTIME_BOOTSTRAP_STALE_PREVIEW")

// ErrBootstrapUnavailable reports that the bootstrap gateways are not wired.
var ErrBootstrapUnavailable = errors.New("RUNTIME_BOOTSTRAP_UNAVAILABLE")

// Bootstrapper turns verified runtime observations into governed canonical
// associations.
type Bootstrapper struct {
	service   *Service
	inventory InventoryGateway
	targets   TargetGateway
	bindings  BindingGateway
	clock     func() time.Time
}

// NewBootstrapper constructs the bootstrap coordinator.
func NewBootstrapper(service *Service, inventory InventoryGateway, targets TargetGateway, bindings BindingGateway) *Bootstrapper {
	return &Bootstrapper{
		service:   service,
		inventory: inventory,
		targets:   targets,
		bindings:  bindings,
		clock:     time.Now,
	}
}

// Ready reports whether every gateway is wired.
func (b *Bootstrapper) Ready() bool {
	return b != nil && b.service != nil && b.inventory != nil && b.targets != nil && b.bindings != nil
}

// Plan produces a bounded, read-only plan.
func (b *Bootstrapper) Plan(ctx context.Context, template string, componentIDs []string) (*Plan, error) {
	if !b.Ready() {
		return nil, ErrBootstrapUnavailable
	}
	snapshot := b.service.Snapshot()
	components, err := b.selectComponents(template, componentIDs)
	if err != nil {
		return nil, err
	}
	plan := &Plan{
		HostID:      snapshot.Host.HostID,
		Template:    template,
		GeneratedAt: b.clock().UTC().Format(time.RFC3339Nano),
		Entries:     make([]PlanEntry, 0, len(components)),
	}
	byID := make(map[string]Observation, len(snapshot.Components))
	for _, observation := range snapshot.Components {
		byID[observation.ComponentID] = observation
	}

	for _, component := range components {
		observation, ok := byID[component.ID]
		if !ok {
			continue
		}
		entry := PlanEntry{
			ComponentID:   component.ID,
			DisplayName:   component.DisplayName,
			ProcessName:   component.ProcessName,
			Domain:        component.Domain,
			Role:          component.Role,
			NFTType:       component.NFTType,
			Category:      component.Category,
			RuntimeStatus: observation.RuntimeStatus,
			Verified:      observation.Verified,
			WorkerCount:   observation.WorkerCount,
			PrimaryPID:    observation.PrimaryPID,
			Conflicts:     []string{},
		}
		if err := b.decide(ctx, snapshot, component, &entry); err != nil {
			return nil, err
		}
		plan.Entries = append(plan.Entries, entry)
	}
	plan.PlanID = planFingerprint(plan)
	plan.Counts = countPlan(plan)
	return plan, nil
}

func (b *Bootstrapper) selectComponents(template string, componentIDs []string) ([]Component, error) {
	template = strings.TrimSpace(template)
	if template == "" {
		template = TemplateAuto
	}
	if !ValidTemplate(template) {
		return nil, fmt.Errorf("unsupported template")
	}
	if len(componentIDs) == 0 {
		return b.service.Registry().FilterTemplate(template), nil
	}
	if len(componentIDs) > MaxBootstrapComponents {
		return nil, fmt.Errorf("too many components")
	}
	selected := make([]Component, 0, len(componentIDs))
	seen := map[string]struct{}{}
	for _, id := range componentIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, fmt.Errorf("empty component id")
		}
		component, ok := b.service.Registry().Lookup(id)
		if !ok {
			return nil, fmt.Errorf("unknown component id")
		}
		if !InTemplate(component, template) && template != TemplateAuto {
			return nil, fmt.Errorf("component is not part of the selected template")
		}
		if _, duplicate := seen[component.ID]; duplicate {
			continue
		}
		seen[component.ID] = struct{}{}
		selected = append(selected, component)
	}
	return selected, nil
}

func (b *Bootstrapper) decide(ctx context.Context, snapshot *Snapshot, component Component, entry *PlanEntry) error {
	if !component.Adoptable {
		entry.Action = ActionSkipNotMonitored
		entry.Reason = component.MonitoringReason
		return nil
	}
	if !entry.Verified || entry.RuntimeStatus != StatusRunning {
		entry.Action = ActionSkipNotRunning
		entry.Reason = entry.RuntimeStatus
		return nil
	}

	key := RuntimeKey(snapshot.Host.HostID, component.ID, component.ProcessName)
	discovered, err := b.inventory.FindDiscovered(ctx, SourceSystem, []string{key})
	if err != nil {
		return err
	}
	if resource, ok := discovered[key]; ok {
		entry.Action = ActionReuseResource
		entry.Reason = "discovered_resource_exists"
		entry.ResourceID = resource.ResourceID
		entry.ResourceName = resource.Name
	} else {
		compatible, cerr := b.inventory.FindCompatible(ctx, component.Domain, component.Role)
		if cerr != nil {
			return cerr
		}
		switch len(compatible) {
		case 0:
			entry.Action = ActionCreateResource
			entry.Reason = "no_compatible_resource"
			entry.ProposedResource = &ProposedResource{
				Kind:           "network_function",
				Name:           resourceName(component, snapshot.Host.HostID),
				DisplayName:    component.DisplayName + " (" + component.ProcessName + ")",
				Domain:         component.Domain,
				Role:           component.Role,
				LifecycleState: "planned",
				ExternalID:     key,
			}
		case 1:
			entry.Action = ActionReuseResource
			entry.Reason = "single_compatible_resource"
			entry.ResourceID = compatible[0].ResourceID
			entry.ResourceName = compatible[0].Name
		default:
			entry.Action = ActionSkipAmbiguous
			entry.Reason = ConflictResourceAmbiguous
			entry.Conflicts = append(entry.Conflicts, ConflictResourceAmbiguous)
			return nil
		}
	}

	if component.Monitoring != MonitoringSupported {
		// Adopted as an Inventory resource only. No NF Health target and no
		// process binding: the registry withholds measurement for a reason, so
		// adoption must never fabricate a collector to fill the gap.
		return nil
	}

	if entry.ResourceID != "" {
		targetID, ok, terr := b.targets.FindByResource(ctx, entry.ResourceID)
		if terr != nil {
			return terr
		}
		if ok {
			entry.TargetAction = "reuse_target"
			entry.TargetID = targetID
		} else {
			entry.TargetAction = "create_target"
		}
	} else {
		entry.TargetAction = "create_target"
	}

	binding := BindingSpec{
		ResourceID:  entry.ResourceID,
		Unit:        component.ProcessName,
		ProcessName: component.ProcessName,
		Domain:      component.Domain,
		NFType:      component.NFTType,
		HostID:      snapshot.Host.HostID,
		BindingKey:  bindingKey(snapshot.Host.HostID, component),
		Source:      BindingSourceRuntime,
	}
	conflict, hasConflict, cerr := b.bindings.PreviewConflict(ctx, binding)
	if cerr != nil {
		return cerr
	}
	if hasConflict {
		entry.Conflicts = append(entry.Conflicts, conflict)
		entry.Action = ActionSkipAmbiguous
		entry.Reason = conflict
		return nil
	}
	entry.Binding = &binding
	entry.ProposedTarget = &ProposedTarget{
		CollectorProfile: "process_only",
		ServiceUnit:      component.ProcessName,
		ServiceKind:      "process",
		CollectionMode:   "scheduled",
		IntervalSeconds:  BootstrapIntervalSeconds,
	}
	return nil
}

// Apply executes an approved plan. It is idempotent: resources, bindings and
// targets are resolved by stable identity, so a retry never duplicates them.
func (b *Bootstrapper) Apply(ctx context.Context, planID, template string, componentIDs []string, actor string) (*ApplyResult, error) {
	if !b.Ready() {
		return nil, ErrBootstrapUnavailable
	}
	plan, err := b.Plan(ctx, template, componentIDs)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(planID) == "" || planID != plan.PlanID {
		return nil, ErrStalePreview
	}

	result := &ApplyResult{
		PlanID:    plan.PlanID,
		HostID:    plan.HostID,
		AppliedAt: b.clock().UTC().Format(time.RFC3339Nano),
		Entries:   make([]ApplyEntryResult, 0, len(plan.Entries)),
	}
	for _, entry := range plan.Entries {
		applied := ApplyEntryResult{
			ComponentID: entry.ComponentID,
			Action:      entry.Action,
			ResourceID:  entry.ResourceID,
			TargetID:    entry.TargetID,
			Conflicts:   append([]string{}, entry.Conflicts...),
			Reason:      entry.Reason,
		}
		switch entry.Action {
		case ActionSkipNotMonitored, ActionSkipNotRunning, ActionSkipAmbiguous:
			applied.Action = "skipped"
			result.Entries = append(result.Entries, applied)
			continue
		}

		if entry.Action == ActionCreateResource {
			spec := DiscoveredSpec{
				ExternalID:     entry.ProposedResource.ExternalID,
				Kind:           entry.ProposedResource.Kind,
				Name:           entry.ProposedResource.Name,
				DisplayName:    entry.ProposedResource.DisplayName,
				Description:    "Discovered by the local runtime scanner from a verified process identity.",
				Domain:         entry.ProposedResource.Domain,
				Role:           entry.ProposedResource.Role,
				LifecycleState: entry.ProposedResource.LifecycleState,
				Labels: map[string]string{
					"managed-by":        SourceSystem,
					"runtime-component": entry.ComponentID,
				},
				Attributes: map[string]any{
					"runtime.componentId": entry.ComponentID,
					"runtime.processName": entry.ProcessName,
					"runtime.hostId":      plan.HostID,
					"runtime.source":      SourceSystem,
				},
			}
			resource, created, cerr := b.inventory.CreateDiscovered(ctx, spec, actor)
			if cerr != nil {
				applied.Action = "failed"
				applied.Reason = "inventory_create_failed"
				result.Entries = append(result.Entries, applied)
				continue
			}
			applied.ResourceID = resource.ResourceID
			applied.ResourceCreated = created
			if created {
				applied.Action = "created"
			} else {
				applied.Action = "reused"
			}
		} else {
			applied.Action = "reused"
		}

		if entry.ProposedTarget == nil {
			// The plan withheld measurement on purpose, so adoption stops at the
			// resource: no target row, no process binding.
			result.Entries = append(result.Entries, applied)
			continue
		}

		if entry.Binding != nil {
			binding := *entry.Binding
			binding.ResourceID = applied.ResourceID
			installed, berr := b.bindings.Install(ctx, binding, actor)
			if berr != nil {
				applied.Conflicts = append(applied.Conflicts, "binding_install_failed")
				applied.Reason = "binding_install_failed"
				result.Entries = append(result.Entries, applied)
				continue
			}
			applied.BindingInstalled = installed
		}

		spec := TargetSpec{
			ResourceID:       applied.ResourceID,
			Name:             entry.DisplayName + " local process",
			CollectorProfile: "process_only",
			ServiceUnit:      entry.ProcessName,
			ServiceKind:      "process",
			CollectionMode:   "scheduled",
			IntervalSeconds:  BootstrapIntervalSeconds,
		}
		targetID, created, terr := b.targets.EnsureTarget(ctx, spec, actor)
		if terr != nil {
			applied.Reason = "nf_health_target_failed"
			applied.Conflicts = append(applied.Conflicts, "nf_health_target_failed")
			result.Entries = append(result.Entries, applied)
			continue
		}
		applied.TargetID = targetID
		applied.TargetCreated = created
		result.Entries = append(result.Entries, applied)
	}
	result.Counts = countApply(result)
	return result, nil
}

func countApply(result *ApplyResult) PlanCounts {
	counts := PlanCounts{Total: len(result.Entries)}
	for _, entry := range result.Entries {
		switch entry.Action {
		case "created":
			counts.Create++
		case "reused":
			counts.Reuse++
		default:
			counts.Skipped++
		}
		if entry.TargetCreated {
			counts.TargetCreate++
		} else if entry.TargetID != "" {
			counts.TargetReuse++
		}
		counts.Conflicts += len(entry.Conflicts)
	}
	return counts
}

func countPlan(plan *Plan) PlanCounts {
	counts := PlanCounts{Total: len(plan.Entries)}
	for _, entry := range plan.Entries {
		switch entry.Action {
		case ActionCreateResource:
			counts.Create++
		case ActionReuseResource:
			counts.Reuse++
		default:
			counts.Skipped++
		}
		if entry.TargetAction == "create_target" {
			counts.TargetCreate++
		} else if entry.TargetAction == "reuse_target" {
			counts.TargetReuse++
		}
		counts.Conflicts += len(entry.Conflicts)
	}
	return counts
}

// planFingerprint hashes the runtime identity inputs that a client cannot
// influence. Inventory or target state is deliberately excluded so an approved
// plan can be applied idempotently more than once.
func planFingerprint(plan *Plan) string {
	parts := make([]string, 0, len(plan.Entries))
	for _, entry := range plan.Entries {
		parts = append(parts, strings.Join([]string{
			entry.ComponentID,
			entry.ProcessName,
			entry.Domain,
			entry.Role,
			entry.RuntimeStatus,
			strconv.FormatBool(entry.Verified),
		}, ":"))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(plan.HostID + "|" + plan.Template + "|" + strings.Join(parts, "|")))
	return "plan-" + hex.EncodeToString(sum[:])[:24]
}

func resourceName(component Component, hostID string) string {
	suffix := hostID
	if len(suffix) > 6 {
		suffix = suffix[len(suffix)-6:]
	}
	return component.DisplayName + "-" + suffix
}

func bindingKey(hostID string, component Component) string {
	return hostID + "|" + component.ProcessName + "|" + component.NFTType
}
