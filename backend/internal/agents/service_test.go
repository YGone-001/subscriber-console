package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/user"
)

type memoryRepo struct {
	mu          sync.Mutex
	records     map[string]Record
	unavailable bool
}

func newMemoryRepo() *memoryRepo { return &memoryRepo{records: map[string]Record{}} }
func clone(r Record) Record {
	r.Scope.PLMNs = append([]string{}, r.Scope.PLMNs...)
	if r.Observation != nil {
		o := *r.Observation
		o.Components = append([]Component{}, o.Components...)
		r.Observation = &o
	}
	return r
}
func (m *memoryRepo) Create(_ context.Context, r *Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records[r.AgentID] = clone(*r)
	return nil
}
func (m *memoryRepo) Get(_ context.Context, id string) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.records[id]
	if !ok {
		return nil, ErrNotFound
	}
	r = clone(r)
	return &r, nil
}
func (m *memoryRepo) List(_ context.Context, q ListQuery, now time.Time) (*Page, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.unavailable {
		return nil, errors.New("unavailable")
	}
	page := &Page{Records: []Record{}}
	keys := []string{}
	for id := range m.records {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	for _, id := range keys {
		r := m.records[id]
		if q.Q != "" && !strings.Contains(r.Name, q.Q) {
			continue
		}
		page.Summary.Total++
		switch ConnectionState(&r, now) {
		case "online":
			page.Summary.Online++
		case "stale":
			page.Summary.Stale++
		case "offline":
			page.Summary.Offline++
		case "pending":
			page.Summary.Pending++
		case "disabled":
			page.Summary.Disabled++
		}
		if id > q.Cursor {
			page.Records = append(page.Records, clone(r))
		}
	}
	if len(page.Records) > q.Limit {
		page.HasMore = true
		page.Records = page.Records[:q.Limit]
		id := page.Records[len(page.Records)-1].AgentID
		page.NextCursor = &id
	}
	return page, nil
}
func (m *memoryRepo) Update(_ context.Context, id string, req UpdateRequest, now time.Time) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.records[id]
	if !ok || r.Revision != req.ExpectedRevision {
		return nil, ErrConflict
	}
	r.Metadata = req.Metadata
	r.Enabled = *req.Enabled
	r.Revision++
	r.UpdatedAt = now
	r.SessionHash = ""
	r.Sequence = 0
	m.records[id] = r
	r = clone(r)
	return &r, nil
}
func (m *memoryRepo) Rotate(_ context.Context, id string, revision int64, hash string, now time.Time) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.records[id]
	if !ok || r.Revision != revision {
		return nil, ErrConflict
	}
	r.KeyHash = hash
	r.SessionHash = ""
	r.Sequence = 0
	r.Revision++
	r.UpdatedAt = now
	m.records[id] = r
	r = clone(r)
	return &r, nil
}
func (m *memoryRepo) StartSession(_ context.Context, id, key, session string, expiry, now time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.records[id]
	if !ok || !r.Enabled || r.KeyHash != key {
		return ErrUnauthorized
	}
	r.SessionHash = session
	r.SessionExpiresAt = expiry
	r.Sequence = 0
	r.ReportHash = ""
	m.records[id] = r
	return nil
}
func (m *memoryRepo) Accept(_ context.Context, id, key, session string, seq int64, hash string, o *Observation, now time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.records[id]
	if !ok || !r.Enabled || r.KeyHash != key {
		return false, ErrUnauthorized
	}
	if r.SessionHash != session || !r.SessionExpiresAt.After(now) {
		return false, ErrSession
	}
	if r.Sequence == seq && r.ReportHash == hash {
		return true, nil
	}
	if seq <= r.Sequence {
		return false, ErrSequence
	}
	r.Sequence = seq
	r.ReportHash = hash
	r.Observation = o
	r.LastReceivedAt = &now
	m.records[id] = clone(r)
	return false, nil
}

