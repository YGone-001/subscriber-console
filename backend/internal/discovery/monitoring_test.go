package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// mockMonitoringResolver records the batch lookups the handler performs and
// answers from a fixed target table (or a fixed error).
type mockMonitoringResolver struct {
	targets map[string]string
	err     error
	calls   int
	seenIDs [][]string
}

func (m *mockMonitoringResolver) ResolveMonitoringTargets(ctx context.Context, resourceIDs []string) (map[string]string, error) {
	m.calls++
	ids := append([]string(nil), resourceIDs...)
	sort.Strings(ids)
	m.seenIDs = append(m.seenIDs, ids)
	if m.err != nil {
		return nil, m.err
	}
	out := map[string]string{}
	for _, id := range resourceIDs {
		if target, ok := m.targets[id]; ok {
			out[id] = target
		}
	}
	return out, nil
}

// seedLinkedCandidate creates one candidate linked to the given resource.
func seedLinkedCandidate(t *testing.T, repo *mockRepo, sourceID, externalID, nfType, resourceID string) *NFObservation {
	t.Helper()
	_, _, _, err := repo.UpsertObservation(context.Background(), sourceID, AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: externalID, NfType: nfType, NfStatus: "REGISTERED"}, CurrentTimestamp())
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	var candidate *NFObservation
	for _, c := range repo.candidates {
		if c.ExternalNfInstanceID == externalID {
			candidate = c
			break
		}
	}
	if candidate == nil {
		t.Fatalf("candidate %s not found", externalID)
	}
	linked, err := repo.SetCandidateLink(context.Background(), candidate.CandidateID, candidate.Revision, &resourceID, "tester")
	if err != nil {
		t.Fatalf("link: %v", err)
	}
	return linked
}

func listCandidatesOnce(t *testing.T, h *Handler) ListCandidatesResponse {
	t.Helper()
	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/candidates", nil), "viewer")
	w := httptest.NewRecorder()
	h.ListCandidates(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", w.Code, w.Body.String())
	}
	var res ListCandidatesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return res
}

// TestListCandidatesProjectsMonitoringAssociation verifies the forward-compatible
// DTO extension: one bounded batch lookup per page, monitored / unmonitored from
// the authoritative target table, and no projection for unlinked candidates.
func TestListCandidatesProjectsMonitoringAssociation(t *testing.T) {
	repo := newMockRepo()
	const resourceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const resourceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

	unlinked := seedLinkedCandidate(t, repo, "src", "unlinked-inst", "AMF", resourceA)
	if _, err := repo.SetCandidateLink(context.Background(), unlinked.CandidateID, unlinked.Revision, nil, "tester"); err != nil {
		t.Fatalf("unlink: %v", err)
	}
	seedLinkedCandidate(t, repo, "src", "linked-monitored", "UDM", resourceA)
	seedLinkedCandidate(t, repo, "src", "linked-shared", "SMF", resourceA)
	seedLinkedCandidate(t, repo, "src", "linked-unmonitored", "PCF", resourceB)

	resolver := &mockMonitoringResolver{targets: map[string]string{resourceA: "target-a"}}
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	h.SetMonitoringResolver(resolver)

	res := listCandidatesOnce(t, h)

	if resolver.calls != 1 {
		t.Fatalf("association lookups = %d, want exactly one bounded batch query", resolver.calls)
	}
	if len(resolver.seenIDs) != 1 || len(resolver.seenIDs[0]) != 2 {
		t.Fatalf("batch ids = %v, want the two distinct linked resources", resolver.seenIDs)
	}

	byExternal := map[string]NFObservation{}
	for _, c := range res.Candidates {
		byExternal[c.ExternalNfInstanceID] = c
	}

	if assoc := byExternal["unlinked-inst"].MonitoringAssociation; assoc != nil {
		t.Fatalf("unlinked candidate must carry no association summary, got %+v", assoc)
	}
	for _, external := range []string{"linked-monitored", "linked-shared"} {
		assoc := byExternal[external].MonitoringAssociation
		if assoc == nil || assoc.State != CandidateMonitored || assoc.TargetID != "target-a" {
			t.Fatalf("%s association = %+v, want monitored/target-a", external, assoc)
		}
	}
	if assoc := byExternal["linked-unmonitored"].MonitoringAssociation; assoc == nil || assoc.State != CandidateUnmonitored {
		t.Fatalf("linked-unmonitored association = %+v, want unmonitored", assoc)
	}
}

