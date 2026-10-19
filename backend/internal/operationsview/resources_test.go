package operationsview

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"subscriber/internal/inventory"
	"subscriber/internal/nfhealth"
)

/* ------------------------------------------------------------------ fakes -- */

type fakeInventory struct {
	resources  []inventory.Resource
	next       *string
	hasMore    bool
	err        error
	calls      int
	lastFilter inventory.ListFilter
}

func (f *fakeInventory) List(_ context.Context, filter inventory.ListFilter) ([]inventory.Resource, *string, bool, error) {
	f.calls++
	f.lastFilter = filter
	if f.err != nil {
		return nil, nil, false, f.err
	}
	limit := filter.Limit
	if limit <= 0 || limit > len(f.resources) {
		limit = len(f.resources)
	}
	return f.resources[:limit], f.next, f.hasMore, nil
}

type fakeHealth struct {
	targets          []nfhealth.HealthTarget
	targetsTruncated bool
	targetsErr       error
	statuses         map[string]nfhealth.BatchTargetStatus
	statusErr        error
	listCalls        int
	statusCalls      int
	lastFilter       nfhealth.TargetListFilter
	lastTargetIDs    []string
}

func (f *fakeHealth) ListTargets(_ context.Context, filter nfhealth.TargetListFilter) ([]nfhealth.HealthTarget, *string, bool, error) {
	f.listCalls++
	f.lastFilter = filter
	if f.targetsErr != nil {
		return nil, nil, false, f.targetsErr
	}
	return f.targets, nil, f.targetsTruncated, nil
}

func (f *fakeHealth) LatestStatusForTargets(_ context.Context, targetIDs []string) (map[string]nfhealth.BatchTargetStatus, error) {
	f.statusCalls++
	f.lastTargetIDs = targetIDs
	if f.statusErr != nil {
		return nil, f.statusErr
	}
	if f.statuses == nil {
		return map[string]nfhealth.BatchTargetStatus{}, nil
	}
	return f.statuses, nil
}

type fakeBindings map[string]string

func (f fakeBindings) BoundUnit(resourceID string) (string, bool) {
	unit, ok := f[resourceID]
	return unit, ok
}

func resource(id, name, kind string) inventory.Resource {
	return inventory.Resource{
		ResourceID:     id,
		Kind:           kind,
		Name:           name,
		Domain:         "5gc",
		Role:           "smf",
		LifecycleState: "active",
	}
}

func target(id, resourceID string, enabled bool) nfhealth.HealthTarget {
	return nfhealth.HealthTarget{
		TargetID:        id,
		ResourceID:      resourceID,
		Name:            "target-" + id,
		Enabled:         enabled,
		NFType:          "SMF",
		Domain:          "5gc",
		IntervalSeconds: 60,
	}
}

func fixedNow() time.Time { return time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC) }

func newService(inv ResourceInventory, health ResourceHealth, bindings RuntimeBindings) *ResourceService {
	return NewResourceService(inv, health, bindings, fixedNow)
}

func requestResources(handler *ResourceHandler, target, role string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/operations/resources", withPrincipal(role, handler.Resources))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
	return recorder
}

/* ------------------------------------------------------- projection tests -- */

