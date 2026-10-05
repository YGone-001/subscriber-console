package inventory

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
	items map[string]*Resource
}

func newMockRepo() *mockRepo {
	return &mockRepo{items: make(map[string]*Resource)}
}

func (m *mockRepo) Create(ctx context.Context, req *CreateResourceRequest, actor string) (*Resource, error) {
	caps, _ := NormalizeCapabilities(req.Capabilities)
	res := &Resource{
		ResourceID:          audit.GenerateUUID(),
		SchemaVersion:       SchemaVersion,
		Kind:                req.Kind,
		Name:                req.Name,
		Domain:              req.Domain,
		LifecycleState:      LifecycleActive,
		Capabilities:        caps,
		Source:              SourceMetadata{Kind: "manual", System: "xcloud", Authority: "authoritative"},
		Revision:            1,
		CreatedAt:           CurrentTimestamp(),
		CreatedBy:           actor,
		UpdatedAt:           CurrentTimestamp(),
		UpdatedBy:           actor,
		ManagementEndpoints: req.ManagementEndpoints,
		Labels:              req.Labels,
		Attributes:          req.Attributes,
	}
	m.items[res.ResourceID] = res
	return res, nil
}

func (m *mockRepo) GetByID(ctx context.Context, id string) (*Resource, error) {
	res, ok := m.items[id]
	if !ok {
		return nil, ErrNotFound
	}
	return res, nil
}

func (m *mockRepo) List(ctx context.Context, filter ListFilter) ([]Resource, *string, bool, error) {
	var list []Resource
	for _, item := range m.items {
		list = append(list, *item)
	}
	return list, nil, false, nil
}

func (m *mockRepo) Update(ctx context.Context, id string, req *UpdateResourceRequest, actor string) (*Resource, *Resource, error) {
	res, ok := m.items[id]
	if !ok {
		return nil, nil, ErrNotFound
	}
	if res.LifecycleState == LifecycleRetired {
		return nil, nil, ErrRetiredConflict
	}
	if res.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}
	if res.Kind != req.Resource.Kind {
		return nil, nil, ErrKindImmutable
	}
	before := *res
	res.Name = req.Resource.Name
	res.Domain = req.Resource.Domain
	res.Revision++
	res.UpdatedAt = CurrentTimestamp()
	res.UpdatedBy = actor
	return &before, res, nil
}

func (m *mockRepo) Retire(ctx context.Context, id string, req *RetireResourceRequest, actor string) (*Resource, *Resource, error) {
	res, ok := m.items[id]
	if !ok {
		return nil, nil, ErrNotFound
	}
	if res.LifecycleState == LifecycleRetired {
		return nil, nil, ErrRetiredConflict
	}
	if res.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}
	before := *res
	res.LifecycleState = LifecycleRetired
	res.Revision++
	res.UpdatedAt = CurrentTimestamp()
	res.UpdatedBy = actor
	return &before, res, nil
}

type dummyAuditWriter struct{}

func (d *dummyAuditWriter) WriteBestEffort(input audit.WriteAuditInput) {}

func makePrincipal(role string) *auth.Principal {
	normalized := role
	if role == "root" {
		normalized = "admin"
	}
	return &auth.Principal{
		Username:       "test-" + role,
		Role:           role,
		NormalizedRole: normalized,
	}
}

func TestHandlerAuthAndPermissions(t *testing.T) {
	repo := newMockRepo()
	h := NewHandler(repo, nil, &dummyAuditWriter{})

	// Pre-populate one resource
	res, _ := repo.Create(context.Background(), &CreateResourceRequest{
		Kind:   KindHost,
		Name:   "host-01",
		Domain: DomainPlatform,
	}, "admin")

	// 1. Anonymous read -> 401
	req := httptest.NewRequest("GET", "/api/inventory/resources", nil)
	w := httptest.NewRecorder()
	h.List(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous read: expected 401, got %d", w.Code)
	}

	// 2. Anonymous write -> 401
	body := bytes.NewBufferString(`{"kind":"host","name":"host-02","domain":"platform"}`)
	req = httptest.NewRequest("POST", "/api/inventory/resources", body)
	w = httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous write: expected 401, got %d", w.Code)
	}

	// 3. Viewer read -> 200
	req = httptest.NewRequest("GET", "/api/inventory/resources", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("viewer")))
	w = httptest.NewRecorder()
	h.List(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("viewer read: expected 200, got %d", w.Code)
	}

	// 4. Viewer write -> 403
	body = bytes.NewBufferString(`{"kind":"host","name":"host-02","domain":"platform"}`)
	req = httptest.NewRequest("POST", "/api/inventory/resources", body)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("viewer")))
	w = httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("viewer write: expected 403, got %d", w.Code)
	}

	// 5. Operator read -> 200
	req = httptest.NewRequest("GET", "/api/inventory/meta", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("operator")))
	w = httptest.NewRecorder()
	h.Meta(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("operator meta read: expected 200, got %d", w.Code)
	}

	// 6. Operator write -> 201
	body = bytes.NewBufferString(`{"kind":"host","name":"host-02","domain":"platform"}`)
	req = httptest.NewRequest("POST", "/api/inventory/resources", body)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("operator")))
	w = httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusCreated {
		t.Errorf("operator write: expected 201, got %d, body: %s", w.Code, w.Body.String())
	}

	// 7. Admin read -> 200
	req = httptest.NewRequest("GET", "/api/inventory/resources/"+res.ResourceID, nil)
	req.SetPathValue("resourceId", res.ResourceID)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("admin")))
	w = httptest.NewRecorder()
	h.Get(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("admin get: expected 200, got %d", w.Code)
	}

	// 8. Invalid UUID -> 400
	req = httptest.NewRequest("GET", "/api/inventory/resources/not-a-uuid", nil)
	req.SetPathValue("resourceId", "not-a-uuid")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("admin")))
	w = httptest.NewRecorder()
	h.Get(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("invalid UUID: expected 400, got %d", w.Code)
	}

	// 9. Unknown UUID -> 404
	randomUUID := "00000000-0000-4000-8000-000000000000"
	req = httptest.NewRequest("GET", "/api/inventory/resources/"+randomUUID, nil)
	req.SetPathValue("resourceId", randomUUID)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("admin")))
	w = httptest.NewRecorder()
	h.Get(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("unknown UUID: expected 404, got %d", w.Code)
	}

	// 10. Concurrency revision conflict -> 409
	updatePayload := map[string]any{
		"expectedRevision": 999,
		"resource": map[string]any{
			"kind":           res.Kind,
			"name":           res.Name,
			"domain":         res.Domain,
			"lifecycleState": "active",
		},
	}
	upBytes, _ := json.Marshal(updatePayload)
	req = httptest.NewRequest("PUT", "/api/inventory/resources/"+res.ResourceID, bytes.NewReader(upBytes))
	req.SetPathValue("resourceId", res.ResourceID)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("operator")))
	w = httptest.NewRecorder()
	h.Update(w, req)
	if w.Code != http.StatusConflict {
		t.Errorf("stale revision update: expected 409, got %d", w.Code)
	}

	// 11. Server-owned field spoofing -> 400
	spoofBody := bytes.NewBufferString(`{"kind":"host","name":"host-03","domain":"platform","revision":10}`)
	req = httptest.NewRequest("POST", "/api/inventory/resources", spoofBody)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal("admin")))
	w = httptest.NewRecorder()
	h.Create(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("server-owned field spoofing: expected 400, got %d", w.Code)
	}
}
