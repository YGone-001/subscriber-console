package investigation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/user"
)

func testID(n int) string { return fmt.Sprintf("%08x-0000-4000-8000-%012x", n, n) }

var instant = time.Date(2026, 11, 12, 1, 0, 0, 0, time.UTC)

type fakeEvidence struct {
	anchor    AlertFact
	resources []ResourceFact
	edges     []EdgeFact
	alerts    []AlertFact
	runs      []RunFact
	samples   []SampleFact
	configs   []ConfigFact
	knowledge []KnowledgeFact
	errors    map[string]error
	more      map[string]bool
	mu        sync.Mutex
	scopes    [][]string
}

func fixtureEvidence() *fakeEvidence {
	return &fakeEvidence{anchor: AlertFact{ID: testID(10), ResourceID: testID(1), TargetID: testID(30), Name: "SMF process evidence", First: instant.Format(time.RFC3339), Last: instant.Add(time.Minute).Format(time.RFC3339), Severity: "warning", State: "active"}, resources: []ResourceFact{{ID: testID(1), Name: "SMF A", Domain: "5gc", Lifecycle: "active"}, {ID: testID(2), Name: "UPF A", Lifecycle: "active"}}, edges: []EdgeFact{{ID: testID(20), From: testID(1), To: testID(2), Type: "depends_on", Revision: 1}}, errors: map[string]error{}, more: map[string]bool{}}
}
func (f *fakeEvidence) Anchor(context.Context, string) (*AlertFact, error) {
	v := f.anchor
	return &v, f.errors["anchor"]
}
func (f *fakeEvidence) Resources(_ context.Context, ids []string) ([]ResourceFact, error) {
	out := []ResourceFact{}
	for _, id := range ids {
		for _, r := range f.resources {
			if id == r.ID {
				out = append(out, r)
			}
		}
	}
	return out, f.errors["inventory"]
}
func (f *fakeEvidence) Edges(context.Context, string) ([]EdgeFact, bool, error) {
	return f.edges, f.more["topology"], f.errors["topology"]
}
func (f *fakeEvidence) scope(ids []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scopes = append(f.scopes, append([]string{}, ids...))
}
func (f *fakeEvidence) Alerts(_ context.Context, ids []string, _, _ time.Time) ([]AlertFact, bool, error) {
	f.scope(ids)
	return f.alerts, f.more["alerts"], f.errors["alerts"]
}
func (f *fakeEvidence) Runs(_ context.Context, ids []string, _, _ time.Time) ([]RunFact, bool, error) {
	f.scope(ids)
	return f.runs, f.more["health"], f.errors["health"]
}
func (f *fakeEvidence) Samples(context.Context, []string) ([]SampleFact, error) {
	return f.samples, f.errors["samples"]
}
func (f *fakeEvidence) Configurations(_ context.Context, ids []string, _, _ time.Time) ([]ConfigFact, bool, error) {
	f.scope(ids)
	return f.configs, f.more["configuration"], f.errors["configuration"]
}
func (f *fakeEvidence) Knowledge(context.Context, []string) ([]KnowledgeFact, error) {
	return f.knowledge, f.errors["knowledge"]
}

type fakeRecords struct {
	mu     sync.Mutex
	data   map[string]Record
	writes int
}

func newRecords() *fakeRecords { return &fakeRecords{data: map[string]Record{}} }
func (r *fakeRecords) Get(_ context.Context, id string) (*Record, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.data[id]
	if !ok {
		return nil, ErrNotFound
	}
	return &v, nil
}
func (r *fakeRecords) Create(_ context.Context, v *Record) (*Record, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, ok := r.data[v.ID]; ok {
		if old.RequestDigest != v.RequestDigest || old.CreatedBy != v.CreatedBy {
			return nil, ErrConflict
		}
		return &old, nil
	}
	r.data[v.ID] = *v
	r.writes++
	return v, nil
}
func (r *fakeRecords) Update(_ context.Context, id string, rev int64, q UpdateRequest, actor string, at time.Time) (*Record, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.data[id]
	if !ok || v.Revision != rev {
		return nil, ErrConflict
	}
	v.Title = q.Title
	v.Status = q.Status
	v.Notes = q.Notes
	v.Conclusion = q.Conclusion
	v.KnowledgeIDs = q.KnowledgeIDs
	v.Revision++
	v.UpdatedAt = at
	v.UpdatedBy = actor
	r.data[id] = v
	r.writes++
	return &v, nil
}
func (r *fakeRecords) List(context.Context, ListQuery, *cursorData) ([]Record, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Record{}
	for _, v := range r.data {
		out = append(out, v)
	}
	return out, false, nil
}

