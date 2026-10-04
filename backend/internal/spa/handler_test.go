package spa

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func newTestAssets() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte("<!doctype html><html><head><title>xCloud</title></head><body><div id=\"root\"></div></body></html>"),
		},
		"assets/index-abc123.js": &fstest.MapFile{
			Data: []byte("console.log(\"app bundle\");"),
		},
		"assets/index-abc123.css": &fstest.MapFile{
			Data: []byte("body { margin: 0; }"),
		},
		"favicon.ico": &fstest.MapFile{
			Data: []byte("fake-ico-bytes"),
		},
		".gitignore": &fstest.MapFile{
			Data: []byte("*\n!.gitignore\n"),
		},
	}
}

func mockNextHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
			return
		}
		if r.URL.Path == "/readyz" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ready"))
			return
		}
		if r.URL.Path == "/api/__unknown_probe__" || r.URL.Path == "/api/not-found" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"Not found","code":"NOT_FOUND"}`))
			return
		}
		if r.URL.Path == "/api/auth/me" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Unauthorized","code":"UNAUTHORIZED"}`))
			return
		}
		http.NotFound(w, r)
	})
}

func TestSPAHandler_RootServesIndex(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("expected text/html; charset=utf-8, got %s", ct)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("expected no-cache, got %s", cc)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != string(assets["index.html"].Data) {
		t.Errorf("body mismatch: got %s", string(body))
	}
}

func TestSPAHandler_DeepRouteServesIndex(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	routes := []string{
		"/login",
		"/subscribers",
		"/system-health",
		"/users/admin",
		"/ocs/balances/417010000000001",
		"/ocs/contracts/417010000000001",
	}

	for _, route := range routes {
		t.Run(route, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			res := rec.Result()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("expected 200 for %s, got %d", route, res.StatusCode)
			}
			if ct := res.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
				t.Errorf("expected text/html; charset=utf-8, got %s", ct)
			}
			if cc := res.Header.Get("Cache-Control"); cc != "no-cache" {
				t.Errorf("expected no-cache, got %s", cc)
			}
			body, _ := io.ReadAll(res.Body)
			if string(body) != string(assets["index.html"].Data) {
				t.Errorf("body mismatch for %s", route)
			}
		})
	}
}

func TestSPAHandler_HashedAssetServesExactBytes(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	// Test JS
	{
		req := httptest.NewRequest(http.MethodGet, "/assets/index-abc123.js", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		res := rec.Result()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", res.StatusCode)
		}
		if ct := res.Header.Get("Content-Type"); ct != "application/javascript" {
			t.Errorf("expected application/javascript, got %s", ct)
		}
		if cc := res.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Errorf("expected immutable cache header, got %s", cc)
		}
		body, _ := io.ReadAll(res.Body)
		if string(body) != string(assets["assets/index-abc123.js"].Data) {
			t.Errorf("body mismatch: got %s", string(body))
		}
	}

	// Test CSS
	{
		req := httptest.NewRequest(http.MethodGet, "/assets/index-abc123.css", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		res := rec.Result()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", res.StatusCode)
		}
		if ct := res.Header.Get("Content-Type"); ct != "text/css; charset=utf-8" {
			t.Errorf("expected text/css; charset=utf-8, got %s", ct)
		}
		if cc := res.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Errorf("expected immutable cache header, got %s", cc)
		}
		body, _ := io.ReadAll(res.Body)
		if string(body) != string(assets["assets/index-abc123.css"].Data) {
			t.Errorf("body mismatch: got %s", string(body))
		}
	}
}

func TestSPAHandler_MissingAssetReturns404(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	missing := []string{
		"/assets/missing.js",
		"/assets/missing.css",
		"/missing.js",
		"/missing.css",
		"/favicon-missing.ico",
	}

	for _, p := range missing {
		t.Run(p, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, p, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			res := rec.Result()
			if res.StatusCode != http.StatusNotFound {
				t.Fatalf("expected 404 for missing asset %s, got %d", p, res.StatusCode)
			}
		})
	}
}

