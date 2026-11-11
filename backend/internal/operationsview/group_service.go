package operationsview

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"subscriber/internal/agents"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/nfhealth"
)

type GroupService struct {
	store  GroupStore
	health ResourceHealth
	config func(context.Context, configsnapshots.ListQuery) (*configsnapshots.SourceList, error)
	now    func() time.Time
}

func NewGroupService(store GroupStore, health ResourceHealth, config func(context.Context, configsnapshots.ListQuery) (*configsnapshots.SourceList, error)) *GroupService {
	return &GroupService{store: store, health: health, config: config, now: time.Now}
}

type GroupResource struct {
	inventory.Resource
	OperationalScopes []inventory.OperationalScope `json:"operationalScopes"`
	DeclarationState  string                       `json:"declarationState"`
	Association       string                       `json:"association"`
	Monitoring        *ResourceMonitoring          `json:"monitoring"`
}

func (s *GroupService) healthResources(ctx context.Context, scope GroupScope) ([]GroupResource, GroupCoverage) {
	rows := make([]GroupResource, 0, len(scope.Resources))
	coverage := completeGroup()
	for _, r := range scope.Resources {
		decl, e := inventory.OperationalScopesForResource(r)
		state := "declared"
		if e != nil {
			state = "invalid"
			decl = []inventory.OperationalScope{}
		} else if len(decl) == 0 {
			state = "unassigned"
		}
		association := AssociationUnresolved
		if !isNetworkFunctionKind(r.Kind) || r.LifecycleState == inventory.LifecycleRetired {
			association = "not_applicable"
		}
		rows = append(rows, GroupResource{Resource: r, OperationalScopes: decl, DeclarationState: state, Association: association})
	}
	for start := 0; start < len(rows); start += 50 {
		end := min(start+50, len(rows))
		ids := []string{}
		for _, r := range rows[start:end] {
			if r.Association != "not_applicable" {
				ids = append(ids, r.ResourceID)
			}
		}
		if len(ids) == 0 {
			continue
		}
		if s.health == nil {
			degradeGroup(&coverage, CompletenessUnavailable, "monitoring_unavailable")
			continue
		}
		targets, _, more, e := s.health.ListTargets(ctx, nfhealth.TargetListFilter{ResourceIDs: ids, Limit: 50})
		if e != nil {
			degradeGroup(&coverage, CompletenessUnavailable, "monitoring_unavailable")
			continue
		}
		byID := map[string]nfhealth.HealthTarget{}
		targetIDs := []string{}
		for _, t := range targets {
			old, exists := byID[t.ResourceID]
			if exists {
				degradeGroup(&coverage, CompletenessPartial, "duplicate_target")
				if old.Enabled || !t.Enabled {
					continue
				}
			}
			byID[t.ResourceID] = t
		}
		for _, t := range byID {
			targetIDs = append(targetIDs, t.TargetID)
		}
		status := map[string]nfhealth.BatchTargetStatus{}
		statusOK := true
		if len(targetIDs) > 0 {
			status, e = s.health.LatestStatusForTargets(ctx, targetIDs)
			if e != nil {
				statusOK = false
				degradeGroup(&coverage, CompletenessUnavailable, "telemetry_unavailable")
			}
		}
		if more {
			degradeGroup(&coverage, CompletenessPartial, "target_limit")
		}
		for i := start; i < end; i++ {
			if rows[i].Association == "not_applicable" {
				continue
			}
			t, found := byID[rows[i].ResourceID]
			if found {
				rows[i].Association = AssociationConfirmed
				rows[i].Monitoring = buildResourceMonitoring(t, status[t.TargetID], statusOK, s.now().UTC())
			} else if !more {
				rows[i].Association = AssociationAbsent
			}
		}
	}
	coverage.ObservedCount = len(rows)
	return rows, coverage
}

