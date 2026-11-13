package configsnapshots

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"
	"subscriber/internal/inventory"
)

type ResourceReader interface {
	GetByID(context.Context, string) (*inventory.Resource, error)
}
type ResourceBatchReader interface {
	FindByIDs(context.Context, []string) ([]inventory.Resource, error)
}
type AuditWriter interface{ WriteBestEffort(audit.WriteAuditInput) }
type Service struct {
	repo           Repository
	actors         governance.ActorRepository
	resources      ResourceReader
	audit          AuditWriter
	catalog        Catalog
	key            []byte
	keyVersion     string
	slots          chan struct{}
	clock          func() time.Time
	read           func(context.Context, string, Source) ([]byte, string)
	workerMu       sync.Mutex
	workerState    string
	next           map[string]time.Time
	scheduleErrors map[string]string
	scheduled      map[string]bool
}

func NewService(repo Repository, catalog Catalog, key []byte, actors governance.ActorRepository, resources ResourceReader, writer AuditWriter) *Service {
	s := &Service{repo: repo, catalog: catalog, key: append([]byte{}, key...), actors: actors, resources: resources, audit: writer, slots: make(chan struct{}, 2), clock: time.Now, read: readSource, workerState: "stopped", next: map[string]time.Time{}, scheduleErrors: map[string]string{}, scheduled: map[string]bool{}}
	if len(key) >= 32 {
		s.keyVersion = sum(key)[:16]
	} else {
		s.key = nil
	}
	return s
}
func randomID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return ""
	}
	return uuidHex(hex.EncodeToString(b))
}
func uuidHex(s string) string {
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}
func requestID(kind, source, id string) string {
	return uuidHex(sum([]byte(kind + ":" + source + ":" + id))[:32])
}
func (s *Service) now() time.Time { return s.clock().UTC().Truncate(time.Millisecond) }
func (s *Service) declared(id string) (Source, bool) {
	for _, v := range s.catalog.Sources {
		if v.SourceID == id {
			return v, true
		}
	}
	return Source{}, false
}
func (s *Service) checkResource(ctx context.Context, source Source) string {
	if source.ResourceID == "" {
		return "unassociated"
	}
	if s.resources == nil {
		return "unavailable"
	}
	r, e := s.resources.GetByID(ctx, source.ResourceID)
	if e != nil || r == nil {
		return "unavailable"
	}
	if r.LifecycleState == inventory.LifecycleRetired {
		return "retired"
	}
	return "valid"
}
func (s *Service) actor(ctx context.Context, p *auth.Principal) (string, error) {
	if p == nil {
		return "", fail(401, "AUTH_INVALID_TOKEN", "Unauthorized")
	}
	if !auth.HasPermission(p, "core.configure") {
		return "", fail(403, "PERMISSION_DENIED", "Configuration permission required")
	}
	a, e := governance.RevalidateFreshActor(ctx, s.actors, p)
	if e != nil {
		return "", fail(e.Status, e.Code, e.Message)
	}
	if !auth.HasPermission(&auth.Principal{NormalizedRole: a.NormalizedRole}, "core.configure") {
		return "", fail(403, "PERMISSION_DENIED", "Configuration permission required")
	}
	return a.Username, nil
}
func (s *Service) log(actor, kind, id, result string) {
	if s.audit != nil {
		s.audit.WriteBestEffort(audit.WriteAuditInput{Action: "config_snapshot." + kind, Module: "config_snapshots", TargetID: id, Result: result, RiskLevel: "medium", Actor: audit.ActorInput{Type: map[bool]string{true: "system", false: "user"}[actor == "system"], Username: actor}})
	}
}
func (s *Service) view(ctx context.Context, source Source, state *State, registered bool) SourceView {
	v := s.viewWithoutResource(source, state, registered)
	v.ResourceState = s.checkResource(ctx, source)
	return v
}
func (s *Service) viewWithoutResource(source Source, state *State, registered bool) SourceView {
	v := SourceView{Source: source, Registered: registered, Revision: 1, CollectionState: "not_collected", ResourceState: "unassociated", Comparison: "no_baseline"}
	s.workerMu.Lock()
	v.ScheduleState = "disabled"
	if source.IntervalSeconds > 0 {
		v.ScheduleState = s.workerState
		if at := s.next[source.SourceID]; !at.IsZero() {
			v.NextCollectionAt = &at
		}
		v.ScheduleLastError = s.scheduleErrors[source.SourceID]
	}
	s.workerMu.Unlock()
	if state == nil {
		return v
	}
	v.Revision = state.Revision
	v.Latest = state.Latest
	v.BaselineID = state.BaselineID
	v.BaselineBy = state.BaselineBy
	v.BaselineAt = state.BaselineAt
	v.Pending = state.Pending != nil
	if v.Latest != nil {
		v.CollectionState = v.Latest.Status
	}
	v.LatestSnapshot = state.LatestEvidence
	if v.BaselineID != "" {
		v.Comparison = Compare(state.BaselineEvidence, v.LatestSnapshot)
		if state.BaselineEvidence == nil {
			v.Comparison = "unavailable"
		}
	}
	if v.LatestSnapshot != nil && v.LatestSnapshot.Generation != source.Generation {
		v.Comparison = "incompatible"
	}
	if v.LatestSnapshot != nil && v.LatestSnapshot.KeyVersion != s.keyVersion {
		v.Comparison = "incompatible"
	}
	if v.Pending {
		v.CollectionState = "publication_pending"
	}
	return v
}
func (s *Service) List(ctx context.Context, q ListQuery) (*SourceList, error) {
	if len(q.ResourceIDs) > 1000 {
		return nil, fail(400, "CONFIG_INVALID_QUERY", "Resource scope exceeds the bound")
	}
	selected := map[string]bool{}
	for _, id := range q.ResourceIDs {
		if !ValidID(id) {
			return nil, fail(400, "CONFIG_INVALID_QUERY", "Invalid resource scope")
		}
		selected[id] = true
	}
	if q.Limit < 1 || q.Limit > 200 || len(q.Q) > 128 || (q.Cursor != "" && !ValidID(q.Cursor)) || (q.ResourceID != "" && !ValidID(q.ResourceID)) {
		return nil, fail(400, "CONFIG_INVALID_QUERY", "Invalid source query")
	}
	out := &SourceList{Page: Page[SourceView]{Items: []SourceView{}}, Completeness: "complete", CatalogState: s.catalog.State}
	var states []State
	var e error
	limited := false
	if q.ResourceIDs != nil {
		declared := []string{}
		for _, source := range s.catalog.Sources {
			if selected[source.ResourceID] {
				declared = append(declared, source.SourceID)
			}
		}
		if repo, ok := s.repo.(ScopedStateRepository); ok {
			states, limited, e = repo.StatesForResources(ctx, q.ResourceIDs, declared, 1000)
		} else {
			e = fail(503, "CONFIG_SCOPE_UNAVAILABLE", "Bounded configuration scope is unavailable")
		}
	} else {
		states, e = s.repo.States(ctx)
	}
	if e != nil {
		out.Completeness = "unavailable"
		return out, nil
	}
	if limited {
		out.Completeness = "partial"
	}
	byID := map[string]*State{}
	all := map[string]Source{}
	registered := map[string]bool{}
	for i := range states {
		v := &states[i]
		byID[v.SourceID] = v
		all[v.SourceID] = v.Source
	}
	for _, v := range s.catalog.Sources {
		all[v.SourceID] = v
		registered[v.SourceID] = true
	}
	ids := []string{}
	resourceIDs := []string{}
	resourceSeen := map[string]bool{}
	for id, source := range all {
		if q.ResourceIDs != nil && !selected[source.ResourceID] {
			continue
		}
		ids = append(ids, id)
		if source.ResourceID != "" && !resourceSeen[source.ResourceID] {
			resourceIDs = append(resourceIDs, source.ResourceID)
			resourceSeen[source.ResourceID] = true
		}
	}
	sort.Strings(ids)
	resources := map[string]string{}
	if batch, ok := s.resources.(ResourceBatchReader); ok {
		for start := 0; start < len(resourceIDs); start += 50 {
			end := start + 50
			if end > len(resourceIDs) {
				end = len(resourceIDs)
			}
			rows, e := batch.FindByIDs(ctx, resourceIDs[start:end])
			if e != nil {
				continue
			}
			for _, r := range rows {
				state := "valid"
				if r.LifecycleState == inventory.LifecycleRetired {
					state = "retired"
				}
				resources[r.ResourceID] = state
			}
		}
	}
	counts := map[string]int{"total": 0, "changed": 0, "failed": 0, "noBaseline": 0, "currentNoBaseline": 0}
	for _, id := range ids {
		source := all[id]
		if q.ResourceIDs != nil && !selected[source.ResourceID] {
			continue
		}
		if q.ResourceID != "" && source.ResourceID != q.ResourceID {
			continue
		}
		if q.Q != "" && !strings.Contains(strings.ToLower(source.Name+" "+source.SourceID+" "+source.ResourceID), strings.ToLower(q.Q)) {
			continue
		}
		// Listing resolves resource identity in bounded batches, never per row.
		v := s.viewWithoutResource(source, byID[id], registered[id])
		v.ResourceState = "unassociated"
		if source.ResourceID != "" {
			v.ResourceState = resources[source.ResourceID]
			if v.ResourceState == "" {
				v.ResourceState = "unavailable"
			}
		}
		if q.Status != "" && v.CollectionState != q.Status {
			continue
		}
		// Collection-wide summaries describe the same filter, never this page.
		counts["total"]++
		if v.Comparison == "visible_changed" || v.Comparison == "unprojected_changed" {
			counts["changed"]++
		}
		if v.CollectionState != "ok" && v.CollectionState != "not_collected" {
			counts["failed"]++
		}
		if v.BaselineID == "" {
			counts["noBaseline"]++
			if registered[id] {
				counts["currentNoBaseline"]++
			}
		}
		if id > q.Cursor && len(out.Items) < q.Limit+1 {
			v.LatestSnapshot = nil
			out.Items = append(out.Items, v)
		}
	}
	if len(out.Items) > q.Limit {
		out.HasMore = true
		out.Items = out.Items[:q.Limit]
		id := out.Items[len(out.Items)-1].SourceID
		out.NextCursor = &id
	}
	if out.Completeness == "complete" {
		out.Summary = &counts
	}
	if s.catalog.State == "invalid_config" {
		out.Completeness = "partial"
		out.Summary = nil
	}
	return out, nil
}
func (s *Service) Get(ctx context.Context, id string) (*SourceView, error) {
	if !ValidID(id) {
		return nil, fail(400, "CONFIG_INVALID_ID", "Invalid source identifier")
	}
	state, e := s.repo.GetState(ctx, id)
	if e != nil && !errors.Is(e, ErrNotFound) {
		return nil, e
	}
	if errors.Is(e, ErrNotFound) {
		state = nil
	}
	source, ok := s.declared(id)
	if !ok {
		if state == nil {
			return nil, ErrNotFound
		}
		source = state.Source
	}
	v := s.view(ctx, source, state, ok)
	if state != nil && state.LatestSnapshotID != "" {
		snap, e := s.Snapshot(ctx, id, state.LatestSnapshotID)
		if e != nil {
			v.CollectionState = "storage_unavailable"
			v.Comparison = "unavailable"
		} else {
			v.LatestSnapshot = snap
		}
	}
	return &v, nil
}
func (s *Service) lease(ctx context.Context, source Source) (*State, func(), error) {
	token := randomID()
	if token == "" {
		return nil, nil, fail(503, "CONFIG_RANDOM_UNAVAILABLE", "Cannot acquire source lease")
	}
	state, e := s.repo.Acquire(ctx, source, token, s.now())
	if e != nil {
		return nil, nil, e
	}
	release := func() {
		c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.repo.Release(c, source.SourceID, token)
	}
	if e = s.recover(ctx, state); e != nil {
		release()
		return nil, nil, e
	}
	return state, release, nil
}
func (s *Service) recover(ctx context.Context, state *State) error {
	if state.Pending == nil {
		return nil
	}
	p := state.Pending
	if e := s.repo.Publish(ctx, p); e != nil {
		return e
	}
	o := p.Observation
	o.Published = true
	state.Latest = &o
	if o.Status == "ok" {
		snap, e := s.repo.Snapshot(ctx, state.SourceID, o.SnapshotID)
		if e != nil {
			return e
		}
		snap.Projection = ""
		state.LatestSnapshotID = o.SnapshotID
		state.LatestEvidence = snap
	}
	if p.Observation.DriftInput != nil {
		if e := appendDrift(state, *p.Observation.DriftInput); e != nil {
			return e
		}
	}
	state.Pending = nil
	return s.repo.Save(ctx, state)
}
func (s *Service) Capture(ctx context.Context, p *auth.Principal, id string, req CaptureRequest) (*Observation, error) {
	actor, e := s.actor(ctx, p)
	if e != nil {
		return nil, e
	}
	return s.capture(ctx, id, req, actor, func(c context.Context) error { _, err := s.actor(c, p); return err })
}
func (s *Service) capture(ctx context.Context, id string, req CaptureRequest, actor string, revalidate ...func(context.Context) error) (*Observation, error) {
	if !ValidID(id) || !ValidID(req.RequestID) {
		return nil, fail(400, "CONFIG_INVALID_ID", "Source and request IDs must be UUIDs")
	}
	source, ok := s.declared(id)
	if !ok {
		return nil, fail(409, "CONFIG_SOURCE_NOT_REGISTERED", "Source is not registered for local collection")
	}
	if len(s.key) < 32 {
		return nil, fail(503, "CONFIG_FINGERPRINT_UNAVAILABLE", "A private fingerprint key is required")
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return nil, ErrBusy
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	state, release, e := s.lease(ctx, source)
	if e != nil {
		return nil, e
	}
	defer release()
	obsID := requestID("observation", id, req.RequestID)
	if previous, e := s.repo.Observation(ctx, id, obsID); e == nil {
		if previous.Generation != source.Generation {
			return nil, ErrConflict
		}
		if !previous.Published {
			if previous.PreparedVersion != state.Version {
				return nil, ErrConflict
			}
			fresh := false
			if previous.SnapshotID != "" {
				snap, e := s.repo.Snapshot(ctx, id, previous.SnapshotID)
				if e != nil {
					return nil, e
				}
				fresh = !snap.Published
			}
			state.Source = source
			state.Pending = &Pending{Observation: *previous, SnapshotID: previous.SnapshotID, NewSnapshot: fresh}
			if e = s.repo.Save(ctx, state); e != nil {
				return nil, e
			}
			if e = s.recover(ctx, state); e != nil {
				return nil, e
			}
			previous.Published = true
		}
		return previous, nil
	} else if !errors.Is(e, ErrNotFound) {
		return nil, e
	}
	resource := s.checkResource(ctx, source)
	if resource != "valid" && resource != "unassociated" {
		return nil, fail(409, "CONFIG_RESOURCE_UNAVAILABLE", "Referenced resource is unavailable or retired")
	}
	needed := 1
	if source.Generation != state.Source.Generation {
		needed++
	}
	if state.DriftPolicy.Revision > 0 && len(state.DriftQueue)+needed > MaxDriftJournal {
		return nil, fail(503, "CONFIG_DRIFT_BACKLOG_FULL", "Configuration drift backlog is full")
	}
	if e = s.repo.Prune(ctx, state, s.now()); e != nil {
		return nil, e
	}
	size, observations, e := s.repo.Usage(ctx)
	if e != nil {
		return nil, e
	}
	if size+2*(MaxProjectionBytes+16384) > 1<<30 || observations+8192 > 256<<20 {
		return nil, fail(507, "CONFIG_CAPACITY_EXCEEDED", "Configuration storage capacity exceeded")
	}
	o := Observation{ObservationID: obsID, SourceID: id, Generation: source.Generation, ResourceID: source.ResourceID, CollectedAt: s.now(), Actor: actor, Status: "ok"}
	root := source.Root
	if root == "" {
		root = s.catalog.Root
	}
	data, reason := s.read(ctx, root, source)
	var snapshot *Snapshot
	if reason != "" {
		o.Status = "unreadable"
		o.Reason = reason
		if reason == "changed_during_read" {
			o.Status = reason
		}
	} else {
		h := hmac.New(sha256.New, s.key)
		_, _ = h.Write(data)
		fingerprint := hex.EncodeToString(h.Sum(nil))
		mode, why, projection := Projection(data, source.Format, source.Profile)
		snapshot = &Snapshot{SnapshotID: requestID("snapshot", id, req.RequestID), SourceID: id, Generation: source.Generation, CollectorID: source.CollectorID, ResourceID: source.ResourceID, CollectedAt: o.CollectedAt, Actor: actor, Mode: mode, Reason: why, Policy: source.Profile, KeyVersion: s.keyVersion, Fingerprint: fingerprint, ProjectionHash: sum([]byte(projection)), Projection: projection, Size: int64(len(data))}
		if state.LatestSnapshotID != "" {
			last, err := s.repo.Snapshot(ctx, id, state.LatestSnapshotID)
			if err != nil {
				return nil, err
			}
			comparison := Compare(last, snapshot)
			if comparison != "incompatible" {
				changed := comparison != "unchanged"
				o.Changed = &changed
				if !changed {
					snapshot = nil
					o.SnapshotID = last.SnapshotID
				}
			}
		}
		if snapshot != nil {
			o.SnapshotID = snapshot.SnapshotID
		}
	}
	// Revalidate mutable ownership immediately before publication.
	if resource = s.checkResource(ctx, source); resource != "valid" && resource != "unassociated" {
		return nil, fail(409, "CONFIG_RESOURCE_UNAVAILABLE", "Referenced resource is unavailable or retired")
	}
	for _, check := range revalidate {
		if err := check(ctx); err != nil {
			return nil, err
		}
	}
	if state.DriftPolicy.Revision > 0 && source.Generation != state.Source.Generation {
		in := s.driftInput(state, source, "environment")
		in.Reason = "source_reconfigured"
		if e = appendDrift(state, in); e != nil {
			return nil, e
		}
		state.DriftEnvironment = source.Generation + ":" + source.ResourceID
	}
	o.PreparedVersion = state.Version
	if state.DriftPolicy.Revision > 0 {
		in := s.driftInput(state, source, "observation")
		in.ObservationID = o.ObservationID
		in.SnapshotID = o.SnapshotID
		in.Status = o.Status
		in.At = o.CollectedAt
		in.Reason = o.Reason
		if o.Status == "ok" {
			current := snapshot
			if current == nil {
				current, e = s.repo.Snapshot(ctx, id, o.SnapshotID)
				if e != nil {
					return nil, e
				}
			}
			in.Comparison = Compare(state.BaselineEvidence, current)
		}
		o.DriftInput = &in
	}
	if snapshot != nil {
		if e = s.repo.InsertSnapshot(ctx, snapshot); e != nil {
			return nil, e
		}
	}
	if e = s.repo.InsertObservation(ctx, &o); e != nil {
		return nil, e
	}
	state.Source = source
	state.Pending = &Pending{Observation: o, SnapshotID: o.SnapshotID, NewSnapshot: snapshot != nil}
	if e = s.repo.Save(ctx, state); e != nil {
		return nil, e
	}
	if e = s.recover(ctx, state); e != nil {
		return nil, e
	}
	s.log(actor, "capture", id, o.Status)
	o.Published = true
	return &o, nil
}
func (s *Service) Baseline(ctx context.Context, p *auth.Principal, id string, req BaselineRequest) (*SourceView, error) {
	actor, e := s.actor(ctx, p)
	if e != nil {
		return nil, e
	}
	if !ValidID(id) || req.ExpectedRevision < 1 || req.SnapshotID == nil || (*req.SnapshotID != "" && !ValidID(*req.SnapshotID)) {
		return nil, fail(400, "CONFIG_INVALID_BASELINE", "A revision and explicit snapshot ID or empty string are required")
	}
	source, ok := s.declared(id)
	if !ok {
		return nil, fail(409, "CONFIG_SOURCE_NOT_REGISTERED", "Source is not registered")
	}
	if r := s.checkResource(ctx, source); r != "valid" && r != "unassociated" {
		return nil, fail(409, "CONFIG_RESOURCE_UNAVAILABLE", "Referenced resource is unavailable or retired")
	}
	state, release, e := s.lease(ctx, source)
	if e != nil {
		return nil, e
	}
	defer release()
	if state.Revision != req.ExpectedRevision {
		return nil, ErrConflict
	}
	state.BaselineEvidence = nil
	if *req.SnapshotID != "" {
		snap, e := s.Snapshot(ctx, id, *req.SnapshotID)
		if e != nil {
			return nil, e
		}
		if snap.Generation != source.Generation || snap.KeyVersion != s.keyVersion || snap.Policy != source.Profile {
			return nil, fail(409, "CONFIG_BASELINE_INCOMPATIBLE", "Snapshot does not match the current source and policy")
		}
		snap.Projection = ""
		state.BaselineEvidence = snap
	}
	now := s.now()
	state.BaselineID = *req.SnapshotID
	state.BaselineBy = actor
	state.BaselineAt = &now
	state.Revision++
	if state.DriftPolicy.Revision > 0 {
		in := s.driftInput(state, source, "baseline")
		if e = appendDrift(state, in); e != nil {
			return nil, e
		}
	}
	if _, err := s.actor(ctx, p); err != nil {
		return nil, err
	}
	if resource := s.checkResource(ctx, source); resource != "valid" && resource != "unassociated" {
		return nil, fail(409, "CONFIG_RESOURCE_UNAVAILABLE", "Referenced resource is unavailable or retired")
	}
	if e = s.repo.Save(ctx, state); e != nil {
		return nil, e
	}
	s.log(actor, "baseline", id, "success")
	return s.Get(ctx, id)
}
func (s *Service) Snapshot(ctx context.Context, id, snapshot string) (*Snapshot, error) {
	if !ValidID(id) || !ValidID(snapshot) {
		return nil, fail(400, "CONFIG_INVALID_ID", "Invalid source or snapshot ID")
	}
	v, e := s.repo.Snapshot(ctx, id, snapshot)
	if e != nil {
		return nil, e
	}
	if !v.Published {
		return nil, ErrNotFound
	}
	return v, nil
}
func (s *Service) History(ctx context.Context, id, after string, limit int, observations bool) (any, error) {
	if !ValidID(id) || !validCursor(after) || limit < 1 || limit > 200 {
		return nil, fail(400, "CONFIG_INVALID_QUERY", "Invalid history query")
	}
	if observations {
		rows, e := s.repo.Observations(ctx, id, after, limit+1)
		if e != nil {
			return nil, e
		}
		out := Page[Observation]{Items: rows}
		if len(rows) > limit {
			out.Items = rows[:limit]
			out.HasMore = true
			c := EncodeCursor(out.Items[limit-1].CollectedAt, out.Items[limit-1].ObservationID)
			out.NextCursor = &c
		}
		return out, nil
	}
	rows, e := s.repo.Snapshots(ctx, id, after, limit+1)
	if e != nil {
		return nil, e
	}
	for i := range rows {
		rows[i].Projection = ""
	}
	out := Page[Snapshot]{Items: rows}
	if len(rows) > limit {
		out.Items = rows[:limit]
		out.HasMore = true
		c := EncodeCursor(out.Items[limit-1].CollectedAt, out.Items[limit-1].SnapshotID)
		out.NextCursor = &c
	}
	return out, nil
}
func (s *Service) Diff(ctx context.Context, id, left, right string) (*Diff, error) {
	a, e := s.Snapshot(ctx, id, left)
	if e != nil {
		return nil, e
	}
	b, e := s.Snapshot(ctx, id, right)
	if e != nil {
		return nil, e
	}
	d := BuildDiff(ctx, a, b)
	return &d, nil
}

func (s *Service) Run(ctx context.Context) {
	jobs := make(chan Source, 2)
	var workers sync.WaitGroup
	for i := 0; i < 2; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case source, open := <-jobs:
					if !open {
						return
					}
					_, err := s.capture(ctx, source.SourceID, CaptureRequest{randomID()}, "system")
					s.workerMu.Lock()
					delete(s.scheduled, source.SourceID)
					s.scheduleErrors[source.SourceID] = ""
					if err != nil {
						s.scheduleErrors[source.SourceID] = "schedule_failed"
					}
					s.workerMu.Unlock()
				}
			}
		}()
	}
	s.workerMu.Lock()
	s.workerState = "running"
	for _, source := range s.catalog.Sources {
		if source.IntervalSeconds > 0 {
			s.next[source.SourceID] = s.now().Add(time.Duration(source.IntervalSeconds) * time.Second)
		}
	}
	s.workerMu.Unlock()
	defer func() {
		close(jobs)
		workers.Wait()
		s.workerMu.Lock()
		s.workerState = "stopped"
		s.scheduled = map[string]bool{}
		s.workerMu.Unlock()
	}()
	lastPrune := time.Time{}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			now := s.now()
			for _, source := range s.catalog.Sources {
				if source.IntervalSeconds == 0 {
					continue
				}
				s.workerMu.Lock()
				due := s.next[source.SourceID]
				if now.Before(due) || s.scheduled[source.SourceID] {
					s.workerMu.Unlock()
					continue
				}
				select {
				case jobs <- source:
					s.scheduled[source.SourceID] = true
					s.next[source.SourceID] = now.Add(time.Duration(source.IntervalSeconds) * time.Second)
				default:
					// Leave the source due; the bounded queue is retried on the next tick.
				}
				s.workerMu.Unlock()
			}
			if now.Sub(lastPrune) >= time.Hour {
				lastPrune = now
				s.maintain(ctx)
			}
		}
	}
}
func (s *Service) maintain(ctx context.Context) {
	states, e := s.repo.States(ctx)
	if e != nil {
		return
	}
	for _, v := range states {
		c, cancel := context.WithTimeout(ctx, 5*time.Second)
		source := v.Source
		if current, ok := s.declared(source.SourceID); ok {
			source = current
		}
		state, release, e := s.lease(c, source)
		if e == nil {
			_ = s.repo.Prune(c, state, s.now())
			release()
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
	}
}
func (s *Service) Meta() map[string]any {
	s.workerMu.Lock()
	worker := s.workerState
	s.workerMu.Unlock()
	return map[string]any{"catalogState": s.catalog.State, "fingerprintConfigured": len(s.key) >= 32, "workerState": worker, "profiles": []string{PolicyVersion, "metadata-only-v1"}, "formats": []string{"yaml", "json", "diameter_conf", "text"}, "maxSources": MaxSources, "maxRoots": MaxRoots, "maxFileBytes": MaxFileBytes, "retentionDays": RetentionDays, "maxVersions": MaxVersions, "remoteCollectionSupported": false, "projectionScope": "allowlisted_network_fields", "intervalsEnabledByServerManifest": true}
}
