package topology

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
)

type mockRepo struct {
	items map[string]*Edge
}

func newMockRepo() *mockRepo {
	return &mockRepo{items: make(map[string]*Edge)}
}

func (m *mockRepo) Create(ctx context.Context, req *CreateEdgeRequest, actor string) (*Edge, error) {
	if req.FromResourceID == req.ToResourceID {
		return nil, ErrSelfEdge
	}
	for _, existing := range m.items {
		if existing.LifecycleState == LifecycleActive &&
			existing.FromResourceID == req.FromResourceID &&
			existing.ToResourceID == req.ToResourceID &&
			existing.RelationshipType == req.RelationshipType {
			return nil, ErrDuplicateActiveEdge
		}
	}
	edge := &Edge{
		EdgeID:           audit.GenerateUUID(),
		SchemaVersion:    SchemaVersion,
		RelationshipType: req.RelationshipType,
		FromResourceID:   req.FromResourceID,
		ToResourceID:     req.ToResourceID,
		Description:      req.Description,
		Labels:           req.Labels,
		Attributes:       req.Attributes,
		LifecycleState:   LifecycleActive,
		Source:           SourceMetadata{Kind: "manual", System: "xcloud", Authority: "authoritative"},
		Revision:         1,
		CreatedAt:        CurrentTimestamp(),
		CreatedBy:        actor,
		UpdatedAt:        CurrentTimestamp(),
		UpdatedBy:        actor,
	}
	m.items[edge.EdgeID] = edge
	return edge, nil
}

func (m *mockRepo) GetByID(ctx context.Context, edgeID string) (*Edge, error) {
	edge, ok := m.items[edgeID]
	if !ok {
		return nil, ErrEdgeNotFound
	}
	return edge, nil
}

func (m *mockRepo) List(ctx context.Context, filter ListFilter) ([]Edge, *string, bool, error) {
	var list []Edge
	for _, item := range m.items {
		if filter.LifecycleState != "" && item.LifecycleState != filter.LifecycleState {
			continue
		}
		if filter.RelationshipType != "" && item.RelationshipType != filter.RelationshipType {
			continue
		}
		list = append(list, *item)
	}
	return list, nil, false, nil
}

func (m *mockRepo) Update(ctx context.Context, edgeID string, req *UpdateEdgeRequest, actor string) (*Edge, *Edge, error) {
	edge, ok := m.items[edgeID]
	if !ok {
		return nil, nil, ErrEdgeNotFound
	}
	if edge.LifecycleState == LifecycleRetired {
		return nil, nil, ErrEdgeRetired
	}
	if edge.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}
	before := *edge
	edge.Description = req.Edge.Description
	edge.Labels = req.Edge.Labels
	edge.Attributes = req.Edge.Attributes
	edge.Revision++
	edge.UpdatedAt = CurrentTimestamp()
	edge.UpdatedBy = actor
	return &before, edge, nil
}

func (m *mockRepo) Retire(ctx context.Context, edgeID string, req *RetireEdgeRequest, actor string) (*Edge, *Edge, error) {
	edge, ok := m.items[edgeID]
	if !ok {
		return nil, nil, ErrEdgeNotFound
	}
	if edge.LifecycleState == LifecycleRetired {
		return nil, nil, ErrEdgeRetired
	}
	if edge.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}
	before := *edge
	edge.LifecycleState = LifecycleRetired
	edge.Revision++
	edge.UpdatedAt = CurrentTimestamp()
	edge.UpdatedBy = actor
	return &before, edge, nil
}

func (m *mockRepo) Neighbors(ctx context.Context, filter NeighborFilter) (*NeighborsResponse, error) {
	if filter.RootResourceID == "" {
		return nil, ErrRootResourceNotFound
	}
	root := ResourceProjection{ResourceID: filter.RootResourceID, Kind: "network_function", Name: "root", Domain: "5gc", LifecycleState: "active"}
	var neighbors []Neighbor
	for _, item := range m.items {
		if item.FromResourceID != filter.RootResourceID {
			continue
		}
		neighbors = append(neighbors, Neighbor{
			Edge:             *item,
			Direction:        DirectionOutbound,
			NeighborResource: ResourceProjection{ResourceID: item.ToResourceID, LifecycleState: "active"},
		})
	}
	return &NeighborsResponse{RootResource: root, Neighbors: neighbors, Page: PageInfo{Limit: 50}}, nil
}

type dummyAuditWriter struct{}

