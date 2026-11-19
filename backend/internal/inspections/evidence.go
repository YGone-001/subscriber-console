package inspections

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/agents"
	"subscriber/internal/configdrift"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/nfhealth"
	"subscriber/internal/operationsview"
)

type GroupResolver interface {
	ResolveGroupScope(context.Context, operationsview.GroupFilter) (operationsview.GroupScope, error)
}
type HealthReader interface {
	ListTargets(context.Context, nfhealth.TargetListFilter) ([]nfhealth.HealthTarget, *string, bool, error)
	LatestStatusForTargets(context.Context, []string) (map[string]nfhealth.BatchTargetStatus, error)
}
type ConfigReader interface {
	List(context.Context, configsnapshots.ListQuery) (*configsnapshots.SourceList, error)
}
type EvidenceReader struct {
	db        *mongo.Database
	groups    GroupResolver
	resources operationsview.GroupStore
	health    HealthReader
	config    ConfigReader
	now       func() time.Time
}

func NewEvidenceReader(db *mongo.Database, groups GroupResolver, resources operationsview.GroupStore, health HealthReader, config ConfigReader) *EvidenceReader {
	return &EvidenceReader{db, groups, resources, health, config, time.Now}
}
func sourceCoverage(n, limit int, more bool, e error, at time.Time) Coverage {
	c := Coverage{State: "complete", ReadAt: at, Count: n, Limit: limit}
	if e != nil {
		c.State = "unavailable"
		c.Reason = "source_unavailable"
		c.Count = 0
	} else if more {
		c.State = "partial"
		c.Reason = "source_limit"
	}
	return c
}
func scopedRead[T any](ctx context.Context, c *mongo.Collection, filter, projection bson.M, limit int) ([]T, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cur, e := c.Find(ctx, filter, options.Find().SetProjection(projection).SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(int64(limit+1)))
	if e != nil {
		return nil, false, e
	}
	defer cur.Close(ctx)
	rows := []T{}
	if e = cur.All(ctx, &rows); e != nil {
		return nil, false, e
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	return rows, more, nil
}

var agentProjection = bson.M{"_id": 1, "name": 1, "scope": 1, "enabled": 1, "revision": 1, "lastReceivedAt": 1}

func (e *EvidenceReader) Resolve(ctx context.Context, selector ScopeSelector) (ResolvedScope, error) {
	at := e.now().UTC()
	out := ResolvedScope{Resources: []ResourceFact{}, AgentIDs: []string{}, Agents: []AgentFact{}, Coverage: sourceCoverage(0, MaxResources, false, nil, at), AgentCoverage: sourceCoverage(0, MaxAgents, false, nil, at)}
	var rows []inventory.Resource
	if selector.Mode == "resources" {
		var more bool
		var err error
		rows, more, err = e.resources.Resources(ctx, operationsview.GroupFilter{}, selector.ResourceIDs, MaxResources)
		if err != nil || more || len(rows) != len(selector.ResourceIDs) {
			return out, fail(422, "INSPECTION_SCOPE_UNAVAILABLE", "Some selected resources are unavailable or retired")
		}
	} else {
		c, cancel := context.WithTimeout(ctx, 4*time.Second)
		scope, err := e.groups.ResolveGroupScope(c, selector.Filter)
		cancel()
		if err != nil || scope.Inventory.Completeness != "complete" || scope.Topology.Completeness != "complete" {
			return out, fail(422, "INSPECTION_SCOPE_UNAVAILABLE", "The complete requested scope could not be resolved")
		}
		rows = scope.Resources
		out.Fingerprint = scope.Fingerprint
	}
	if len(rows) > MaxResources {
		return out, fail(422, "INSPECTION_SCOPE_LIMIT", "Narrow this scope to at most 200 resources")
	}
	for _, r := range rows {
		name := r.DisplayName
		if name == "" {
			name = r.Name
		}
		out.Resources = append(out.Resources, ResourceFact{r.ResourceID, name, r.Kind, r.Domain})
	}
	sort.Slice(out.Resources, func(i, j int) bool { return out.Resources[i].ID < out.Resources[j].ID })
	out.Coverage.Count = len(rows)
	filter := bson.M{}
	f := selector.Filter
	for k, v := range map[string]string{"networkKey": f.NetworkKey, "operatorName": f.OperatorName, "siteResourceId": f.SiteResourceID, "hostResourceId": f.HostResourceID, "plmns": f.PLMN} {
		if v != "" {
			filter["scope."+k] = v
		}
	}
	if f.Domain != "" || selector.Mode == "resources" {
		hosts, sites := []string{}, []string{}
		for _, r := range rows {
			if r.Kind == inventory.KindHost {
				hosts = append(hosts, r.ResourceID)
			}
			if r.Kind == inventory.KindSite {
				sites = append(sites, r.ResourceID)
			}
		}
		if f.Domain != "" || len(hosts)+len(sites) == 0 {
			out.AgentCoverage.State = "unavailable"
			out.AgentCoverage.Reason = "agent_scope_unresolved"
		} else {
			filter["$or"] = bson.A{bson.M{"scope.hostResourceId": bson.M{"$in": hosts}}, bson.M{"scope.siteResourceId": bson.M{"$in": sites}}}
		}
	}
	if out.AgentCoverage.State == "complete" {
		agentRows, more, err := scopedRead[agents.Record](ctx, e.db.Collection("app_agents"), filter, agentProjection, MaxAgents)
		out.AgentCoverage = sourceCoverage(len(agentRows), MaxAgents, more, err, e.now().UTC())
		for _, a := range agentRows {
			out.AgentIDs = append(out.AgentIDs, a.AgentID)
			out.Agents = append(out.Agents, AgentFact{a.AgentID, a.Name, a.Revision})
		}
	}
	ids := []string{}
	for _, r := range out.Resources {
		ids = append(ids, r.ID)
	}
	out.MembershipDigest = digest([]any{ids, out.AgentIDs})
	if out.Fingerprint == "" {
		out.Fingerprint = digest([]any{selector, out.Resources})
	}
	return out, nil
}
func baseItem(kind, id, resource, name string, at time.Time) Item {
	return Item{Key: kind + ":" + id, Kind: kind, SubjectID: id, ResourceID: resource, Name: name, Result: "unknown", ReadAt: at, Compatibility: fmt.Sprintf("%d:%s", Version, id)}
}
func unknownItem(kind, reason string, at time.Time) Item {
	v := baseItem(kind, "coverage", "", "", at)
	v.Reason = reason
	return v
}
func applyAge(i *Item, at time.Time, maxAge int) bool {
	i.MaxAgeSeconds = maxAge
	if at.IsZero() || at.After(i.ReadAt) {
		i.Reason = "evidence_time_invalid"
		return false
	}
	at = at.UTC()
	i.EvidenceAt = &at
	n := int64(i.ReadAt.Sub(at).Seconds())
	i.AgeSeconds = &n
	if n > int64(maxAge) {
		i.Reason = "evidence_stale"
		return false
	}
	return true
}
func nfResources(scope ResolvedScope) []ResourceFact {
	out := []ResourceFact{}
	for _, r := range scope.Resources {
		if r.Kind == inventory.KindNetworkFunction || r.Kind == inventory.KindNetworkFunctionInstance {
			out = append(out, r)
		}
	}
	return out
}
func (e *EvidenceReader) Evaluate(ctx context.Context, d Definition, scope ResolvedScope) ([]Item, map[string]Coverage) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	items := []Item{}
	coverage := map[string]Coverage{}
	for _, kind := range d.Checks {
		wg.Add(1)
		go func(kind string) {
			defer wg.Done()
			var rows []Item
			var c Coverage
			switch kind {
			case "monitoring":
				rows, c = e.monitoring(ctx, scope)
			case "configuration", "drift":
				rows, c = e.configuration(ctx, d, scope, kind)
			case "alerts":
				rows, c = e.alerts(ctx, scope)
			case "agents":
				rows, c = e.agentItems(ctx, scope)
			}
			if len(rows) == 0 {
				rows = append(rows, unknownItem(kind, "no_applicable_evidence", e.now().UTC()))
			}
			mu.Lock()
			items = append(items, rows...)
			coverage[kind] = c
			mu.Unlock()
		}(kind)
	}
	wg.Wait()
	sort.Slice(items, func(i, j int) bool { return items[i].Key < items[j].Key })
	return items, coverage
}
func (e *EvidenceReader) monitoring(ctx context.Context, scope ResolvedScope) ([]Item, Coverage) {
	at := e.now().UTC()
	rows := []Item{}
	resources := nfResources(scope)
	c := sourceCoverage(0, MaxResources, false, nil, at)
	for start := 0; start < len(resources); start += 50 {
		end := min(start+50, len(resources))
		ids := []string{}
		for _, r := range resources[start:end] {
			ids = append(ids, r.ID)
		}
		readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		targets, _, more, err := e.health.ListTargets(readCtx, nfhealth.TargetListFilter{ResourceIDs: ids, Limit: 50})
		cancel()
		byID := map[string][]nfhealth.HealthTarget{}
		targetIDs := []string{}
		for _, t := range targets {
			byID[t.ResourceID] = append(byID[t.ResourceID], t)
			targetIDs = append(targetIDs, t.TargetID)
		}
		status := map[string]nfhealth.BatchTargetStatus{}
		if err == nil && !more {
			readCtx, cancel = context.WithTimeout(ctx, 2*time.Second)
			status, err = e.health.LatestStatusForTargets(readCtx, targetIDs)
			cancel()
		}
		if err != nil || more {
			c = sourceCoverage(c.Count, MaxResources, more, err, e.now().UTC())
		}
		for _, r := range resources[start:end] {
			i := baseItem("monitoring", r.ID, r.ID, r.Name, e.now().UTC())
			i.Link = "/inventory/" + r.ID
			tt := byID[r.ID]
			if err != nil || more {
				i.Reason = "source_unavailable"
				rows = append(rows, i)
				continue
			}
			if len(tt) != 1 {
				i.Reason = "monitoring_not_configured"
				if len(tt) > 1 {
					i.Reason = "monitoring_ambiguous"
					c.State = "partial"
					c.Reason = "duplicate_target"
				}
				rows = append(rows, i)
				continue
			}
			t := tt[0]
			st := status[t.TargetID]
			i.Link = "/nf-health/" + t.TargetID
			i.SubjectID = t.TargetID
			i.Compatibility = digest([]any{Version, t.TargetID, t.CollectorProfile})
			fresh := nfhealth.EvaluateFreshness(&t, i.ReadAt)
			i.MaxAgeSeconds = fresh.PolicySeconds
			i.AgeSeconds = fresh.AgeSeconds
			if fresh.State != "fresh" {
				i.Reason = fresh.Reason
				rows = append(rows, i)
				continue
			}
			if t.LastError != "" || (st.Run != nil && st.Run.Status == nfhealth.RunStatusFailed) {
				i.Reason = "latest_collection_failed"
				rows = append(rows, i)
				continue
			}
			if st.Sample == nil || st.Run == nil || st.Sample.TargetID != t.TargetID || st.Sample.ResourceID != r.ID || st.Run.TargetID != t.TargetID || st.Run.ResourceID != r.ID || st.Sample.RunID != st.Run.RunID || st.Run.SampleID != st.Sample.SampleID {
				i.Reason = "evidence_identity_unverified"
				rows = append(rows, i)
				continue
			}
			measured, te := time.Parse(time.RFC3339Nano, st.Sample.CollectedAt)
			accepted, ae := time.Parse(time.RFC3339Nano, t.LastMeasuredAt)
			if te != nil || ae != nil || !measured.Equal(accepted) || !applyAge(&i, measured, fresh.PolicySeconds) {
				i.Reason = "evidence_time_unverified"
				rows = append(rows, i)
				continue
			}
			i.EvidenceID = st.Sample.SampleID
			i.Layers = map[string]string{}
			i.Result = "pass"
			i.Reason = "measured_layers_healthy"
			incomplete := false
			for key, layer := range map[string]nfhealth.LayerEvidence{"process": st.Sample.Layers.Process, "interface": st.Sample.Layers.Interface, "service": st.Sample.Layers.Service} {
				i.Layers[key] = layer.State
				if !layer.Measured || (layer.State != "healthy" && layer.State != "unhealthy" && layer.State != "degraded") {
					incomplete = true
					if i.Result != "finding" {
						i.Result = "unknown"
						i.Reason = "layer_evidence_incomplete"
					}
				}
				if layer.Measured && (layer.State == "unhealthy" || layer.State == "degraded") {
					i.Result = "finding"
					if i.Severity != "critical" {
						i.Severity = "warning"
					}
					i.Reason = "measured_layer_problem"
					if layer.State == "unhealthy" {
						i.Severity = "critical"
					}
				}
			}
			rows = append(rows, i)
			if incomplete && i.Result == "finding" {
				gap := i
				gap.Key += ":layer-coverage"
				gap.Compatibility += ":layer-coverage"
				gap.Result = "unknown"
				gap.Severity = ""
				gap.Reason = "layer_evidence_incomplete"
				rows = append(rows, gap)
			}
			c.Count++
		}
	}
	return rows, c
}

