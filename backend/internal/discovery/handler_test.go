package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
)

type mockRepo struct {
	sources      map[string]*DiscoverySource
	runs         map[string]*DiscoveryRun
	candidates   map[string]*NFObservation
	scanErr      error
	profiles     []*NormalizedProfile
	complete     bool
	linkCalls    int
	inventoryMut int
}

func newMockRepo() *mockRepo {
	return &mockRepo{
		sources:    map[string]*DiscoverySource{},
		runs:       map[string]*DiscoveryRun{},
		candidates: map[string]*NFObservation{},
		complete:   true,
	}
}

func (m *mockRepo) CreateSource(ctx context.Context, req *CreateSourceRequest, actor string) (*DiscoverySource, error) {
	src := &DiscoverySource{
		SourceID: "11111111-1111-4111-8111-111111111111", SchemaVersion: 1,
		Name: req.Name, AdapterType: req.AdapterType, BaseURL: req.BaseURL,
		TransportMode: req.TransportMode, Enabled: true, Revision: 1,
		CreatedAt: CurrentTimestamp(), CreatedBy: actor, UpdatedAt: CurrentTimestamp(), UpdatedBy: actor,
	}
	m.sources[src.SourceID] = src
	return src, nil
}

func (m *mockRepo) GetSource(ctx context.Context, id string) (*DiscoverySource, error) {
	if s, ok := m.sources[id]; ok {
		return s, nil
	}
	return nil, ErrNotFound
}

func (m *mockRepo) ListSources(ctx context.Context, f SourceListFilter) ([]DiscoverySource, *string, bool, error) {
	out := []DiscoverySource{}
	for _, s := range m.sources {
		out = append(out, *s)
	}
	return out, nil, false, nil
}

func (m *mockRepo) UpdateSource(ctx context.Context, id string, req *UpdateSourceRequest, actor string) (*DiscoverySource, *DiscoverySource, error) {
	s, ok := m.sources[id]
	if !ok {
		return nil, nil, ErrNotFound
	}
	if s.Revision != req.ExpectedRevision {
		return nil, nil, ErrConflict
	}
	before := *s
	s.Name = req.Source.Name
	s.BaseURL = req.Source.BaseURL
	s.TransportMode = req.Source.TransportMode
	s.Enabled = req.Source.Enabled
	s.Revision++
	after := *s
	return &before, &after, nil
}

func (m *mockRepo) InsertRun(ctx context.Context, run *DiscoveryRun) error {
	m.runs[run.RunID] = run
	return nil
}

func (m *mockRepo) CompleteRun(ctx context.Context, run *DiscoveryRun) error {
	m.runs[run.RunID] = run
	return nil
}

func (m *mockRepo) GetRun(ctx context.Context, id string) (*DiscoveryRun, error) {
	if r, ok := m.runs[id]; ok {
		return r, nil
	}
	return nil, ErrNotFound
}

func (m *mockRepo) ListRuns(ctx context.Context, f RunListFilter) ([]DiscoveryRun, *string, bool, error) {
	out := []DiscoveryRun{}
	for _, r := range m.runs {
		out = append(out, *r)
	}
	return out, nil, false, nil
}

func (m *mockRepo) UpsertObservation(ctx context.Context, sourceID, adapterType string, p *NormalizedProfile, now string) (bool, bool, bool, error) {
	for _, existing := range m.candidates {
		if existing.SourceID == sourceID && existing.ExternalNfInstanceID == p.ExternalNfInstanceID {
			existing.LastSeenAt = now
			return false, false, true, nil
		}
	}
	id := audit.GenerateUUID()
	m.candidates[id] = &NFObservation{
		CandidateID: id, SchemaVersion: 1, SourceID: sourceID, AdapterType: adapterType,
		ExternalNfInstanceID: p.ExternalNfInstanceID, NfType: p.NfType, NfStatus: p.NfStatus,
		ObservedEndpoints: []ObservedEndpoint{}, ObservedServices: []ObservedService{},
		FirstSeenAt: now, LastSeenAt: now, ObservationState: ObservationSeen, Revision: 1,
	}
	return true, false, false, nil
}