func (s *GroupService) configRows(ctx context.Context, scope GroupScope) ([]configsnapshots.SourceView, GroupCoverage) {
	c := completeGroup()
	rows := []configsnapshots.SourceView{}
	if s.config == nil {
		c.Completeness = CompletenessUnavailable
		c.Reason = "config_sources_not_configured"
		return rows, c
	}
	cursor := ""
	for {
		page, e := s.config(ctx, configsnapshots.ListQuery{Limit: 200, Cursor: cursor, ResourceIDs: scope.IDs})
		if e != nil || page == nil {
			degradeGroup(&c, CompletenessUnavailable, "config_unavailable")
			break
		}
		if page.CatalogState != "configured" {
			degradeGroup(&c, CompletenessUnavailable, "config_sources_not_configured")
		}
		if page.Completeness != CompletenessComplete {
			degradeGroup(&c, page.Completeness, "config_unavailable")
		}
		for _, v := range page.Items {
			v.LatestSnapshot = nil
			rows = append(rows, v)
		}
		if len(rows) > GroupMaxResources {
			rows = rows[:GroupMaxResources]
			degradeGroup(&c, CompletenessPartial, "source_limit")
			break
		}
		if !page.HasMore {
			break
		}
		if page.NextCursor == nil || *page.NextCursor == cursor {
			degradeGroup(&c, CompletenessPartial, "source_cursor")
			break
		}
		cursor = *page.NextCursor
	}
	c.ObservedCount = len(rows)
	return rows, c
}
func (s *GroupService) agentRows(ctx context.Context, f GroupFilter) ([]agents.View, GroupCoverage) {
	c := completeGroup()
	out := []agents.View{}
	if f.Domain != "" {
		c.Completeness = CompletenessUnavailable
		c.Reason = "unsupported_filter"
		return out, c
	}
	rows, more, e := s.store.Agents(ctx, f, GroupMaxAgents)
	if e != nil {
		c.Completeness = CompletenessUnavailable
		c.Reason = "agents_unavailable"
		return out, c
	}
	if more {
		degradeGroup(&c, CompletenessPartial, "agent_limit")
	}
	for i := range rows {
		out = append(out, agents.ListView(&rows[i], s.now().UTC()))
	}
	c.ObservedCount = len(out)
	return out, c
}

