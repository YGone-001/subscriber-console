//go:build linux

package imsreg

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/operationsview"
)

type previewGroups struct{ partial bool }

func (g previewGroups) ResolveGroupScope(_ context.Context, f operationsview.GroupFilter) (operationsview.GroupScope, error) {
	ids := []string{resourceA, resourceB}
	if f.NetworkKey == "network-a" || f.PLMN == "00101" || f.SiteResourceID == resourceA {
		ids = []string{resourceA}
	} else if f.NetworkKey == "network-b" {
		ids = []string{resourceB}
	} else if f.NetworkKey != "" {
		ids = []string{}
	}
	out := testGroups(ids...).scope
	b, _ := json.Marshal(f)
	sum := sha256.Sum256(b)
	out.Fingerprint = hex.EncodeToString(sum[:])
	out.Filter = f
	if g.partial {
		out.Topology.Completeness = "partial"
		out.Topology.Reason = "edge_limit"
	}
	return out, nil
}

// This opt-in harness uses its own MySQL, HTTP listener and fixture principals.
// It does not prove production authentication or live IMS registration behavior.
func TestIMSBrowserPreview(t *testing.T) {
	if os.Getenv("IMS_BROWSER_PREVIEW") != "1" {
		t.Skip("explicit browser preview flag required")
	}
	admin, address := ownedMySQL(t)
	for _, query := range []string{"DELETE FROM ims_scscf.impu_contact WHERE impu_id=5", "DELETE FROM ims_scscf.impu WHERE id=5", "CREATE DATABASE ims_scscf_b", "CREATE TABLE ims_scscf_b.impu LIKE ims_scscf.impu", "CREATE TABLE ims_scscf_b.contact LIKE ims_scscf.contact", "CREATE TABLE ims_scscf_b.impu_contact LIKE ims_scscf.impu_contact", "GRANT SELECT ON ims_scscf_b.* TO 'observer'@'127.0.0.1'"} {
		if _, e := admin.Exec(query); e != nil {
			t.Fatal(e)
		}
	}
	for id := 6; id < 66; id++ {
		if _, e := admin.Exec("INSERT INTO ims_scscf.impu VALUES (?,?,1)", id, fmt.Sprintf("sip:demo-%03d@ims.test", id)); e != nil {
			t.Fatal(e)
		}
		if _, e := admin.Exec("INSERT INTO ims_scscf.contact VALUES (?,?,NOW()+INTERVAL 1 HOUR)", id, fmt.Sprintf("sip:demo-%03d@127.0.0.1", id)); e != nil {
			t.Fatal(e)
		}
		if _, e := admin.Exec("INSERT INTO ims_scscf.impu_contact VALUES (?,?)", id, id); e != nil {
			t.Fatal(e)
		}
	}
	a := fixtureSource(address)
	a.Name = "DEMO / S-CSCF A"
	b := testSource("b", resourceB)
	b.Name = "DEMO / S-CSCF B"
	b.SCSCF = a.SCSCF
	b.SCSCF.Database = "ims_scscf_b"
	r := NewMySQLReader(func(string) string { return "isolated-fixture-only" })
	defer r.Close()
	catalog := Catalog{Version: 1, Sources: []Source{a, b}}
	services := map[string]*Service{"normal": NewService(catalog, nil, r, previewGroups{}), "partial": NewService(catalog, nil, r, previewGroups{partial: true}), "not_configured": NewService(Catalog{}, nil, r, previewGroups{})}
	memory := a
	memory.Persistence = "memory_only"
	services["memory"] = NewService(Catalog{Sources: []Source{memory}}, nil, r, previewGroups{})
	writer := a
	writer.SCSCF.User = "writer"
	services["writer"] = NewService(Catalog{Sources: []Source{writer}}, nil, r, previewGroups{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/operations/summary", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"generatedAt": time.Now().UTC(), "sections": []string{"alerts"}, "alerts": map[string]any{"completeness": "complete", "scope": "full_collection", "alerts": map[string]any{"totalRules": 0, "enabledRules": 0, "alertsByState": map[string]int{}, "openBySeverity": map[string]int{}}}})
	})
	principal := func(r *http.Request) *auth.Principal {
		role := "viewer"
		if c, e := r.Cookie("fixture_role"); e == nil && (c.Value == "admin" || c.Value == "operator") {
			role = c.Value
		}
		return &auth.Principal{Username: "demo-" + role, Role: role, NormalizedRole: role}
	}
	get := func(w http.ResponseWriter, request *http.Request) {
		mode := "normal"
		if c, e := request.Cookie("fixture_mode"); e == nil && services[c.Value] != nil {
			mode = c.Value
		}
		NewHandler(services[mode], nil).Get(w, request.WithContext(auth.ContextWithPrincipal(request.Context(), principal(request))))
	}
	mux.HandleFunc("GET /api/ims/registrations", get)
	mux.HandleFunc("GET /api/ims/registrations/summary", get)
	mux.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"username": p.Username, "role": p.Role, "normalizedRole": p.Role, "status": "active", "permissions": auth.PermissionsFor(p)})
	})
	mux.HandleFunc("GET /api/auth/permissions", func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"username": p.Username, "role": p.Role, "permissions": auth.PermissionsFor(p), "capabilities": auth.CapabilitiesFor(p.Role)})
	})
	mux.HandleFunc("GET /api/notifications/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("GET /__fixture/{mode}", func(w http.ResponseWriter, r *http.Request) {
		mode := r.PathValue("mode")
		if services[mode] == nil {
			http.NotFound(w, r)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "fixture_mode", Value: mode, Path: "/", SameSite: http.SameSiteLaxMode})
		http.Redirect(w, r, "/ims-registrations", 303)
	})
	stop := make(chan struct{}, 1)
	mux.HandleFunc("POST /__fixture_stop", func(w http.ResponseWriter, r *http.Request) {
		select {
		case stop <- struct{}{}:
		default:
		}
		w.WriteHeader(204)
	})
	dist := os.Getenv("IMS_BROWSER_DIST")
	if _, e := os.Stat(filepath.Join(dist, "index.html")); e != nil {
		t.Fatal(e)
	}
	files := http.FileServer(http.Dir(dist))
	mux.Handle("GET /assets/", files)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		asset := filepath.Join(dist, strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/"))
		if info, e := os.Stat(asset); e == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	go server.Serve(listener)
	if e = os.WriteFile(os.Getenv("IMS_BROWSER_ADDRESS_FILE"), []byte(listener.Addr().String()), 0600); e != nil {
		t.Fatal(e)
	}
	t.Log("DEMO fixture ready: owned MySQL and loopback HTTP, fixture principals, production bundle")
	select {
	case <-stop:
	case <-time.After(45 * time.Minute):
		t.Fatal("owned fixture timed out")
	}
}
