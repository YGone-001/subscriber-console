package spa

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
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

func TestSPAHandler_DottedUsernameRoutes(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	dottedRoutes := []string{
		"/users/john.doe",
		"/users/user.js",
		"/users/.alice",
		"/users/john..doe",
		"/users/a_b-c.d",
	}

	for _, route := range dottedRoutes {
		t.Run(route, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			res := rec.Result()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("expected 200 for dotted route %s, got %d", route, res.StatusCode)
			}
			if ct := res.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
				t.Errorf("expected text/html; charset=utf-8, got %s", ct)
			}
			if cc := res.Header.Get("Cache-Control"); cc != "no-cache" {
				t.Errorf("expected no-cache, got %s", cc)
			}
			body, _ := io.ReadAll(res.Body)
			if string(body) != string(assets["index.html"].Data) {
				t.Errorf("expected index.html body for dotted route %s", route)
			}
		})
	}
}

func TestSPAHandler_StaticVsBrowserCollision(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	// Pair 1: /users/user.js (application route with static extension) vs /missing.js (root static file)
	{
		reqApp := httptest.NewRequest(http.MethodGet, "/users/user.js", nil)
		recApp := httptest.NewRecorder()
		handler.ServeHTTP(recApp, reqApp)
		resApp := recApp.Result()
		if resApp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 for /users/user.js, got %d", resApp.StatusCode)
		}
		bodyApp, _ := io.ReadAll(resApp.Body)
		if string(bodyApp) != string(assets["index.html"].Data) {
			t.Errorf("expected index.html body for /users/user.js")
		}

		reqStatic := httptest.NewRequest(http.MethodGet, "/missing.js", nil)
		recStatic := httptest.NewRecorder()
		handler.ServeHTTP(recStatic, reqStatic)
		resStatic := recStatic.Result()
		if resStatic.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404 for /missing.js, got %d", resStatic.StatusCode)
		}
	}

	// Pair 2: /users/.alice (dot-prefixed username route) vs /.gitignore (dotfile)
	{
		reqApp := httptest.NewRequest(http.MethodGet, "/users/.alice", nil)
		recApp := httptest.NewRecorder()
		handler.ServeHTTP(recApp, reqApp)
		resApp := recApp.Result()
		if resApp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 for /users/.alice, got %d", resApp.StatusCode)
		}
		bodyApp, _ := io.ReadAll(resApp.Body)
		if string(bodyApp) != string(assets["index.html"].Data) {
			t.Errorf("expected index.html body for /users/.alice")
		}

		reqDot := httptest.NewRequest(http.MethodGet, "/.gitignore", nil)
		recDot := httptest.NewRecorder()
		handler.ServeHTTP(recDot, reqDot)
		resDot := recDot.Result()
		if resDot.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404 for /.gitignore, got %d", resDot.StatusCode)
		}
	}

	// Pair 3: /users/john..doe (double-dot in username) vs /../etc/passwd (traversal)
	{
		reqApp := httptest.NewRequest(http.MethodGet, "/users/john..doe", nil)
		recApp := httptest.NewRecorder()
		handler.ServeHTTP(recApp, reqApp)
		resApp := recApp.Result()
		if resApp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 for /users/john..doe, got %d", resApp.StatusCode)
		}
		bodyApp, _ := io.ReadAll(resApp.Body)
		if string(bodyApp) != string(assets["index.html"].Data) {
			t.Errorf("expected index.html body for /users/john..doe")
		}

		reqTrav := httptest.NewRequest(http.MethodGet, "/../etc/passwd", nil)
		recTrav := httptest.NewRecorder()
		handler.ServeHTTP(recTrav, reqTrav)
		resTrav := recTrav.Result()
		if resTrav.StatusCode != http.StatusBadRequest && resTrav.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 400 or 404 for /../etc/passwd, got %d", resTrav.StatusCode)
		}
	}
}

func TestSPAHandler_HEADOnDottedRoute(t *testing.T) {
	assets := newTestAssets()
	handler := NewHandler(mockNextHandler(), assets)

	req := httptest.NewRequest(http.MethodHead, "/users/john.doe", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for HEAD /users/john.doe, got %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("expected text/html, got %s", ct)
	}
	expectedLen := len(assets["index.html"].Data)
	if cl := res.Header.Get("Content-Length"); cl == "" || cl == "0" {
		t.Errorf("expected positive Content-Length header on HEAD, got %s", cl)
	} else {
		expectedStr := strconv.Itoa(expectedLen)
		if cl != expectedStr {
			t.Errorf("expected Content-Length %s, got %s", expectedStr, cl)
		}
	}
	body, _ := io.ReadAll(res.Body)
	if len(body) != 0 {
		t.Errorf("expected empty body for HEAD, got %d bytes", len(body))
	}
}