func (s *GroupService) issues(ctx context.Context, scope GroupScope, agentRows []agents.View) ([]GroupIssue, GroupCoverage) {
	refCoverage := completeGroup()
	if store, ok := s.store.(GroupAgentReferenceStore); ok {
		hosts := []string{}
		for _, r := range scope.Resources {
			if r.Kind == inventory.KindHost {
				hosts = append(hosts, r.ResourceID)
			}
		}
		if len(hosts) > 0 {
			related, more, e := store.AgentsForHosts(ctx, hosts, GroupMaxAgents)
			if e != nil {
				degradeGroup(&refCoverage, CompletenessUnavailable, "agents_unavailable")
			}
			if more {
				degradeGroup(&refCoverage, CompletenessPartial, "agent_limit")
			}
			known := map[string]bool{}
			for _, a := range agentRows {
				known[a.AgentID] = true
			}
			for i := range related {
				if known[related[i].AgentID] {
					continue
				}
				if len(agentRows) >= GroupMaxAgents {
					degradeGroup(&refCoverage, CompletenessPartial, "agent_limit")
					break
				}
				agentRows = append(agentRows, agents.ListView(&related[i], s.now().UTC()))
				known[related[i].AgentID] = true
			}
		}
	}
	ids := append([]string{}, scope.IDs...)
	for _, a := range agentRows {
		if a.Scope.HostResourceID != "" {
			ids = append(ids, a.Scope.HostResourceID)
		}
		if a.Scope.SiteResourceID != "" {
			ids = append(ids, a.Scope.SiteResourceID)
		}
	}
	sites, more, c := s.assignmentGraph(ctx, ids)
	if refCoverage.Completeness != CompletenessComplete {
		degradeGroup(&c, refCoverage.Completeness, refCoverage.Reason)
	}
	issues := append(append([]GroupIssue{}, scope.Issues...), more...)
	refs := map[string]bool{}
	for _, a := range agentRows {
		if a.Scope.HostResourceID != "" {
			refs[a.Scope.HostResourceID] = true
		}
		if a.Scope.SiteResourceID != "" {
			refs[a.Scope.SiteResourceID] = true
		}
	}
	wanted := []string{}
	for id := range refs {
		wanted = append(wanted, id)
	}
	byID := map[string]inventory.Resource{}
	for _, r := range scope.Resources {
		byID[r.ResourceID] = r
	}
	if len(wanted) > 0 {
		rows, limited, e := s.store.Resources(ctx, GroupFilter{IncludeRetired: true}, wanted, 2*GroupMaxAgents)
		if e != nil {
			degradeGroup(&c, CompletenessUnavailable, "inventory_unavailable")
		}
		if limited {
			degradeGroup(&c, CompletenessPartial, "scope_limit")
		}
		for _, r := range rows {
			byID[r.ResourceID] = r
		}
	}
	operators := map[string]map[string]bool{}
	addOperator := func(key, name string) {
		if name == "" || scope.Filter.NetworkKey != "" && scope.Filter.NetworkKey != key {
			return
		}
		if operators[key] == nil {
			operators[key] = map[string]bool{}
		}
		operators[key][name] = true
	}
	for _, r := range scope.Resources {
		scopes, e := inventory.OperationalScopesForResource(r)
		for _, d := range scopes {
			addOperator(d.NetworkKey, d.OperatorName)
		}
		if e == nil && len(scopes) == 0 && (r.Kind == inventory.KindSite || r.Kind == inventory.KindHost || isNetworkFunctionKind(r.Kind)) {
			issues = append(issues, groupIssue("unassigned_network", r.ResourceID, "", ""))
		}
	}
	for _, a := range agentRows {
		addOperator(a.Scope.NetworkKey, a.Scope.OperatorName)
		host, site := a.Scope.HostResourceID, a.Scope.SiteResourceID
		if host == "" {
			issues = append(issues, groupIssue("agent_host_unbound", site, "", a.AgentID))
			continue
		}
		if site != "" && c.Completeness == CompletenessComplete && !sites[host][site] {
			issues = append(issues, groupIssue("agent_site_conflict", host, site, a.AgentID))
		}
		if r, ok := byID[host]; ok {
			decl, e := inventory.OperationalScopesForResource(r)
			if e == nil && len(decl) > 0 {
				match := false
				for _, d := range decl {
					match = match || d.NetworkKey == a.Scope.NetworkKey
				}
				if !match {
					issues = append(issues, groupIssue("agent_network_conflict", host, a.Scope.NetworkKey, a.AgentID))
				}
			}
		}
	}
	for key, names := range operators {
		if len(names) > 1 {
			issues = append(issues, groupIssue("operator_name_conflict", "", key, ""))
		}
	}
	seen := map[string]bool{}
	unique := []GroupIssue{}
	for _, i := range issues {
		if !seen[i.ID] {
			seen[i.ID] = true
			unique = append(unique, i)
		}
	}
	sort.Slice(unique, func(i, j int) bool { return unique[i].ID < unique[j].ID })
	c.ObservedCount = len(unique)
	return unique, c
}

func scopeCoverage(scope GroupScope, c GroupCoverage) GroupCoverage {
	if scope.Inventory.Completeness != CompletenessComplete {
		degradeGroup(&c, scope.Inventory.Completeness, scope.Inventory.Reason)
	}
	if scope.Topology.Completeness != CompletenessComplete {
		degradeGroup(&c, scope.Topology.Completeness, scope.Topology.Reason)
	}
	return c
}
func groupCount(n int, c GroupCoverage) *int {
	if c.Completeness != CompletenessComplete {
		return nil
	}
	return &n
}