func (m *mockRepo) MarkMissing(ctx context.Context, sourceID string, seen map[string]struct{}, now string) (int, error) {
	missing := 0
	for _, c := range m.candidates {
		if c.SourceID != sourceID {
			continue
		}
		if _, ok := seen[c.ExternalNfInstanceID]; !ok {
			if c.ObservationState != ObservationMissing {
				c.ObservationState = ObservationMissing
				missing++
			}
		}
	}
	return missing, nil
}

func (m *mockRepo) GetCandidate(ctx context.Context, id string) (*NFObservation, error) {
	if c, ok := m.candidates[id]; ok {
		return c, nil
	}
	return nil, ErrNotFound
}

func (m *mockRepo) ListCandidates(ctx context.Context, f CandidateListFilter) ([]NFObservation, *string, bool, error) {
	out := []NFObservation{}
	for _, c := range m.candidates {
		out = append(out, *c)
	}
	return out, nil, false, nil
}

func (m *mockRepo) SetCandidateLink(ctx context.Context, id string, rev int64, resourceID *string, actor string) (*NFObservation, error) {
	c, ok := m.candidates[id]
	if !ok {
		return nil, ErrNotFound
	}
	if c.Revision != rev {
		return nil, ErrConflict
	}
	c.LinkedResourceID = resourceID
	c.Revision++
	m.linkCalls++
	return c, nil
}

func (m *mockRepo) UpdateSourceScanMeta(ctx context.Context, sourceID, completedAt, lastError string) error {
	return nil
}

func (m *mockRepo) CountSources(ctx context.Context) (int, error) { return len(m.sources), nil }

func (m *mockRepo) CountCandidates(ctx context.Context, sourceID, linkedOnly string) (int, error) {
	return len(m.candidates), nil
}

func (m *mockRepo) LatestRun(ctx context.Context) (*DiscoveryRun, error) { return nil, nil }

func (m *mockRepo) ListSourceIDs(ctx context.Context) ([]string, error) { return nil, nil }

type mockResolver struct {
	exists   bool
	linkable bool
}

func (r *mockResolver) ExistsAndLinkable(ctx context.Context, id string) (bool, bool, error) {
	return r.exists, r.linkable, nil
}

type dummyAudit struct{ actions []string }

func (d *dummyAudit) WriteBestEffort(input audit.WriteAuditInput) {
	d.actions = append(d.actions, input.Action)
}

type mockAdapter struct {
	batch *ObservationBatch
	err   error
}

func (a *mockAdapter) Type() string { return AdapterNRF }

func (a *mockAdapter) Discover(ctx context.Context, src DiscoverySource) (*ObservationBatch, error) {
	if a.err != nil {
		return nil, a.err
	}
	return a.batch, nil
}

func makePrincipal(role string) *auth.Principal {
	return &auth.Principal{Username: "tester", Role: role, NormalizedRole: role, UserID: "u1", SessionVersion: 1}
}

func withPrincipal(req *http.Request, role string) *http.Request {
	return req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal(role)))
}

func newTestHandler(repo *mockRepo, adapter Adapter, resolver InventoryResolver) (*Handler, *dummyAudit) {
	aud := &dummyAudit{}
	reg := NewAdapterRegistry(adapter)
	allow := NewDestinationAllowlist("127.0.0.10:7777")
	h := NewHandler(repo, nil, aud, reg, allow, resolver)
	return h, aud
}

func TestMetaRequiresReadPermission(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/meta", nil), "viewer")
	w := httptest.NewRecorder()
	h.Meta(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("viewer read meta status = %d", w.Code)
	}
}

