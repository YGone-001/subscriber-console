package runtimeinv

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

// ---------------------------------------------------------------- fakes

type fakeInventory struct {
	discovered map[string]ResourceRef
	compatible []ResourceRef
	created    []DiscoveredSpec
	nextID     int
}

func newFakeInventory() *fakeInventory {
	return &fakeInventory{discovered: map[string]ResourceRef{}}
}

func (f *fakeInventory) FindDiscovered(ctx context.Context, system string, externalIDs []string) (map[string]ResourceRef, error) {
	out := map[string]ResourceRef{}
	for _, id := range externalIDs {
		if resource, ok := f.discovered[id]; ok {
			out[id] = resource
		}
	}
	return out, nil
}

func (f *fakeInventory) FindCompatible(ctx context.Context, domain, role string) ([]ResourceRef, error) {
	return f.compatible, nil
}

func (f *fakeInventory) CreateDiscovered(ctx context.Context, spec DiscoveredSpec, actor string) (ResourceRef, bool, error) {
	if existing, ok := f.discovered[spec.ExternalID]; ok {
		return existing, false, nil
	}
	f.nextID++
	resource := ResourceRef{
		ResourceID:     "res-" + spec.Role + "-" + spec.ExternalID,
		Name:           spec.Name,
		Kind:           spec.Kind,
		Domain:         spec.Domain,
		Role:           spec.Role,
		LifecycleState: spec.LifecycleState,
		ExternalID:     spec.ExternalID,
		SourceKind:     SourceKindDiscovered,
	}
	f.discovered[spec.ExternalID] = resource
	f.created = append(f.created, spec)
	return resource, true, nil
}

type fakeTargets struct {
	byResource map[string]string
	created    []TargetSpec
}

func newFakeTargets() *fakeTargets {
	return &fakeTargets{byResource: map[string]string{}}
}

func (f *fakeTargets) FindByResource(ctx context.Context, resourceID string) (string, bool, error) {
	id, ok := f.byResource[resourceID]
	return id, ok, nil
}

func (f *fakeTargets) FindByResources(ctx context.Context, resourceIDs []string) (map[string]string, error) {
	out := map[string]string{}
	for _, id := range resourceIDs {
		if target, ok := f.byResource[id]; ok {
			out[id] = target
		}
	}
	return out, nil
}

func (f *fakeTargets) EnsureTarget(ctx context.Context, spec TargetSpec, actor string) (string, bool, error) {
	if existing, ok := f.byResource[spec.ResourceID]; ok {
		return existing, false, nil
	}
	targetID := "tgt-" + spec.ResourceID
	f.byResource[spec.ResourceID] = targetID
	f.created = append(f.created, spec)
	return targetID, true, nil
}

type fakeBindings struct {
	static     map[string]string
	byResource map[string]string
	byKey      map[string]string
	installed  []BindingSpec
}

func newFakeBindings() *fakeBindings {
	return &fakeBindings{
		static:     map[string]string{},
		byResource: map[string]string{},
		byKey:      map[string]string{},
	}
}

func (f *fakeBindings) PreviewConflict(ctx context.Context, spec BindingSpec) (string, bool, error) {
	if static, ok := f.static[spec.ResourceID]; ok && static != spec.Unit {
		return ConflictStaticBinding, true, nil
	}
	if existing, ok := f.byResource[spec.ResourceID]; ok && existing != spec.Unit {
		return ConflictBindingMismatch, true, nil
	}
	if owner, ok := f.byKey[spec.BindingKey]; ok && owner != spec.ResourceID {
		return ConflictBindingMismatch, true, nil
	}
	return "", false, nil
}

func (f *fakeBindings) Install(ctx context.Context, spec BindingSpec, actor string) (bool, error) {
	if existing, ok := f.byResource[spec.ResourceID]; ok {
		if existing != spec.Unit {
			return false, errors.New("binding conflict")
		}
		return false, nil
	}
	f.byResource[spec.ResourceID] = spec.Unit
	f.byKey[spec.BindingKey] = spec.ResourceID
	f.installed = append(f.installed, spec)
	return true, nil
}

