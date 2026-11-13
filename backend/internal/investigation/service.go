package investigation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/nfhealth"
	"subscriber/internal/topology"
)

type EvidenceRepository interface {
	Anchor(context.Context, string) (*AlertFact, error)
	Resources(context.Context, []string) ([]ResourceFact, error)
	Edges(context.Context, string) ([]EdgeFact, bool, error)
	Alerts(context.Context, []string, time.Time, time.Time) ([]AlertFact, bool, error)
	Runs(context.Context, []string, time.Time, time.Time) ([]RunFact, bool, error)
	Samples(context.Context, []string) ([]SampleFact, error)
	Configurations(context.Context, []string, time.Time, time.Time) ([]ConfigFact, bool, error)
	Knowledge(context.Context, []string) ([]KnowledgeFact, error)
}
type RecordRepository interface {
	Get(context.Context, string) (*Record, error)
	Create(context.Context, *Record) (*Record, error)
	Update(context.Context, string, int64, UpdateRequest, string, time.Time) (*Record, error)
	List(context.Context, ListQuery, *cursorData) ([]Record, bool, error)
}
type AuditWriter interface{ WriteBestEffort(audit.WriteAuditInput) }
type Service struct {
	evidence EvidenceRepository
	records  RecordRepository
	actors   governance.ActorRepository
	audit    AuditWriter
	key      []byte
	clock    func() time.Time
	slots    chan struct{}
}

