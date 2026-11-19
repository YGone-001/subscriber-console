package inspections

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/auth"
	"subscriber/internal/configdrift"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/nfhealth"
	"subscriber/internal/operationsview"
	"subscriber/internal/user"
)

type fixtureActors struct {
	mu           sync.RWMutex
	role, status string
}

func (a *fixtureActors) FindByUsernameIdentity(_ context.Context, name string) (*user.UserIdentity, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: name, Role: a.role, Status: a.status}}, nil
}
func (a *fixtureActors) revoke() { a.mu.Lock(); defer a.mu.Unlock(); a.role = "viewer" }
func operator() *auth.Principal {
	return &auth.Principal{Username: "synthetic-operator", NormalizedRole: "operator", Role: "operator"}
}

type fixtureEvidence struct {
	scope ResolvedScope
	items []Item
	fail  bool
}

func (e *fixtureEvidence) Resolve(context.Context, ScopeSelector) (ResolvedScope, error) {
	if e.fail {
		return ResolvedScope{}, errors.New("synthetic read failure")
	}
	return e.scope, nil
}
func (e *fixtureEvidence) Evaluate(context.Context, Definition, ResolvedScope) ([]Item, map[string]Coverage) {
	return append([]Item{}, e.items...), map[string]Coverage{"monitoring": {State: "complete"}}
}
func mongoFixture(t *testing.T, initialize bool) (*mongo.Database, *Repository) {
	t.Helper()
	uri := os.Getenv("INSPECTIONS_TEST_MONGO_URI")
	if uri == "" {
		t.Skip("owned isolated MongoDB required: INSPECTIONS_TEST_MONGO_URI")
	}
	u, e := url.Parse(uri)
	if e != nil || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Port() == "27017" {
		t.Fatal("tests require an explicitly owned non-default loopback MongoDB")
	}
	client, e := mongo.Connect(options.Client().ApplyURI(uri))
	if e != nil {
		t.Fatal(e)
	}
	db := client.Database("test_inspections_" + strings.ReplaceAll(newID(), "-", ""))
	ctx := context.Background()
	t.Cleanup(func() {
		if !strings.HasPrefix(db.Name(), "test_inspections_") {
			panic("unsafe fixture cleanup")
		}
		_ = db.Drop(context.Background())
		_ = client.Disconnect(context.Background())
	})
	if initialize {
		if _, e = db.Collection("app_inspection_plans").Indexes().CreateMany(ctx, PlanIndexes()); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Collection("app_inspection_runs").Indexes().CreateMany(ctx, RunIndexes()); e != nil {
			t.Fatal(e)
		}
	}
	return db, NewRepository(db)
}
func serviceFixture(t *testing.T) (*Service, *Repository, *fixtureEvidence, *fixtureActors) {
	_, r := mongoFixture(t, true)
	actors := &fixtureActors{role: "operator", status: "active"}
	evidence := &fixtureEvidence{scope: ResolvedScope{Resources: []ResourceFact{{ID: newID(), Name: "SYNTHETIC NF", Kind: inventory.KindNetworkFunction, Domain: "epc"}}, Coverage: Coverage{State: "complete"}, AgentCoverage: Coverage{State: "complete"}}, items: []Item{{Key: "nf", Kind: "monitoring", Result: "pass", Compatibility: "same"}}}
	s := NewService(r, evidence, actors, nil, []byte("synthetic test cursor key"))
	return s, r, evidence, actors
}
func createPlan(t *testing.T, s *Service) *Plan {
	t.Helper()
	p, e := s.Create(context.Background(), operator(), CreateRequest{Definition: fixtureDefinition(), RequestID: newID()})
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func executeManual(t *testing.T, s *Service, r *Repository, p *Plan) *Run {
	t.Helper()
	ctx := context.Background()
	v, e := s.Trigger(ctx, operator(), p.ID, RunRequest{p.Revision, newID()})
	if e != nil {
		t.Fatal(e)
	}
	latest, e := r.Plan(ctx, p.ID)
	if e != nil {
		t.Fatal(e)
	}
	if e = r.Reconcile(ctx, latest); e != nil {
		t.Fatal(e)
	}
	s.runOne(ctx, v.ID)
	v, e = r.Run(ctx, v.ID)
	if e != nil || v.State != "completed" {
		t.Fatalf("manual execution %+v %v", v, e)
	}
	return v
}
func TestMongoManualJournalIdempotencyAndImmutableReport(t *testing.T) {
	s, r, ev, _ := serviceFixture(t)
	ctx := context.Background()
	p := createPlan(t, s)
	req := RunRequest{p.Revision, newID()}
	first, e := s.Trigger(ctx, operator(), p.ID, req)
	if e != nil {
		t.Fatal(e)
	}
	// Simulate a process disappearing after the plan journal committed, before
	// the report projection exists. A fresh service repairs only its own journal.
	if _, e = r.Run(ctx, first.ID); !errors.Is(e, ErrNotFound) {
		t.Fatalf("projection unexpectedly exists: %v", e)
	}
	if e = r.Recover(ctx, s.clock()); e != nil {
		t.Fatal(e)
	}
	again, e := s.Trigger(ctx, operator(), p.ID, req)
	if e != nil || again.ID != first.ID {
		t.Fatal("request retry lost its report identity")
	}
	s.runOne(ctx, first.ID)
	saved, e := r.Run(ctx, first.ID)
	if e != nil || saved.State != "completed" || saved.Conclusion != "pass" {
		t.Fatalf("unexpected report %+v %v", saved, e)
	}
	before, _ := json.Marshal(saved)
	ev.items = []Item{{Key: "nf", Kind: "monitoring", Result: "finding", Compatibility: "same"}}
	newRun := executeManual(t, s, r, p)
	if newRun.Conclusion != "findings" {
		t.Fatal("new evidence not evaluated")
	}
	old, _ := r.Run(ctx, first.ID)
	after, _ := json.Marshal(old)
	if string(before) != string(after) {
		t.Fatal("historical report changed")
	}
	bad := req
	bad.ExpectedRevision++
	if _, e = s.Trigger(ctx, operator(), p.ID, bad); !errors.Is(e, ErrConflict) {
		t.Fatalf("request reuse changed payload: %v", e)
	}
	n, _ := r.runs.CountDocuments(ctx, bson.M{})
	if n != 2 {
		t.Fatalf("unexpected duplicate reports: %d", n)
	}
}
func TestMongoConcurrentAdmissionAndLeaseFencing(t *testing.T) {
	s, r, _, _ := serviceFixture(t)
	p := createPlan(t, s)
	req := RunRequest{p.Revision, newID()}
	ids := make(chan string, 12)
	errs := make(chan error, 12)
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := s.Trigger(context.Background(), operator(), p.ID, req)
			if e != nil {
				errs <- e
			} else {
				ids <- v.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	var id string
	for v := range ids {
		if id != "" && id != v {
			t.Fatal("concurrent retry changed identity")
		}
		id = v
	}
	ctx := context.Background()
	plan, _ := r.Plan(ctx, p.ID)
	if e := r.Reconcile(ctx, plan); e != nil {
		t.Fatal(e)
	}
	claimed, e := r.Claim(ctx, id, time.Now().UTC())
	if e != nil {
		t.Fatal(e)
	}
	token := claimed.LeaseToken
	_, e = r.runs.UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": bson.M{"leaseUntil": time.Now().Add(-time.Second)}})
	if e != nil {
		t.Fatal(e)
	}
	if e = r.Recover(ctx, time.Now().UTC()); e != nil {
		t.Fatal(e)
	}
	claimed.State = "completed"
	if e = r.Finish(ctx, claimed, token, time.Now().UTC()); !errors.Is(e, ErrConflict) {
		t.Fatalf("expired worker overwrote recovery: %v", e)
	}
	final, _ := r.Run(ctx, id)
	if final.State != "interrupted" || final.ExpiresAt == nil {
		t.Fatalf("recovery failed %+v", final)
	}
	plan, _ = r.Plan(ctx, p.ID)
	if plan.ActiveRunID != "" {
		t.Fatal("terminal report did not release its plan")
	}
}
func TestMongoSchedulesMissesEditsAndRevokedAuthorizer(t *testing.T) {
	s, r, ev, actors := serviceFixture(t)
	ctx := context.Background()
	now := instant("2026-11-19T00:00:00Z")
	s.now = func() time.Time { return now }
	p := createPlan(t, s)
	d := p.Definition
	d.Schedule = Schedule{Kind: "interval", Timezone: "UTC", IntervalSeconds: 900}
	p, e := s.Update(ctx, operator(), p.ID, UpdateRequest{Definition: d, ExpectedRevision: p.Revision, Enabled: true})
	if e != nil {
		t.Fatal(e)
	}
	now = now.Add(15 * time.Minute)
	if e = s.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	if e = s.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	runs, _, _ := r.Runs(ctx, Query{Limit: 20})
	if len(runs) != 1 {
		t.Fatalf("duplicate scheduled occurrence: %d", len(runs))
	}
	queued := runs[0]
	// Pausing remains possible while evidence reads are unavailable. The
	// queued old revision is interrupted, rather than executed under new scope.
	ev.fail = true
	p, _ = r.Plan(ctx, p.ID)
	p, e = s.Update(ctx, operator(), p.ID, UpdateRequest{Definition: p.Definition, ExpectedRevision: p.Revision, Enabled: false})
	if e != nil {
		t.Fatalf("could not pause after source failure: %v", e)
	}
	s.runOne(ctx, queued.ID)
	pausedRun, _ := r.Run(ctx, queued.ID)
	if pausedRun.State != "interrupted" {
		t.Fatalf("old queued revision executed %+v", pausedRun)
	}
	ev.fail = false
	p, e = s.Update(ctx, operator(), p.ID, UpdateRequest{Definition: p.Definition, ExpectedRevision: p.Revision, Enabled: true})
	if e != nil {
		t.Fatal(e)
	}
	now = now.Add(24 * time.Hour)
	if e = s.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	runs, _, _ = r.Runs(ctx, Query{PlanID: p.ID, State: "missed", Limit: 20})
	if len(runs) != 1 || runs[0].MissedCount < 90 {
		t.Fatalf("downtime backfilled instead of summarized: %+v", runs)
	}
	actors.revoke()
	p, _ = r.Plan(ctx, p.ID)
	now = p.NextAt.Add(time.Second)
	if e = s.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	p, _ = r.Plan(ctx, p.ID)
	if p.Enabled || p.ScheduleReason != "authorization_lost" {
		t.Fatalf("revoked authorizer remained enabled %+v", p)
	}
}
func TestMongoCapacityIndexesAndPermissions(t *testing.T) {
	_, missingRepo := mongoFixture(t, false)
	s := NewService(missingRepo, nil, nil, nil, []byte("key"))
	meta := s.Meta(context.Background())
	if meta["retainedRuns"] != nil || meta["reason"] != "INSPECTION_INDEXES_REQUIRED" {
		t.Fatalf("uninitialized storage became zero coverage: %+v", meta)
	}
	s, r, _, _ := serviceFixture(t)
	p := createPlan(t, s)
	handler := NewHandler(s, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/inspection-plans/{planId}/runs", handler.Handle)
	request := httptest.NewRequest("POST", "/api/inspection-plans/"+p.ID+"/runs", strings.NewReader(`{}`))
	request = request.WithContext(auth.ContextWithPrincipal(request.Context(), &auth.Principal{Username: "viewer", NormalizedRole: "viewer"}))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, request)
	if w.Code != 403 {
		t.Fatalf("viewer mutation status=%d", w.Code)
	}
	ctx := context.Background()
	docs := []any{}
	for range MaxRetainedRuns {
		docs = append(docs, Run{ID: newID(), State: "completed"})
	}
	if _, e := r.runs.InsertMany(ctx, docs); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Trigger(ctx, operator(), p.ID, RunRequest{p.Revision, newID()}); e == nil {
		t.Fatal("capacity guard did not reject execution")
	}
	if _, e := r.plans.UpdateOne(ctx, bson.M{"_id": p.ID}, bson.M{"$set": bson.M{"revision": p.Revision + 1}}); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Update(ctx, operator(), p.ID, UpdateRequest{Definition: p.Definition, ExpectedRevision: p.Revision}); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale CAS accepted: %v", e)
	}
}

type configFixture struct{ view *configsnapshots.SourceList }

func (c *configFixture) List(context.Context, configsnapshots.ListQuery) (*configsnapshots.SourceList, error) {
	return c.view, nil
}
func TestMongoEvidenceKeepsFailuresGapsAndPrivateFieldsOut(t *testing.T) {
	db, _ := mongoFixture(t, true)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	resourceID, targetID, runID, sampleID, sourceID := newID(), newID(), newID(), newID(), newID()
	resource := inventory.Resource{ResourceID: resourceID, Name: "SYNTHETIC MME", Kind: inventory.KindNetworkFunction, Domain: "epc", LifecycleState: "active"}
	if _, e := db.Collection("app_inventory_resources").InsertOne(ctx, resource); e != nil {
		t.Fatal(e)
	}
	health := nfhealth.NewRepository(db.Collection("app_nf_health_targets"), db.Collection("app_nf_health_runs"), db.Collection("app_nf_health_samples"))
	stamp := now.Format(time.RFC3339Nano)
	target := nfhealth.HealthTarget{TargetID: targetID, ResourceID: resourceID, Enabled: true, LastMeasuredAt: stamp, CollectionMode: "manual", CollectorProfile: "http_metrics"}
	layers := nfhealth.LayerSet{Process: nfhealth.LayerEvidence{Measured: true, State: "healthy"}, Interface: nfhealth.LayerEvidence{Measured: true, State: "healthy"}, Service: nfhealth.LayerEvidence{Measured: true, State: "healthy"}}
	for coll, doc := range map[string]any{"app_nf_health_targets": target, "app_nf_health_runs": nfhealth.HealthRun{RunID: runID, TargetID: targetID, ResourceID: resourceID, SampleID: sampleID, Status: "success", StartedAt: stamp}, "app_nf_health_samples": nfhealth.HealthSample{SampleID: sampleID, RunID: runID, TargetID: targetID, ResourceID: resourceID, CollectedAt: stamp, Layers: layers, Metrics: []nfhealth.MetricSample{{Key: "DO_NOT_EXPORT", Labels: map[string]string{"secret": "DO_NOT_EXPORT"}}}}} {
		if _, e := db.Collection(coll).InsertOne(ctx, doc); e != nil {
			t.Fatal(e)
		}
	}
	config := &configFixture{view: &configsnapshots.SourceList{CatalogState: "configured", Completeness: "complete", Page: configsnapshots.Page[configsnapshots.SourceView]{Items: []configsnapshots.SourceView{{Source: configsnapshots.Source{SourceID: sourceID, ResourceID: resourceID, Name: "SYNTHETIC config", Generation: "g1"}, Registered: true, ResourceState: "valid", BaselineID: newID(), Comparison: "unchanged", Latest: &configsnapshots.Observation{ObservationID: newID(), Generation: "g1", Status: "ok", Published: true, CollectedAt: now}, LatestSnapshot: &configsnapshots.Snapshot{Projection: "DO_NOT_EXPORT", Fingerprint: "DO_NOT_EXPORT"}}}}}}
	groupRepo := operationsview.NewGroupRepository(db)
	groups := operationsview.NewGroupService(groupRepo, health, config.List)
	reader := NewEvidenceReader(db, groups, groupRepo, health, config)
	reader.now = func() time.Time { return now }
	scope, e := reader.Resolve(ctx, ScopeSelector{Mode: "all"})
	if e != nil {
		t.Fatal(e)
	}
	items, cov := reader.Evaluate(ctx, fixtureDefinition(), scope)
	if cov["monitoring"].State != "complete" {
		t.Fatal("monitoring read failed")
	}
	encoded, _ := json.Marshal(items)
	if strings.Contains(string(encoded), "DO_NOT_EXPORT") {
		t.Fatal("private source content entered report")
	}
	monitorPass := false
	for _, i := range items {
		if i.Kind == "monitoring" && i.Result == "pass" {
			monitorPass = true
		}
	}
	if !monitorPass {
		t.Fatalf("valid evidence did not pass: %s", encoded)
	}
	layers.Process.State = "unhealthy"
	layers.Interface.State = "degraded"
	layers.Service.Measured = false
	layers.Service.State = "unknown"
	_, _ = db.Collection("app_nf_health_samples").UpdateOne(ctx, bson.M{"_id": sampleID}, bson.M{"$set": bson.M{"layers": layers}})
	for range 20 {
		mixed, _ := reader.monitoring(ctx, scope)
		if len(mixed) != 2 || mixed[0].Result != "finding" || mixed[0].Severity != "critical" || mixed[1].Result != "unknown" {
			t.Fatalf("mixed finding hid coverage or severity depended on map order: %+v", mixed)
		}
	}
	_, _ = db.Collection("app_nf_health_targets").UpdateOne(ctx, bson.M{"_id": targetID}, bson.M{"$set": bson.M{"lastError": "DO_NOT_EXPORT"}})
	items, _ = reader.monitoring(ctx, scope)
	if len(items) != 1 || items[0].Result != "unknown" || items[0].Reason != "latest_collection_failed" {
		t.Fatalf("old success masked latest failure %+v", items)
	}
	config.view.Items[0].Latest.CollectedAt = now.Add(-48 * time.Hour)
	items, _ = reader.configuration(ctx, fixtureDefinition(), scope, "configuration")
	if items[0].Result != "unknown" || items[0].Reason != "evidence_stale" {
		t.Fatal("stale config passed")
	}
	config.view.CatalogState = "not_configured"
	items, c := reader.configuration(ctx, fixtureDefinition(), scope, "configuration")
	if c.State != "unavailable" || items[0].Result != "unknown" {
		t.Fatal("missing catalog became a pass")
	}
}

func TestMongoCalendarGapAndBusyOccurrenceAreRecordsNotCollections(t *testing.T) {
	s, r, _, _ := serviceFixture(t)
	ctx := context.Background()
	now := instant("2026-03-07T08:00:00Z")
	s.now = func() time.Time { return now }
	p := createPlan(t, s)
	d := p.Definition
	d.Schedule = Schedule{Kind: "daily", Timezone: "America/New_York", Time: "02:30"}
	p, e := s.Update(ctx, operator(), p.ID, UpdateRequest{Definition: d, ExpectedRevision: p.Revision, Enabled: true})
	if e != nil {
		t.Fatal(e)
	}
	now = instant("2026-03-08T07:05:00Z")
	if e = s.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	if e = s.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	runs, _, _ := r.Runs(ctx, Query{PlanID: p.ID, State: "skipped", Limit: 20})
	if len(runs) != 1 || runs[0].Reason != "calendar_time_missing" || runs[0].StartedAt != nil {
		t.Fatalf("DST gap executed or duplicated %+v", runs)
	}
	p, _ = r.Plan(ctx, p.ID)
	if p.NextAt == nil || !p.NextAt.Equal(instant("2026-03-09T06:30:00Z")) {
		t.Fatalf("DST skip changed next valid schedule %+v", p.NextAt)
	}
	d = p.Definition
	d.Schedule = Schedule{Kind: "interval", Timezone: "UTC", IntervalSeconds: 900}
	p, e = s.Update(ctx, operator(), p.ID, UpdateRequest{Definition: d, ExpectedRevision: p.Revision, Enabled: true})
	if e != nil {
		t.Fatal(e)
	}
	due := *p.NextAt
	now = due.Add(-5 * time.Second)
	v, e := s.Trigger(ctx, operator(), p.ID, RunRequest{p.Revision, newID()})
	if e != nil {
		t.Fatal(e)
	}
	p, _ = r.Plan(ctx, p.ID)
	if e = r.Reconcile(ctx, p); e != nil {
		t.Fatal(e)
	}
	if _, e = r.Claim(ctx, v.ID, now); e != nil {
		t.Fatal(e)
	}
	now = due
	if e = s.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	runs, _, _ = r.Runs(ctx, Query{PlanID: p.ID, State: "skipped", Limit: 20})
	busy := 0
	for _, v := range runs {
		if v.Reason == "plan_busy" {
			busy++
		}
	}
	if busy != 1 {
		t.Fatalf("busy occurrence was not recorded: %+v", runs)
	}
}

func TestMongoDriftUsesCurrentCycleAndNeverRepairsSourceData(t *testing.T) {
	db, _ := mongoFixture(t, true)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	resourceID, sourceID, baselineID, observationID := newID(), newID(), newID(), newID()
	source := configsnapshots.SourceView{Source: configsnapshots.Source{SourceID: sourceID, ResourceID: resourceID, Generation: "g1", Profile: "metadata-only-v1"}, Registered: true, ResourceState: "valid", BaselineID: baselineID, Comparison: "unchanged", Latest: &configsnapshots.Observation{ObservationID: observationID, Status: "ok", Published: true, Generation: "g1", CollectedAt: now}}
	config := &configFixture{view: &configsnapshots.SourceList{CatalogState: "configured", Completeness: "complete", Page: configsnapshots.Page[configsnapshots.SourceView]{Items: []configsnapshots.SourceView{source}}}}
	control := sourceControl{ID: sourceID, Sequence: 2, Policy: configsnapshots.DriftPolicy{Enabled: true, Revision: 1, Severity: "warning"}}
	state := configdrift.State{SourceID: sourceID, Sequence: 2, Input: configsnapshots.DriftInput{SourceID: sourceID, ResourceID: resourceID, Generation: "g1", Profile: source.Profile, BaselineID: baselineID, ObservationID: observationID, Policy: control.Policy}, Evaluation: configdrift.Evaluation{State: "in_sync", ProcessedSequence: 2}}
	if _, e := db.Collection("app_config_sources").InsertOne(ctx, control); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Collection("app_config_drift_sources").InsertOne(ctx, state); e != nil {
		t.Fatal(e)
	}
	reader := NewEvidenceReader(db, nil, nil, nil, config)
	reader.now = func() time.Time { return now }
	scope := ResolvedScope{Resources: []ResourceFact{{ID: resourceID, Kind: inventory.KindNetworkFunction}}}
	snapshot := func(collection string) string {
		var v bson.M
		if e := db.Collection(collection).FindOne(ctx, bson.M{"_id": sourceID}).Decode(&v); e != nil {
			t.Fatal(e)
		}
		return digest(v)
	}
	beforeSource, beforeDrift := snapshot("app_config_sources"), snapshot("app_config_drift_sources")
	items, _ := reader.configuration(ctx, fixtureDefinition(), scope, "drift")
	if len(items) != 1 || items[0].Result != "pass" {
		t.Fatalf("current matching evaluation unavailable %+v", items)
	}
	if snapshot("app_config_sources") != beforeSource || snapshot("app_config_drift_sources") != beforeDrift {
		t.Fatal("inspection mutated an evidence owner")
	}
	_, _ = db.Collection("app_config_sources").UpdateOne(ctx, bson.M{"_id": sourceID}, bson.M{"$set": bson.M{"driftSequence": int64(3)}})
	items, _ = reader.configuration(ctx, fixtureDefinition(), scope, "drift")
	if items[0].Result != "unknown" || items[0].Reason != "drift_evaluation_pending" {
		t.Fatal("lagging evaluation passed")
	}
	state.Current = &configdrift.Alert{ID: newID(), ResourceID: resourceID, Generation: "g1", BaselineID: baselineID, State: "active", Severity: "warning"}
	_, _ = db.Collection("app_config_drift_sources").ReplaceOne(ctx, bson.M{"_id": sourceID}, state)
	config.view.Items[0].Latest.Status = "unreadable"
	items, _ = reader.configuration(ctx, fixtureDefinition(), scope, "drift")
	if items[0].Result != "finding" {
		t.Fatal("unreadable observation concealed existing drift")
	}
	config.view.Items[0].Generation = "new-generation"
	items, _ = reader.configuration(ctx, fixtureDefinition(), scope, "drift")
	if items[0].Result != "unknown" {
		t.Fatal("old cycle was assigned to a new source generation")
	}
}