type actors struct {
	status string
	role   string
}

func (a actors) FindByUsernameIdentity(context.Context, string) (*user.UserIdentity, error) {
	status := a.status
	if status == "" {
		status = "active"
	}
	role := a.role
	if role == "" {
		role = "admin"
	}
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: "admin", Role: role, Status: status}}, nil
}
func admin() *auth.Principal {
	return &auth.Principal{Username: "admin", Role: "admin", NormalizedRole: "admin"}
}
func setup(t *testing.T) (*Service, *memoryRepo, *time.Time) {
	t.Helper()
	now := time.Date(2026, 11, 9, 1, 2, 3, 0, time.UTC)
	repo := newMemoryRepo()
	s := NewService(repo, actors{}, nil, nil, nil)
	s.clock = func() time.Time { return now }
	return s, repo, &now
}
func create(t *testing.T, s *Service, name, network string) *CredentialResponse {
	t.Helper()
	r, err := s.Create(context.Background(), admin(), CreateRequest{Metadata: Metadata{Name: name, Scope: Scope{NetworkKey: network, PLMNs: []string{"00101"}}}})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func observation(now time.Time) Observation {
	return Observation{CollectedAt: now.Format(time.RFC3339Nano), HostName: "same-host-label", Platform: "linux", Version: "test", Visibility: "host", ScanComplete: true, Components: []Component{
		{ComponentID: "mme", RuntimeStatus: "running", Verified: true, PrimaryPID: 123, WorkerCount: 1},
	}}
}
func publish(t *testing.T, s *Service, credential *CredentialResponse, o Observation) (*Record, *SessionResponse) {
	t.Helper()
	ctx := context.Background()
	r, err := s.Authenticate(ctx, credential.Agent.AgentID, credential.Token)
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.StartSession(ctx, r, SessionRequest{ProtocolVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	r, err = s.Authenticate(ctx, r.AgentID, credential.Token)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Accept(ctx, r, ReportRequest{ProtocolVersion: 1, SessionID: session.SessionID, Sequence: 1, Observation: o})
	if err != nil {
		t.Fatal(err)
	}
	return r, session
}
func TestTwoCollectorsKeepSamePIDAndComponentSeparate(t *testing.T) {
	s, repo, now := setup(t)
	a := create(t, s, "node-a", "home")
	b := create(t, s, "node-b", "partner")
	o := observation(*now)
	publish(t, s, a, o)
	o.Components[0].RuntimeStatus = "stopped"
	o.Components[0].Verified = false
	o.Components[0].PrimaryPID = 0
	o.Components[0].WorkerCount = 0
	publish(t, s, b, o)
	va, _ := s.Get(context.Background(), a.Agent.AgentID)
	vb, _ := s.Get(context.Background(), b.Agent.AgentID)
	if va.Scope.NetworkKey != "home" || vb.Scope.NetworkKey != "partner" || va.Observation.Components[0].RuntimeStatus != "running" || vb.Observation.Components[0].RuntimeStatus != "stopped" {
		t.Fatal("collector evidence crossed node boundaries")
	}
	if len(repo.records) != 2 {
		t.Fatal("node identities collapsed")
	}
}
func TestCredentialRotationRevokesSessionsAndInflightReports(t *testing.T) {
	s, _, now := setup(t)
	c := create(t, s, "node", "home")
	old, session := publish(t, s, c, observation(*now))
	fresh, err := s.Rotate(context.Background(), admin(), c.Agent.AgentID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(context.Background(), c.Agent.AgentID, c.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("old key accepted")
	}
	_, err = s.Accept(context.Background(), old, ReportRequest{ProtocolVersion: 1, SessionID: session.SessionID, Sequence: 2, Observation: observation(*now)})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatal("inflight old key bypassed atomic revocation")
	}
	if _, err = s.Authenticate(context.Background(), fresh.Agent.AgentID, fresh.Token); err != nil {
		t.Fatal(err)
	}
}
func TestDuplicateReportDoesNotRefreshLivenessAndSessionReplacementRejectsOld(t *testing.T) {
	s, _, now := setup(t)
	c := create(t, s, "node", "home")
	r, session := publish(t, s, c, observation(*now))
	original := *now
	*now = now.Add(50 * time.Second)
	req := ReportRequest{ProtocolVersion: 1, SessionID: session.SessionID, Sequence: 1, Observation: observation(original)}
	duplicate, err := s.Accept(context.Background(), r, req)
	if err != nil || !duplicate {
		t.Fatal("retry was not idempotent", err)
	}
	v, _ := s.Get(context.Background(), r.AgentID)
	if v.ConnectionState != "stale" || !v.LastReceivedAt.Equal(original) {
		t.Fatal("retry revived old evidence")
	}
	current, _ := s.Authenticate(context.Background(), r.AgentID, c.Token)
	_, err = s.StartSession(context.Background(), current, SessionRequest{ProtocolVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	req.Sequence = 2
	_, err = s.Accept(context.Background(), r, req)
	if !errors.Is(err, ErrSession) {
		t.Fatal("replaced session accepted")
	}
}
func TestNoHeartbeatIsPendingOfflineIsNotStoppedAndMissingMetricsStayNull(t *testing.T) {
	s, _, now := setup(t)
	c := create(t, s, "node", "home")
	v, _ := s.Get(context.Background(), c.Agent.AgentID)
	if v.ConnectionState != "pending" {
		t.Fatal(v.ConnectionState)
	}
	publish(t, s, c, observation(*now))
	*now = now.Add(121 * time.Second)
	v, _ = s.Get(context.Background(), c.Agent.AgentID)
	if v.ConnectionState != "offline" || v.EvidenceFreshness != "stale" || v.Observation.Components[0].RuntimeStatus != "running" {
		t.Fatal("disconnect fabricated NF state")
	}
	data, _ := json.Marshal(v)
	text := string(data)
	for _, bad := range []string{"keyHash", "sessionHash", c.Token} {
		if strings.Contains(text, bad) {
			t.Fatal("secret in projection")
		}
	}
	if !strings.Contains(text, `"cpuPercent":null`) {
		t.Fatal("missing measurement replaced with zero")
	}
}
func TestFreshActorAndCASProtectCollectorAccess(t *testing.T) {
	s, _, _ := setup(t)
	c := create(t, s, "node", "home")
	p := admin()
	p.NormalizedRole = "operator"
	if _, err := s.Create(context.Background(), p, CreateRequest{}); err == nil {
		t.Fatal("operator created machine access")
	}
	s.actors = actors{status: "disabled"}
	if _, err := s.Rotate(context.Background(), admin(), c.Agent.AgentID, 1); err == nil {
		t.Fatal("disabled actor wrote")
	}
	s.actors = actors{}
	disabled := false
	req := UpdateRequest{Metadata: c.Agent.Metadata, ExpectedRevision: 1, Enabled: &disabled}
	if _, err := s.Update(context.Background(), admin(), c.Agent.AgentID, req); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(context.Background(), admin(), c.Agent.AgentID, req); !errors.Is(err, ErrConflict) {
		t.Fatal("stale CAS accepted")
	}
	if _, err := s.Authenticate(context.Background(), c.Agent.AgentID, c.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("disabled collector accepted")
	}
}
func TestReportValidationRejectsInventedEvidenceAndScope(t *testing.T) {
	s, _, now := setup(t)
	c := create(t, s, "node", "home")
	r, session := publish(t, s, c, observation(*now))
	good := observation(*now)
	cases := []Observation{good, good, good, good}
	cases[0].ScanComplete = false
	cases[0].Components = []Component{{ComponentID: "mme", RuntimeStatus: "stopped"}}
	cases[1].Components = []Component{{ComponentID: "mme", RuntimeStatus: "running", PrimaryPID: 1, WorkerCount: 1}}
	cases[2].CollectedAt = now.Add(2 * time.Minute).Format(time.RFC3339Nano)
	n := int64(-1)
	cases[3].Metrics.MemoryTotalBytes = &n
	for i, o := range cases {
		if _, err := s.Accept(context.Background(), r, ReportRequest{ProtocolVersion: 1, SessionID: session.SessionID, Sequence: 2, Observation: o}); err == nil {
			t.Fatalf("invalid report %d accepted", i)
		}
	}
	h := NewHandler(s, nil, nil)
	req := httptest.NewRequest("POST", "/api/agent-reports/"+r.AgentID, strings.NewReader(`{"scope":{"networkKey":"other"}}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.SetPathValue("agentId", r.AgentID)
	req.Header.Set("Authorization", "Agent "+c.Token)
	w := httptest.NewRecorder()
	h.Report(w, req)
	if w.Code != 400 {
		t.Fatalf("self-assigned scope accepted: %d", w.Code)
	}
}
func TestMachineEndpointsRejectBrowserIdentityAndUnencryptedRemote(t *testing.T) {
	s, _, _ := setup(t)
	c := create(t, s, "node", "home")
	h := NewHandler(s, nil, nil)
	for _, test := range []struct {
		peer, proto, auth string
		want              int
	}{
		{"192.0.2.1:5000", "", "Agent " + c.Token, 400},
		{"127.0.0.1:5000", "http", "Agent " + c.Token, 400},
		{"127.0.0.1:5000", "", "", 401},
		{"192.0.2.1:5000", "https", "Agent " + c.Token, 400},
	} {
		r := httptest.NewRequest("POST", "/api/agent-sessions/"+c.Agent.AgentID, strings.NewReader(`{"protocolVersion":1}`))
		r.RemoteAddr = test.peer
		r.Header.Set("X-Forwarded-Proto", test.proto)
		r.Header.Set("Authorization", test.auth)
		r.Header.Set("X-User", "admin")
		r.AddCookie(&http.Cookie{Name: "auth_token", Value: "browser-cookie"})
		r.SetPathValue("agentId", c.Agent.AgentID)
		w := httptest.NewRecorder()
		h.Session(w, r)
		if w.Code != test.want {
			t.Fatalf("got %d want %d", w.Code, test.want)
		}
	}
}
func TestUnavailableListDoesNotClaimZeroAndPaginationSummaryUsesWholeSet(t *testing.T) {
	s, repo, _ := setup(t)
	create(t, s, "a", "a")
	create(t, s, "b", "b")
	page, err := s.List(context.Background(), ListQuery{Limit: 1})
	if err != nil || !page.HasMore || page.Summary.Total != 2 || len(page.Agents) != 1 {
		t.Fatal("partial page became platform total")
	}
	repo.unavailable = true
	page, err = s.List(context.Background(), ListQuery{Limit: 1})
	if err != nil || page.Summary != nil || page.Completeness != "unavailable" {
		t.Fatal("unavailable read became empty healthy set")
	}
}
func TestCPUUsesDeltasAndCounterResetBecomesUnavailable(t *testing.T) {
	samples := []hostCounters{{TotalCPU: 100, IdleCPU: 50, CPUValid: true}, {TotalCPU: 200, IdleCPU: 100, CPUValid: true}, {TotalCPU: 1, IdleCPU: 0, CPUValid: true}}
	i := 0
	s := &HostSampler{read: func() hostCounters { v := samples[i]; i++; return v }}
	if s.Sample().CPUPercent != nil {
		t.Fatal("first interval fabricated")
	}
	cpu := s.Sample().CPUPercent
	if cpu == nil || *cpu != 50 {
		t.Fatal("wrong interval delta")
	}
	if s.Sample().CPUPercent != nil {
		t.Fatal("counter reset inherited old interval")
	}
}
