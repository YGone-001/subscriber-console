package configdrift

import (
	"context"
	"errors"
	"strconv"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/governance"
	"subscriber/internal/operationsview"
	"sync"
	"time"
)

type Sources interface {
	Get(context.Context, string) (*configsnapshots.SourceView, error)
	DriftPolicy(context.Context, string) (configsnapshots.DriftPolicy, error)
	SetDriftPolicy(context.Context, *auth.Principal, string, configsnapshots.DriftPolicyRequest) (configsnapshots.DriftPolicy, error)
	DriftSources(context.Context) ([]string, error)
	ConsumeDrift(context.Context, string, func(context.Context, configsnapshots.DriftInput) error) error
	DriftProgress(context.Context, string) (int64, int, error)
}
type Groups interface {
	ResolveGroupScope(context.Context, operationsview.GroupFilter) (operationsview.GroupScope, error)
}
type AuditWriter interface{ WriteBestEffort(audit.WriteAuditInput) }
type Service struct {
	repo      Store
	sources   Sources
	actors    governance.ActorRepository
	audit     AuditWriter
	sink      NoticeSink
	groups    Groups
	mu        sync.Mutex
	running   bool
	lastError string
	lastRun   time.Time
}

func NewService(r Store, s Sources, a governance.ActorRepository, w AuditWriter) *Service {
	return &Service{repo: r, sources: s, actors: a, audit: w}
}
func (s *Service) SetSink(v NoticeSink) { s.sink = v }
func (s *Service) SetGroups(g Groups)   { s.groups = g }
func (s *Service) flush(ctx context.Context, st *State) error {
	if st.Pending == nil {
		return nil
	}
	p := st.Pending
	if e := s.repo.Materialize(ctx, p); e != nil {
		return e
	}
	if p.Notify && s.sink != nil {
		if e := s.sink.NotifyConfigDrift(ctx, p.Alert, p.Event.Kind); e != nil {
			return e
		}
	}
	st.Pending = nil
	return s.repo.Save(ctx, st, st.Version)
}
func (s *Service) Consume(ctx context.Context, in configsnapshots.DriftInput) error {
	st, e := s.repo.State(ctx, in.SourceID)
	if e != nil {
		return e
	}
	if e = s.flush(ctx, st); e != nil {
		return e
	}
	if in.Sequence <= st.Sequence {
		return nil
	}
	if e = reduce(st, in); e != nil {
		return e
	}
	if e = s.repo.Save(ctx, st, st.Version); e != nil {
		return e
	}
	return s.flush(ctx, st)
}
func (s *Service) RunOnce(ctx context.Context) error {
	listContext, listCancel := context.WithTimeout(ctx, 2*time.Second)
	ids, e := s.sources.DriftSources(listContext)
	listCancel()
	if e != nil {
		return e
	}
	jobs := make(chan string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var first error
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range jobs {
				c, cancel := context.WithTimeout(ctx, 10*time.Second)
				st, err := s.repo.State(c, id)
				if err == nil {
					err = s.flush(c, st)
				}
				if err == nil {
					err = s.sources.ConsumeDrift(c, id, s.Consume)
				}
				cancel()
				if err != nil && !errors.Is(err, configsnapshots.ErrBusy) {
					mu.Lock()
					if first == nil {
						first = err
					}
					mu.Unlock()
				}
			}
		}()
	}
	for _, id := range ids {
		select {
		case jobs <- id:
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			return ctx.Err()
		}
	}
	close(jobs)
	wg.Wait()
	return first
}
func (s *Service) Run(ctx context.Context) {
	s.mu.Lock()
	s.running = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.running = false; s.mu.Unlock() }()
	lastPrune := time.Time{}
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e := s.RunOnce(ctx)
			if time.Since(lastPrune) >= time.Hour {
				if r, ok := s.repo.(interface {
					Prune(context.Context, time.Time) error
				}); ok {
					lastPrune = time.Now().UTC()
					if err := r.Prune(ctx, lastPrune); err != nil && e == nil {
						e = err
					}
				}
			}
			s.mu.Lock()
			s.lastRun = time.Now().UTC()
			s.lastError = ""
			if e != nil {
				s.lastError = "evaluation_or_projection_failed"
			}
			s.mu.Unlock()
		}
	}
}
func (s *Service) Meta() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{"workerRunning": s.running, "lastRunAt": s.lastRun, "lastError": s.lastError, "defaultEnabled": false, "defaultSeverity": "warning", "severities": []string{"critical", "warning", "info"}, "maxJournal": configsnapshots.MaxDriftJournal, "batchSize": 32, "concurrency": 2, "retentionDays": 90, "sourceScope": "declared_local_sources", "configWriteSupported": false}
}

