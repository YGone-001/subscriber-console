//go:build linux

package investigation

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/nfalert"
	"subscriber/internal/user"
)

type browserActors struct{ disabled atomic.Bool }

func (a *browserActors) FindByUsernameIdentity(_ context.Context, name string) (*user.UserIdentity, error) {
	role := strings.TrimPrefix(name, "demo-")
	status := "active"
	if a.disabled.Load() {
		status = "disabled"
	}
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: name, Role: role, Status: status}}, nil
}

type browserEvidence struct {
	EvidenceRepository
	mode string
}

func (e browserEvidence) Configurations(ctx context.Context, ids []string, a, b time.Time) ([]ConfigFact, bool, error) {
	v, m, err := e.EvidenceRepository.Configurations(ctx, ids, a, b)
	if e.mode == "partial" {
		m = true
	}
	return v, m, err
}
func (e browserEvidence) Runs(ctx context.Context, ids []string, a, b time.Time) ([]RunFact, bool, error) {
	if e.mode == "unavailable" {
		return nil, false, errors.New("fixture read failed")
	}
	return e.EvidenceRepository.Runs(ctx, ids, a, b)
}
func (e browserEvidence) Anchor(ctx context.Context, id string) (*AlertFact, error) {
	v, err := e.EvidenceRepository.Anchor(ctx, id)
	if err == nil && e.mode == "unbound" {
		v.ResourceID = ""
	}
	return v, err
}

// This opt-in harness owns its database, listener and synthetic principals.
// It proves browser integration, not production authentication or fault causation.
func TestInvestigationBrowserPreview(t *testing.T) {
	if os.Getenv("INVESTIGATION_BROWSER_PREVIEW") != "1" {
		t.Skip("explicit browser preview flag required")
	}
	db := ownedMongo(t)
	at := time.Now().UTC().Add(-15 * time.Minute).Truncate(time.Millisecond)
	seedEvidence(t, db, at)
	repo := NewRepository(db)
	actors := &browserActors{}
	services := map[string]*Service{}
	for _, mode := range []string{"normal", "partial", "unavailable", "unbound"} {
		services[mode] = NewService(browserEvidence{repo, mode}, repo, actors, nil, []byte(strings.Repeat("fixture-cursor-key", 3)))
	}
	operator := &auth.Principal{Username: "demo-operator", Role: "operator", NormalizedRole: "operator"}
	for n := 1000; n < 1027; n++ {
		_, err := services["normal"].Create(context.Background(), operator, CreateRequest{testID(n), testID(10), "DEMO investigation " + testID(n)[:8], at.Add(-30 * time.Minute).Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)})
		if err != nil {
			t.Fatal(err)
		}
	}
	principal := func(r *http.Request) *auth.Principal {
		role := "operator"
		if c, e := r.Cookie("fixture_role"); e == nil && (c.Value == "admin" || c.Value == "viewer") {
			role = c.Value
		}
		return &auth.Principal{Username: "demo-" + role, Role: role, NormalizedRole: role}
	}
	withActor := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			handler(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), principal(r))))
		}
	}
	mux := http.NewServeMux()
	for _, route := range []string{"GET /api/investigations", "GET /api/investigations/context", "POST /api/investigations", "GET /api/investigations/{investigationId}", "PATCH /api/investigations/{investigationId}"} {
		mux.HandleFunc(route, withActor(func(w http.ResponseWriter, r *http.Request) {
			mode := "normal"
			if c, e := r.Cookie("fixture_mode"); e == nil && services[c.Value] != nil {
				mode = c.Value
			}
			NewHandler(services[mode], nil).Handle(w, r)
		}))
	}
	jsonReply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		jsonReply(w, map[string]any{"username": p.Username, "role": p.Role, "normalizedRole": p.Role, "status": "active", "permissions": auth.PermissionsFor(p)})
	})
	mux.HandleFunc("GET /api/auth/permissions", func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		jsonReply(w, map[string]any{"username": p.Username, "role": p.Role, "permissions": auth.PermissionsFor(p), "capabilities": auth.CapabilitiesFor(p.Role)})
	})
	mux.HandleFunc("GET /api/operations/summary", func(w http.ResponseWriter, r *http.Request) {
		jsonReply(w, map[string]any{"generatedAt": time.Now().UTC(), "sections": []string{"alerts"}, "alerts": map[string]any{"completeness": "complete", "scope": "full_collection", "alerts": map[string]any{"totalRules": 0, "enabledRules": 0, "alertsByState": map[string]int{"active": 1}, "openBySeverity": map[string]int{"warning": 1}}}})
	})
	mux.HandleFunc("GET /api/notifications/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("GET /api/knowledge/entries", func(w http.ResponseWriter, r *http.Request) {
		v, err := repo.Knowledge(r.Context(), []string{testID(70)})
		if err != nil {
			w.WriteHeader(503)
			return
		}
		out := []KnowledgeFact{}
		for _, k := range v {
			if strings.Contains(strings.ToLower(k.Title), strings.ToLower(r.URL.Query().Get("q"))) {
				out = append(out, k)
			}
		}
		jsonReply(w, map[string]any{"entries": out, "total": len(out), "page": map[string]any{"hasMore": false}})
	})
	nf := nfalert.NewHandler(nfalert.NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts")), nil, nil)
	mux.HandleFunc("GET /api/nf-alerts", withActor(nf.ListAlerts))
	mux.HandleFunc("GET /api/nf-alerts/meta", withActor(nf.Meta))
	mux.HandleFunc("GET /api/nf-alerts/rules", withActor(nf.ListRules))
	mux.HandleFunc("GET /__fixture/{mode}/{role}", func(w http.ResponseWriter, r *http.Request) {
		mode, role := r.PathValue("mode"), r.PathValue("role")
		if services[mode] == nil || (role != "admin" && role != "operator" && role != "viewer") {
			http.NotFound(w, r)
			return
		}
		for name, value := range map[string]string{"fixture_role": role, "fixture_mode": mode} {
			http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", SameSite: http.SameSiteLaxMode})
		}
		http.Redirect(w, r, "/investigations?view=context&alertId="+testID(10), 303)
	})
	mux.HandleFunc("POST /__fixture_actor/{state}", func(w http.ResponseWriter, r *http.Request) {
		actors.disabled.Store(r.PathValue("state") == "disabled")
		w.WriteHeader(204)
	})
	stop := make(chan struct{}, 1)
	mux.HandleFunc("POST /__fixture_stop", func(w http.ResponseWriter, r *http.Request) {
		select {
		case stop <- struct{}{}:
		default:
		}
		w.WriteHeader(204)
	})
	dist := os.Getenv("INVESTIGATION_BROWSER_DIST")
	if _, err := os.Stat(filepath.Join(dist, "index.html")); err != nil {
		t.Fatal(err)
	}
	files := http.FileServer(http.Dir(dist))
	mux.Handle("GET /assets/", files)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		asset := filepath.Join(dist, strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/"))
		if info, err := os.Stat(asset); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	go server.Serve(l)
	if err = os.WriteFile(os.Getenv("INVESTIGATION_BROWSER_ADDRESS_FILE"), []byte(l.Addr().String()), 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("DEMO ready: owned Mongo, loopback HTTP, synthetic principals and production bundle")
	select {
	case <-stop:
	case <-time.After(45 * time.Minute):
		t.Fatal("owned preview timed out")
	}
}
