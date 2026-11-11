package operationsview

import (
	"context"
	"errors"
	"sort"

	"subscriber/internal/governance"
	"subscriber/internal/inventory"
	"subscriber/internal/topology"
)

func groupIssue(code, id, related, agent string) GroupIssue {
	return GroupIssue{ID: groupDigest([]string{code, id, related, agent}), Code: code, ResourceID: id, RelatedID: related, AgentID: agent}
}
func completeGroup() GroupCoverage { return GroupCoverage{Completeness: CompletenessComplete} }
func degradeGroup(c *GroupCoverage, state, reason string) {
	if c.Completeness != CompletenessUnavailable {
		c.Completeness = state
		c.Reason = reason
	}
}
func matchesGroupResource(r inventory.Resource, f GroupFilter) bool {
	if !f.IncludeRetired && r.LifecycleState == inventory.LifecycleRetired {
		return false
	}
	if f.Domain != "" && r.Domain != f.Domain {
		return false
	}
	if f.NetworkKey == "" && f.OperatorName == "" && f.PLMN == "" {
		return true
	}
	scopes, e := inventory.OperationalScopesForResource(r)
	if e != nil {
		return false
	}
	for _, s := range scopes {
		if f.NetworkKey != "" && s.NetworkKey != f.NetworkKey || f.OperatorName != "" && s.OperatorName != f.OperatorName {
			continue
		}
		if f.PLMN != "" {
			found := false
			for _, p := range s.PLMNs {
				found = found || p == f.PLMN
			}
			if !found {
				continue
			}
		}
		return true
	}
	return false
}

// ResolveGroupScope is shared by the workbench and operational reports. No
// failed or truncated identity lookup may broaden the selection to all records.
func (s *GroupService) ResolveGroupScope(ctx context.Context, f GroupFilter) (GroupScope, error) {
	out := GroupScope{Filter: f, Resources: []inventory.Resource{}, IDs: []string{}, Issues: []GroupIssue{}, Inventory: completeGroup(), Topology: completeGroup()}
	var allowed map[string]inventory.Resource
	for _, root := range []struct{ id, kind string }{{f.SiteResourceID, inventory.KindSite}, {f.HostResourceID, inventory.KindHost}} {
		if root.id == "" {
			continue
		}
		r, e := s.store.Resource(ctx, root.id)
		if errors.Is(e, inventory.ErrNotFound) {
			return out, &governance.HTTPError{Status: 404, Code: "GROUP_RESOURCE_NOT_FOUND", Message: "Group resource not found"}
		}
		if e != nil || r == nil {
			degradeGroup(&out.Inventory, CompletenessUnavailable, "inventory_unavailable")
			return out, nil
		}
		if r.Kind != root.kind {
			return out, &governance.HTTPError{Status: 400, Code: "GROUP_RESOURCE_KIND", Message: "Group resource has an incompatible kind"}
		}
		members, edges, cov, e := s.walkGroup(ctx, *r, f.IncludeRetired)
		if e != nil {
			degradeGroup(&out.Inventory, CompletenessUnavailable, "inventory_unavailable")
		}
		if cov.Completeness != CompletenessComplete {
			degradeGroup(&out.Topology, cov.Completeness, cov.Reason)
		}
		out.Issues = append(out.Issues, graphGroupIssues(edges, members, cov.Completeness == CompletenessComplete)...)
		if allowed == nil {
			allowed = members
		} else {
			for id := range allowed {
				if _, ok := members[id]; !ok {
					delete(allowed, id)
				}
			}
		}
	}
	var rows []inventory.Resource
	if allowed != nil {
		for _, r := range allowed {
			rows = append(rows, r)
		}
	} else {
		var more bool
		var e error
		rows, more, e = s.store.Resources(ctx, f, nil, GroupMaxResources)
		if e != nil {
			degradeGroup(&out.Inventory, CompletenessUnavailable, "inventory_unavailable")
		}
		if more {
			degradeGroup(&out.Inventory, CompletenessPartial, "scope_limit")
		}
	}
	for _, r := range rows {
		if _, e := inventory.OperationalScopesForResource(r); e != nil {
			out.Issues = append(out.Issues, groupIssue("invalid_declaration", r.ResourceID, "", ""))
			if f.NetworkKey != "" || f.OperatorName != "" || f.PLMN != "" {
				degradeGroup(&out.Inventory, CompletenessPartial, "invalid_declaration")
			}
		}
		if matchesGroupResource(r, f) {
			out.Resources = append(out.Resources, r)
			out.IDs = append(out.IDs, r.ResourceID)
		}
	}
	sort.Slice(out.Resources, func(i, j int) bool { return out.Resources[i].ResourceID < out.Resources[j].ResourceID })
	sort.Strings(out.IDs)
	out.Inventory.ObservedCount = len(out.Resources)
	versions := []string{}
	for _, r := range out.Resources {
		versions = append(versions, r.ResourceID+":"+r.UpdatedAt+":"+groupDigest(r.Revision))
	}
	out.Fingerprint = groupDigest([]any{f, versions, out.Inventory, out.Topology})
	return out, nil
}