func (d *dummyAuditWriter) WriteBestEffort(input audit.WriteAuditInput) {}

func makePrincipal(role string) *auth.Principal {
	return &auth.Principal{Username: "test-" + role, Role: role, NormalizedRole: role}
}

func withPrincipal(req *http.Request, role string) *http.Request {
	return req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal(role)))
}

const (
	fromID = "2f1a6a52-6c7f-4f8a-9f2b-0f7d4a1c8e33"
	toID   = "8c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f"
)

func TestMetaRequiresReadPermission(t *testing.T) {
	h := NewHandler(newMockRepo(), nil, &dummyAuditWriter{})

	w := httptest.NewRecorder()
	h.Meta(w, httptest.NewRequest("GET", "/api/topology/meta", nil))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous meta: expected 401, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	h.Meta(w, withPrincipal(httptest.NewRequest("GET", "/api/topology/meta", nil), "viewer"))
	if w.Code != http.StatusOK {
		t.Fatalf("viewer meta: expected 200, got %d", w.Code)
	}
	var body MetaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("meta body must be JSON: %v", err)
	}
	if body.SchemaVersion != 1 || len(body.RelationshipTypes) != 9 || len(body.LifecycleStates) != 2 {
		t.Errorf("meta payload must reflect schema v1, 9 types, 2 states; got %+v", body)
	}
}

func TestViewerCannotMutate(t *testing.T) {
	h := NewHandler(newMockRepo(), nil, &dummyAuditWriter{})

	body := bytes.NewBufferString(`{"relationshipType":"depends_on","fromResourceId":"` + fromID + `","toResourceId":"` + toID + `"}`)
	w := httptest.NewRecorder()
	h.Create(w, withPrincipal(httptest.NewRequest("POST", "/api/topology/edges", body), "viewer"))
	if w.Code != http.StatusForbidden {
		t.Errorf("viewer create: expected 403, got %d", w.Code)
	}
}