// TestListCandidatesAssociationFailureIsUnresolved proves a failed association
// lookup is reported as unresolved and never downgraded to unmonitored.
func TestListCandidatesAssociationFailureIsUnresolved(t *testing.T) {
	repo := newMockRepo()
	seedLinkedCandidate(t, repo, "src", "linked", "AMF", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

	resolver := &mockMonitoringResolver{err: errors.New("association backend unavailable")}
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	h.SetMonitoringResolver(resolver)

	res := listCandidatesOnce(t, h)
	if len(res.Candidates) != 1 {
		t.Fatalf("candidates = %d, want 1", len(res.Candidates))
	}
	assoc := res.Candidates[0].MonitoringAssociation
	if assoc == nil || assoc.State != CandidateUnresolved {
		t.Fatalf("association = %+v, want unresolved (absence is not established)", assoc)
	}
}

// TestListCandidatesWithoutResolverOmitsProjection proves an unwired handler
// serves unprojected pages instead of guessing an association.
func TestListCandidatesWithoutResolverOmitsProjection(t *testing.T) {
	repo := newMockRepo()
	seedLinkedCandidate(t, repo, "src", "linked", "AMF", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})

	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/candidates", nil), "viewer")
	w := httptest.NewRecorder()
	h.ListCandidates(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}

	var res ListCandidatesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(res.Candidates) != 1 || res.Candidates[0].MonitoringAssociation != nil {
		t.Fatalf("unwired handler must not project an association, got %+v", res.Candidates)
	}
	if bytes.Contains(w.Body.Bytes(), []byte("monitoringAssociation")) {
		t.Fatalf("the wire payload must omit monitoringAssociation entirely, body=%s", w.Body.String())
	}
}

// TestGetCandidateProjectsMonitoringAssociation covers the single-candidate
// read path with the same authoritative projection.
func TestGetCandidateProjectsMonitoringAssociation(t *testing.T) {
	repo := newMockRepo()
	const resourceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	candidate := seedLinkedCandidate(t, repo, "src", "linked", "AMF", resourceA)

	resolver := &mockMonitoringResolver{targets: map[string]string{resourceA: "target-a"}}
	h, _ := newTestHandler(repo, &mockAdapter{}, &mockResolver{})
	h.SetMonitoringResolver(resolver)

	req := withPrincipal(httptest.NewRequest(http.MethodGet, "/api/discovery/candidates/"+candidate.CandidateID, nil), "viewer")
	req.SetPathValue("candidateId", candidate.CandidateID)
	w := httptest.NewRecorder()
	h.GetCandidate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}

	var got NFObservation
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.MonitoringAssociation == nil || got.MonitoringAssociation.State != CandidateMonitored || got.MonitoringAssociation.TargetID != "target-a" {
		t.Fatalf("association = %+v, want monitored/target-a", got.MonitoringAssociation)
	}
}

// TestMonitoringAssociationNeverPersisted proves the derived projection is a
// response-only field: bson:"-" keeps it out of the stored document.
func TestMonitoringAssociationNeverPersisted(t *testing.T) {
	doc := NFObservation{
		CandidateID:           "c1",
		ObservationState:      ObservationSeen,
		MonitoringAssociation: &CandidateMonitoringAssociation{State: CandidateMonitored, TargetID: "t1"},
	}
	encoded, err := bson.Marshal(doc)
	if err != nil {
		t.Fatalf("bson marshal: %v", err)
	}
	if bytes.Contains(encoded, []byte("monitoringAssociation")) {
		t.Fatalf("the stored document must not contain the derived projection: %s", encoded)
	}
	var back NFObservation
	if err := bson.Unmarshal(encoded, &back); err != nil {
		t.Fatalf("bson unmarshal: %v", err)
	}
	if back.MonitoringAssociation != nil {
		t.Fatalf("decoded document carries a projection: %+v", back.MonitoringAssociation)
	}
}