func (s *GroupService) walkGroup(ctx context.Context, root inventory.Resource, includeRetired bool) (map[string]inventory.Resource, []topology.Edge, GroupCoverage, error) {
	cov := completeGroup()
	members := map[string]inventory.Resource{}
	allEdges := []topology.Edge{}
	if !includeRetired && root.LifecycleState == inventory.LifecycleRetired {
		return members, allEdges, cov, nil
	}
	members[root.ResourceID] = root
	front := []string{root.ResourceID}
	seen := map[string]bool{root.ResourceID: true}
	for depth := 0; len(front) > 0; depth++ {
		remaining := GroupMaxEdges - len(allEdges)
		if remaining <= 0 {
			degradeGroup(&cov, CompletenessPartial, "edge_limit")
			break
		}
		edges, more, e := s.store.Edges(ctx, front, "outbound", remaining)
		if e != nil {
			degradeGroup(&cov, CompletenessUnavailable, "topology_unavailable")
			break
		}
		allEdges = append(allEdges, edges...)
		if more {
			degradeGroup(&cov, CompletenessPartial, "edge_limit")
		}
		wanted := []string{}
		for _, edge := range edges {
			if !seen[edge.ToResourceID] {
				seen[edge.ToResourceID] = true
				wanted = append(wanted, edge.ToResourceID)
			}
		}
		if len(wanted) == 0 {
			break
		}
		if depth >= GroupMaxDepth-1 {
			degradeGroup(&cov, CompletenessPartial, "depth_limit")
			break
		}
		rows, limited, e := s.store.Resources(ctx, GroupFilter{IncludeRetired: includeRetired}, wanted, GroupMaxResources-len(members))
		if e != nil {
			return members, allEdges, cov, e
		}
		front = []string{}
		for _, r := range rows {
			members[r.ResourceID] = r
			front = append(front, r.ResourceID)
		}
		if limited {
			degradeGroup(&cov, CompletenessPartial, "scope_limit")
			break
		}
		if more {
			break
		}
	}
	cov.ObservedCount = len(allEdges)
	return members, allEdges, cov, nil
}

func graphGroupIssues(edges []topology.Edge, nodes map[string]inventory.Resource, complete bool) []GroupIssue {
	out := []GroupIssue{}
	parents := map[string][]string{}
	children := map[string][]string{}
	for _, e := range edges {
		parents[e.ToResourceID] = append(parents[e.ToResourceID], e.FromResourceID)
		children[e.FromResourceID] = append(children[e.FromResourceID], e.ToResourceID)
		if _, ok := nodes[e.ToResourceID]; !ok && complete {
			out = append(out, groupIssue("unresolved_reference", e.FromResourceID, e.ToResourceID, ""))
		}
	}
	for id, p := range parents {
		if len(p) > 1 {
			out = append(out, groupIssue("shared_containment", id, "", ""))
		}
	}
	state := map[string]int{}
	var visit func(string)
	visit = func(id string) {
		if state[id] == 2 {
			return
		}
		if state[id] == 1 {
			out = append(out, groupIssue("containment_cycle", id, "", ""))
			return
		}
		state[id] = 1
		for _, c := range children[id] {
			visit(c)
		}
		state[id] = 2
	}
	nodeIDs := []string{}
	for id := range nodes {
		nodeIDs = append(nodeIDs, id)
	}
	sort.Strings(nodeIDs)
	for _, list := range children {
		sort.Strings(list)
	}
	for _, id := range nodeIDs {
		visit(id)
	}
	return out
}