func (s *GroupService) Summary(ctx context.Context, f GroupFilter) (*GroupSummary, error) {
	scope, e := s.ResolveGroupScope(ctx, f)
	if e != nil {
		return nil, e
	}
	out := &GroupSummary{GeneratedAt: s.now().UTC(), Scope: scope, Counts: map[string]*int{}, Sources: map[string]GroupCoverage{"inventory": scope.Inventory, "topology": scope.Topology}, Consistency: "eventual_across_collections", ConfigurationScope: "controller_local_declared_sources", ControllerRole: "controller_local_collector"}
	base := scopeCoverage(scope, completeGroup())
	counts := map[string]int{"hosts": 0, "logicalFunctions": 0, "instances": 0, "retired": 0}
	for _, r := range scope.Resources {
		if r.LifecycleState == inventory.LifecycleRetired {
			counts["retired"]++
		}
		switch r.Kind {
		case inventory.KindHost:
			counts["hosts"]++
		case inventory.KindNetworkFunction:
			counts["logicalFunctions"]++
		case inventory.KindNetworkFunctionInstance:
			counts["instances"]++
		}
	}
	for k, n := range counts {
		out.Counts[k] = groupCount(n, base)
	}
	health, hcov := s.healthResources(ctx, scope)
	hcov = scopeCoverage(scope, hcov)
	out.Sources["monitoring"] = hcov
	hc := map[string]int{"monitored": 0, "unmonitored": 0, "unresolved": 0, "l1Measured": 0, "l2Measured": 0, "l3Measured": 0, "fresh": 0}
	for _, r := range health {
		if !isNetworkFunctionKind(r.Kind) || r.LifecycleState == inventory.LifecycleRetired {
			continue
		}
		switch r.Association {
		case AssociationAbsent:
			hc["unmonitored"]++
		case AssociationUnresolved:
			hc["unresolved"]++
		case AssociationConfirmed:
			hc["monitored"]++
		}
		m := r.Monitoring
		if m == nil || !m.Enabled || !m.StatusComplete {
			continue
		}
		if m.Coverage.L1Measured {
			hc["l1Measured"]++
		}
		if m.Coverage.L2Measured {
			hc["l2Measured"]++
		}
		if m.Coverage.L3Measured {
			hc["l3Measured"]++
		}
		if m.Freshness.State == "fresh" {
			hc["fresh"]++
		}
	}
	for k, n := range hc {
		out.Counts[k] = groupCount(n, hcov)
	}
	agents, acov := s.agentRows(ctx, f)
	out.Sources["agents"] = acov
	out.Counts["agents"] = groupCount(len(agents), acov)
	online := 0
	for _, a := range agents {
		if a.ConnectionState == "online" {
			online++
		}
	}
	out.Counts["agentsOnline"] = groupCount(online, acov)
	_, total, e := s.store.Alerts(ctx, scope.IDs, GroupQuery{Limit: 1}, "")
	alertCov := base
	if e != nil {
		degradeGroup(&alertCov, CompletenessUnavailable, "alerts_unavailable")
	}
	out.Sources["alerts"] = alertCov
	out.Counts["alertsOpen"] = groupCount(total, alertCov)
	configs, ccov := s.configRows(ctx, scope)
	ccov = scopeCoverage(scope, ccov)
	out.Sources["config"] = ccov
	out.Counts["configSources"] = groupCount(len(configs), ccov)
	changed, noBaseline, comparable, failed := 0, 0, 0, 0
	for _, v := range configs {
		if v.Comparison == "unchanged" || v.Comparison == "visible_changed" || v.Comparison == "unprojected_changed" {
			comparable++
		}
		if v.CollectionState != "ok" && v.CollectionState != "not_collected" {
			failed++
		}
		if v.Comparison == "visible_changed" || v.Comparison == "unprojected_changed" {
			changed++
		}
		if v.Registered && v.BaselineID == "" {
			noBaseline++
		}
	}
	out.Counts["configChanged"] = groupCount(changed, ccov)
	out.Counts["configNoBaseline"] = groupCount(noBaseline, ccov)
	out.Counts["configComparable"] = groupCount(comparable, ccov)
	out.Counts["configNotComparable"] = groupCount(len(configs)-comparable, ccov)
	out.Counts["configFailed"] = groupCount(failed, ccov)
	issues, icov := s.issues(ctx, scope, agents)
	icov = scopeCoverage(scope, icov)
	if acov.Completeness != CompletenessComplete {
		degradeGroup(&icov, acov.Completeness, acov.Reason)
	}
	out.Sources["issues"] = icov
	out.Counts["issues"] = groupCount(len(issues), icov)
	return out, nil
}