type sourceControl struct {
	ID       string                      `bson:"_id"`
	Sequence int64                       `bson:"driftSequence"`
	Policy   configsnapshots.DriftPolicy `bson:"driftPolicy"`
}

func (e *EvidenceReader) configuration(ctx context.Context, d Definition, scope ResolvedScope, kind string) ([]Item, Coverage) {
	at := e.now().UTC()
	ids := []string{}
	for _, r := range scope.Resources {
		ids = append(ids, r.ID)
	}
	c := sourceCoverage(0, MaxSources, false, nil, at)
	if len(ids) == 0 {
		return []Item{unknownItem(kind, "scope_empty", at)}, c
	}
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	page, err := e.config.List(readCtx, configsnapshots.ListQuery{ResourceIDs: ids, Limit: 200})
	cancel()
	if err != nil || page == nil {
		c.State = "unavailable"
		c.Reason = "source_unavailable"
		return []Item{unknownItem(kind, c.Reason, at)}, c
	}
	if page.CatalogState != "configured" {
		c.State = "unavailable"
		c.Reason = "config_sources_not_configured"
		return []Item{unknownItem(kind, c.Reason, at)}, c
	}
	if page.HasMore || page.Completeness != "complete" || len(page.Items) > MaxSources {
		c.State = "partial"
		c.Reason = "source_limit"
		return []Item{unknownItem(kind, c.Reason, at)}, c
	}
	rows := []Item{}
	sourceIDs := []string{}
	for _, s := range page.Items {
		sourceIDs = append(sourceIDs, s.SourceID)
	}
	controls := map[string]sourceControl{}
	evaluations := map[string]configdrift.State{}
	if kind == "drift" && len(sourceIDs) > 0 {
		cc, more, ce := scopedRead[sourceControl](ctx, e.db.Collection("app_config_sources"), bson.M{"_id": bson.M{"$in": sourceIDs}}, bson.M{"_id": 1, "driftSequence": 1, "driftPolicy": 1}, MaxSources)
		ss, smore, se := scopedRead[configdrift.State](ctx, e.db.Collection("app_config_drift_sources"), bson.M{"_id": bson.M{"$in": sourceIDs}}, bson.M{"_id": 1, "sequence": 1, "input": 1, "evaluation": 1, "current": 1, "pending": 1}, MaxSources)
		if ce != nil || se != nil || more || smore {
			c.State = "unavailable"
			c.Reason = "source_unavailable"
			return []Item{unknownItem(kind, c.Reason, at)}, c
		}
		for _, v := range cc {
			controls[v.ID] = v
		}
		for _, v := range ss {
			evaluations[v.SourceID] = v
		}
	}
	byResource := map[string]bool{}
	for _, s := range page.Items {
		byResource[s.ResourceID] = true
		i := baseItem(kind, s.SourceID, s.ResourceID, s.Name, e.now().UTC())
		i.Link = "/config-snapshots/" + s.SourceID
		i.Compatibility = digest([]any{Version, s.Generation, s.BaselineID, s.Profile})
		i.Reason = "configuration_unavailable"
		maxAge := d.ConfigMaxAgeSeconds
		if s.IntervalSeconds > 0 {
			maxAge = min(maxAge, s.IntervalSeconds+300)
		}
		usable := s.Registered && s.ResourceState == "valid" && !s.Pending && s.Latest != nil && s.Latest.Published && s.Latest.Generation == s.Generation && s.Latest.Status == "ok"
		if s.Latest != nil {
			i.EvidenceID = s.Latest.ObservationID
		}
		if !s.Registered {
			i.Reason = "config_source_withdrawn"
		} else if s.Pending {
			i.Reason = "publication_pending"
		} else if s.Latest == nil {
			i.Reason = "configuration_not_collected"
		} else if s.Latest.Status != "ok" {
			i.Reason = "configuration_collection_failed"
		}
		if usable {
			usable = applyAge(&i, s.Latest.CollectedAt, maxAge)
		}
		if usable {
			if s.BaselineID == "" {
				i.Reason = "baseline_missing"
			} else if s.Comparison != "unchanged" && s.Comparison != "visible_changed" && s.Comparison != "unprojected_changed" {
				i.Reason = "baseline_incompatible"
			} else {
				i.Result = "pass"
				i.Reason = "configuration_evidence_current"
			}
		}
		if kind == "drift" {
			control, exists := controls[s.SourceID]
			ev, found := evaluations[s.SourceID]
			if ev.Current != nil && ev.Current.ResourceID == s.ResourceID && ev.Current.Generation == s.Generation && ev.Current.BaselineID == s.BaselineID && (ev.Current.State == "active" || ev.Current.State == "acknowledged") {
				i.Result = "finding"
				i.Reason = "configuration_drift_open"
				i.Severity = ev.Current.Severity
				i.EvidenceID = ev.Current.ID
				i.Link = "/nf-alerts?view=config&sourceId=" + s.SourceID
			} else if !exists || !control.Policy.Enabled {
				i.Result = "unknown"
				i.Reason = "drift_policy_disabled"
			} else if !usable || i.Result != "pass" {
				i.Result = "unknown"
			} else if !found || ev.Pending != nil || ev.Sequence != control.Sequence || ev.Input.ResourceID != s.ResourceID || ev.Input.Generation != s.Generation || ev.Input.Profile != s.Profile || ev.Input.BaselineID != s.BaselineID || ev.Input.Policy.Revision != control.Policy.Revision || ev.Input.ObservationID != s.Latest.ObservationID {
				i.Result = "unknown"
				i.Reason = "drift_evaluation_pending"
			} else if ev.Evaluation.State != "in_sync" {
				i.Result = "unknown"
				i.Reason = "drift_comparison_unavailable"
			} else {
				i.Result = "pass"
				i.Reason = "baseline_equal"
			}
		}
		rows = append(rows, i)
	}
	for _, r := range nfResources(scope) {
		if !byResource[r.ID] {
			i := baseItem(kind, "resource:"+r.ID, r.ID, r.Name, at)
			i.Reason = "config_source_not_declared"
			i.Link = "/config-snapshots?resourceId=" + r.ID
			rows = append(rows, i)
		}
	}
	c.Count = len(page.Items)
	return rows, c
}

