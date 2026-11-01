package inventory

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
)

func seedResource(repo *mockRepo, id, name string) {
	repo.items[id] = &Resource{
		ResourceID:     id,
		SchemaVersion:  SchemaVersion,
		Kind:           KindNetworkFunction,
		Name:           name,
		Domain:         Domain5GC,
		LifecycleState: LifecycleActive,
		Revision:       1,
		CreatedAt:      CurrentTimestamp(),
		UpdatedAt:      CurrentTimestamp(),
	}
}

func resourceIDsRequest(target string, role string) *http.Request {
	req := httptest.NewRequest("GET", target, nil)
	if role == "" {
		return req
	}
	return req.WithContext(auth.ContextWithPrincipal(req.Context(), makePrincipal(role)))
}

func writeErrorCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error body: %v (%s)", err, recorder.Body.String())
	}
	code, _ := payload["code"].(string)
	return code
}

func TestListResolvesRequestedResourcesInOneAnswer(t *testing.T) {
	repo := newMockRepo()
	first, second, third := audit.GenerateUUID(), audit.GenerateUUID(), audit.GenerateUUID()
	seedResource(repo, first, "smf-01")
	seedResource(repo, second, "upf-01")
	seedResource(repo, third, "amf-01")
	h := NewHandler(repo, nil, &dummyAuditWriter{})

	target := "/api/inventory/resources?resourceIds=" + second + "," + first + "," + second
	w := httptest.NewRecorder()
	h.List(w, resourceIDsRequest(target, "viewer"))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var payload ListResourcesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Resources) != 2 {
		t.Fatalf("duplicates must collapse and unknown identifiers stay absent, got %+v", payload.Resources)
	}
	if payload.Resources[0].ResourceID != second || payload.Resources[1].ResourceID != first {
		t.Fatalf("the requested order must be preserved, got %+v", payload.Resources)
	}
	if payload.Page.Limit != 2 || payload.Page.HasMore || payload.Page.NextCursor != nil {
		t.Fatalf("a resolved set is one bounded answer, got %+v", payload.Page)
	}
}

func TestListRejectsNarrowingParametersWithResourceIDs(t *testing.T) {
	repo := newMockRepo()
	id := audit.GenerateUUID()
	seedResource(repo, id, "smf-01")
	h := NewHandler(repo, nil, &dummyAuditWriter{})

	cases := []string{
		"/api/inventory/resources?resourceIds=" + id + "&limit=10",
		"/api/inventory/resources?resourceIds=" + id + "&q=smf",
		"/api/inventory/resources?resourceIds=" + id + "&cursor=abc",
		"/api/inventory/resources?resourceIds=" + id + "&kind=network_function",
		"/api/inventory/resources?resourceIds=" + id + "&domain=5gc",
		"/api/inventory/resources?resourceIds=" + id + "&lifecycleState=active",
	}
	for _, target := range cases {
		w := httptest.NewRecorder()
		h.List(w, resourceIDsRequest(target, "viewer"))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", target, w.Code)
		}
		if code := writeErrorCode(t, w); code != "UNSUPPORTED_QUERY_COMBINATION" {
			t.Fatalf("%s: expected UNSUPPORTED_QUERY_COMBINATION, got %q", target, code)
		}
	}
}

func TestListRejectsMalformedResourceIDs(t *testing.T) {
	repo := newMockRepo()
	seedResource(repo, audit.GenerateUUID(), "smf-01")
	h := NewHandler(repo, nil, &dummyAuditWriter{})

	cases := []struct {
		target string
		code   string
	}{
		{"/api/inventory/resources?resourceIds=", "INVALID_RESOURCE_ID"},
		{"/api/inventory/resources?resourceIds=not-a-uuid", "INVALID_RESOURCE_ID"},
		{"/api/inventory/resources?resourceIds=" + audit.GenerateUUID() + ",", "INVALID_RESOURCE_ID"},
		{
			"/api/inventory/resources?resourceIds=" + strings.Repeat(audit.GenerateUUID()+",", 50) + audit.GenerateUUID(),
			"RESOURCE_ID_FILTER_TOO_LARGE",
		},
	}
	for _, testCase := range cases {
		w := httptest.NewRecorder()
		h.List(w, resourceIDsRequest(testCase.target, "viewer"))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", testCase.target, w.Code)
		}
		if code := writeErrorCode(t, w); code != testCase.code {
			t.Fatalf("%s: expected %s, got %q", testCase.target, testCase.code, code)
		}
	}
}

func TestListResourceIDsHonoursTheReadGate(t *testing.T) {
	repo := newMockRepo()
	id := audit.GenerateUUID()
	seedResource(repo, id, "smf-01")
	h := NewHandler(repo, nil, &dummyAuditWriter{})

	w := httptest.NewRecorder()
	h.List(w, resourceIDsRequest("/api/inventory/resources?resourceIds="+id, ""))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous read must stay 401, got %d", w.Code)
	}

	w = httptest.NewRecorder()
	h.List(w, resourceIDsRequest("/api/inventory/resources?resourceIds="+id, "viewer"))
	if w.Code != http.StatusOK {
		t.Fatalf("a read-only role with core.read must resolve the set, got %d", w.Code)
	}
}

func TestFindByIDsKeepsRequestOrderAndNeverInventsEntries(t *testing.T) {
	repo := newMockRepo()
	first, second := audit.GenerateUUID(), audit.GenerateUUID()
	seedResource(repo, first, "smf-01")
	seedResource(repo, second, "upf-01")
	missing := audit.GenerateUUID()

	items, err := repo.FindByIDs(context.Background(), []string{second, missing, first})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(items) != 2 || items[0].ResourceID != second || items[1].ResourceID != first {
		t.Fatalf("expected the requested order without the missing entry, got %+v", items)
	}
}