func TestViewerCannotMutate(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})

	body := []byte(`{"name":"nrf","adapterType":"nrf","baseUrl":"http://127.0.0.10:7777","transportMode":"h2c"}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources", bytes.NewReader(body)), "viewer")
	w := httptest.NewRecorder()
	h.CreateSource(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("viewer create status = %d", w.Code)
	}
}

func TestCreateSourceRejectsNonAllowlistedTarget(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	body := []byte(`{"name":"evil","adapterType":"nrf","baseUrl":"http://127.0.0.11:7777","transportMode":"h2c"}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources", bytes.NewReader(body)), "operator")
	w := httptest.NewRecorder()
	h.CreateSource(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var payload map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload["code"] != "DISCOVERY_TARGET_NOT_ALLOWED" {
		t.Fatalf("code = %q", payload["code"])
	}
}

func TestCreateSourceRejectsUnknownJSONFields(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	body := []byte(`{"name":"nrf","adapterType":"nrf","baseUrl":"http://127.0.0.10:7777","transportMode":"h2c","evil":true}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources", bytes.NewReader(body)), "operator")
	w := httptest.NewRecorder()
	h.CreateSource(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown fields must be rejected, status = %d", w.Code)
	}
}

func TestCreateSourceRejectsTrailingJSON(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	body := []byte(`{"name":"nrf","adapterType":"nrf","baseUrl":"http://127.0.0.10:7777","transportMode":"h2c"}{"extra":1}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources", bytes.NewReader(body)), "operator")
	w := httptest.NewRecorder()
	h.CreateSource(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("trailing content must be rejected, status = %d", w.Code)
	}
}

func TestScanDisabledSource(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	src.Enabled = false
	h, _ := newTestHandler(repo, &mockAdapter{batch: &ObservationBatch{Complete: true}}, &mockResolver{})

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources/"+src.SourceID+"/scan", nil), "operator")
	req.SetPathValue("sourceId", src.SourceID)
	w := httptest.NewRecorder()
	h.ScanSource(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("disabled source status = %d", w.Code)
	}
	var payload map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload["code"] != "DISCOVERY_SOURCE_DISABLED" {
		t.Fatalf("code = %q", payload["code"])
	}
}

func TestScanFailureIsNotSuccessfulEmptyDiscovery(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	adapter := &mockAdapter{err: ErrProtocol}
	h, _ := newTestHandler(repo, adapter, &mockResolver{})

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources/"+src.SourceID+"/scan", nil), "operator")
	req.SetPathValue("sourceId", src.SourceID)
	w := httptest.NewRecorder()
	h.ScanSource(w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("failed scan must not be reported as success, body=%s", w.Body.String())
	}
	var payload map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload["code"] != "DISCOVERY_PROTOCOL_ERROR" {
		t.Fatalf("code = %q", payload["code"])
	}
}

func TestScanPersistsCandidatesIdempotently(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	adapter := &mockAdapter{batch: &ObservationBatch{
		Complete: true,
		Profiles: []*NormalizedProfile{
			{ExternalNfInstanceID: "aaaa", NfType: "AMF", NfStatus: "REGISTERED"},
			{ExternalNfInstanceID: "bbbb", NfType: "UDM", NfStatus: "REGISTERED"},
		},
	}}
	h, _ := newTestHandler(repo, adapter, &mockResolver{})

	runScan := func() *DiscoveryRun {
		req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources/"+src.SourceID+"/scan", nil), "operator")
		req.SetPathValue("sourceId", src.SourceID)
		w := httptest.NewRecorder()
		h.ScanSource(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("scan status = %d body=%s", w.Code, w.Body.String())
		}
		var res ScanResult
		_ = json.Unmarshal(w.Body.Bytes(), &res)
		return &res.Run
	}

	first := runScan()
	if first.DiscoveredCount != 2 || first.CreatedCount != 2 {
		t.Fatalf("first run = %+v", first)
	}
	if len(repo.candidates) != 2 {
		t.Fatalf("candidates = %d", len(repo.candidates))
	}

	// Second scan must be idempotent: no duplicate candidates, stable ids.
	idsBefore := map[string]bool{}
	for id := range repo.candidates {
		idsBefore[id] = true
	}
	// Reset rate-limit bookkeeping for the deterministic unit test.
	h.lastScanAt = map[string]time.Time{}
	second := runScan()
	if second.UnchangedCount != 2 {
		t.Fatalf("second run = %+v", second)
	}
	if len(repo.candidates) != 2 {
		t.Fatalf("duplicate candidates created: %d", len(repo.candidates))
	}
	for id := range repo.candidates {
		if !idsBefore[id] {
			t.Fatalf("candidate identity changed across scans: %s", id)
		}
	}
}

func TestIncompleteScanDoesNotMarkMissing(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	// Seed a previously seen candidate.
	repo.UpsertObservation(context.Background(), src.SourceID, AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "zzz", NfType: "SMF", NfStatus: "REGISTERED"}, CurrentTimestamp())

	adapter := &mockAdapter{batch: &ObservationBatch{Complete: false, Truncated: true, Profiles: nil}}
	h, _ := newTestHandler(repo, adapter, &mockResolver{})

	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources/"+src.SourceID+"/scan", nil), "operator")
	req.SetPathValue("sourceId", src.SourceID)
	w := httptest.NewRecorder()
	h.ScanSource(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var res ScanResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Run.Status != RunStatusPartial {
		t.Fatalf("truncated scan status = %q", res.Run.Status)
	}
	if res.Run.MissingCount != 0 {
		t.Fatalf("truncated scan must not infer absence, missing=%d", res.Run.MissingCount)
	}
}

func TestFailedScanRetainsPreviousObservations(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	repo.UpsertObservation(context.Background(), src.SourceID, AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "keep", NfType: "AMF", NfStatus: "REGISTERED"}, CurrentTimestamp())

	h, _ := newTestHandler(repo, &mockAdapter{err: ErrProtocol}, &mockResolver{})
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/sources/"+src.SourceID+"/scan", nil), "operator")
	req.SetPathValue("sourceId", src.SourceID)
	w := httptest.NewRecorder()
	h.ScanSource(w, req)
	if w.Code == http.StatusOK {
		t.Fatal("failed scan must not be success")
	}
	if len(repo.candidates) != 1 {
		t.Fatalf("previous observations must be retained, got %d", len(repo.candidates))
	}
}

func TestLinkCandidateRejectsIncompatibleResource(t *testing.T) {
	repo := newMockRepo()
	_, _, _, _ = repo.UpsertObservation(context.Background(), "src", AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "x", NfType: "AMF", NfStatus: "REGISTERED"}, CurrentTimestamp())
	var candidateID string
	for id := range repo.candidates {
		candidateID = id
	}
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{exists: true, linkable: false})

	body := []byte(`{"expectedRevision":1,"resourceId":"22222222-2222-4222-8222-222222222222"}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/candidates/"+candidateID+"/link", bytes.NewReader(body)), "operator")
	req.SetPathValue("candidateId", candidateID)
	w := httptest.NewRecorder()
	h.LinkCandidate(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("incompatible resource status = %d body=%s", w.Code, w.Body.String())
	}
	var payload map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload["code"] != "DISCOVERY_INVENTORY_LINK_CONFLICT" {
		t.Fatalf("code = %q", payload["code"])
	}
}

func TestLinkCandidateUpdatesDiscoveryMetadataOnly(t *testing.T) {
	repo := newMockRepo()
	_, _, _, _ = repo.UpsertObservation(context.Background(), "src", AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "x", NfType: "AMF", NfStatus: "REGISTERED"}, CurrentTimestamp())
	var candidateID string
	for id := range repo.candidates {
		candidateID = id
	}
	h, aud := newTestHandler(repo, &mockAdapter{}, &mockResolver{exists: true, linkable: true})

	body := []byte(`{"expectedRevision":1,"resourceId":"22222222-2222-4222-8222-222222222222"}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/candidates/"+candidateID+"/link", bytes.NewReader(body)), "operator")
	req.SetPathValue("candidateId", candidateID)
	w := httptest.NewRecorder()
	h.LinkCandidate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("link status = %d body=%s", w.Code, w.Body.String())
	}
	if repo.linkCalls != 1 {
		t.Fatalf("linkCalls = %d", repo.linkCalls)
	}
	found := false
	for _, a := range aud.actions {
		if a == "discovery.candidate.link" {
			found = true
		}
	}
	if !found {
		t.Fatalf("audit actions = %v", aud.actions)
	}
}