func groupPage(q GroupQuery, scope GroupScope, rows []groupRow, c GroupCoverage, now time.Time) (*GroupPage, error) {
	page := &GroupPage{GeneratedAt: now, Scope: scope, Items: []any{}, Coverage: c}
	sort.Slice(rows, func(i, j int) bool { return rows[i].id < rows[j].id })
	after, e := groupAfter(q, scope.Fingerprint)
	if e != nil {
		return nil, e
	}
	for _, r := range rows {
		if r.id <= after {
			continue
		}
		if len(page.Items) == q.Limit {
			page.HasMore = true
			break
		}
		page.Items = append(page.Items, r.value)
		cursor := groupCursor(q, scope.Fingerprint, r.id)
		page.NextCursor = &cursor
	}
	if !page.HasMore {
		page.NextCursor = nil
	}
	return page, nil
}
func (s *GroupService) Directory(ctx context.Context, q GroupQuery) (*GroupPage, error) {
	if q.NetworkKey != "" || q.SiteResourceID != "" || q.HostResourceID != "" || q.OperatorName != "" || q.PLMN != "" || q.Domain != "" {
		return s.scopedDirectory(ctx, q)
	}
	rows, more, e := s.store.Directory(ctx, q)
	c := completeGroup()
	if e != nil {
		degradeGroup(&c, CompletenessUnavailable, "directory_unavailable")
	}
	if more {
		degradeGroup(&c, CompletenessPartial, "directory_limit")
	}
	c.ObservedCount = len(rows)
	scope := GroupScope{Filter: q.GroupFilter, Fingerprint: groupDigest([]any{q.GroupBy, rows}), Inventory: c, Topology: completeGroup()}
	entries := []groupRow{}
	for _, v := range rows {
		entries = append(entries, groupRow{id: v.Key, value: v})
	}
	return groupPage(q, scope, entries, c, s.now().UTC())
}