type PolicyView struct {
	SourceID           string                      `json:"sourceId"`
	Policy             configsnapshots.DriftPolicy `json:"policy"`
	Registered         bool                        `json:"registered"`
	ResourceState      string                      `json:"resourceState"`
	BaselineID         string                      `json:"baselineId"`
	BaselineRevision   int64                       `json:"baselineRevision"`
	CollectionState    string                      `json:"collectionState"`
	PublicationPending bool                        `json:"publicationPending"`
	PublishedSequence  int64                       `json:"publishedSequence"`
	QueuedInputs       int                         `json:"queuedInputs"`
	Evaluation         Evaluation                  `json:"evaluation"`
	OpenAlertID        string                      `json:"openAlertId"`
	Freshness          string                      `json:"freshness"`
}

func (s *Service) Policy(ctx context.Context, id string) (*PolicyView, error) {
	source, e := s.sources.Get(ctx, id)
	if e != nil {
		return nil, e
	}
	p, e := s.sources.DriftPolicy(ctx, id)
	if e != nil {
		return nil, e
	}
	st, e := s.repo.State(ctx, id)
	if e != nil {
		return nil, e
	}
	seq, n, e := s.sources.DriftProgress(ctx, id)
	if e != nil {
		return nil, e
	}
	ev := st.Evaluation
	if ev.State == "" {
		ev.State = "disabled"
		if p.Enabled {
			ev.State = "awaiting_observation"
		}
	}
	v := &PolicyView{SourceID: id, Policy: p, Registered: source.Registered, ResourceState: source.ResourceState, BaselineID: source.BaselineID, BaselineRevision: source.Revision, CollectionState: source.CollectionState, PublicationPending: source.Pending, PublishedSequence: seq, QueuedInputs: n, Evaluation: ev, Freshness: "unknown"}
	if p.Enabled && source.BaselineID == "" {
		v.Evaluation.State = "not_armed"
		v.Evaluation.Reason = "no_baseline"
	}
	if p.Enabled && source.Comparison == "incompatible" {
		v.Evaluation.State = "comparison_unavailable"
		v.Evaluation.Reason = "incompatible"
	}
	if p.Enabled && !source.Registered {
		v.Evaluation.State = "comparison_unavailable"
		v.Evaluation.Reason = "source_not_registered"
	}
	if st.Current != nil {
		v.OpenAlertID = st.Current.ID
	}
	if ev.LastVerified != nil {
		v.Freshness = "last_observation"
		if source.IntervalSeconds > 0 {
			v.Freshness = "fresh"
			if time.Since(ev.LastVerified.At) > 3*time.Duration(source.IntervalSeconds)*time.Second {
				v.Freshness = "stale"
			}
		}
	}
	return v, nil
}
func (s *Service) SetPolicy(ctx context.Context, p *auth.Principal, id string, q configsnapshots.DriftPolicyRequest) (*PolicyView, error) {
	if _, e := s.sources.SetDriftPolicy(ctx, p, id, q); e != nil {
		return nil, e
	}
	return s.Policy(ctx, id)
}
func (s *Service) Alert(ctx context.Context, id string) (*Alert, error) {
	if !configsnapshots.ValidID(id) {
		return nil, fail(400, "CONFIG_DRIFT_INVALID_ID", "Invalid alert ID")
	}
	return s.repo.Alert(ctx, id)
}
func (s *Service) List(ctx context.Context, q ListQuery, g operationsview.GroupFilter) (*ListView, error) {
	if q.Limit < 1 || q.Limit > 200 || (q.State != "" && q.State != "open" && q.State != "active" && q.State != "acknowledged" && q.State != "resolved") || (q.Severity != "" && q.Severity != "critical" && q.Severity != "warning" && q.Severity != "info") || (q.SourceID != "" && !configsnapshots.ValidID(q.SourceID)) || (q.ResourceID != "" && !configsnapshots.ValidID(q.ResourceID)) {
		return nil, fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Invalid bounded alert filter")
	}
	complete := "complete"
	if g.HasGroups() || g.Domain != "" {
		if s.groups == nil {
			return nil, fail(503, "CONFIG_DRIFT_SCOPE_UNAVAILABLE", "Group scope is unavailable")
		}
		v, e := s.groups.ResolveGroupScope(ctx, g)
		if e != nil {
			return nil, e
		}
		if v.Inventory.Completeness == "unavailable" || v.Topology.Completeness == "unavailable" {
			return nil, fail(503, "CONFIG_DRIFT_SCOPE_UNAVAILABLE", "Group scope is unavailable")
		}
		q.ResourceIDs = v.IDs
		if q.ResourceIDs == nil {
			q.ResourceIDs = []string{}
		}
		q.Scope = v.Fingerprint
		if v.Inventory.Completeness != "complete" || v.Topology.Completeness != "complete" {
			complete = "partial"
		}
	}
	out, e := s.repo.List(ctx, q)
	if e == nil && complete != "complete" {
		out.Completeness = complete
		out.Summary = nil
	}
	return out, e
}
func (s *Service) Events(ctx context.Context, id, cursor string, limit int) (*Page[Event], error) {
	if _, e := s.Alert(ctx, id); e != nil {
		return nil, e
	}
	if limit < 1 || limit > 200 {
		return nil, fail(400, "CONFIG_DRIFT_INVALID_QUERY", "Invalid event limit")
	}
	return s.repo.Events(ctx, id, cursor, limit)
}
func (s *Service) Acknowledge(ctx context.Context, p *auth.Principal, id string, q AckRequest) (*Alert, error) {
	if p == nil || !auth.HasPermission(p, "core.configure") {
		return nil, fail(403, "PERMISSION_DENIED", "Forbidden")
	}
	if q.ExpectedRevision < 1 {
		return nil, fail(400, "CONFIG_DRIFT_INVALID_REVISION", "A positive expectedRevision is required")
	}
	a, e := s.Alert(ctx, id)
	if e != nil {
		return nil, e
	}
	st, e := s.repo.State(ctx, a.SourceID)
	if e != nil {
		return nil, e
	}
	if e = s.flush(ctx, st); e != nil {
		return nil, e
	}
	if st.Current == nil || st.Current.ID != id || st.Current.Revision != q.ExpectedRevision || st.Current.State != "active" {
		return nil, ErrConflict
	}
	actor, f := governance.RevalidateFreshActor(ctx, s.actors, p)
	if f != nil {
		return nil, f
	}
	if !auth.HasPermission(&auth.Principal{NormalizedRole: actor.NormalizedRole}, "core.configure") {
		return nil, fail(403, "PERMISSION_DENIED", "Forbidden")
	}
	updated := *st.Current
	now := time.Now().UTC().Truncate(time.Millisecond)
	updated.State = "acknowledged"
	updated.AcknowledgedAt = &now
	updated.AcknowledgedBy = actor.Username
	updated.Revision++
	eventID := stableID(id + ":ack:" + strconv.FormatInt(updated.Revision, 10))
	st.Current = &updated
	st.Pending = &Mutation{ID: eventID, Alert: updated, Event: Event{ID: eventID, AlertID: id, SourceID: a.SourceID, Kind: "acknowledged", At: now, Actor: actor.Username}}
	if e = s.repo.Save(ctx, st, st.Version); e != nil {
		return nil, e
	}
	if e = s.flush(ctx, st); e != nil {
		return nil, e
	}
	if s.audit != nil {
		s.audit.WriteBestEffort(audit.WriteAuditInput{Action: "config_drift.acknowledge", Module: "config_drift", TargetID: id, Result: "success", RiskLevel: "low", Actor: audit.ActorInput{Type: "user", Username: actor.Username}})
	}
	return &updated, nil
}
