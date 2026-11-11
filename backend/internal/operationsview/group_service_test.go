package operationsview

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"subscriber/internal/agents"
	"subscriber/internal/auth"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/nfalert"
	"subscriber/internal/nfhealth"
	"subscriber/internal/topology"
)

func groupTestID(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012x", n) }
func groupTestResource(n int, kind string, scopes ...inventory.OperationalScope) inventory.Resource {
	r := inventory.Resource{ResourceID: groupTestID(n), Kind: kind, Name: fmt.Sprintf("resource-%d", n), Domain: inventory.DomainPlatform, LifecycleState: inventory.LifecycleActive, Revision: 1, Attributes: map[string]any{}}
	if scopes != nil {
		r.Attributes[inventory.OperationalScopesAttribute] = scopes
	}
	return r
}
func groupTestEdge(n, from, to int, rel string) topology.Edge {
	return topology.Edge{EdgeID: groupTestID(n + 10000), FromResourceID: groupTestID(from), ToResourceID: groupTestID(to), RelationshipType: rel, LifecycleState: topology.LifecycleActive, Revision: 1}
}

type groupStoreFixture struct {
	resources                                    map[string]inventory.Resource
	edges                                        []topology.Edge
	agents                                       []agents.Record
	alerts                                       []nfalert.Alert
	resourceFail, edgeFail, agentFail, alertFail bool
}

func groupFixture(resources ...inventory.Resource) *groupStoreFixture {
	f := &groupStoreFixture{resources: map[string]inventory.Resource{}}
	for _, r := range resources {
		f.resources[r.ResourceID] = r
	}
	return f
}
func (f *groupStoreFixture) Resource(_ context.Context, id string) (*inventory.Resource, error) {
	if f.resourceFail {
		return nil, errors.New("down")
	}
	r, ok := f.resources[id]
	if !ok {
		return nil, inventory.ErrNotFound
	}
	return &r, nil
}
func (f *groupStoreFixture) Resources(_ context.Context, q GroupFilter, ids []string, limit int) ([]inventory.Resource, bool, error) {
	if f.resourceFail {
		return nil, false, errors.New("down")
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	out := []inventory.Resource{}
	for _, r := range f.resources {
		if ids != nil && !wanted[r.ResourceID] {
			continue
		}
		if !matchesGroupResource(r, q) {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ResourceID < out[j].ResourceID })
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}
func (f *groupStoreFixture) Edges(_ context.Context, ids []string, direction string, limit int) ([]topology.Edge, bool, error) {
	if f.edgeFail {
		return nil, false, errors.New("down")
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	out := []topology.Edge{}
	for _, e := range f.edges {
		id := e.FromResourceID
		if direction == "inbound" {
			id = e.ToResourceID
		}
		if wanted[id] && e.RelationshipType == topology.RelationshipContains && e.LifecycleState == topology.LifecycleActive {
			out = append(out, e)
		}
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}
func (f *groupStoreFixture) Directory(_ context.Context, q GroupQuery) ([]GroupEntry, bool, error) {
	out := []GroupEntry{}
	keys := map[string]bool{}
	for _, r := range f.resources {
		if !q.IncludeRetired && r.LifecycleState == inventory.LifecycleRetired {
			continue
		}
		if q.GroupBy == "site" && r.Kind == inventory.KindSite {
			out = append(out, GroupEntry{Key: r.ResourceID, Name: r.Name, Kind: "site"})
		}
		if q.GroupBy == "network" {
			scopes, _ := inventory.OperationalScopesForResource(r)
			for _, s := range scopes {
				keys[s.NetworkKey] = true
			}
		}
	}
	if q.GroupBy == "network" {
		for _, a := range f.agents {
			keys[a.Scope.NetworkKey] = true
		}
		for key := range keys {
			out = append(out, GroupEntry{Key: key, Name: key, Kind: "network"})
		}
	}
	return out, false, nil
}
func (f *groupStoreFixture) Agents(_ context.Context, q GroupFilter, limit int) ([]agents.Record, bool, error) {
	if f.agentFail {
		return nil, false, errors.New("down")
	}
	out := []agents.Record{}
	for _, a := range f.agents {
		s := a.Scope
		if q.NetworkKey != "" && s.NetworkKey != q.NetworkKey || q.SiteResourceID != "" && s.SiteResourceID != q.SiteResourceID || q.HostResourceID != "" && s.HostResourceID != q.HostResourceID || q.OperatorName != "" && s.OperatorName != q.OperatorName {
			continue
		}
		if q.PLMN != "" {
			match := false
			for _, p := range s.PLMNs {
				match = match || p == q.PLMN
			}
			if !match {
				continue
			}
		}
		out = append(out, a)
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}

func (f *groupStoreFixture) AgentsForHosts(ctx context.Context, ids []string, limit int) ([]agents.Record, bool, error) {
	all, _, e := f.Agents(ctx, GroupFilter{}, GroupMaxAgents)
	if e != nil {
		return nil, false, e
	}
	hosts := map[string]bool{}
	for _, id := range ids {
		hosts[id] = true
	}
	out := []agents.Record{}
	for _, a := range all {
		if hosts[a.Scope.HostResourceID] {
			out = append(out, a)
		}
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}
func (f *groupStoreFixture) Alerts(_ context.Context, ids []string, q GroupQuery, after string) ([]nfalert.Alert, int, error) {
	if f.alertFail {
		return nil, 0, errors.New("down")
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	all := []nfalert.Alert{}
	for _, a := range f.alerts {
		if !wanted[a.ResourceID] || a.State == nfalert.AlertStateResolved || q.Severity != "" && q.Severity != a.Severity {
			continue
		}
		all = append(all, a)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].AlertID < all[j].AlertID })
	rows := []nfalert.Alert{}
	for _, a := range all {
		if a.AlertID > after && len(rows) < q.Limit+1 {
			rows = append(rows, a)
		}
	}
	return rows, len(all), nil
}

type groupHealthFixture struct {
	calls    []int
	failCall int
	targets  map[string]nfhealth.HealthTarget
}

func (f *groupHealthFixture) ListTargets(_ context.Context, q nfhealth.TargetListFilter) ([]nfhealth.HealthTarget, *string, bool, error) {
	f.calls = append(f.calls, len(q.ResourceIDs))
	if len(f.calls) == f.failCall {
		return nil, nil, false, errors.New("down")
	}
	rows := []nfhealth.HealthTarget{}
	for _, id := range q.ResourceIDs {
		if t, ok := f.targets[id]; ok {
			rows = append(rows, t)
		}
	}
	return rows, nil, false, nil
}
func (f *groupHealthFixture) LatestStatusForTargets(context.Context, []string) (map[string]nfhealth.BatchTargetStatus, error) {
	return map[string]nfhealth.BatchTargetStatus{}, nil
}

func TestGroupContainmentDeduplicatesAndNeverInheritsNetwork(t *testing.T) {
	a := inventory.OperationalScope{NetworkKey: "a", OperatorName: "A", PLMNs: []string{"00101"}}
	f := groupFixture(groupTestResource(1, "site", a), groupTestResource(2, "host", a), groupTestResource(3, "host"), groupTestResource(4, "network_function"), groupTestResource(5, "network_function_instance", a), groupTestResource(6, "network_function", a))
	f.edges = []topology.Edge{groupTestEdge(1, 1, 2, "contains"), groupTestEdge(2, 1, 3, "contains"), groupTestEdge(3, 2, 4, "contains"), groupTestEdge(4, 3, 4, "contains"), groupTestEdge(5, 2, 5, "contains"), groupTestEdge(6, 1, 6, "runs_on")}
	s := NewGroupService(f, &groupHealthFixture{}, nil)
	scope, e := s.ResolveGroupScope(context.Background(), GroupFilter{SiteResourceID: groupTestID(1)})
	if e != nil || len(scope.IDs) != 5 {
		t.Fatalf("declared membership: %#v %v", scope.IDs, e)
	}
	scope, e = s.ResolveGroupScope(context.Background(), GroupFilter{SiteResourceID: groupTestID(1), NetworkKey: "a"})
	if e != nil || len(scope.IDs) != 3 {
		t.Fatalf("network inheritance or duplicate identity: %#v %v", scope.IDs, e)
	}
	for _, id := range scope.IDs {
		if id == groupTestID(4) || id == groupTestID(6) {
			t.Fatal("inferred a network or used runs_on")
		}
	}
	summary, e := s.Summary(context.Background(), GroupFilter{SiteResourceID: groupTestID(1)})
	if e != nil || summary.Counts["logicalFunctions"] == nil || *summary.Counts["logicalFunctions"] != 1 || *summary.Counts["instances"] != 1 || *summary.Counts["hosts"] != 2 {
		t.Fatalf("population changed: %#v %v", summary, e)
	}
}
func TestGroupSelectorsMatchOneDeclarationAndPreservePLMN(t *testing.T) {
	a := inventory.OperationalScope{NetworkKey: "a", OperatorName: "A", PLMNs: []string{"00101"}}
	b := inventory.OperationalScope{NetworkKey: "b", OperatorName: "B", PLMNs: []string{"001001"}}
	f := groupFixture(groupTestResource(1, "host", a, b))
	s := NewGroupService(f, nil, nil)
	for _, q := range []GroupFilter{{NetworkKey: "a", PLMN: "001001"}, {NetworkKey: "a", OperatorName: "B"}, {NetworkKey: "b", PLMN: "00101"}} {
		scope, e := s.ResolveGroupScope(context.Background(), q)
		if e != nil || len(scope.IDs) != 0 {
			t.Fatalf("crossed declaration elements: %#v", q)
		}
	}
	scope, _ := s.ResolveGroupScope(context.Background(), GroupFilter{NetworkKey: "b", PLMN: "001001"})
	if len(scope.IDs) != 1 {
		t.Fatal("six digit PLMN lost")
	}
}
func TestGroupLimitsFailuresAndCursorMembership(t *testing.T) {
	f := groupFixture(groupTestResource(1, "site"))
	for i := 2; i <= 1002; i++ {
		r := groupTestResource(i, "host")
		f.resources[r.ResourceID] = r
		f.edges = append(f.edges, groupTestEdge(i, 1, i, "contains"))
	}
	s := NewGroupService(f, nil, nil)
	summary, e := s.Summary(context.Background(), GroupFilter{SiteResourceID: groupTestID(1)})
	if e != nil || summary.Scope.Topology.Completeness != "partial" || summary.Counts["hosts"] != nil || summary.Counts["alertsOpen"] != nil {
		t.Fatalf("bounded read invented totals: %#v %v", summary, e)
	}
	f = groupFixture(groupTestResource(1, "host"), groupTestResource(2, "host"))
	s = NewGroupService(f, nil, nil)
	q := GroupQuery{Section: "resources", Limit: 1}
	page, e := s.Members(context.Background(), q)
	if e != nil || !page.HasMore {
		t.Fatal(e)
	}
	q.Cursor = *page.NextCursor
	r := f.resources[groupTestID(1)]
	r.Revision++
	f.resources[r.ResourceID] = r
	if _, e = s.Members(context.Background(), q); e == nil || !strings.Contains(e.Error(), "scope_changed") {
		t.Fatal("cursor survived membership revision")
	}
	f.resourceFail = true
	summary, e = s.Summary(context.Background(), GroupFilter{})
	if e != nil || summary.Counts["hosts"] != nil || summary.Counts["alertsOpen"] != nil {
		t.Fatal("source failure became a complete zero")
	}
}
func TestGroupAncestryCyclesAndMissingReferences(t *testing.T) {
	f := groupFixture(groupTestResource(1, "site"), groupTestResource(2, "host"))
	f.edges = []topology.Edge{groupTestEdge(1, 1, 2, "contains"), groupTestEdge(2, 2, 1, "contains")}
	s := NewGroupService(f, nil, nil)
	first, e := s.ResolveGroupScope(context.Background(), GroupFilter{SiteResourceID: groupTestID(1)})
	if e != nil || len(first.IDs) != 2 {
		t.Fatal("cycle traversal did not terminate")
	}
	for i := 0; i < 10; i++ {
		next, _ := s.ResolveGroupScope(context.Background(), GroupFilter{SiteResourceID: groupTestID(1)})
		a, _ := json.Marshal(first.Issues)
		b, _ := json.Marshal(next.Issues)
		if string(a) != string(b) {
			t.Fatal("cycle diagnostics are nondeterministic")
		}
	}
	f.edges = []topology.Edge{groupTestEdge(1, 99, 2, "contains")}
	_, issues, cov := s.assignmentGraph(context.Background(), []string{groupTestID(2)})
	if cov.Completeness == "complete" {
		t.Fatal("missing ancestor established absence")
	}
	for _, i := range issues {
		if i.Code == "unassigned_site" {
			t.Fatal("unknown ancestry became unassigned")
		}
	}
}
func TestGroupHealthIsBoundedAndUnresolvedIsNotUnmonitored(t *testing.T) {
	f := groupFixture()
	for i := 1; i <= 51; i++ {
		r := groupTestResource(i, "network_function")
		f.resources[r.ResourceID] = r
	}
	h := &groupHealthFixture{failCall: 2}
	s := NewGroupService(f, h, nil)
	page, e := s.Members(context.Background(), GroupQuery{Section: "resources", Limit: 100})
	if e != nil || page.Coverage.Completeness != "unavailable" {
		t.Fatalf("missing health coverage: %v", e)
	}
	absent, unresolved := 0, 0
	for _, v := range page.Items {
		r := v.(GroupResource)
		if r.Association == AssociationAbsent {
			absent++
		}
		if r.Association == AssociationUnresolved {
			unresolved++
		}
	}
	if absent != 50 || unresolved != 1 {
		t.Fatalf("absent=%d unresolved=%d", absent, unresolved)
	}
	for _, n := range h.calls {
		if n > 50 {
			t.Fatal("unbounded target lookup")
		}
	}
}
func TestGroupMetadataOnlyAgentAndConfigurationProjection(t *testing.T) {
	a := inventory.OperationalScope{NetworkKey: "b", OperatorName: "B", PLMNs: []string{}}
	f := groupFixture(groupTestResource(1, "site"), groupTestResource(2, "host", a))
	f.edges = []topology.Edge{groupTestEdge(1, 1, 2, "contains")}
	now := time.Now().UTC()
	f.agents = []agents.Record{{AgentID: "01234567890123456789012345678901", Metadata: agents.Metadata{Name: "agent", Scope: agents.Scope{NetworkKey: "a", SiteResourceID: groupTestID(1), HostResourceID: groupTestID(2)}}, Enabled: true, LastReceivedAt: &now, KeyHash: "private-key", SessionHash: "private-session"}}
	config := func(_ context.Context, q configsnapshots.ListQuery) (*configsnapshots.SourceList, error) {
		if q.ResourceIDs == nil {
			t.Fatal("config scope fell back to global")
		}
		return &configsnapshots.SourceList{Page: configsnapshots.Page[configsnapshots.SourceView]{Items: []configsnapshots.SourceView{{Source: configsnapshots.Source{SourceID: groupTestID(11), ResourceID: groupTestID(2), Path: "/private/config"}, LatestSnapshot: &configsnapshots.Snapshot{Projection: "private-original"}}}}, CatalogState: "configured", Completeness: "complete"}, nil
	}
	s := NewGroupService(f, nil, config)
	scope, _ := s.ResolveGroupScope(context.Background(), GroupFilter{NetworkKey: "a"})
	agentRows, _ := s.agentRows(context.Background(), scope.Filter)
	issues, _ := s.issues(context.Background(), scope, agentRows)
	conflict := false
	for _, i := range issues {
		conflict = conflict || i.Code == "agent_network_conflict"
	}
	if !conflict {
		t.Fatal("agent metadata overrode host declaration")
	}
	page, e := s.Members(context.Background(), GroupQuery{Section: "agents", Limit: 50})
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(page)
	if strings.Contains(string(b), "private-") {
		t.Fatal("agent secret leaked")
	}
	page, e = s.Members(context.Background(), GroupQuery{Section: "config", Limit: 50})
	if e != nil {
		t.Fatal(e)
	}
	b, _ = json.Marshal(page)
	if strings.Contains(string(b), "private") {
		t.Fatal("configuration content or path leaked")
	}
}
func TestGroupDirectoryFindsCanonicalSiteForAgentOnlyNetwork(t *testing.T) {
	f := groupFixture(groupTestResource(1, "site"), groupTestResource(2, "host"))
	f.edges = []topology.Edge{groupTestEdge(1, 1, 2, "contains")}
	f.agents = []agents.Record{{Metadata: agents.Metadata{Scope: agents.Scope{NetworkKey: "a", SiteResourceID: groupTestID(1), HostResourceID: groupTestID(2)}}}}
	s := NewGroupService(f, nil, nil)
	page, e := s.Directory(context.Background(), GroupQuery{GroupFilter: GroupFilter{NetworkKey: "a"}, GroupBy: "site", Limit: 50})
	if e != nil || len(page.Items) != 1 || page.Items[0].(GroupEntry).Key != groupTestID(1) {
		t.Fatalf("agent-only site lost: %#v %v", page, e)
	}
}
func TestGroupHTTPValidationAndReadPermission(t *testing.T) {
	s := NewGroupService(groupFixture(groupTestResource(1, "host")), nil, nil)
	h := NewGroupHandler(s, nil, nil)
	for _, tc := range []struct {
		query  string
		status int
	}{{"unknown=x", 400}, {"networkKey=a&networkKey=b", 400}, {"siteResourceId=" + groupTestID(1), 400}, {"siteResourceId=" + groupTestID(99), 404}, {"plmn=00101", 200}, {"domain=unsupported", 400}, {"includeRetired=true", 400}, {"cursor=invalid", 400}} {
		r := httptest.NewRequest("GET", "/api/operations/groups/members?"+tc.query, nil)
		r = r.WithContext(auth.ContextWithPrincipal(r.Context(), &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}))
		w := httptest.NewRecorder()
		h.Handle(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s: got %d want %d", tc.query, w.Code, tc.status)
		}
	}
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest("GET", "/api/operations/groups", nil))
	if w.Code != 401 {
		t.Fatal("anonymous read accepted")
	}
	for _, raw := range []string{"plmn=001001", "operatorName=A%20B", "networkKey=lab.a"} {
		v, _ := url.ParseQuery(raw)
		if _, e := ParseGroupQuery(v); e != nil {
			t.Fatal(e)
		}
	}
}
