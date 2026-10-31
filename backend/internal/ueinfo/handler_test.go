package ueinfo

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"subscriber/internal/auth"
)

func testHandler() *Handler {
	service := NewService(testSources(), nil, testFetcher(), &fakeSubscribers{
		msisdns: map[string]string{"460020000000001": "18800000001"},
		count:   12,
	})
	return NewHandler(service, nil)
}

func principalRequest(method, target, role string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	return req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		Username:       "test",
		Role:           role,
		NormalizedRole: role,
	}))
}

func TestGetSummaryMode(t *testing.T) {
	rec := httptest.NewRecorder()
	testHandler().Get(rec, principalRequest(http.MethodGet, "/api/ue-info?summary=1", "viewer"))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res Response
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !res.Configured || !res.Complete {
		t.Fatalf("expected a configured complete response: %+v", res)
	}
	if res.Summary.Total != 2 || res.Summary.EPC5GCOnlineUsers == nil || *res.Summary.EPC5GCOnlineUsers != 5 {
		t.Fatalf("unexpected summary: %+v", res.Summary)
	}
	if len(res.Items) != 0 {
		t.Fatalf("summary mode must not return items: %d", len(res.Items))
	}
	if res.Pagination.Total != 2 {
		t.Fatalf("summary pagination total must reflect the merged population: %+v", res.Pagination)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected no-store, got %q", got)
	}
}

func TestGetListFiltersAndPaginates(t *testing.T) {
	rec := httptest.NewRecorder()
	testHandler().Get(rec, principalRequest(http.MethodGet, "/api/ue-info?domain=EPS&limit=1", "viewer"))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res Response
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if res.Pagination.Total != 1 || len(res.Items) != 1 || res.Items[0].SUPI != "460020000000001" {
		t.Fatalf("unexpected filtered page: %+v", res)
	}
	if res.Items[0].MSISDN != "18800000001" {
		t.Fatalf("MSISDN enrichment missing: %+v", res.Items[0])
	}
}

func TestGetCursorPagination(t *testing.T) {
	first := httptest.NewRecorder()
	testHandler().Get(first, principalRequest(http.MethodGet, "/api/ue-info?limit=1", "viewer"))
	var page Response
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode first page: %v", err)
	}
	if len(page.Items) != 1 || !page.Pagination.HasMore || page.Pagination.NextCursor == nil {
		t.Fatalf("first page must expose exactly one item and a next cursor: %+v", page.Pagination)
	}

	second := httptest.NewRecorder()
	testHandler().Get(second, principalRequest(http.MethodGet, "/api/ue-info?limit=1&cursor="+*page.Pagination.NextCursor, "viewer"))
	var next Response
	if err := json.Unmarshal(second.Body.Bytes(), &next); err != nil {
		t.Fatalf("decode second page: %v", err)
	}
	if len(next.Items) != 1 || next.Items[0].SUPI == page.Items[0].SUPI {
		t.Fatalf("cursor must advance to the next item: %+v", next.Items)
	}
	if next.Pagination.HasMore || next.Pagination.NextCursor != nil {
		t.Fatalf("last page must not expose another cursor: %+v", next.Pagination)
	}
}

func TestGetRejectsInvalidQueries(t *testing.T) {
	cases := []string{
		"/api/ue-info?unknown=1",
		"/api/ue-info?summary=yes",
		"/api/ue-info?q=" + strings.Repeat("a", 65),
		"/api/ue-info?domain=2G",
		"/api/ue-info?state=active",
		"/api/ue-info?limit=0",
		"/api/ue-info?limit=201",
		"/api/ue-info?offset=-1",
		"/api/ue-info?cursor=@@@",
		"/api/ue-info?cursor=MQ&offset=0",
	}
	for _, target := range cases {
		rec := httptest.NewRecorder()
		testHandler().Get(rec, principalRequest(http.MethodGet, target, "viewer"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d: %s", target, rec.Code, rec.Body.String())
		}
	}
}

func TestGetRequiresAuthenticationAndPermission(t *testing.T) {
	rec := httptest.NewRecorder()
	testHandler().Get(rec, httptest.NewRequest(http.MethodGet, "/api/ue-info", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	testHandler().Get(rec, principalRequest(http.MethodGet, "/api/ue-info", "unknown"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}

func TestGetWithoutConfiguredSources(t *testing.T) {
	service := NewService(Sources{}, nil, testFetcher(), nil)
	rec := httptest.NewRecorder()
	NewHandler(service, nil).Get(rec, principalRequest(http.MethodGet, "/api/ue-info", "viewer"))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var res Response
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if res.Configured {
		t.Fatal("unconfigured sources must be explicit")
	}
	if res.Summary.EPC5GCOnlineUsers != nil {
		t.Fatal("unconfigured sources must not fabricate online users")
	}
}
