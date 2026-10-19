package nflogs

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"subscriber/internal/auth"
)

type stubLimiter struct{}

func (stubLimiter) Enforce(http.ResponseWriter, *http.Request, string, int, int) bool { return true }

func newLogHandler(t *testing.T, logLines []string) (*Handler, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "amfd.log")
	body := strings.Join(logLines, "\n")
	if len(logLines) > 0 {
		body += "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}
	registry, err := NewRegistry("", "amf="+path, "amf=resource-1")
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	return NewHandler(registry, stubLimiter{}, nil), path
}

func request(h *Handler, target, role string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if role != "" {
		principal := &auth.Principal{Username: role + "-user", Role: role, NormalizedRole: role}
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	}
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, req)
	return recorder
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/nf-logs/sources":
		h.ListSources(w, r)
	case "/api/nf-logs/stream":
		h.Stream(w, r)
	default:
		http.NotFound(w, r)
	}
}

func TestSourcesRequiresSession(t *testing.T) {
	handler, _ := newLogHandler(t, []string{"line"})
	if rec := request(handler, "/api/nf-logs/sources", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated must be 401, got %d", rec.Code)
	}
}

func TestSourcesListsCapabilities(t *testing.T) {
	handler, _ := newLogHandler(t, []string{"line"})
	rec := request(handler, "/api/nf-logs/sources", "viewer")
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer must read sources, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"sourceId":"amf"`) || !strings.Contains(body, `"resourceIds":["resource-1"]`) {
		t.Fatalf("source projection missing: %s", body)
	}
	if !strings.Contains(body, `"maxTailLines":500`) || !strings.Contains(body, `"keywordIsLiteral":true`) {
		t.Fatalf("capabilities missing: %s", body)
	}
}

func TestSourcesFiltersByResource(t *testing.T) {
	handler, _ := newLogHandler(t, []string{"line"})
	rec := request(handler, "/api/nf-logs/sources?resourceId=resource-1", "viewer")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"sourceId":"amf"`) {
		t.Fatalf("bound resource must match: %d %s", rec.Code, rec.Body.String())
	}
	rec = request(handler, "/api/nf-logs/sources?resourceId=resource-9", "viewer")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"sources":[]`) {
		t.Fatalf("unbound resource must not match: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSourcesRejectsUnsupportedQuery(t *testing.T) {
	handler, _ := newLogHandler(t, []string{"line"})
	if rec := request(handler, "/api/nf-logs/sources?path=/etc/passwd", "viewer"); rec.Code != http.StatusBadRequest {
		t.Fatalf("a path parameter must be rejected, got %d", rec.Code)
	}
}

func TestStreamReturnsSanitizedTail(t *testing.T) {
	handler, _ := newLogHandler(t, []string{
		"INFO started with imsi 460001234567890",
		"ERROR peer 10.20.30.40 refused",
	})
	rec := request(handler, "/api/nf-logs/stream?sourceId=amf&follow=false&tailLines=10", "viewer")
	if rec.Code != http.StatusOK {
		t.Fatalf("stream must open, got %d (%s)", rec.Code, rec.Body.String())
	}
	if contentType := rec.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") {
		t.Fatalf("unexpected content type: %s", contentType)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "event: meta") || strings.Count(body, "event: line") != 2 {
		t.Fatalf("expected meta plus two lines: %s", body)
	}
	if strings.Contains(body, "460001234567890") || strings.Contains(body, "10.20.30.40") {
		t.Fatalf("raw identifiers leaked: %s", body)
	}
	if !strings.Contains(body, "[imsi]") || !strings.Contains(body, "10.20.*.*") {
		t.Fatalf("masked identifiers missing: %s", body)
	}
}

func TestStreamAppliesLevelAndKeywordFilters(t *testing.T) {
	handler, _ := newLogHandler(t, []string{
		"INFO connecting",
		"ERROR connection refused",
		"ERROR timeout after 3s",
	})

	rec := request(handler, "/api/nf-logs/stream?sourceId=amf&follow=false&level=error", "viewer")
	body := rec.Body.String()
	if strings.Count(body, "event: line") != 2 {
		t.Fatalf("error filter must keep both errors: %s", body)
	}
	if strings.Contains(body, "INFO connecting") {
		t.Fatalf("info must be filtered out: %s", body)
	}

	rec = request(handler, "/api/nf-logs/stream?sourceId=amf&follow=false&keyword=timeout", "viewer")
	body = rec.Body.String()
	if strings.Count(body, "event: line") != 1 || !strings.Contains(body, "timeout after 3s") {
		t.Fatalf("keyword filter must keep one line: %s", body)
	}
}

func TestStreamValidation(t *testing.T) {
	handler, _ := newLogHandler(t, []string{"line"})
	cases := map[string]string{
		"/api/nf-logs/stream":                               "INVALID_SOURCE_ID",
		"/api/nf-logs/stream?sourceId=amf&tailLines=999":    "INVALID_TAIL_LINES",
		"/api/nf-logs/stream?sourceId=amf&tailLines=-1":     "INVALID_TAIL_LINES",
		"/api/nf-logs/stream?sourceId=amf&level=verbose":    "INVALID_LEVEL",
		"/api/nf-logs/stream?sourceId=amf&follow=sometimes": "INVALID_FOLLOW",
		"/api/nf-logs/stream?sourceId=amf&path=/etc/passwd": "UNSUPPORTED_QUERY_PARAMETER",
		"/api/nf-logs/stream?sourceId=../etc/passwd":        "INVALID_SOURCE_ID",
	}
	for target, code := range cases {
		rec := request(handler, target, "viewer")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d", target, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), code) {
			t.Fatalf("%s: expected %s, got %s", target, code, rec.Body.String())
		}
	}

	longKeyword := strings.Repeat("k", MaxKeywordBytes+1)
	rec := request(handler, "/api/nf-logs/stream?sourceId=amf&keyword="+longKeyword, "viewer")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "INVALID_KEYWORD") {
		t.Fatalf("oversized keyword must be rejected: %d %s", rec.Code, rec.Body.String())
	}
}

func TestStreamUnknownSource(t *testing.T) {
	handler, _ := newLogHandler(t, []string{"line"})
	rec := request(handler, "/api/nf-logs/stream?sourceId=unknown&follow=false", "viewer")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "NF_LOG_SOURCE_NOT_FOUND") {
		t.Fatalf("unknown source must be 404: %d %s", rec.Code, rec.Body.String())
	}
}

func TestStreamSlotsBoundConcurrency(t *testing.T) {
	slots := &streamSlots{perUser: map[string]int{}}
	if !slots.acquire("operator1") || !slots.acquire("operator1") {
		t.Fatal("two streams are allowed per session")
	}
	if slots.acquire("operator1") {
		t.Fatal("a third stream must be refused")
	}
	slots.release("operator1")
	if !slots.acquire("operator1") {
		t.Fatal("releasing a slot must free it")
	}
	slots.release("operator1")
	slots.release("operator1")
	if slots.total != 0 {
		t.Fatalf("all slots must be released, got %d", slots.total)
	}
}