// AssignmentGraph reads ancestors in bounded batches, including host references
// from the Agent plane. Unknown ancestry never establishes non-membership.
func (s *GroupService) assignmentGraph(ctx context.Context, ids []string) (map[string]map[string]bool, []GroupIssue, GroupCoverage) {
	cov := completeGroup()
	nodes := map[string]inventory.Resource{}
	all := []topology.Edge{}
	seen := map[string]bool{}
	front := []string{}
	missing := []string{}
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			front = append(front, id)
		}
	}
	for depth := 0; len(front) > 0; depth++ {
		rows, limited, e := s.store.Resources(ctx, GroupFilter{IncludeRetired: true}, front, len(front))
		if e != nil {
			degradeGroup(&cov, CompletenessUnavailable, "inventory_unavailable")
			break
		}
		for _, r := range rows {
			nodes[r.ResourceID] = r
		}
		if len(rows) != len(front) {
			for _, id := range front {
				if _, ok := nodes[id]; !ok {
					missing = append(missing, id)
				}
			}
			degradeGroup(&cov, CompletenessPartial, "unresolved_reference")
		}
		if limited {
			degradeGroup(&cov, CompletenessPartial, "scope_limit")
		}
		remaining := GroupMaxEdges - len(all)
		if remaining <= 0 {
			degradeGroup(&cov, CompletenessPartial, "edge_limit")
			break
		}
		edges, more, e := s.store.Edges(ctx, front, "inbound", remaining)
		if e != nil {
			degradeGroup(&cov, CompletenessUnavailable, "topology_unavailable")
			break
		}
		all = append(all, edges...)
		next := []string{}
		for _, edge := range edges {
			if !seen[edge.FromResourceID] {
				seen[edge.FromResourceID] = true
				next = append(next, edge.FromResourceID)
			}
		}
		if more {
			degradeGroup(&cov, CompletenessPartial, "edge_limit")
			break
		}
		if len(next) > 0 && (depth >= GroupMaxDepth-1 || len(seen) > 3*GroupMaxResources) {
			degradeGroup(&cov, CompletenessPartial, "depth_limit")
			break
		}
		front = next
	}
	parents := map[string][]string{}
	for _, e := range all {
		if parent, ok := nodes[e.FromResourceID]; ok && parent.LifecycleState != inventory.LifecycleRetired {
			parents[e.ToResourceID] = append(parents[e.ToResourceID], e.FromResourceID)
		}
	}
	byID := map[string]map[string]bool{}
	for _, id := range ids {
		sites := map[string]bool{}
		visited := map[string]bool{}
		stack := []string{id}
		for len(stack) > 0 {
			last := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if visited[last] {
				continue
			}
			visited[last] = true
			r, ok := nodes[last]
			if ok && r.Kind == inventory.KindSite && r.LifecycleState != inventory.LifecycleRetired {
				sites[last] = true
			}
			stack = append(stack, parents[last]...)
		}
		byID[id] = sites
	}
	issues := graphGroupIssues(all, nodes, cov.Completeness == CompletenessComplete)
	for _, id := range missing {
		issues = append(issues, groupIssue("unresolved_reference", id, "", ""))
	}
	for _, id := range ids {
		if r, ok := nodes[id]; ok && r.LifecycleState == inventory.LifecycleRetired {
			issues = append(issues, groupIssue("retired_reference", id, "", ""))
		}
	}
	if cov.Completeness == CompletenessComplete {
		for _, id := range ids {
			r, ok := nodes[id]
			if !ok {
				issues = append(issues, groupIssue("unresolved_reference", id, "", ""))
				continue
			}
			if r.LifecycleState == inventory.LifecycleRetired {
				issues = append(issues, groupIssue("retired_reference", id, "", ""))
			}
			if (r.Kind == inventory.KindHost || isNetworkFunctionKind(r.Kind)) && len(byID[id]) == 0 {
				issues = append(issues, groupIssue("unassigned_site", id, "", ""))
			}
		}
	}
	cov.ObservedCount = len(all)
	return byID, issues, cov
}