func TestResourcesHandlerRequiresCoreReadAndRejectsInvalidQuery(t *testing.T) {
	inventoryReader := &fakeInventory{}
	handler := NewResourceHandler(newService(inventoryReader, &fakeHealth{}, nil), stubLimiter{}, nil)

	if recorder := requestResources(handler, "/api/operations/resources", ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}
	if recorder := requestResources(handler, "/api/operations/resources?unsupported=value", "viewer"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("unknown query status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if recorder := requestResources(handler, "/api/operations/resources?roles=smf,,amf", "viewer"); recorder.Code != http.StatusBadRequest {
		t.Fatalf("malformed roles status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if inventoryReader.calls != 0 {
		t.Fatalf("invalid requests reached inventory reader %d times, want 0", inventoryReader.calls)
	}
}

func TestResourcesHandlerServesBoundedProjectionToViewer(t *testing.T) {
	inventoryReader := &fakeInventory{resources: []inventory.Resource{
		resource("r-1", "smf", "network_function"),
	}}
	handler := NewResourceHandler(newService(inventoryReader, &fakeHealth{}, nil), stubLimiter{}, nil)

	recorder := requestResources(handler, "/api/operations/resources?roles=smf,smf&limit=1", "viewer")
	if recorder.Code != http.StatusOK {
		t.Fatalf("viewer projection status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if inventoryReader.calls != 1 {
		t.Fatalf("inventory calls = %d, want 1", inventoryReader.calls)
	}
	if got := inventoryReader.lastFilter.Roles; len(got) != 1 || got[0] != "smf" {
		t.Fatalf("deduplicated roles = %#v, want [smf]", got)
	}
	if inventoryReader.lastFilter.Limit != 1 {
		t.Fatalf("inventory limit = %d, want 1", inventoryReader.lastFilter.Limit)
	}
}

func TestProjectionPagesInventoryAndResolvesOneBatch(t *testing.T) {
	resources := make([]inventory.Resource, 0, 60)
	for i := 0; i < 60; i++ {
		resources = append(resources, resource("r-"+itoa(i), "resource-"+itoa(i), "network_function"))
	}
	next := "cursor-1"
	inv := &fakeInventory{resources: resources, next: &next, hasMore: true}
	health := &fakeHealth{targets: []nfhealth.HealthTarget{target("t-0", "r-0", true)}}

	resp, err := newService(inv, health, nil).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	if len(resp.Resources) != 20 {
		t.Fatalf("expected one bounded page of 20, got %d", len(resp.Resources))
	}
	if !resp.Page.HasMore || resp.Page.NextCursor == nil || *resp.Page.NextCursor != "cursor-1" {
		t.Fatalf("cursor envelope must be preserved: %+v", resp.Page)
	}
	if resp.Completeness.Inventory != CompletenessPartial {
		t.Fatalf("a page with more rows behind the cursor is partial, got %q", resp.Completeness.Inventory)
	}
	if resp.Completeness.Monitoring != CompletenessComplete || resp.Completeness.Telemetry != CompletenessComplete {
		t.Fatalf("monitoring/telemetry must be complete: %+v", resp.Completeness)
	}
	if health.listCalls != 1 {
		t.Fatalf("association lookup must be one batch call, got %d", health.listCalls)
	}
	if health.statusCalls != 1 {
		t.Fatalf("status projection must be one batch call, got %d", health.statusCalls)
	}
	if len(health.lastFilter.ResourceIDs) != 20 {
		t.Fatalf("association lookup must cover exactly the page, got %d ids", len(health.lastFilter.ResourceIDs))
	}
	if inv.lastFilter.Limit != 20 {
		t.Fatalf("inventory page limit must be forwarded, got %d", inv.lastFilter.Limit)
	}
	if resp.Resources[0].Association != AssociationConfirmed {
		t.Fatalf("resource r-0 must be confirmed, got %q", resp.Resources[0].Association)
	}
	if resp.Resources[1].Association != AssociationAbsent {
		t.Fatalf("a resolved lookup without a target is a confirmed absence, got %q", resp.Resources[1].Association)
	}
}

func TestAssociationFailureIsUnresolvedNeverUnmonitored(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{resource("r-1", "smf", "network_function")}}
	health := &fakeHealth{targetsErr: errors.New("mongo down")}

	resp, err := newService(inv, health, nil).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if resp.Resources[0].Association != AssociationUnresolved {
		t.Fatalf("failed lookup must be unresolved, got %q", resp.Resources[0].Association)
	}
	if resp.Completeness.Monitoring != CompletenessUnavailable {
		t.Fatalf("monitoring dimension must be unavailable, got %q", resp.Completeness.Monitoring)
	}
	if resp.Completeness.Overall != CompletenessUnavailable {
		t.Fatalf("overall must be unavailable, got %q", resp.Completeness.Overall)
	}
	for _, entry := range resp.Resources {
		if entry.Association == AssociationAbsent {
			t.Fatalf("an unresolved association must never be reported as absent")
		}
	}
}

func TestTelemetryFailureKeepsAssociationAndMarksStatusIncomplete(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{resource("r-1", "smf", "network_function")}}
	health := &fakeHealth{
		targets:   []nfhealth.HealthTarget{target("t-1", "r-1", true)},
		statusErr: errors.New("aggregation failed"),
	}

	resp, err := newService(inv, health, nil).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	entry := resp.Resources[0]
	if entry.Association != AssociationConfirmed {
		t.Fatalf("the association is still authoritative, got %q", entry.Association)
	}
	if entry.Monitoring == nil || entry.Monitoring.StatusComplete {
		t.Fatalf("an unreadable evidence projection must report statusComplete=false")
	}
	if resp.Completeness.Telemetry != CompletenessUnavailable {
		t.Fatalf("telemetry must be unavailable, got %q", resp.Completeness.Telemetry)
	}
}

func TestTruncatedAssociationReadIsPartial(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{
		resource("r-1", "smf", "network_function"),
		resource("r-2", "pcf", "network_function"),
	}}
	health := &fakeHealth{targets: []nfhealth.HealthTarget{target("t-1", "r-1", true)}, targetsTruncated: true}

	resp, err := newService(inv, health, nil).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if resp.Completeness.Monitoring != CompletenessPartial {
		t.Fatalf("a capped association read is partial, got %q", resp.Completeness.Monitoring)
	}
	if resp.Completeness.Telemetry != CompletenessPartial {
		t.Fatalf("a capped association read leaves telemetry partial, got %q", resp.Completeness.Telemetry)
	}
	if resp.Resources[0].Association != AssociationConfirmed {
		t.Fatalf("a returned target remains a confirmed association, got %q", resp.Resources[0].Association)
	}
	if resp.Resources[1].Association != AssociationUnresolved {
		t.Fatalf("an association omitted by a capped read is unresolved, got %q", resp.Resources[1].Association)
	}
}