func TestSPAHandler_UnknownAPIDelegates(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	req := httptest.NewRequest(http.MethodGet, "/api/__unknown_probe__", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 from api delegate, got %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != `{"error":"Not found","code":"NOT_FOUND"}` {
		t.Errorf("expected JSON API 404, got %s", string(body))
	}
}

func TestSPAHandler_HealthEndpointsDelegate(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	// /healthz
	{
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		res := rec.Result()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 for healthz, got %d", res.StatusCode)
		}
		body, _ := io.ReadAll(res.Body)
		if string(body) != "ok" {
			t.Errorf("expected 'ok', got %s", string(body))
		}
	}

	// /readyz
	{
		req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		res := rec.Result()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 for readyz, got %d", res.StatusCode)
		}
		body, _ := io.ReadAll(res.Body)
		if string(body) != "ready" {
			t.Errorf("expected 'ready', got %s", string(body))
		}
	}
}

func TestSPAHandler_NonGETDoesNotSPAFallback(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	methods := []string{
		http.MethodPost,
		http.MethodPut,
		http.MethodDelete,
		http.MethodPatch,
	}

	for _, m := range methods {
		t.Run(m, func(t *testing.T) {
			req := httptest.NewRequest(m, "/", nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			res := rec.Result()
			// Mock handler returns 404 for unknown routes.
			if res.StatusCode != http.StatusNotFound {
				t.Fatalf("expected non-GET request to delegate to next (404), got %d", res.StatusCode)
			}
			body, _ := io.ReadAll(res.Body)
			if string(body) == string(assets["index.html"].Data) {
				t.Fatalf("non-GET request must never return SPA HTML")
			}
		})
	}
}

func TestSPAHandler_HEADWorks(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	req := httptest.NewRequest(http.MethodHead, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for HEAD, got %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("expected text/html, got %s", ct)
	}
	if cl := res.Header.Get("Content-Length"); cl == "" || cl == "0" {
		t.Errorf("expected positive Content-Length header on HEAD, got %s", cl)
	}
	body, _ := io.ReadAll(res.Body)
	if len(body) != 0 {
		t.Errorf("expected empty body for HEAD, got %d bytes", len(body))
	}
}

func TestSPAHandler_PathTraversalBlocked(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	traversals := []string{
		"/../etc/passwd",
		"/assets/../../secret",
		"/%2e%2e/passwd",
		"/assets/%2e%2e/index.html",
		"/..\\secret",
	}

	for _, p := range traversals {
		t.Run(p, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, p, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			res := rec.Result()
			if res.StatusCode != http.StatusBadRequest && res.StatusCode != http.StatusNotFound {
				t.Fatalf("expected traversal to be blocked with 400 or 404, got %d", res.StatusCode)
			}
			body, _ := io.ReadAll(res.Body)
			if string(body) == string(assets["index.html"].Data) {
				t.Fatalf("traversal must not fall back to index.html")
			}
		})
	}
}

func TestSPAHandler_DotfileBlocked(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	dotfiles := []string{
		"/.gitignore",
		"/assets/.env",
		"/.hidden",
	}

	for _, p := range dotfiles {
		t.Run(p, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, p, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			res := rec.Result()
			if res.StatusCode != http.StatusNotFound {
				t.Fatalf("expected 404 for dotfile %s, got %d", p, res.StatusCode)
			}
			body, _ := io.ReadAll(res.Body)
			if string(body) == string(assets["index.html"].Data) {
				t.Fatalf("dotfile must not fall back to index.html")
			}
		})
	}
}

func TestSPAHandler_CachePolicies(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	// Index cache policy
	{
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		res := rec.Result()
		if cc := res.Header.Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("expected no-cache for index.html, got %s", cc)
		}
	}

	// Fallback route cache policy
	{
		req := httptest.NewRequest(http.MethodGet, "/system-health", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		res := rec.Result()
		if cc := res.Header.Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("expected no-cache for fallback route, got %s", cc)
		}
	}

	// Hashed asset cache policy
	{
		req := httptest.NewRequest(http.MethodGet, "/assets/index-abc123.js", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		res := rec.Result()
		if cc := res.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Errorf("expected immutable cache policy for hashed asset, got %s", cc)
		}
	}
}