type testActors struct {
	disabled bool
	err      error
}

func (a *testActors) FindByUsernameIdentity(_ context.Context, name string) (*user.UserIdentity, error) {
	status := "active"
	if a.disabled {
		status = "disabled"
	}
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: name, Role: "operator", Status: status}}, a.err
}
func operator() *auth.Principal {
	return &auth.Principal{Username: "operator", Role: "operator", NormalizedRole: "operator"}
}
func testService(e *fakeEvidence, r RecordRepository, a *testActors) *Service {
	s := NewService(e, r, a, nil, []byte(strings.Repeat("k", 32)))
	s.clock = func() time.Time { return instant.Add(2 * time.Hour) }
	return s
}
func testWindow() ContextQuery {
	return ContextQuery{AlertID: testID(10), From: instant.Add(-time.Hour).Format(time.RFC3339), To: instant.Add(time.Hour).Format(time.RFC3339)}
}

func TestContextUsesExplicitOneHopAndIndependentEvidence(t *testing.T) {
	e := fixtureEvidence()
	changed := true
	e.configs = []ConfigFact{{ID: testID(40), SourceID: testID(41), ResourceID: testID(1), At: instant.Add(-5 * time.Minute), Outcome: "ok", Changed: &changed}}
	e.runs = []RunFact{{ID: testID(50), ResourceID: testID(2), TargetID: testID(51), At: instant.Format(time.RFC3339), Outcome: "failed"}}
	e.alerts = []AlertFact{e.anchor}
	s := testService(e, newRecords(), &testActors{})
	v, err := s.Context(context.Background(), testWindow())
	if err != nil {
		t.Fatal(err)
	}
	if v.Completeness != "complete" || len(v.Relations) != 1 || len(v.Events) != 4 {
		t.Fatalf("unexpected context: %+v", v)
	}
	if v.Events[0].Kind != "configuration" || v.Events[0].Basis != "same_resource" || v.Events[0].Changed == nil || !*v.Events[0].Changed {
		t.Fatal("configuration evidence lost")
	}
	for _, scope := range e.scopes {
		if len(scope) != 2 || scope[0] != testID(1) || scope[1] != testID(2) {
			t.Fatalf("scope broadened: %v", scope)
		}
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "confidence") {
		t.Fatal("confidence is not a measured fact")
	}
}
func TestUnboundMissingAndFailedRelationsNeverBroaden(t *testing.T) {
	for _, mode := range []string{"unbound", "missing", "topology_failure"} {
		t.Run(mode, func(t *testing.T) {
			e := fixtureEvidence()
			switch mode {
			case "unbound":
				e.anchor.ResourceID = ""
			case "missing":
				e.resources = nil
			case "topology_failure":
				e.errors["topology"] = errors.New("private failure")
			}
			v, err := testService(e, newRecords(), &testActors{}).Context(context.Background(), testWindow())
			if err != nil {
				t.Fatal(err)
			}
			for _, scope := range e.scopes {
				if len(scope) != 1 || scope[0] != testID(1) {
					t.Fatalf("broadened %v", scope)
				}
			}
			if mode != "topology_failure" && len(e.scopes) != 0 {
				t.Fatal("unresolved identity queried all evidence")
			}
			if v.Completeness == "complete" {
				t.Fatal("missing relation proof was hidden")
			}
		})
	}
}
func TestPartialSourcesRetainReadableFactsAndNoFalseSampleHealth(t *testing.T) {
	e := fixtureEvidence()
	e.errors["alerts"] = errors.New("sensitive backend error")
	e.more["configuration"] = true
	e.runs = []RunFact{{ID: testID(50), ResourceID: testID(1), TargetID: testID(51), SampleID: testID(52), At: instant.Format(time.RFC3339), Outcome: "success"}}
	e.samples = []SampleFact{{ID: testID(52), RunID: testID(50), ResourceID: testID(2), TargetID: testID(51), Layers: Layers{Process: LayerState{State: "healthy"}}}}
	v, err := testService(e, newRecords(), &testActors{}).Context(context.Background(), testWindow())
	if err != nil {
		t.Fatal(err)
	}
	if v.Coverage["alerts"].State != "unavailable" || v.Coverage["configuration"].State != "partial" || v.Coverage["health"].State != "partial" {
		t.Fatalf("coverage: %+v", v.Coverage)
	}
	for _, event := range v.Events {
		if event.Kind == "health" && event.Layers != nil {
			t.Fatal("sample associated by wrong resource")
		}
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "sensitive") {
		t.Fatal("raw error leaked")
	}
}
func TestWindowClipsUnboundTimelineAndRejectsWideOrFuture(t *testing.T) {
	e := fixtureEvidence()
	e.anchor.ResourceID = ""
	q := testWindow()
	q.From = instant.Add(-2 * time.Hour).Format(time.RFC3339)
	q.To = instant.Add(-time.Hour).Format(time.RFC3339)
	s := testService(e, newRecords(), &testActors{})
	v, err := s.Context(context.Background(), q)
	if err != nil || len(v.Events) != 0 {
		t.Fatalf("unbound timeline escaped window: %+v %v", v, err)
	}
	q = testWindow()
	q.To = instant.Add(25 * time.Hour).Format(time.RFC3339)
	if _, err = s.Context(context.Background(), q); err == nil {
		t.Fatal("wide future window accepted")
	}
	q = testWindow()
	q.From = ""
	if _, err = s.Context(context.Background(), q); err == nil {
		t.Fatal("half window accepted")
	}
}
func TestCreateIsIdempotentAndFreshActorRequiredForEveryMutation(t *testing.T) {
	e := fixtureEvidence()
	r := newRecords()
	a := &testActors{}
	s := testService(e, r, a)
	q := CreateRequest{RequestID: testID(100), AlertID: e.anchor.ID, Title: "SMF investigation", From: testWindow().From, To: testWindow().To}
	v, err := s.Create(context.Background(), operator(), q)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Create(context.Background(), operator(), q)
	if err != nil || again.ID != v.ID || r.writes != 1 {
		t.Fatal("idempotency lost")
	}
	q.Title = "different"
	if _, err = s.Create(context.Background(), operator(), q); !errors.Is(err, ErrConflict) {
		t.Fatalf("request collision accepted: %v", err)
	}
	a.disabled = true
	u := UpdateRequest{ExpectedRevision: 1, Title: v.Title, Status: "investigating"}
	if _, err = s.Update(context.Background(), operator(), v.ID, u); err == nil {
		t.Fatal("disabled actor wrote")
	}
	if r.writes != 1 {
		t.Fatal("denied mutation changed storage")
	}
	viewer := &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}
	if _, err = s.Create(context.Background(), viewer, q); err == nil {
		t.Fatal("viewer wrote")
	}
}
func TestConclusionKnowledgeAndCAS(t *testing.T) {
	e := fixtureEvidence()
	r := newRecords()
	s := testService(e, r, &testActors{})
	v, err := s.Create(context.Background(), operator(), CreateRequest{RequestID: testID(100), AlertID: e.anchor.ID, Title: "Investigate", From: testWindow().From, To: testWindow().To})
	if err != nil {
		t.Fatal(err)
	}
	u := UpdateRequest{ExpectedRevision: 1, Title: v.Title, Status: "resolved"}
	if _, err = s.Update(context.Background(), operator(), v.ID, u); err == nil {
		t.Fatal("empty conclusion allowed")
	}
	u.Conclusion = "No causal conclusion; evidence incomplete"
	u.KnowledgeIDs = []string{testID(70)}
	if _, err = s.Update(context.Background(), operator(), v.ID, u); err == nil {
		t.Fatal("missing reference accepted")
	}
	e.knowledge = []KnowledgeFact{{ID: testID(70), Title: "Check health evidence"}}
	after, err := s.Update(context.Background(), operator(), v.ID, u)
	if err != nil || after.Revision != 2 || after.AlertID != v.AlertID || after.ResourceID != v.ResourceID {
		t.Fatalf("update failed %v", err)
	}
	if _, err = s.Update(context.Background(), operator(), v.ID, u); !errors.Is(err, ErrConflict) {
		t.Fatal("stale version accepted")
	}
	e.knowledge = nil
	read, err := s.Get(context.Background(), v.ID)
	if err != nil || read.KnowledgeCoverage.State != "partial" || len(read.Record.KnowledgeIDs) != 1 {
		t.Fatal("deleted reference was hidden")
	}
}
func TestCursorBindsFiltersSignatureAndExpiry(t *testing.T) {
	s := testService(fixtureEvidence(), newRecords(), &testActors{})
	q := ListQuery{Status: "open"}
	q.Cursor = s.encodeCursor(q, Record{ID: testID(100), UpdatedAt: instant})
	if _, err := s.decodeCursor(q); err != nil {
		t.Fatal(err)
	}
	other := q
	other.Status = "resolved"
	if _, err := s.decodeCursor(other); err == nil {
		t.Fatal("cross filter cursor accepted")
	}
	other = q
	other.Cursor = q.Cursor[:len(q.Cursor)-2] + "ab"
	if _, err := s.decodeCursor(other); err == nil {
		t.Fatal("tampered signature accepted")
	}
	s.clock = func() time.Time { return instant.Add(3 * time.Hour) }
	if _, err := s.decodeCursor(q); err == nil {
		t.Fatal("expired cursor accepted")
	}
}