func TestMonitoringFilterDeclaresPageScope(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{
		resource("r-1", "smf", "network_function"),
		resource("r-2", "pcf", "network_function"),
	}}
	health := &fakeHealth{targets: []nfhealth.HealthTarget{target("t-1", "r-1", true)}}

	resp, err := newService(inv, health, nil).Build(context.Background(), ResourceQuery{
		Limit:      20,
		Monitoring: MonitoringMonitored,
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if len(resp.Resources) != 1 || resp.Resources[0].ResourceID != "r-1" {
		t.Fatalf("filter must keep only monitored resources: %+v", resp.Resources)
	}
	if resp.Page.FilterScope != FilterScopePage {
		t.Fatalf("a page-evaluated filter must declare its scope, got %q", resp.Page.FilterScope)
	}
	if resp.Page.FilteredCount == nil || *resp.Page.FilteredCount != 1 {
		t.Fatalf("filtered count must be reported")
	}
}

func TestDuplicateTargetsPreferTheEnabledOne(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{resource("r-1", "smf", "network_function")}}
	health := &fakeHealth{targets: []nfhealth.HealthTarget{
		target("t-disabled", "r-1", false),
		target("t-enabled", "r-1", true),
	}}

	resp, err := newService(inv, health, nil).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	entry := resp.Resources[0]
	if entry.Monitoring == nil || entry.Monitoring.TargetID != "t-enabled" {
		t.Fatalf("the enabled target must win, got %+v", entry.Monitoring)
	}
}

func TestRuntimeBindingSummary(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{
		resource("r-1", "smf", "network_function"),
		resource("r-2", "pcf", "network_function"),
	}}
	health := &fakeHealth{}
	bindings := fakeBindings{"r-1": "smfd.service"}

	resp, err := newService(inv, health, bindings).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if resp.Resources[0].RuntimeBinding.State != RuntimeBindingBound || resp.Resources[0].RuntimeBinding.Unit != "smfd.service" {
		t.Fatalf("bound resource must report its unit: %+v", resp.Resources[0].RuntimeBinding)
	}
	if resp.Resources[1].RuntimeBinding.State != RuntimeBindingUnbound {
		t.Fatalf("unbound resource must be explicit: %+v", resp.Resources[1].RuntimeBinding)
	}
}

func TestUnknownBindingsRegistryReportsUnknown(t *testing.T) {
	inv := &fakeInventory{resources: []inventory.Resource{resource("r-1", "smf", "network_function")}}
	resp, err := newService(inv, &fakeHealth{}, nil).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if resp.Resources[0].RuntimeBinding.State != RuntimeBindingUnknown {
		t.Fatalf("a missing registry is unknown, never unbound")
	}
}

func TestInventoryErrorIsReturned(t *testing.T) {
	inv := &fakeInventory{err: errors.New("bad cursor")}
	if _, err := newService(inv, &fakeHealth{}, nil).Build(context.Background(), ResourceQuery{}); err == nil {
		t.Fatalf("an inventory read error must be returned to the caller")
	}
}

func TestNoResourcesSkipsTheAssociationRead(t *testing.T) {
	inv := &fakeInventory{}
	health := &fakeHealth{}
	resp, err := newService(inv, health, nil).Build(context.Background(), ResourceQuery{Limit: 20})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if health.listCalls != 0 {
		t.Fatalf("an empty page must not query the health authority")
	}
	if resp.Completeness.Overall != CompletenessComplete {
		t.Fatalf("an empty complete page is complete, got %q", resp.Completeness.Overall)
	}
	if resp.Resources == nil {
		t.Fatalf("resources must serialise as an empty array, never null")
	}
}