func newTestService(t *testing.T, f *fixture, clock *fakeClock) *Service {
	t.Helper()
	scanner := newTestScanner(f, clock)
	service := NewService(scanner, NewMemoryStateStore(), ServiceOptions{
		Enabled:  true,
		Interval: 10 * time.Second,
		Clock:    clock.Now,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if _, err := service.scan(context.Background(), TriggerStartup); err != nil {
		t.Fatalf("startup scan: %v", err)
	}
	return service
}

func planEntry(t *testing.T, plan *Plan, componentID string) PlanEntry {
	t.Helper()
	for _, entry := range plan.Entries {
		if entry.ComponentID == componentID {
			return entry
		}
	}
	t.Fatalf("component %q missing from plan", componentID)
	return PlanEntry{}
}

// ---------------------------------------------------------------- preview

func TestBootstrapPlanProposesCreation(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(1401, "amfd", "/opt/nf/amfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	bootstrapper := NewBootstrapper(service, newFakeInventory(), newFakeTargets(), newFakeBindings())

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"amf"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	entry := planEntry(t, plan, "amf")
	if entry.Action != ActionCreateResource {
		t.Fatalf("expected a resource creation proposal, got %s", entry.Action)
	}
	if entry.ProposedResource == nil || entry.ProposedResource.LifecycleState != "planned" {
		t.Fatal("a discovered resource must be proposed as planned, never active")
	}
	if entry.ProposedTarget == nil || entry.ProposedTarget.CollectorProfile != "process_only" {
		t.Fatal("a process_only target must be proposed")
	}
	if entry.ProposedTarget.CollectionMode != "scheduled" || entry.ProposedTarget.IntervalSeconds != BootstrapIntervalSeconds {
		t.Fatalf("scheduled L1 collection must be proposed: %+v", entry.ProposedTarget)
	}
	if entry.Binding == nil || entry.Binding.ProcessName != "amfd" {
		t.Fatal("a process binding must be proposed")
	}
	if plan.PlanID == "" || len(plan.PlanID) < 8 {
		t.Fatal("the plan must carry a stable identifier")
	}
}

func TestBootstrapPlanReusesDiscoveredResource(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(1501, "smfd", "/opt/nf/smfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	inventory := newFakeInventory()
	key := RuntimeKey(service.Host().HostID, "smf", "smfd")
	inventory.discovered[key] = ResourceRef{ResourceID: "res-existing", Name: "SMF", Domain: "5gc", Role: "smf", LifecycleState: "active"}
	bootstrapper := NewBootstrapper(service, inventory, newFakeTargets(), newFakeBindings())

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"smf"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	entry := planEntry(t, plan, "smf")
	if entry.Action != ActionReuseResource || entry.ResourceID != "res-existing" {
		t.Fatalf("expected reuse of the discovered resource, got %+v", entry)
	}
	if entry.TargetAction != "create_target" {
		t.Fatalf("a missing target must be created, got %s", entry.TargetAction)
	}
}

func TestBootstrapPlanReusesSingleCompatibleResource(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(1601, "mmed", "/opt/nf/mmed", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	inventory := newFakeInventory()
	inventory.compatible = []ResourceRef{{ResourceID: "res-manual", Name: "MME-01", Domain: "epc", Role: "mme"}}
	bootstrapper := NewBootstrapper(service, inventory, newFakeTargets(), newFakeBindings())

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"mme"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	entry := planEntry(t, plan, "mme")
	if entry.Action != ActionReuseResource || entry.ResourceID != "res-manual" {
		t.Fatalf("a single compatible manual resource must be reused, got %+v", entry)
	}
	if entry.Reason != "single_compatible_resource" {
		t.Fatalf("expected the reuse reason, got %s", entry.Reason)
	}
	if len(inventory.created) != 0 {
		t.Fatal("reuse must never create a second resource")
	}
}

func TestBootstrapPlanRejectsAmbiguousResource(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(1701, "pcrfd", "/opt/nf/pcrfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	inventory := newFakeInventory()
	inventory.compatible = []ResourceRef{
		{ResourceID: "res-a", Name: "PCRF-A", Domain: "epc", Role: "pcrf"},
		{ResourceID: "res-b", Name: "PCRF-B", Domain: "epc", Role: "pcrf"},
	}
	bootstrapper := NewBootstrapper(service, inventory, newFakeTargets(), newFakeBindings())

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"pcrf"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	entry := planEntry(t, plan, "pcrf")
	if entry.Action != ActionSkipAmbiguous {
		t.Fatalf("an ambiguous identity must not be adopted, got %s", entry.Action)
	}
	if len(entry.Conflicts) == 0 {
		t.Fatal("the ambiguity must be reported as a conflict")
	}
}

func TestBootstrapPlanSkipsUnsupportedAndAbsentComponents(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(1801, "drad", "/opt/nf/drad", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	bootstrapper := NewBootstrapper(service, newFakeInventory(), newFakeTargets(), newFakeBindings())

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"dra", "amf"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	dra := planEntry(t, plan, "dra")
	if dra.Action != ActionSkipNotMonitored {
		t.Fatalf("a support component must not be adopted, got %s", dra.Action)
	}
	if dra.RuntimeStatus != StatusRunning {
		t.Fatalf("the support component must still be visible as running, got %s", dra.RuntimeStatus)
	}
	amf := planEntry(t, plan, "amf")
	if amf.Action != ActionSkipNotRunning {
		t.Fatalf("an absent component must not be adopted, got %s", amf.Action)
	}
}

func TestBootstrapPlanReportsStaticBindingConflict(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(1901, "amfd", "/opt/nf/amfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	inventory := newFakeInventory()
	key := RuntimeKey(service.Host().HostID, "amf", "amfd")
	inventory.discovered[key] = ResourceRef{ResourceID: "res-amf", Name: "AMF", Domain: "5gc", Role: "amf"}
	bindings := newFakeBindings()
	bindings.static["res-amf"] = "amfd-static"
	bootstrapper := NewBootstrapper(service, inventory, newFakeTargets(), bindings)

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"amf"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	entry := planEntry(t, plan, "amf")
	if entry.Action != ActionSkipAmbiguous {
		t.Fatalf("a static binding conflict must stop the adoption, got %s", entry.Action)
	}
	if entry.Reason != ConflictStaticBinding {
		t.Fatalf("expected the static binding conflict, got %s", entry.Reason)
	}
}

// ------------------------------------------------------------------ apply

func TestBootstrapApplyIsIdempotent(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(2001, "upfd", "/opt/nf/upfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	inventory := newFakeInventory()
	targets := newFakeTargets()
	bindings := newFakeBindings()
	bootstrapper := NewBootstrapper(service, inventory, targets, bindings)

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"upf"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	first, err := bootstrapper.Apply(context.Background(), plan.PlanID, TemplateAuto, []string{"upf"}, "operator")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if first.Counts.Create != 1 {
		t.Fatalf("first apply must create one resource, got %+v", first.Counts)
	}
	if len(inventory.created) != 1 || len(targets.created) != 1 || len(bindings.installed) != 1 {
		t.Fatalf("expected exactly one resource, target and binding: %d/%d/%d",
			len(inventory.created), len(targets.created), len(bindings.installed))
	}
	if first.Entries[0].ResourceCreated != true || first.Entries[0].TargetCreated != true {
		t.Fatalf("first apply must report the creations: %+v", first.Entries[0])
	}

	// Retrying the same approved plan is safe: the runtime identity is unchanged,
	// so the plan id still matches and every write resolves to the existing
	// canonical identity.
	second, err := bootstrapper.Apply(context.Background(), plan.PlanID, TemplateAuto, []string{"upf"}, "operator")
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if second.Counts.Create != 0 || second.Counts.Reuse != 1 {
		t.Fatalf("second apply must reuse, got %+v", second.Counts)
	}
	if len(inventory.created) != 1 || len(targets.created) != 1 {
		t.Fatalf("retry must not duplicate: %d resources, %d targets", len(inventory.created), len(targets.created))
	}
}

func TestBootstrapApplyRejectsStalePreview(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(2101, "amfd", "/opt/nf/amfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	bootstrapper := NewBootstrapper(service, newFakeInventory(), newFakeTargets(), newFakeBindings())

	if _, err := bootstrapper.Apply(context.Background(), "plan-outdated", TemplateAuto, []string{"amf"}, "operator"); !errors.Is(err, ErrStalePreview) {
		t.Fatalf("an outdated plan must be rejected, got %v", err)
	}
	if _, err := bootstrapper.Apply(context.Background(), "", TemplateAuto, []string{"amf"}, "operator"); !errors.Is(err, ErrStalePreview) {
		t.Fatalf("a missing plan id must be rejected, got %v", err)
	}
}

func TestBootstrapPlanChangesWhenRuntimeIdentityChanges(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(2201, "amfd", "/opt/nf/amfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)
	bootstrapper := NewBootstrapper(service, newFakeInventory(), newFakeTargets(), newFakeBindings())

	plan, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"amf"})
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	// The process disappears: the approved plan no longer describes reality.
	if _, err := service.scan(context.Background(), TriggerScheduled); err != nil {
		t.Fatalf("scan: %v", err)
	}
	removeFixtureProcess(t, f, 2201)
	if _, err := service.scan(context.Background(), TriggerScheduled); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if _, err := bootstrapper.Apply(context.Background(), plan.PlanID, TemplateAuto, []string{"amf"}, "operator"); !errors.Is(err, ErrStalePreview) {
		t.Fatalf("an identity change must invalidate the plan, got %v", err)
	}
}

func TestBootstrapRequiresGateways(t *testing.T) {
	bootstrapper := &Bootstrapper{}
	if _, err := bootstrapper.Plan(context.Background(), TemplateAuto, nil); !errors.Is(err, ErrBootstrapUnavailable) {
		t.Fatalf("an unwired bootstrapper must fail closed, got %v", err)
	}
	if _, err := bootstrapper.Apply(context.Background(), "x", TemplateAuto, nil, "operator"); !errors.Is(err, ErrBootstrapUnavailable) {
		t.Fatalf("an unwired apply must fail closed, got %v", err)
	}
}

func TestBootstrapRejectsUnknownComponentAndTemplate(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	service := newTestService(t, f, clock)
	bootstrapper := NewBootstrapper(service, newFakeInventory(), newFakeTargets(), newFakeBindings())

	if _, err := bootstrapper.Plan(context.Background(), "unknown", nil); err == nil {
		t.Fatal("an unknown template must be rejected")
	}
	if _, err := bootstrapper.Plan(context.Background(), TemplateAuto, []string{"nope"}); err == nil {
		t.Fatal("an unknown component must be rejected")
	}
	if _, err := bootstrapper.Plan(context.Background(), TemplateIMS, []string{"amf"}); err == nil {
		t.Fatal("a component outside the selected template must be rejected")
	}
}

// -------------------------------------------------------------- freshness

func TestSnapshotExpiresIntoStale(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	f.process(2301, "amfd", "/opt/nf/amfd", 1, 0, 10, 10, nil)
	service := newTestService(t, f, clock)

	clock.advance(10 * time.Minute)
	snapshot := service.Snapshot()
	amf := observationFor(t, snapshot, "amf")
	if amf.RuntimeStatus != StatusStale {
		t.Fatalf("an expired observation must be stale, got %s", amf.RuntimeStatus)
	}
	if amf.PreviousStatus != StatusRunning {
		t.Fatalf("the previous status must be preserved, got %s", amf.PreviousStatus)
	}
}

func TestDisabledServiceNeverReportsStopped(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: fixedTime()}
	scanner := newTestScanner(f, clock)
	service := NewService(scanner, NewMemoryStateStore(), ServiceOptions{
		Enabled: false, Clock: clock.Now, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	snapshot := service.Snapshot()
	for _, observation := range snapshot.Components {
		if observation.RuntimeStatus == StatusStopped {
			t.Fatalf("%s must not be reported as stopped while the scanner is disabled", observation.ComponentID)
		}
		if observation.RuntimeStatus != StatusNotConfigured {
			t.Fatalf("%s must be not_configured, got %s", observation.ComponentID, observation.RuntimeStatus)
		}
	}
	if _, err := service.Rescan(context.Background()); !errors.Is(err, ErrScannerDisabled) {
		t.Fatalf("a disabled scanner must refuse a manual scan, got %v", err)
	}
}
