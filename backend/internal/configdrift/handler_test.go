package configdrift

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"subscriber/internal/auth"
	"testing"
)

func TestHTTPBoundaryBeforeStorage(t *testing.T) {
	h := NewHandler(NewService(nil, nil, nil, nil), nil)
	mux := http.NewServeMux()
	for _, p := range []string{"GET /api/config-drift/meta", "PUT /api/config-drift/sources/{sourceId}/policy", "POST /api/config-drift/alerts/{driftAlertId}/acknowledge"} {
		mux.HandleFunc(p, h.Handle)
	}
	for _, c := range []struct {
		method, path, role, body string
		status                   int
	}{
		{"GET", "/api/config-drift/meta", "", "", 401},
		{"GET", "/api/config-drift/meta", "viewer", "", 200},
		{"GET", "/api/config-drift/meta?path=/etc/passwd", "viewer", "", 400},
		{"PUT", "/api/config-drift/sources/x/policy", "viewer", "{}", 403},
		{"POST", "/api/config-drift/alerts/x/acknowledge", "viewer", "{}", 403},
		{"PUT", "/api/config-drift/sources/x/policy", "operator", `{"path":"/etc/passwd"}`, 400},
		{"PUT", "/api/config-drift/sources/x/policy", "operator", `{"enabled":true,"severity":"warning"}`, 400},
		{"PUT", "/api/config-drift/sources/x/policy", "operator", strings.Repeat("x", 17<<10), 400},
		{"POST", "/api/config-drift/alerts/x/acknowledge", "operator", `{} {}`, 400},
	} {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		if c.role != "" {
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{Username: c.role, Role: c.role, NormalizedRole: c.role}))
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != c.status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s %s: %d %s", c.method, c.path, c.role, w.Code, w.Body.String())
		}
	}
}