/* -------------------------------------------------------- filter predicate -- */

func TestMonitoringPredicateSeparatesEveryBucket(t *testing.T) {
	confirmed := OperationsResource{Association: AssociationConfirmed, Monitoring: &ResourceMonitoring{OverallState: "healthy"}}
	unmonitored := OperationsResource{Association: AssociationAbsent}
	unresolved := OperationsResource{Association: AssociationUnresolved}
	degraded := OperationsResource{Association: AssociationConfirmed, Monitoring: &ResourceMonitoring{OverallState: "degraded"}}
	stale := OperationsResource{Association: AssociationConfirmed, Monitoring: &ResourceMonitoring{OverallState: "stale"}}
	unknown := OperationsResource{Association: AssociationConfirmed, Monitoring: &ResourceMonitoring{OverallState: "unknown"}}
	notConfigured := OperationsResource{Association: AssociationConfirmed, Monitoring: &ResourceMonitoring{OverallState: "not_configured"}}

	cases := []struct {
		filter string
		entry  OperationsResource
		want   bool
	}{
		{MonitoringMonitored, confirmed, true},
		{MonitoringMonitored, unmonitored, false},
		{MonitoringUnmonitored, unmonitored, true},
		{MonitoringUnmonitored, unresolved, false},
		{MonitoringUnresolved, unresolved, true},
		{MonitoringUnresolved, unmonitored, false},
		{MonitoringDegraded, degraded, true},
		{MonitoringDegraded, confirmed, false},
		{MonitoringStale, stale, true},
		{MonitoringStale, confirmed, false},
		{MonitoringUnknown, unknown, true},
		{MonitoringUnknown, notConfigured, true},
		{MonitoringUnknown, confirmed, false},
	}
	for _, tc := range cases {
		if got := matchesMonitoringFilter(tc.entry, tc.filter); got != tc.want {
			t.Fatalf("filter %q on %+v: got %v want %v", tc.filter, tc.entry, got, tc.want)
		}
	}
}

/* ------------------------------------------------------------- validation -- */

func TestParseRolesDeduplicatesAndBounds(t *testing.T) {
	roles, err := parseRoles("smf, smf ,pcf")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roles) != 2 || roles[0] != "smf" || roles[1] != "pcf" {
		t.Fatalf("roles must be de-duplicated in order, got %v", roles)
	}

	if _, err := parseRoles("smf,,pcf"); err == nil {
		t.Fatalf("an empty role value must be rejected")
	}
	if _, err := parseRoles(""); err != nil {
		t.Fatalf("an absent roles parameter is valid: %v", err)
	}
}

func TestParseRolesAcceptsTheReferenceSkeletonAndRefusesUnboundedQueries(t *testing.T) {
	// The architecture canvas asks for every role token of its skeleton. The
	// filter must accept that legitimate bound and still refuse an unbounded one.
	skeleton := []string{
		"amf", "mme", "smf", "sgw-c", "sgwc", "pgw-c", "pgwc", "nrf", "nssf", "bsf",
		"scp", "udm", "udr", "ausf", "pcf", "hss", "ocs", "dra", "pcrf", "upf",
		"sgw-u", "sgwu", "pgw-u", "pgwu",
	}
	if len(skeleton) > ResourceMaxRoles {
		t.Fatalf("the reference skeleton must fit inside the bound")
	}
	roles, err := parseRoles(strings.Join(skeleton, ","))
	if err != nil {
		t.Fatalf("the reference skeleton must be accepted: %v", err)
	}
	if len(roles) != len(skeleton) {
		t.Fatalf("every skeleton role must survive: got %d", len(roles))
	}

	over := make([]string, 0, ResourceMaxRoles+1)
	for i := 0; i <= ResourceMaxRoles; i++ {
		over = append(over, "role-"+itoa(i))
	}
	if _, err := parseRoles(strings.Join(over, ",")); err == nil {
		t.Fatalf("more than %d roles must be rejected", ResourceMaxRoles)
	}
}

func TestRolesFilterIsForwardedToInventory(t *testing.T) {
	inv := &fakeInventory{}
	_, err := newService(inv, &fakeHealth{}, nil).Build(context.Background(), ResourceQuery{
		Limit: 20,
		Roles: []string{"smf", "pcf"},
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if len(inv.lastFilter.Roles) != 2 {
		t.Fatalf("roles must be forwarded to the inventory query, got %v", inv.lastFilter.Roles)
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