func TestLinkCandidateRevisionConflict(t *testing.T) {
	repo := newMockRepo()
	_, _, _, _ = repo.UpsertObservation(context.Background(), "src", AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "x", NfType: "AMF", NfStatus: "REGISTERED"}, CurrentTimestamp())
	var candidateID string
	for id := range repo.candidates {
		candidateID = id
	}
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{exists: true, linkable: true})

	body := []byte(`{"expectedRevision":99,"resourceId":"22222222-2222-4222-8222-222222222222"}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/candidates/"+candidateID+"/link", bytes.NewReader(body)), "admin")
	req.SetPathValue("candidateId", candidateID)
	w := httptest.NewRecorder()
	h.LinkCandidate(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("revision conflict status = %d", w.Code)
	}
}

func TestUnlinkDoesNotMutateInventory(t *testing.T) {
	repo := newMockRepo()
	_, _, _, _ = repo.UpsertObservation(context.Background(), "src", AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "x", NfType: "AMF", NfStatus: "REGISTERED"}, CurrentTimestamp())
	var candidateID string
	for id := range repo.candidates {
		candidateID = id
	}
	resolver := &mockResolver{exists: true, linkable: true}
	h, _ := newTestHandler(repo, &mockAdapter{}, resolver)

	linkBody := []byte(`{"expectedRevision":1,"resourceId":"22222222-2222-4222-8222-222222222222"}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/candidates/"+candidateID+"/link", bytes.NewReader(linkBody)), "operator")
	req.SetPathValue("candidateId", candidateID)
	w := httptest.NewRecorder()
	h.LinkCandidate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("link status = %d", w.Code)
	}

	unlinkBody := []byte(`{"expectedRevision":2}`)
	req = withPrincipal(httptest.NewRequest(http.MethodPost, "/api/discovery/candidates/"+candidateID+"/unlink", bytes.NewReader(unlinkBody)), "operator")
	req.SetPathValue("candidateId", candidateID)
	w = httptest.NewRecorder()
	h.UnlinkCandidate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unlink status = %d body=%s", w.Code, w.Body.String())
	}
	if repo.inventoryMut != 0 {
		t.Fatalf("inventory mutations = %d", repo.inventoryMut)
	}
	c, _ := repo.GetCandidate(context.Background(), candidateID)
	if c.LinkedResourceID != nil {
		t.Fatalf("link should be cleared, got %v", c.LinkedResourceID)
	}
}

