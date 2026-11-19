package inspections

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/governance"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type AuditWriter interface{ WriteBestEffort(audit.WriteAuditInput) }
type Service struct {
	store     Store
	evidence  Evidence
	actors    governance.ActorRepository
	audit     AuditWriter
	key       []byte
	now       func() time.Time
	mu        sync.Mutex
	running   bool
	lastError string
	wake      chan struct{}
	slots     chan struct{}
}

func NewService(store Store, evidence Evidence, actors governance.ActorRepository, writer AuditWriter, key []byte) *Service {
	h := sha256.Sum256(append([]byte("inspection-cursors-v1:"), key...))
	return &Service{store: store, evidence: evidence, actors: actors, audit: writer, key: h[:], now: time.Now, wake: make(chan struct{}, 1), slots: make(chan struct{}, 2)}
}
func (s *Service) clock() time.Time { return s.now().UTC().Truncate(time.Millisecond) }
func (s *Service) actor(ctx context.Context, p *auth.Principal) (string, error) {
	if p == nil {
		return "", fail(401, "AUTH_INVALID_TOKEN", "Unauthorized")
	}
	if !auth.HasPermission(p, "core.configure") {
		return "", fail(403, "PERMISSION_DENIED", "Inspection configuration permission required")
	}
	a, e := governance.RevalidateFreshActor(ctx, s.actors, p)
	if e != nil {
		return "", e
	}
	if !auth.HasPermission(&auth.Principal{NormalizedRole: a.NormalizedRole}, "core.configure") {
		return "", fail(403, "PERMISSION_DENIED", "Inspection configuration permission required")
	}
	return a.Username, nil
}
func (s *Service) backgroundActor(ctx context.Context, name string) error {
	if s.actors == nil {
		return fail(503, "AUTH_SERVICE_UNAVAILABLE", "User validation unavailable")
	}
	identity, e := s.actors.FindByUsernameIdentity(ctx, name)
	if e != nil {
		return fail(503, "AUTH_SERVICE_UNAVAILABLE", "User validation unavailable")
	}
	if identity == nil || identity.SafeUser.Username != name || identity.SafeUser.Status != "active" || identity.SafeUser.Locked || !auth.HasPermission(&auth.Principal{NormalizedRole: auth.NormalizeRole(identity.SafeUser.Role)}, "core.configure") {
		return fail(403, "INSPECTION_AUTHORIZATION_LOST", "The inspection authorizer no longer has permission")
	}
	return nil
}
func (s *Service) log(actor, action, id string, revision int64) {
	if s.audit != nil {
		s.audit.WriteBestEffort(audit.WriteAuditInput{Action: "inspection." + action, Module: "inspections", TargetID: id, Result: "success", RiskLevel: "low", Actor: audit.ActorInput{Type: "user", Username: actor}, Metadata: map[string]interface{}{"revision": revision}})
	}
}
func (s *Service) Preview(ctx context.Context, d Definition) (*Preview, error) {
	d, e := normalizeDefinition(d)
	if e != nil {
		return nil, e
	}
	scope, e := s.evidence.Resolve(ctx, d.Scope)
	if e != nil {
		return nil, e
	}
	at := s.clock()
	next, e := nextOccurrences(d.Schedule, at, 5)
	if e != nil {
		return nil, e
	}
	return &Preview{d, scope, next, at}, nil
}
func (s *Service) Create(ctx context.Context, p *auth.Principal, req CreateRequest) (*Plan, error) {
	actor, e := s.actor(ctx, p)
	if e != nil {
		return nil, e
	}
	if !validID(req.RequestID) {
		return nil, fail(400, "INSPECTION_INVALID_REQUEST_ID", "requestId must be UUID v4")
	}
	d, e := normalizeDefinition(req.Definition)
	if e != nil {
		return nil, e
	}
	key := digest([]string{actor, req.RequestID})
	id := stableID("plan:" + key)
	requestDigest := digest(d)
	if old, e := s.store.Plan(ctx, id); e == nil {
		if old.RequestDigest != requestDigest || old.RequestKey != key {
			return nil, ErrConflict
		}
		return old, nil
	} else if !errors.Is(e, ErrNotFound) {
		return nil, e
	}
	if _, e = s.Preview(ctx, d); e != nil {
		return nil, e
	}
	if _, e = s.actor(ctx, p); e != nil {
		return nil, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	plan := &Plan{ID: id, Definition: d, Revision: 1, ScheduleRevision: 1, AuthorizedBy: actor, CreatedAt: now, UpdatedAt: now, RequestKey: key, RequestDigest: requestDigest}
	created, e := s.store.Create(ctx, plan)
	if e == nil {
		s.log(actor, "create", id, created.Revision)
	}
	return created, e
}
func (s *Service) GetPlan(ctx context.Context, id string) (*Plan, error) {
	if !validID(id) {
		return nil, fail(400, "INSPECTION_INVALID_ID", "Invalid plan ID")
	}
	return s.store.Plan(ctx, id)
}
func (s *Service) Update(ctx context.Context, p *auth.Principal, id string, req UpdateRequest) (*Plan, error) {
	actor, e := s.actor(ctx, p)
	if e != nil {
		return nil, e
	}
	old, e := s.GetPlan(ctx, id)
	if e != nil {
		return nil, e
	}
	if old.Revision != req.ExpectedRevision || old.Archived {
		return nil, ErrConflict
	}
	d, e := normalizeDefinition(req.Definition)
	if e != nil {
		return nil, e
	}
	if req.Archived && (req.Enabled || old.ActiveRunID != "") {
		return nil, fail(409, "INSPECTION_PLAN_BUSY", "Pause and finish the active inspection before archiving")
	}
	if !req.Archived && (digest(old.Definition) != digest(d) || (req.Enabled && !old.Enabled)) {
		if _, e = s.Preview(ctx, d); e != nil {
			return nil, e
		}
	}
	if req.Enabled {
		if e = s.admission(ctx, false); e != nil {
			return nil, e
		}
	}
	plan := *old
	plan.Definition = d
	plan.Revision++
	plan.Enabled = req.Enabled
	plan.Archived = req.Archived
	plan.UpdatedAt = s.clock()
	plan.ScheduleReason = ""
	changedSchedule := digest(old.Schedule) != digest(d.Schedule) || old.Enabled != req.Enabled
	if changedSchedule {
		plan.ScheduleRevision++
		plan.NextAt = nil
		if plan.Enabled {
			at, err := nextScheduled(d.Schedule, s.clock())
			if err != nil {
				return nil, err
			}
			plan.NextAt = &at
		}
	}
	if req.Enabled {
		plan.AuthorizedBy = actor
	}
	if _, e = s.actor(ctx, p); e != nil {
		return nil, e
	}
	if e = s.store.Update(ctx, &plan, old.Revision); e != nil {
		return nil, e
	}
	s.log(actor, "update", id, plan.Revision)
	return s.GetPlan(ctx, id)
}
func emptyRun(p *Plan, mode, actor, key string, now time.Time) *Run {
	return &Run{ID: stableID(key), PlanID: p.ID, PlanRevision: p.Revision, Definition: p.Definition, Version: Version, Mode: mode, Actor: actor, State: "queued", Conclusion: "inconclusive", QueuedAt: now, Items: []Item{}, Coverage: map[string]Coverage{}, Counts: map[string]int{}, Scope: ResolvedScope{Resources: []ResourceFact{}, AgentIDs: []string{}, Agents: []AgentFact{}}, Comparison: Comparison{State: "not_available"}}
}
func (s *Service) admission(ctx context.Context, queued bool) error {
	n, q, e := s.store.Capacity(ctx)
	if e != nil {
		return e
	}
	if n >= MaxRetainedRuns {
		return fail(409, "INSPECTION_STORAGE_FULL", "Retained-report capacity is full; execution is paused until storage is available")
	}
	if queued && q >= MaxQueued {
		return fail(429, "INSPECTION_QUEUE_FULL", "Inspection queue is full; retry later")
	}
	return nil
}
func (s *Service) Trigger(ctx context.Context, p *auth.Principal, id string, req RunRequest) (*Run, error) {
	actor, e := s.actor(ctx, p)
	if e != nil {
		return nil, e
	}
	if !validID(id) || !validID(req.RequestID) || req.ExpectedRevision < 1 {
		return nil, fail(400, "INSPECTION_INVALID_REQUEST", "Explicit plan revision and request UUID are required")
	}
	key := digest([]string{id, actor, req.RequestID})
	runID := stableID("manual:" + key)
	requestDigest := digest([]any{id, req.ExpectedRevision})
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, e := s.store.Run(ctx, runID); e == nil {
		if old.RequestKey != key || old.RequestDigest != requestDigest {
			return nil, ErrConflict
		}
		return old, nil
	} else if !errors.Is(e, ErrNotFound) {
		return nil, e
	}
	plan, e := s.GetPlan(ctx, id)
	if e != nil {
		return nil, e
	}
	if plan.Pending != nil && plan.Pending.ID == runID {
		if plan.Pending.RequestKey != key || plan.Pending.RequestDigest != requestDigest {
			return nil, ErrConflict
		}
		return plan.Pending, nil
	}
	if plan.Revision != req.ExpectedRevision || plan.Archived {
		return nil, ErrConflict
	}
	if plan.ActiveRunID != "" {
		return nil, fail(409, "INSPECTION_PLAN_BUSY", plan.ActiveRunID)
	}
	if e = s.admission(ctx, true); e != nil {
		return nil, e
	}
	if _, e = s.actor(ctx, p); e != nil {
		return nil, e
	}
	v := emptyRun(plan, "manual", actor, "manual:"+key, s.clock())
	v.RequestKey = key
	v.RequestDigest = requestDigest
	if e = s.store.Admit(ctx, plan, v, nil); e != nil {
		return nil, e
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	s.log(actor, "run", v.ID, plan.Revision)
	return v, nil
}

type cursorValue struct {
	ID     string    `json:"id"`
	At     time.Time `json:"at"`
	Filter string    `json:"filter"`
}

func queryDigest(kind string, q Query) string {
	q.Cursor = ""
	q.Limit = 0
	q.AfterAt = time.Time{}
	return digest([]any{kind, q})
}
func (s *Service) encodeCursor(kind string, q Query, id string, at time.Time) string {
	b, _ := json.Marshal(cursorValue{id, at, queryDigest(kind, q)})
	h := hmac.New(sha256.New, s.key)
	_, _ = h.Write(b)
	return hex.EncodeToString(b) + "." + hex.EncodeToString(h.Sum(nil))
}
func (s *Service) decodeCursor(kind string, q Query) (Query, error) {
	if q.Cursor == "" {
		return q, nil
	}
	if len(q.Cursor) > 2048 {
		return q, fail(400, "INSPECTION_INVALID_CURSOR", "Invalid cursor")
	}
	parts := strings.Split(q.Cursor, ".")
	if len(parts) != 2 {
		return q, fail(400, "INSPECTION_INVALID_CURSOR", "Invalid cursor")
	}
	b, e := hex.DecodeString(parts[0])
	sig, se := hex.DecodeString(parts[1])
	h := hmac.New(sha256.New, s.key)
	_, _ = h.Write(b)
	var v cursorValue
	if e != nil || se != nil || !hmac.Equal(sig, h.Sum(nil)) || json.Unmarshal(b, &v) != nil || v.Filter != queryDigest(kind, q) {
		return q, fail(400, "INSPECTION_INVALID_CURSOR", "Cursor does not match this query")
	}
	q.Cursor = v.ID
	q.AfterAt = v.At
	return q, nil
}
func (s *Service) ListPlans(ctx context.Context, q Query) (*Page[Plan], error) {
	parsed, e := s.decodeCursor("plans", q)
	if e != nil {
		return nil, e
	}
	rows, more, e := s.store.ListPlans(ctx, parsed)
	if e != nil {
		return nil, e
	}
	out := &Page[Plan]{Items: rows, HasMore: more}
	if more && len(rows) > 0 {
		c := s.encodeCursor("plans", q, rows[len(rows)-1].ID, time.Time{})
		out.NextCursor = &c
	}
	return out, nil
}
func (s *Service) ListRuns(ctx context.Context, q Query) (*Page[Run], error) {
	parsed, e := s.decodeCursor("runs", q)
	if e != nil {
		return nil, e
	}
	rows, more, e := s.store.Runs(ctx, parsed)
	if e != nil {
		return nil, e
	}
	out := &Page[Run]{Items: rows, HasMore: more}
	if more && len(rows) > 0 {
		last := rows[len(rows)-1]
		c := s.encodeCursor("runs", q, last.ID, last.QueuedAt)
		out.NextCursor = &c
	}
	return out, nil
}
func (s *Service) GetRun(ctx context.Context, id string) (*Run, error) {
	if !validID(id) {
		return nil, fail(400, "INSPECTION_INVALID_ID", "Invalid run ID")
	}
	return s.store.Run(ctx, id)
}
func (s *Service) Items(ctx context.Context, id string, q Query) (*Page[Item], error) {
	v, e := s.GetRun(ctx, id)
	if e != nil {
		return nil, e
	}
	parsed, e := s.decodeCursor("items:"+id, q)
	if e != nil {
		return nil, e
	}
	out := &Page[Item]{Items: []Item{}}
	for _, i := range v.Items {
		if (q.Kind != "" && q.Kind != i.Kind) || (q.Result != "" && q.Result != i.Result) || i.Key <= parsed.Cursor {
			continue
		}
		out.Items = append(out.Items, i)
		if len(out.Items) > q.Limit {
			out.Items = out.Items[:q.Limit]
			out.HasMore = true
			c := s.encodeCursor("items:"+id, q, out.Items[len(out.Items)-1].Key, time.Time{})
			out.NextCursor = &c
			break
		}
	}
	return out, nil
}
func (s *Service) Meta(ctx context.Context) map[string]any {
	s.mu.Lock()
	running, lastError := s.running, s.lastError
	s.mu.Unlock()
	n, q, e := s.store.Capacity(ctx)
	reason := ""
	if e != nil {
		reason = "storage_unavailable"
		var f *Failure
		if errors.As(e, &f) {
			reason = f.Code
		}
	}
	var retained, queued any
	if e == nil {
		retained = n
		queued = q
	}
	return map[string]any{"version": Version, "running": running, "lastError": lastError, "checkKinds": CheckKinds, "readiness": map[bool]string{true: "ready", false: "unavailable"}[e == nil], "reason": reason, "retainedRuns": retained, "queuedRuns": queued, "maxRetainedRuns": MaxRetainedRuns, "storageBudgetBytes": StorageBudgetBytes, "reservationBytesPerRun": MaxRunBytes, "maxResources": MaxResources, "maxAgents": MaxAgents, "maxSources": MaxSources, "retentionDays": RetentionDays, "collectionMode": "existing_evidence_only", "timezones": []string{"Asia/Shanghai", "UTC", "Europe/London", "America/New_York"}}
}
func summarize(v *Run) {
	v.Counts = map[string]int{"pass": 0, "finding": 0, "unknown": 0, "not_applicable": 0, "resources": len(v.Scope.Resources), "agents": len(v.Scope.AgentIDs)}
	for _, i := range v.Items {
		v.Counts[i.Result]++
	}
	v.Conclusion = "inconclusive"
	complete := v.Scope.Coverage.State == "complete" && len(v.Scope.Resources) > 0
	for _, c := range v.Coverage {
		complete = complete && c.State == "complete"
	}
	if v.Counts["finding"] > 0 {
		v.Conclusion = "findings"
	} else if complete && v.Counts["pass"] > 0 && v.Counts["unknown"] == 0 {
		v.Conclusion = "pass"
	}
}
func compare(v, old *Run) {
	v.Comparison = Comparison{State: "not_available"}
	if old == nil {
		return
	}
	v.Comparison.PreviousRunID = old.ID
	if old.Version != v.Version || digest(old.Definition.Checks) != digest(v.Definition.Checks) || old.Definition.ConfigMaxAgeSeconds != v.Definition.ConfigMaxAgeSeconds {
		v.Comparison.State = "policy_changed"
		return
	}
	v.Comparison.State = "compatible"
	if v.Scope.MembershipDigest != old.Scope.MembershipDigest {
		v.Comparison.State = "scope_changed"
	}
	previous := map[string]Item{}
	for _, i := range old.Items {
		previous[i.Key] = i
	}
	for j := range v.Items {
		i := &v.Items[j]
		p, ok := previous[i.Key]
		if !ok {
			i.Change = "added"
			v.Comparison.Added++
			continue
		}
		delete(previous, i.Key)
		if p.Compatibility != i.Compatibility {
			i.Change = "incomparable"
			v.Comparison.Incomparable++
		} else if i.Result == "finding" && p.Result != "finding" {
			i.Change = "new_finding"
			v.Comparison.NewFindings++
		} else if i.Result == "pass" && p.Result == "finding" {
			i.Change = "not_redetected"
			v.Comparison.NotRedetected++
		} else if i.Result == "unknown" {
			i.Change = "incomparable"
			v.Comparison.Incomparable++
		}
	}
	v.Comparison.Removed = len(previous)
}
func (s *Service) runOne(ctx context.Context, id string) {
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	v, e := s.store.Claim(readCtx, id, s.clock())
	cancel()
	if e != nil {
		return
	}
	token := v.LeaseToken
	work, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	plan, e := s.store.Plan(work, v.PlanID)
	if e == nil && (plan.Revision != v.PlanRevision || plan.Archived || (v.Mode == "scheduled" && !plan.Enabled)) {
		e = ErrConflict
	}
	if e == nil {
		e = s.backgroundActor(work, v.Actor)
	}
	if e == nil {
		v.Scope, e = s.evidence.Resolve(work, v.Definition.Scope)
	}
	if e != nil {
		v.State = "failed"
		v.Reason = "scope_or_authorization_unavailable"
		if errors.Is(e, ErrConflict) {
			v.State = "interrupted"
			v.Reason = "plan_changed_before_start"
		}
	} else if len(v.Scope.Resources) == 0 {
		v.State = "completed"
		v.Reason = "scope_empty"
		v.Items = []Item{unknownItem("monitoring", "scope_empty", s.clock())}
	} else {
		v.Items, v.Coverage = s.evidence.Evaluate(work, v.Definition, v.Scope)
		v.State = "completed"
	}
	if ctx.Err() != nil || work.Err() != nil {
		v.State = "interrupted"
		v.Reason = "execution_cancelled"
		v.Items = []Item{unknownItem("monitoring", "execution_cancelled", s.clock())}
	}
	summarize(v)
	if v.State == "completed" {
		if old, err := s.store.Previous(work, v); err == nil {
			compare(v, old)
		} else if !errors.Is(err, ErrNotFound) {
			v.Comparison.State = "previous_unavailable"
		}
	}
	if len(v.Items) > MaxItems {
		v.Items = []Item{unknownItem("monitoring", "report_limit", s.clock())}
		v.State = "failed"
		v.Reason = "report_limit"
		summarize(v)
	}
	b, encodeErr := json.Marshal(v)
	stored, storeErr := bson.Marshal(v)
	if encodeErr != nil || storeErr != nil || len(b) > MaxRunBytes-1024 || len(stored) > MaxRunBytes-1024 {
		v.Items = []Item{}
		v.State = "failed"
		v.Reason = "report_limit"
		summarize(v)
	}
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer finishCancel()
	if e = s.store.Finish(finishCtx, v, token, s.clock()); e == nil && plan != nil {
		_ = s.store.Release(finishCtx, plan, v.ID)
	}
}
func (s *Service) terminalOccurrence(ctx context.Context, p *Plan, v *Run, next time.Time) error {
	if _, e := s.store.Run(ctx, v.ID); errors.Is(e, ErrNotFound) {
		if e = s.admission(ctx, false); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	now := s.clock()
	v.FinishedAt = &now
	expires := now.AddDate(0, 0, RetentionDays)
	v.ExpiresAt = &expires
	if e := s.store.Record(ctx, v); e != nil {
		return e
	}
	return s.store.ScheduleNext(ctx, p, &next, v.Reason)
}
func (s *Service) Tick(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.store.Recover(ctx, s.clock()); e != nil {
		return e
	}
	plans, e := s.store.Plans(ctx)
	if e != nil {
		return e
	}
	for i := range plans {
		p := &plans[i]
		now := s.clock()
		if !p.Enabled || p.Archived || p.NextAt == nil {
			continue
		}
		if gapAt, wall, gap := calendarGap(p.Schedule, now); gap && p.UpdatedAt.Before(gapAt) {
			key := digest([]any{p.ID, p.ScheduleRevision, "calendar_gap", wall})
			id := stableID("scheduled:" + key)
			if _, err := s.store.Run(ctx, id); errors.Is(err, ErrNotFound) {
				if err = s.backgroundActor(ctx, p.AuthorizedBy); err != nil {
					var f *Failure
					if errors.As(err, &f) && f.Status == 403 {
						p.Enabled = false
						p.Revision++
						p.NextAt = nil
						p.ScheduleReason = "authorization_lost"
						if e = s.store.Update(ctx, p, p.Revision-1); e != nil {
							return e
						}
						continue
					}
					return err
				}
				v := emptyRun(p, "scheduled", p.AuthorizedBy, "scheduled:"+key, now)
				v.OccurrenceKey = key
				v.ScheduledFor = &gapAt
				v.State = "skipped"
				v.Reason = "calendar_time_missing"
				if err = s.terminalOccurrence(ctx, p, v, *p.NextAt); err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
		}
		if p.NextAt.After(now) {
			continue
		}
		if err := s.backgroundActor(ctx, p.AuthorizedBy); err != nil {
			var f *Failure
			if errors.As(err, &f) && f.Status == 403 {
				p.Enabled = false
				p.Revision++
				p.NextAt = nil
				p.ScheduleReason = "authorization_lost"
				if e = s.store.Update(ctx, p, p.Revision-1); e != nil {
					return e
				}
				continue
			}
			return err
		}
		key := digest([]any{p.ID, p.ScheduleRevision, p.NextAt.UTC()})
		v := emptyRun(p, "scheduled", p.AuthorizedBy, "scheduled:"+key, now)
		v.OccurrenceKey = key
		v.ScheduledFor = p.NextAt
		next, n := advanceSchedule(p.Schedule, *p.NextAt, now)
		if now.Sub(*p.NextAt) > 5*time.Minute {
			v.State = "missed"
			v.Reason = "outside_catchup_window"
			v.MissedUntil = &now
			v.MissedCount = n
			if e = s.terminalOccurrence(ctx, p, v, next); e != nil {
				return e
			}
			continue
		}
		if p.ActiveRunID != "" {
			v.State = "skipped"
			v.Reason = "plan_busy"
			if e = s.terminalOccurrence(ctx, p, v, next); e != nil {
				return e
			}
			continue
		}
		if e = s.admission(ctx, true); e != nil {
			return e
		}
		if e = s.store.Admit(ctx, p, v, &next); e != nil {
			if errors.Is(e, ErrConflict) {
				continue
			}
			return e
		}
		if e = s.store.Reconcile(ctx, &Plan{ID: p.ID, ActiveRunID: v.ID, Pending: v}); e != nil {
			return e
		}
	}
	return nil
}
func (s *Service) Run(ctx context.Context) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.mu.Unlock()
	var wg sync.WaitGroup
	defer func() { wg.Wait(); s.mu.Lock(); s.running = false; s.mu.Unlock() }()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastTick := time.Time{}
	for {
		if ctx.Err() != nil {
			return
		}
		now := s.clock()
		if lastTick.IsZero() || now.Sub(lastTick) >= 15*time.Second || now.Before(lastTick) {
			c, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := s.Tick(c)
			cancel()
			s.mu.Lock()
			s.lastError = ""
			if err != nil {
				s.lastError = "inspection_scheduler_unavailable"
			}
			s.mu.Unlock()
			lastTick = now
		}
		// Reconcile the manual admission journal before looking for queued runs.
		c, cancel := context.WithTimeout(ctx, 3*time.Second)
		plans, e := s.store.Plans(c)
		if e == nil {
			for i := range plans {
				if plans[i].Pending != nil {
					_ = s.store.Reconcile(c, &plans[i])
				}
			}
		}
		queued, _, e := s.store.Runs(c, Query{State: "queued", Limit: MaxQueued})
		cancel()
		if e == nil {
			sort.Slice(queued, func(i, j int) bool { return queued[i].QueuedAt.Before(queued[j].QueuedAt) })
			for _, v := range queued {
				select {
				case s.slots <- struct{}{}:
					wg.Add(1)
					go func(id string) { defer wg.Done(); defer func() { <-s.slots }(); s.runOne(ctx, id) }(v.ID)
				default:
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.wake:
		}
	}
}
func (s *Service) String() string { return fmt.Sprintf("inspection policy v%d", Version) }