type alertAggregate struct {
	ID       string `bson:"_id"`
	Count    int    `bson:"count"`
	Critical int    `bson:"critical"`
	FirstID  string `bson:"firstId"`
}

func (e *EvidenceReader) alerts(ctx context.Context, scope ResolvedScope) ([]Item, Coverage) {
	at := e.now().UTC()
	out := []Item{}
	c := sourceCoverage(0, MaxResources*2, false, nil, at)
	ids := []string{}
	for _, r := range scope.Resources {
		ids = append(ids, r.ID)
	}
	for _, subject := range []string{"nf", "drift"} {
		collection, states := "app_nf_alerts", []string{"active", "acknowledged", "assigned", "recovering"}
		if subject == "drift" {
			collection = "app_config_drift_alerts"
			states = []string{"active", "acknowledged"}
		}
		readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		pipeline := mongo.Pipeline{{{Key: "$match", Value: bson.M{"resourceId": bson.M{"$in": ids}, "state": bson.M{"$in": states}}}}, {{Key: "$group", Value: bson.M{"_id": "$resourceId", "count": bson.M{"$sum": 1}, "critical": bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$severity", "critical"}}, 1, 0}}}, "firstId": bson.M{"$first": "$_id"}}}}, {{Key: "$limit", Value: MaxResources + 1}}}
		cursor, err := e.db.Collection(collection).Aggregate(readCtx, pipeline, options.Aggregate().SetAllowDiskUse(false))
		aggregates := []alertAggregate{}
		if err == nil {
			err = cursor.All(readCtx, &aggregates)
			_ = cursor.Close(readCtx)
		}
		cancel()
		counts := map[string]alertAggregate{}
		for _, a := range aggregates {
			counts[a.ID] = a
		}
		if err != nil || len(aggregates) > MaxResources {
			c = sourceCoverage(c.Count, c.Limit, len(aggregates) > MaxResources, err, e.now().UTC())
		}
		for _, r := range scope.Resources {
			if r.Kind != inventory.KindNetworkFunction && r.Kind != inventory.KindNetworkFunctionInstance {
				continue
			}
			i := baseItem("alerts", subject+":"+r.ID, r.ID, r.Name, e.now().UTC())
			i.Link = "/nf-alerts?resourceId=" + r.ID
			if subject == "drift" {
				i.Link += "&view=config"
			}
			if err != nil {
				i.Reason = "source_unavailable"
			} else {
				a := counts[r.ID]
				n := a.Count
				i.Count = &n
				i.Result = "pass"
				i.Reason = "no_matching_open_alerts"
				if n > 0 {
					i.Result = "finding"
					i.Severity = "warning"
					if a.Critical > 0 {
						i.Severity = "critical"
					}
					i.Reason = "open_alerts"
					i.EvidenceID = a.FirstID
				}
				c.Count++
			}
			out = append(out, i)
		}
	}
	return out, c
}
func (e *EvidenceReader) agentItems(ctx context.Context, scope ResolvedScope) ([]Item, Coverage) {
	at := e.now().UTC()
	c := scope.AgentCoverage
	out := []Item{}
	if c.State != "complete" {
		return []Item{unknownItem("agents", c.Reason, at)}, c
	}
	if len(scope.AgentIDs) == 0 {
		return []Item{unknownItem("agents", "agent_coverage_unknown", at)}, c
	}
	rows, more, err := scopedRead[agents.Record](ctx, e.db.Collection("app_agents"), bson.M{"_id": bson.M{"$in": scope.AgentIDs}}, agentProjection, MaxAgents)
	c = sourceCoverage(len(rows), MaxAgents, more, err, e.now().UTC())
	byID := map[string]agents.Record{}
	for _, r := range rows {
		byID[r.AgentID] = r
	}
	for _, saved := range scope.Agents {
		i := baseItem("agents", saved.ID, "", saved.Name, e.now().UTC())
		i.Link = "/agents/" + saved.ID
		r, ok := byID[saved.ID]
		i.Reason = "agent_unavailable"
		if err == nil && !more && ok {
			if r.Revision != saved.Revision {
				i.Reason = "agent_assignment_changed"
			} else {
				if r.LastReceivedAt != nil && r.LastReceivedAt.After(i.ReadAt) {
					i.Reason = "evidence_time_invalid"
					out = append(out, i)
					continue
				}
				state := agents.ConnectionState(&r, i.ReadAt)
				i.Reason = "agent_" + state
				i.Compatibility = digest([]any{Version, r.AgentID, r.Revision})
				if r.LastReceivedAt != nil {
					i.EvidenceAt = r.LastReceivedAt
					age := int64(i.ReadAt.Sub(*r.LastReceivedAt).Seconds())
					i.AgeSeconds = &age
				}
				i.MaxAgeSeconds = agents.StaleAfterSeconds
				if state == "online" {
					i.Result = "pass"
				} else if state == "offline" || state == "stale" {
					i.Result = "finding"
					i.Severity = "warning"
				}
			}
		}
		out = append(out, i)
	}
	return out, c
}