func TestListCandidatesRejectsUnknownQueryParameter(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/candidates?evil=1", nil), "viewer")
	w := httptest.NewRecorder()
	h.ListCandidates(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown query param status = %d", w.Code)
	}
}

func TestListCandidatesRejectsBadLimit(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/candidates?limit=9999", nil), "viewer")
	w := httptest.NewRecorder()
	h.ListCandidates(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad limit status = %d", w.Code)
	}
}

func TestMissingSourceReturns404(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/sources/33333333-3333-4333-8333-333333333333", nil), "viewer")
	req.SetPathValue("sourceId", "33333333-3333-4333-8333-333333333333")
	w := httptest.NewRecorder()
	h.GetSource(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestInvalidUUIDRejected(t *testing.T) {
	repo := newMockRepo()
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/sources/not-a-uuid", nil), "viewer")
	req.SetPathValue("sourceId", "not-a-uuid")
	w := httptest.NewRecorder()
	h.GetSource(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestUpdateSourceCAS(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})

	body := []byte(`{"expectedRevision":5,"source":{"name":"nrf2","baseUrl":"http://127.0.0.10:7777","transportMode":"h2c","enabled":true}}`)
	req := withPrincipal(httptest.NewRequest(http.MethodPut, "/api/discovery/sources/"+src.SourceID, bytes.NewReader(body)), "operator")
	req.SetPathValue("sourceId", src.SourceID)
	w := httptest.NewRecorder()
	h.UpdateSource(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("CAS mismatch status = %d body=%s", w.Code, w.Body.String())
	}
	var payload map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload["code"] != "DISCOVERY_REVISION_CONFLICT" {
		t.Fatalf("code = %q", payload["code"])
	}
}