func NewService(e EvidenceRepository, r RecordRepository, actors governance.ActorRepository, writer AuditWriter, key []byte) *Service {
	sum := sha256.Sum256(append([]byte("investigation-cursor-v1:"), key...))
	return &Service{e, r, actors, writer, append([]byte{}, sum[:]...), time.Now, make(chan struct{}, 4)}
}
func (s *Service) now() time.Time { return s.clock().UTC().Truncate(time.Millisecond) }
func coverage(n, limit int, more bool, err error) Coverage {
	c := Coverage{State: "complete", Returned: n, Limit: limit, HistoryCoverage: "unknown"}
	if err != nil {
		c.State = "unavailable"
		c.Reason = "read_failed"
		c.Returned = 0
	} else if more {
		c.State = "partial"
		c.Reason = "row_limit"
	}
	return c
}
func incomplete(c Coverage, reason string) Coverage {
	if c.State != "unavailable" {
		c.State = "partial"
		c.Reason = reason
	}
	return c
}
func (s *Service) Context(ctx context.Context, q ContextQuery) (*ContextView, error) {
	kind, id, anchorErr := anchorIdentity(q.AlertID, q.AnchorKind, q.AnchorID)
	if anchorErr != nil {
		return nil, anchorErr
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return nil, fail(429, "INVESTIGATION_BUSY", "Investigation evidence capacity is busy")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	var saved *Record
	if q.InvestigationID != "" {
		if !validID(q.InvestigationID) {
			return nil, fail(400, "INVESTIGATION_INVALID_ID", "Investigation ID must be UUID v4")
		}
		var recordErr error
		saved, recordErr = s.records.Get(ctx, q.InvestigationID)
		if recordErr != nil {
			return nil, recordErr
		}
		savedKind, savedID := recordAnchor(saved)
		if savedKind != kind || savedID != id {
			return nil, fail(409, "INVESTIGATION_CONTEXT_CHANGED", "Saved alert context changed")
		}
		q.From, q.To = saved.From.Format(time.RFC3339Nano), saved.To.Format(time.RFC3339Nano)
	}
	a, err := s.anchor(ctx, kind, id)
	if err != nil {
		return nil, err
	}
	if saved != nil && saved.ResourceID != a.ResourceID {
		return nil, fail(409, "INVESTIGATION_CONTEXT_CHANGED", "Saved resource association changed")
	}
	now := s.now()
	if q.From == "" && q.To == "" {
		at, e := time.Parse(time.RFC3339Nano, a.First)
		if e != nil {
			return nil, fail(422, "INVESTIGATION_ANCHOR_TIME_UNKNOWN", "Select an explicit time window for this historical alert")
		}
		from, to := at.Add(-30*time.Minute), at.Add(30*time.Minute)
		if to.After(now) {
			to = now
		}
		q.From = from.UTC().Format(time.RFC3339Nano)
		q.To = to.UTC().Format(time.RFC3339Nano)
	}
	from, to, err := parseWindow(q.From, q.To, now)
	if err != nil {
		return nil, err
	}
	out := &ContextView{GeneratedAt: now, From: from, To: to, Anchor: *a, Resources: []ResourceFact{}, Relations: []EdgeFact{}, Events: []Event{}, Coverage: map[string]Coverage{}, Completeness: "complete", RelationshipBasis: "current_declared_one_hop"}
	for _, key := range []string{"inventory", "topology", "alerts", "health", "configuration"} {
		out.Coverage[key] = Coverage{State: "not_applicable", Reason: "resource_unbound", HistoryCoverage: "unknown"}
	}
	if !validID(a.ResourceID) {
		addAlertEvents(out, *a, "anchor_alert")
		out.Completeness = "partial"
		finalizeTimeline(out)
		return out, nil
	}
	primary, e := s.evidence.Resources(ctx, []string{a.ResourceID})
	out.Coverage["inventory"] = coverage(len(primary), MaxEdges+1, false, e)
	if e != nil || len(primary) != 1 || primary[0].ID != a.ResourceID {
		out.Coverage["inventory"] = incomplete(out.Coverage["inventory"], "resource_missing")
		out.Completeness = "unavailable"
		addAlertEvents(out, *a, "anchor_alert")
		finalizeTimeline(out)
		return out, nil
	}
	out.Resources = primary
	ids := []string{a.ResourceID}
	allowed := map[string]bool{a.ResourceID: true}
	if primary[0].Lifecycle != "retired" {
		edges, more, edgeErr := s.evidence.Edges(ctx, a.ResourceID)
		out.Coverage["topology"] = coverage(len(edges), MaxEdges, more, edgeErr)
		if edgeErr == nil {
			seen := map[string]bool{}
			neighbors := []string{}
			for _, edge := range edges {
				if !validID(edge.ID) || !validID(edge.From) || !validID(edge.To) || edge.From == edge.To || !validRelation(edge.Type) || edge.Revision < 1 || (edge.From != a.ResourceID && edge.To != a.ResourceID) {
					out.Coverage["topology"] = incomplete(out.Coverage["topology"], "invalid_relation")
					continue
				}
				out.Relations = append(out.Relations, edge)
				id := edge.From
				if id == a.ResourceID {
					id = edge.To
				}
				if !seen[id] {
					neighbors = append(neighbors, id)
					seen[id] = true
				}
			}
			if len(neighbors) > 0 {
				resources, re := s.evidence.Resources(ctx, neighbors)
				if re != nil {
					out.Coverage["inventory"] = incomplete(out.Coverage["inventory"], "related_resources_unavailable")
				} else {
					for _, r := range resources {
						if seen[r.ID] {
							out.Resources = append(out.Resources, r)
							if r.Lifecycle != "retired" {
								allowed[r.ID] = true
								ids = append(ids, r.ID)
							}
						}
					}
					if len(resources) != len(neighbors) {
						out.Coverage["inventory"] = incomplete(out.Coverage["inventory"], "resource_missing")
					}
				}
			}
		}
	} else {
		out.Coverage["topology"] = Coverage{State: "not_applicable", Reason: "retired_resource", HistoryCoverage: "unknown"}
	}
	sort.Strings(ids)
	meta := out.Coverage["inventory"]
	meta.Returned = len(out.Resources)
	out.Coverage["inventory"] = meta
	var alerts []AlertFact
	var runs []RunFact
	var configs []ConfigFact
	var samples []SampleFact
	var ac, hc, cc Coverage
	var sampleErr error
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		v, m, e := s.evidence.Alerts(ctx, ids, from, to)
		alerts = v
		ac = coverage(len(v), MaxEvidence, m, e)
	}()
	go func() {
		defer wg.Done()
		v, m, e := s.evidence.Runs(ctx, ids, from, to)
		runs = v
		hc = coverage(len(v), MaxEvidence, m, e)
		if e == nil {
			sampleIDs := []string{}
			seen := map[string]bool{}
			for _, r := range v {
				if validID(r.SampleID) && !seen[r.SampleID] {
					seen[r.SampleID] = true
					sampleIDs = append(sampleIDs, r.SampleID)
				}
			}
			if len(sampleIDs) > 0 {
				samples, sampleErr = s.evidence.Samples(ctx, sampleIDs)
			}
		}
	}()
	go func() {
		defer wg.Done()
		v, m, e := s.evidence.Configurations(ctx, ids, from, to)
		configs = v
		cc = coverage(len(v), MaxEvidence, m, e)
	}()
	wg.Wait()
	out.Coverage["alerts"] = ac
	out.Coverage["health"] = hc
	out.Coverage["configuration"] = cc
	basis := func(id string) string {
		if id == a.ResourceID {
			return "same_resource"
		}
		return "current_declared_relation"
	}
	seenAnchor := false
	if ac.State != "unavailable" {
		for _, v := range alerts {
			if !allowed[v.ResourceID] || !validID(v.ID) {
				out.Coverage["alerts"] = incomplete(out.Coverage["alerts"], "invalid_record")
				continue
			}
			if a.AnchorKind != "config_drift" && v.ID == a.ID {
				seenAnchor = true
			}
			addAlertEvents(out, v, basis(v.ResourceID))
		}
	}
	if !seenAnchor {
		addAlertEvents(out, *a, "anchor_alert")
	}
	bySample := map[string]SampleFact{}
	for _, v := range samples {
		bySample[v.ID] = v
	}
	if hc.State != "unavailable" {
		for _, v := range runs {
			at, e := time.Parse(time.RFC3339Nano, v.At)
			if e != nil || !validID(v.ID) || !allowed[v.ResourceID] || !validID(v.TargetID) {
				out.Coverage["health"] = incomplete(out.Coverage["health"], "invalid_record")
				continue
			}
			var layers *Layers
			var measuredAt *time.Time
			if v.SampleID != "" {
				sample, ok := bySample[v.SampleID]
				if sampleErr != nil || !ok || sample.RunID != v.ID || sample.ResourceID != v.ResourceID || sample.TargetID != v.TargetID {
					out.Coverage["health"] = incomplete(out.Coverage["health"], "sample_unavailable")
				} else {
					measured, parseErr := time.Parse(time.RFC3339Nano, sample.At)
					if parseErr != nil || measured.Before(at) || measured.Before(from) || measured.After(to) {
						out.Coverage["health"] = incomplete(out.Coverage["health"], "sample_time_unavailable")
					} else {
						l := sample.Layers
						for _, layer := range []*LayerState{&l.Process, &l.Interface, &l.Service} {
							if !validLayerState(layer.State) {
								layer.State = "unknown"
								out.Coverage["health"] = incomplete(out.Coverage["health"], "invalid_record")
							}
						}
						layers = &l
						measuredUTC := measured.UTC()
						measuredAt = &measuredUTC
					}
				}
			}
			out.Events = append(out.Events, Event{Key: "health:" + v.ID, Kind: "health", ID: v.ID, ResourceID: v.ResourceID, TargetID: v.TargetID, At: at.UTC(), Outcome: v.Outcome, Basis: basis(v.ResourceID), Layers: layers, MeasuredAt: measuredAt})
		}
	}
	if cc.State != "unavailable" {
		for _, v := range configs {
			if !validID(v.ID) || !validID(v.SourceID) || !allowed[v.ResourceID] || v.At.IsZero() {
				out.Coverage["configuration"] = incomplete(out.Coverage["configuration"], "invalid_record")
				continue
			}
			out.Events = append(out.Events, Event{Key: "configuration:" + v.ID, Kind: "configuration", ID: v.ID, ResourceID: v.ResourceID, SourceID: v.SourceID, SnapshotID: v.SnapshotID, At: v.At.UTC(), Outcome: v.Outcome, Basis: basis(v.ResourceID), Changed: v.Changed})
		}
	}
	finalizeTimeline(out)
	for _, c := range out.Coverage {
		if c.State == "unavailable" {
			out.Completeness = "unavailable"
			break
		}
		if c.State == "partial" {
			out.Completeness = "partial"
		}
	}
	return out, nil
}
func addAlertEvents(out *ContextView, a AlertFact, basis string) {
	times := []struct{ kind, at string }{{"alert_triggered", a.First}, {"alert_retriggered", a.Last}, {"alert_acknowledged", a.Acknowledged}, {"alert_assigned", a.Assigned}, {"alert_recovering", a.Recovering}, {"alert_resolved", a.Resolved}}
	for _, v := range times {
		if v.at == "" || (v.kind == "alert_retriggered" && v.at == a.First) {
			continue
		}
		at, e := time.Parse(time.RFC3339Nano, v.at)
		if e != nil {
			continue
		}
		out.Events = append(out.Events, Event{AnchorKind: a.AnchorKind, Key: v.kind + ":" + a.ID + a.AnchorID, Kind: v.kind, ID: a.ID + a.AnchorID, SourceID: a.SourceID, ResourceID: a.ResourceID, TargetID: a.TargetID, At: at.UTC(), Name: a.Name, Outcome: a.Severity, Basis: basis})
	}
}
func (s *Service) checkWriter(ctx context.Context, p *auth.Principal) (*governance.FreshActor, error) {
	if p == nil {
		return nil, fail(401, "AUTH_INVALID_TOKEN", "Unauthorized")
	}
	if !auth.HasPermission(p, "core.configure") {
		return nil, fail(403, "PERMISSION_DENIED", "Forbidden")
	}
	actor, e := governance.RevalidateFreshActor(ctx, s.actors, p)
	if e != nil {
		return nil, e
	}
	return actor, nil
}
func (s *Service) Create(ctx context.Context, p *auth.Principal, q CreateRequest) (*Record, error) {
	if p == nil || !auth.HasPermission(p, "core.configure") {
		return nil, fail(403, "PERMISSION_DENIED", "Forbidden")
	}
	kind, id, anchorErr := anchorIdentity(q.AlertID, q.AnchorKind, q.AnchorID)
	if anchorErr != nil {
		return nil, anchorErr
	}
	if !validID(q.RequestID) {
		return nil, fail(400, "INVESTIGATION_INVALID_ID", "Request and alert IDs must be UUID v4")
	}
	validation := UpdateRequest{ExpectedRevision: 1, Title: q.Title, Status: "open"}
	if e := validateUpdate(&validation); e != nil {
		return nil, e
	}
	q.Title = validation.Title
	from, to, e := parseWindow(q.From, q.To, s.now())
	if e != nil {
		return nil, e
	}
	anchor, e := s.anchor(ctx, kind, id)
	if e != nil {
		return nil, e
	}
	if anchor.ResourceID != "" && !validID(anchor.ResourceID) {
		return nil, fail(409, "INVESTIGATION_RESOURCE_UNRESOLVED", "Alert resource identity is not canonical")
	}
	actor, e := s.checkWriter(ctx, p)
	if e != nil {
		return nil, e
	}
	requestBytes, _ := json.Marshal([]string{q.AlertID, q.Title, from.Format(time.RFC3339Nano), to.Format(time.RFC3339Nano)})
	if kind == "config_drift" {
		requestBytes, _ = json.Marshal([]string{kind, id, q.Title, from.Format(time.RFC3339Nano), to.Format(time.RFC3339Nano)})
	}
	digest := sha256.Sum256(requestBytes)
	now := s.now()
	v := &Record{ID: q.RequestID, AlertID: q.AlertID, ResourceID: anchor.ResourceID, From: from, To: to, Title: q.Title, Status: "open", KnowledgeIDs: []string{}, Revision: 1, CreatedAt: now, UpdatedAt: now, CreatedBy: actor.Username, UpdatedBy: actor.Username, RecentChanges: []Change{{1, now, actor.Username, "open"}}, RequestDigest: hex.EncodeToString(digest[:])}
	if kind == "config_drift" {
		v.AnchorKind = kind
		v.AnchorID = id
		v.AlertID = ""
	}
	out, e := s.records.Create(ctx, v)
	if e == nil {
		s.log(p, "create", out)
	}
	return out, e
}
func (s *Service) Update(ctx context.Context, p *auth.Principal, id string, q UpdateRequest) (*Record, error) {
	if p == nil || !auth.HasPermission(p, "core.configure") {
		return nil, fail(403, "PERMISSION_DENIED", "Forbidden")
	}
	if !validID(id) {
		return nil, fail(400, "INVESTIGATION_INVALID_ID", "Investigation ID must be UUID v4")
	}
	if e := validateUpdate(&q); e != nil {
		return nil, e
	}
	old, e := s.records.Get(ctx, id)
	if e != nil {
		return nil, e
	}
	if old.Revision != q.ExpectedRevision {
		return nil, ErrConflict
	}
	if len(q.KnowledgeIDs) > 0 {
		knowledge, e := s.evidence.Knowledge(ctx, q.KnowledgeIDs)
		if e != nil {
			return nil, fail(503, "INVESTIGATION_KNOWLEDGE_UNAVAILABLE", "Knowledge references cannot be validated")
		}
		seen := map[string]bool{}
		for _, v := range knowledge {
			seen[v.ID] = true
		}
		for _, id := range q.KnowledgeIDs {
			if !seen[id] {
				return nil, fail(409, "INVESTIGATION_KNOWLEDGE_CHANGED", "A referenced knowledge entry is unavailable")
			}
		}
	}
	actor, e := s.checkWriter(ctx, p)
	if e != nil {
		return nil, e
	}
	out, e := s.records.Update(ctx, id, q.ExpectedRevision, q, actor.Username, s.now())
	if e == nil {
		s.log(p, "update", out)
	}
	return out, e
}
func (s *Service) Get(ctx context.Context, id string) (*RecordView, error) {
	if !validID(id) {
		return nil, fail(400, "INVESTIGATION_INVALID_ID", "Investigation ID must be UUID v4")
	}
	v, e := s.records.Get(ctx, id)
	if e != nil {
		return nil, e
	}
	if v.KnowledgeIDs == nil {
		v.KnowledgeIDs = []string{}
	}
	if v.RecentChanges == nil {
		v.RecentChanges = []Change{}
	}
	k, e := s.evidence.Knowledge(ctx, v.KnowledgeIDs)
	c := coverage(len(k), MaxKnowledge, false, e)
	if e != nil {
		k = []KnowledgeFact{}
	} else if len(k) != len(v.KnowledgeIDs) {
		c = incomplete(c, "reference_missing")
	}
	return &RecordView{v, k, c}, nil
}
func (s *Service) List(ctx context.Context, q ListQuery) (*ListView, error) {
	if q.AnchorKind != "" && q.AnchorKind != "nf_alert" && q.AnchorKind != "config_drift" && q.AnchorKind != "all" {
		return nil, fail(400, "INVESTIGATION_INVALID_QUERY", "Invalid anchor kind")
	}
	if q.AnchorID != "" && (!validID(q.AnchorID) || (q.AnchorKind != "nf_alert" && q.AnchorKind != "config_drift")) {
		return nil, fail(400, "INVESTIGATION_INVALID_QUERY", "Invalid anchor ID")
	}
	if q.AlertID != "" && (q.AnchorKind != "" || q.AnchorID != "") {
		return nil, fail(400, "INVESTIGATION_ANCHOR_CONFLICT", "Conflicting anchor filters")
	}
	q.Q = strings.TrimSpace(q.Q)
	if !validText(q.Q, 640) || len([]rune(q.Q)) > 160 || (q.Status != "" && q.Status != "open" && q.Status != "investigating" && q.Status != "resolved") || (q.AlertID != "" && !validID(q.AlertID)) || (q.ResourceID != "" && !validID(q.ResourceID)) {
		return nil, fail(400, "INVESTIGATION_INVALID_QUERY", "Invalid investigation filter")
	}
	if q.Limit == 0 {
		q.Limit = 50
	}
	if q.Limit < 1 || q.Limit > 100 {
		return nil, fail(400, "INVESTIGATION_INVALID_QUERY", "Limit must be between 1 and 100")
	}
	after, e := s.decodeCursor(q)
	if e != nil {
		return nil, e
	}
	v, more, e := s.records.List(ctx, q, after)
	if e != nil {
		return nil, e
	}
	out := &ListView{Items: []RecordSummary{}, HasMore: more}
	for _, r := range v {
		out.Items = append(out.Items, RecordSummary{ID: r.ID, AlertID: r.AlertID, ResourceID: r.ResourceID, Title: r.Title, Status: r.Status, Revision: r.Revision, UpdatedAt: r.UpdatedAt, UpdatedBy: r.UpdatedBy, AnchorKind: r.AnchorKind, AnchorID: r.AnchorID})
	}
	if more && len(v) > 0 {
		cursor := s.encodeCursor(q, v[len(v)-1])
		out.NextCursor = &cursor
	}
	return out, nil
}
func (s *Service) log(p *auth.Principal, action string, v *Record) {
	if s.audit == nil {
		return
	}
	s.audit.WriteBestEffort(audit.WriteAuditInput{Action: "investigation." + action, Module: "investigation", Result: "success", RiskLevel: "low", Actor: audit.ActorInput{Type: "user", Username: p.Username, Role: p.Role}, Metadata: map[string]any{"investigationId": v.ID, "alertId": v.AlertID, "revision": v.Revision, "status": v.Status}})
}

func finalizeTimeline(out *ContextView) {
	filtered := out.Events[:0]
	for _, v := range out.Events {
		if !v.At.Before(out.From) && !v.At.After(out.To) {
			filtered = append(filtered, v)
		}
	}
	out.Events = filtered
	sort.Slice(out.Events, func(i, j int) bool {
		if out.Events[i].At.Equal(out.Events[j].At) {
			return out.Events[i].Key < out.Events[j].Key
		}
		return out.Events[i].At.Before(out.Events[j].At)
	})
	if len(out.Events) > MaxEvents {
		out.Events = out.Events[len(out.Events)-MaxEvents:]
		for _, name := range []string{"alerts", "health", "configuration"} {
			if c := out.Coverage[name]; c.Returned > 0 {
				out.Coverage[name] = incomplete(c, "event_limit")
			}
		}
	}
}
func validRelation(kind string) bool { return topology.ValidateRelationshipType(kind) == nil }

func validLayerState(state string) bool {
	for _, valid := range nfhealth.CanonicalLayerStates {
		if state == valid {
			return true
		}
	}
	return false
}