func TestOperatorCreateUpdateRetire(t *testing.T) {
	repo := newMockRepo()
	h := NewHandler(repo, nil, &dummyAuditWriter{})

	// Create
	body := bytes.NewBufferString(`{"relationshipType":"depends_on","fromResourceId":"` + fromID + `","toResourceId":"` + toID + `","description":"SMF depends on PCF"}`)
	w := httptest.NewRecorder()
	h.Create(w, withPrincipal(httptest.NewRequest("POST", "/api/topology/edges", body), "operator"))
	if w.Code != http.StatusCreated {
		t.Fatalf("operator create: expected 201, got %d (%s)", w.Code, w.Body.String())
	}
	var created Edge
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("create body must be JSON: %v", err)
	}
	if created.Revision != 1 || created.LifecycleState != LifecycleActive || created.Source.Kind != "manual" {
		t.Errorf("created edge must start at revision 1/active/manual: %+v", created)
	}

	// Duplicate active edge -> 409
	w = httptest.NewRecorder()
	h.Create(w, withPrincipal(httptest.NewRequest("POST", "/api/topology/edges", bytes.NewBufferString(`{"relationshipType":"depends_on","fromResourceId":"`+fromID+`","toResourceId":"`+toID+`"}`)), "operator"))
	if w.Code != http.StatusConflict {
		t.Errorf("duplicate active edge: expected 409, got %d", w.Code)
	}

	// Update
	w = httptest.NewRecorder()
	req := withPrincipal(httptest.NewRequest("PUT", "/api/topology/edges/x", bytes.NewBufferString(`{"expectedRevision":1,"edge":{"description":"updated"}}`)), "operator")
	req.SetPathValue("edgeId", created.EdgeID)
	h.Update(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("operator update: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var updated Edge
	json.Unmarshal(w.Body.Bytes(), &updated)
	if updated.Revision != 2 || updated.Description != "updated" {
		t.Errorf("update must increment revision and replace description: %+v", updated)
	}

	// Stale update -> 409
	w = httptest.NewRecorder()
	req = withPrincipal(httptest.NewRequest("PUT", "/api/topology/edges/x", bytes.NewBufferString(`{"expectedRevision":1,"edge":{"description":"stale"}}`)), "operator")
	req.SetPathValue("edgeId", created.EdgeID)
	h.Update(w, req)
	if w.Code != http.StatusConflict {
		t.Errorf("stale update: expected 409, got %d", w.Code)
	}

	// Retire
	w = httptest.NewRecorder()
	req = withPrincipal(httptest.NewRequest("POST", "/api/topology/edges/x/retire", bytes.NewBufferString(`{"expectedRevision":2,"reason":"no longer applicable"}`)), "operator")
	req.SetPathValue("edgeId", created.EdgeID)
	h.Retire(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("operator retire: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var retired Edge
	json.Unmarshal(w.Body.Bytes(), &retired)
	if retired.LifecycleState != LifecycleRetired || retired.Revision != 3 {
		t.Errorf("retire must set terminal state and increment revision: %+v", retired)
	}

	// Mutating a retired edge -> 409
	w = httptest.NewRecorder()
	req = withPrincipal(httptest.NewRequest("PUT", "/api/topology/edges/x", bytes.NewBufferString(`{"expectedRevision":3,"edge":{"description":"nope"}}`)), "operator")
	req.SetPathValue("edgeId", created.EdgeID)
	h.Update(w, req)
	if w.Code != http.StatusConflict {
		t.Errorf("mutating retired edge: expected 409, got %d", w.Code)
	}

	// Retired edges remain readable
	w = httptest.NewRecorder()
	req = withPrincipal(httptest.NewRequest("GET", "/api/topology/edges/x", nil), "operator")
	req.SetPathValue("edgeId", created.EdgeID)
	h.Get(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("retired edge read: expected 200, got %d", w.Code)
	}
}

func TestCreateValidationErrorCodes(t *testing.T) {
	h := NewHandler(newMockRepo(), nil, &dummyAuditWriter{})

	cases := []struct {
		name string
		body string
		code string
	}{
		{"invalid relationship", `{"relationshipType":"peer_of","fromResourceId":"` + fromID + `","toResourceId":"` + toID + `"}`, "INVALID_RELATIONSHIP_TYPE"},
		{"invalid identifier", `{"relationshipType":"depends_on","fromResourceId":"nope","toResourceId":"` + toID + `"}`, "INVALID_RESOURCE_ID"},
		{"self edge", `{"relationshipType":"depends_on","fromResourceId":"` + fromID + `","toResourceId":"` + fromID + `"}`, "TOPOLOGY_SELF_EDGE"},
		{"server owned", `{"relationshipType":"depends_on","fromResourceId":"` + fromID + `","toResourceId":"` + toID + `","lifecycleState":"retired"}`, "SERVER_OWNED_FIELD_FORBIDDEN"},
		{"unknown field", `{"relationshipType":"depends_on","fromResourceId":"` + fromID + `","toResourceId":"` + toID + `","bogus":1}`, "INVALID_JSON"},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		h.Create(w, withPrincipal(httptest.NewRequest("POST", "/api/topology/edges", bytes.NewBufferString(tc.body)), "operator"))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d", tc.name, w.Code)
			continue
		}
		var payload struct {
			Code string `json:"code"`
		}
		json.Unmarshal(w.Body.Bytes(), &payload)
		if payload.Code != tc.code {
			t.Errorf("%s: expected code %s, got %s", tc.name, tc.code, payload.Code)
		}
	}
}

func TestListRejectsUnknownQueryParameterAndBadLimit(t *testing.T) {
	h := NewHandler(newMockRepo(), nil, &dummyAuditWriter{})

	w := httptest.NewRecorder()
	h.List(w, withPrincipal(httptest.NewRequest("GET", "/api/topology/edges?bogus=1", nil), "viewer"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("unknown query parameter: expected 400, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	h.List(w, withPrincipal(httptest.NewRequest("GET", "/api/topology/edges?limit=500", nil), "viewer"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("out-of-range limit: expected 400, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	h.List(w, withPrincipal(httptest.NewRequest("GET", "/api/topology/edges", nil), "viewer"))
	if w.Code != http.StatusOK {
		t.Errorf("default list: expected 200, got %d", w.Code)
	}
}

func TestNeighborsRejectsMalformedResourceID(t *testing.T) {
	h := NewHandler(newMockRepo(), nil, &dummyAuditWriter{})

	w := httptest.NewRecorder()
	req := withPrincipal(httptest.NewRequest("GET", "/api/topology/resources/nope/neighbors", nil), "viewer")
	req.SetPathValue("resourceId", "nope")
	h.Neighbors(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("malformed resource id: expected 400, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	req = withPrincipal(httptest.NewRequest("GET", "/api/topology/resources/"+fromID+"/neighbors", nil), "viewer")
	req.SetPathValue("resourceId", fromID)
	h.Neighbors(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("valid neighbor query: expected 200, got %d", w.Code)
	}
}