func TestSavedContextRejectsReboundAnchorAndPreservesWindow(t *testing.T) {
	e := fixtureEvidence()
	records := newRecords()
	s := testService(e, records, &testActors{})
	v, err := s.Create(context.Background(), operator(), CreateRequest{RequestID: testID(100), AlertID: e.anchor.ID, Title: "Bound context", From: testWindow().From, To: testWindow().To})
	if err != nil {
		t.Fatal(err)
	}
	q := testWindow()
	q.InvestigationID = v.ID
	q.From = instant.Add(-10 * time.Hour).Format(time.RFC3339)
	q.To = instant.Add(-9 * time.Hour).Format(time.RFC3339)
	out, err := s.Context(context.Background(), q)
	if err != nil || !out.From.Equal(v.From) || !out.To.Equal(v.To) {
		t.Fatalf("saved window was changed: %v", err)
	}
	e.anchor.ResourceID = testID(2)
	if _, err = s.Context(context.Background(), q); err == nil {
		t.Fatal("rebound anchor silently changed saved scope")
	}
}

func TestMeasurementOutsideWindowDoesNotEstablishLayerHealth(t *testing.T) {
	e := fixtureEvidence()
	e.runs = []RunFact{{ID: testID(50), ResourceID: testID(1), TargetID: testID(51), SampleID: testID(52), At: instant.Format(time.RFC3339), Outcome: "success"}}
	e.samples = []SampleFact{{ID: testID(52), RunID: testID(50), ResourceID: testID(1), TargetID: testID(51), At: instant.Add(3 * time.Hour).Format(time.RFC3339), Layers: Layers{Process: LayerState{State: "healthy"}}}}
	v, err := testService(e, newRecords(), &testActors{}).Context(context.Background(), testWindow())
	if err != nil {
		t.Fatal(err)
	}
	if v.Coverage["health"].State != "partial" {
		t.Fatal("outside measurement was treated as complete")
	}
	for _, event := range v.Events {
		if event.Kind == "health" && event.Layers != nil {
			t.Fatal("outside measurement attached to event")
		}
	}
}
func TestHandlerRBACStrictBodiesNoStoreAndQueryBounds(t *testing.T) {
	e := fixtureEvidence()
	r := newRecords()
	s := testService(e, r, &testActors{})
	h := NewHandler(s, nil)
	mux := http.NewServeMux()
	for _, route := range []string{"GET /api/investigations", "GET /api/investigations/context", "POST /api/investigations", "GET /api/investigations/{investigationId}", "PATCH /api/investigations/{investigationId}"} {
		mux.HandleFunc(route, h.Handle)
	}
	cases := []struct {
		method, path, body, role string
		want                     int
	}{{"GET", "/api/investigations", "", "", 401}, {"POST", "/api/investigations", "{}", "viewer", 403}, {"GET", "/api/investigations?limit=201", "", "viewer", 400}, {"GET", "/api/investigations?limit=0", "", "viewer", 400}, {"GET", "/api/investigations?status=open&status=resolved", "", "viewer", 400}, {"POST", "/api/investigations", `{"command":"whoami"}`, "operator", 400}, {"GET", "/api/investigations", "", "viewer", 200}}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		if c.role != "" {
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{Username: c.role, Role: c.role, NormalizedRole: c.role}))
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != c.want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s: %d %s", c.method, c.path, w.Code, w.Body.String())
		}
	}
	if r.writes != 0 {
		t.Fatal("invalid or read request mutated storage")
	}
}

func TestSubMillisecondWindowCannotCreateAnUnreadableRecord(t *testing.T) {
	_, _, err := parseWindow(instant.Add(time.Nanosecond).Format(time.RFC3339Nano), instant.Add(2*time.Nanosecond).Format(time.RFC3339Nano), instant.Add(time.Hour))
	if err == nil {
		t.Fatal("window collapsed after canonicalization")
	}
}