func (s *GroupService) scopedDirectory(ctx context.Context, q GroupQuery) (*GroupPage, error) {
	scope, e := s.ResolveGroupScope(ctx, q.GroupFilter)
	if e != nil {
		return nil, e
	}
	c := scopeCoverage(scope, completeGroup())
	agentRows, ac := s.agentRows(ctx, q.GroupFilter)
	if ac.Completeness != CompletenessComplete {
		degradeGroup(&c, ac.Completeness, ac.Reason)
	}
	entries := map[string]GroupEntry{}
	if q.GroupBy == "network" {
		for _, r := range scope.Resources {
			scopes, e := inventory.OperationalScopesForResource(r)
			if e != nil {
				continue
			}
			for _, d := range scopes {
				if q.NetworkKey != "" && q.NetworkKey != d.NetworkKey || q.OperatorName != "" && q.OperatorName != d.OperatorName {
					continue
				}
				if q.PLMN != "" {
					match := false
					for _, p := range d.PLMNs {
						match = match || p == q.PLMN
					}
					if !match {
						continue
					}
				}
				entries[d.NetworkKey] = GroupEntry{Key: d.NetworkKey, Name: d.NetworkKey, Kind: "network"}
			}
		}
		for _, a := range agentRows {
			entries[a.Scope.NetworkKey] = GroupEntry{Key: a.Scope.NetworkKey, Name: a.Scope.NetworkKey, Kind: "network"}
		}
	} else {
		ids := append([]string{}, scope.IDs...)
		for _, a := range agentRows {
			if a.Scope.HostResourceID != "" {
				ids = append(ids, a.Scope.HostResourceID)
			}
			if a.Scope.SiteResourceID != "" {
				ids = append(ids, a.Scope.SiteResourceID)
			}
		}
		ancestors, _, tc := s.assignmentGraph(ctx, ids)
		if tc.Completeness != CompletenessComplete {
			degradeGroup(&c, tc.Completeness, tc.Reason)
		}
		sites := map[string]bool{}
		for _, list := range ancestors {
			for id := range list {
				sites[id] = true
			}
		}
		for _, a := range agentRows {
			if a.Scope.SiteResourceID != "" {
				sites[a.Scope.SiteResourceID] = true
			}
		}
		for _, r := range scope.Resources {
			if r.Kind == inventory.KindSite {
				sites[r.ResourceID] = true
			}
		}
		wanted := []string{}
		for id := range sites {
			wanted = append(wanted, id)
		}
		rows, more, e := s.store.Resources(ctx, GroupFilter{IncludeRetired: q.IncludeRetired}, wanted, GroupMaxResources)
		if e != nil {
			degradeGroup(&c, CompletenessUnavailable, "inventory_unavailable")
		}
		if more {
			degradeGroup(&c, CompletenessPartial, "directory_limit")
		}
		for _, r := range rows {
			if r.Kind != inventory.KindSite {
				continue
			}
			name := r.DisplayName
			if name == "" {
				name = r.Name
			}
			entries[r.ResourceID] = GroupEntry{Key: r.ResourceID, Name: name, Kind: "site"}
		}
	}
	rows := []groupRow{}
	versions := []string{}
	for id, v := range entries {
		if q.Q != "" && !strings.Contains(strings.ToLower(v.Name+" "+v.Key), strings.ToLower(q.Q)) {
			continue
		}
		rows = append(rows, groupRow{id: id, value: v})
		versions = append(versions, id)
	}
	sort.Strings(versions)
	scope.Fingerprint = groupDigest([]any{q.GroupBy, q.GroupFilter, versions, c})
	c.ObservedCount = len(rows)
	return groupPage(q, scope, rows, c, s.now().UTC())
}
func (s *GroupService) Members(ctx context.Context, q GroupQuery) (*GroupPage, error) {
	scope, e := s.ResolveGroupScope(ctx, q.GroupFilter)
	if e != nil {
		return nil, e
	}
	c := scopeCoverage(scope, completeGroup())
	rows := []groupRow{}
	match := func(v string) bool { return q.Q == "" || strings.Contains(strings.ToLower(v), strings.ToLower(q.Q)) }
	switch q.Section {
	case "resources":
		resourceScope := scope
		if q.Kind != "" {
			resourceScope.Resources = []inventory.Resource{}
			for _, r := range scope.Resources {
				if r.Kind == q.Kind {
					resourceScope.Resources = append(resourceScope.Resources, r)
				}
			}
		}
		items, coverage := s.healthResources(ctx, resourceScope)
		c = scopeCoverage(scope, coverage)
		for _, v := range items {
			if (q.Kind == "" || v.Kind == q.Kind) && match(v.Name+" "+v.DisplayName+" "+v.ResourceID) {
				rows = append(rows, groupRow{id: v.ResourceID, value: v})
			}
		}
	case "agents":
		items, coverage := s.agentRows(ctx, q.GroupFilter)
		c = coverage
		versions := []string{}
		for _, v := range items {
			versions = append(versions, v.AgentID+fmt.Sprint(v.Revision))
			if match(v.Name + " " + v.AgentID) {
				rows = append(rows, groupRow{id: v.AgentID, value: v})
			}
		}
		scope.Fingerprint = groupDigest([]any{scope.Fingerprint, versions})
	case "alerts":
		after, e := groupAfter(q, scope.Fingerprint)
		if e != nil {
			return nil, e
		}
		items, total, e := s.store.Alerts(ctx, scope.IDs, q, after)
		if e != nil {
			degradeGroup(&c, CompletenessUnavailable, "alerts_unavailable")
		}
		c.ObservedCount = total
		p := &GroupPage{GeneratedAt: s.now().UTC(), Scope: scope, Items: []any{}, Coverage: c, HasMore: len(items) > q.Limit}
		if p.HasMore {
			items = items[:q.Limit]
		}
		for _, v := range items {
			p.Items = append(p.Items, v)
		}
		if p.HasMore {
			cursor := groupCursor(q, scope.Fingerprint, items[len(items)-1].AlertID)
			p.NextCursor = &cursor
		}
		return p, nil
	case "config":
		items, coverage := s.configRows(ctx, scope)
		c = scopeCoverage(scope, coverage)
		versions := []string{}
		for _, v := range items {
			versions = append(versions, v.SourceID+fmt.Sprint(v.Revision)+v.Generation)
			if match(v.Name + " " + v.SourceID) {
				rows = append(rows, groupRow{id: v.SourceID, value: v})
			}
		}
		scope.Fingerprint = groupDigest([]any{scope.Fingerprint, versions})
	case "issues":
		agentRows, acov := s.agentRows(ctx, q.GroupFilter)
		items, coverage := s.issues(ctx, scope, agentRows)
		c = scopeCoverage(scope, coverage)
		if acov.Completeness != CompletenessComplete {
			degradeGroup(&c, acov.Completeness, acov.Reason)
		}
		for _, v := range items {
			if match(v.Code + " " + v.ResourceID + " " + v.AgentID) {
				rows = append(rows, groupRow{id: v.ID, value: v})
			}
		}
	}
	c.ObservedCount = len(rows)
	return groupPage(q, scope, rows, c, s.now().UTC())
}
