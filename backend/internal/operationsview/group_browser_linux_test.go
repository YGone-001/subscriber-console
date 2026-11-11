//go:build linux

package operationsview_test

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/auth"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/nfalert"
	"subscriber/internal/nfhealth"
	"subscriber/internal/operationsview"
	"subscriber/internal/opsreports"
	"subscriber/internal/topology"
	"subscriber/internal/user"
)

type groupFaultStore struct {
	*operationsview.GroupRepository
	failure atomic.Int32
}

func (f *groupFaultStore) Edges(ctx context.Context, ids []string, direction string, limit int) ([]topology.Edge, bool, error) {
	if f.failure.Load() == 1 {
		return nil, false, context.DeadlineExceeded
	}
	return f.GroupRepository.Edges(ctx, ids, direction, limit)
}
func (f *groupFaultStore) Resources(ctx context.Context, filter operationsview.GroupFilter, ids []string, limit int) ([]inventory.Resource, bool, error) {
	if f.failure.Load() == 2 {
		return nil, false, context.DeadlineExceeded
	}
	return f.GroupRepository.Resources(ctx, filter, ids, limit)
}

// This opt-in browser harness owns its mongod, files, HTTP listener and fixture
// principals. It verifies UI/data flows, not production login or multi-host TLS.
func TestGroupBrowserPreview(t *testing.T) {
	if os.Getenv("GROUPS_BROWSER_PREVIEW") != "1" {
		t.Skip("explicit isolated browser preview flag required")
	}
	db := ownedGroupDB(t)
	seedGroupData(t, db)
	ctx := context.Background()
	for _, role := range []string{"admin", "operator", "viewer"} {
		if _, e := db.Collection("app_users").InsertOne(ctx, bson.M{"username": "demo-" + role, "role": role, "status": "active", "locked": false, "security": bson.M{"sessionVersion": 0}}); e != nil {
			t.Fatal(e)
		}
	}
	accounts := user.NewRepository(db)
	inv := inventory.NewRepository(db.Collection("app_inventory_resources"))
	topo := topology.NewMongoRepository(db.Collection("app_topology_edges"), db.Collection("app_inventory_resources"))
	invHandler := inventory.NewHandler(inv, nil, nil, accounts)
	topoHandler := topology.NewHandler(topo, nil, nil, accounts)
	health := nfhealth.NewRepository(db.Collection("app_nf_health_targets"), db.Collection("app_nf_health_runs"), db.Collection("app_nf_health_samples"))
	alerts := nfalert.NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts"))
	alertHandler := nfalert.NewHandler(alerts, nil, nil)
	dir := t.TempDir()
	file := filepath.Join(dir, "demo-amf.yaml")
	diameter := filepath.Join(dir, "demo-diameter.conf")
	write := func(address string) {
		if e := os.WriteFile(file, []byte("# DEMO owned fixture\namf:\n  sbi:\n    server:\n      - address: "+address+"\n        port: 7777\n  security:\n    key: SYNTHETIC_PRIVATE_NEVER_DISPLAYED\n"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("127.0.0.5")
	if e := os.WriteFile(diameter, []byte("Identity=\"DEMO\";\nTLS_Cred=\"SYNTHETIC_PRIVATE\";"), 0600); e != nil {
		t.Fatal(e)
	}
	manifest := configsnapshots.Manifest{CollectorID: fixtureGroupID(300), Root: dir, Sources: []configsnapshots.SourceDeclaration{{SourceID: fixtureGroupID(301), Name: "DEMO / AMF endpoints", ResourceID: fixtureGroupID(5), Path: file, Format: "yaml", Profile: configsnapshots.PolicyVersion}, {SourceID: fixtureGroupID(302), Name: "DEMO / Diameter metadata", ResourceID: fixtureGroupID(7), Path: diameter, Format: "diameter_conf", Profile: "metadata-only-v1"}}}
	raw, _ := json.Marshal(manifest)
	catalog, e := configsnapshots.ParseCatalog(raw)
	if e != nil {
		t.Fatal(e)
	}
	configRepo := configsnapshots.NewRepository(db)
	if e = configRepo.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	configs := configsnapshots.NewService(configRepo, catalog, []byte(strings.Repeat("isolated-demo-fingerprint-", 3)), accounts, inv, nil)
	p := &auth.Principal{Username: "demo-operator", Role: "operator", NormalizedRole: "operator"}
	first, e := configs.Capture(ctx, p, fixtureGroupID(301), configsnapshots.CaptureRequest{RequestID: fixtureGroupID(401)})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = configs.Baseline(ctx, p, fixtureGroupID(301), configsnapshots.BaselineRequest{ExpectedRevision: 1, SnapshotID: &first.SnapshotID}); e != nil {
		t.Fatal(e)
	}
	write("127.0.0.9")
	if _, e = configs.Capture(ctx, p, fixtureGroupID(301), configsnapshots.CaptureRequest{RequestID: fixtureGroupID(402)}); e != nil {
		t.Fatal(e)
	}
	if _, e = configs.Capture(ctx, p, fixtureGroupID(302), configsnapshots.CaptureRequest{RequestID: fixtureGroupID(403)}); e != nil {
		t.Fatal(e)
	}
	store := &groupFaultStore{GroupRepository: operationsview.NewGroupRepository(db)}
	groups := operationsview.NewGroupService(store, health, configs.List)
	groupHandler := operationsview.NewGroupHandler(groups, nil, nil)
	reports := opsreports.NewService(opsreports.NewRepository(db), configs.Meta)
	reports.SetGroups(groups, func(ctx context.Context, ids []string) (*map[string]int, error) {
		v, e := configs.List(ctx, configsnapshots.ListQuery{Limit: 1, ResourceIDs: ids})
		if e != nil {
			return nil, e
		}
		return v.Summary, nil
	})
	reportHandler := opsreports.NewHandler(reports, nil)
	configHandler := configsnapshots.NewHandler(configs, nil)
	overview := operationsview.NewHandler(operationsview.NewService(inv, nil, health, alerts, topo, nil), nil, nil)
	mux := http.NewServeMux()
	principal := func(r *http.Request) *auth.Principal {
		role := "operator"
		if c, e := r.Cookie("fixture_role"); e == nil && (c.Value == "viewer" || c.Value == "admin") {
			role = c.Value
		}
		return &auth.Principal{Username: "demo-" + role, Role: role, NormalizedRole: role}
	}
	wrap := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			h(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), principal(r))))
		}
	}
	for _, pattern := range []string{"GET /api/operations/groups", "GET /api/operations/groups/summary", "GET /api/operations/groups/members"} {
		mux.HandleFunc(pattern, wrap(groupHandler.Handle))
	}
	for _, pattern := range []string{"GET /api/ops-reports/summary", "GET /api/ops-reports/alerts", "GET /api/ops-reports/metrics", "GET /api/ops-reports/export"} {
		mux.HandleFunc(pattern, wrap(reportHandler.Handle))
	}
	for _, pattern := range []string{"GET /api/config-snapshots/meta", "GET /api/config-snapshots/sources", "GET /api/config-snapshots/sources/{sourceId}", "GET /api/config-snapshots/sources/{sourceId}/observations", "GET /api/config-snapshots/sources/{sourceId}/snapshots", "GET /api/config-snapshots/sources/{sourceId}/snapshots/{snapshotId}", "GET /api/config-snapshots/sources/{sourceId}/diff"} {
		mux.HandleFunc(pattern, wrap(configHandler.Handle))
	}
	mux.HandleFunc("GET /api/inventory/meta", wrap(invHandler.Meta))
	mux.HandleFunc("GET /api/inventory/resources", wrap(invHandler.List))
	mux.HandleFunc("GET /api/inventory/resources/{resourceId}", wrap(invHandler.Get))
	mux.HandleFunc("POST /api/inventory/resources", wrap(invHandler.Create))
	mux.HandleFunc("PUT /api/inventory/resources/{resourceId}", wrap(invHandler.Update))
	mux.HandleFunc("POST /api/inventory/resources/{resourceId}/retire", wrap(invHandler.Retire))
	mux.HandleFunc("GET /api/topology/meta", wrap(topoHandler.Meta))
	mux.HandleFunc("GET /api/topology/edges", wrap(topoHandler.List))
	mux.HandleFunc("GET /api/topology/edges/{edgeId}", wrap(topoHandler.Get))
	mux.HandleFunc("POST /api/topology/edges", wrap(topoHandler.Create))
	mux.HandleFunc("PUT /api/topology/edges/{edgeId}", wrap(topoHandler.Update))
	mux.HandleFunc("POST /api/topology/edges/{edgeId}/retire", wrap(topoHandler.Retire))
	mux.HandleFunc("GET /api/topology/resources/{resourceId}/neighbors", wrap(topoHandler.Neighbors))
	mux.HandleFunc("GET /api/nf-alerts", wrap(alertHandler.ListAlerts))
	mux.HandleFunc("GET /api/nf-alerts/meta", wrap(alertHandler.Meta))
	mux.HandleFunc("GET /api/nf-alerts/rules", wrap(alertHandler.ListRules))
	mux.HandleFunc("GET /api/operations/summary", wrap(overview.Summary))
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
	mux.HandleFunc("GET /__fixture_role/{role}", func(w http.ResponseWriter, r *http.Request) {
		role := r.PathValue("role")
		if role != "admin" && role != "operator" && role != "viewer" {
			http.Error(w, "invalid fixture role", 400)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "fixture_role", Value: role, Path: "/", SameSite: http.SameSiteLaxMode})
		http.Redirect(w, r, "/inventory/groups", 303)
	})
	mux.HandleFunc("GET /__fixture_failure/{source}", func(w http.ResponseWriter, r *http.Request) {
		v := int32(0)
		if r.PathValue("source") == "topology" {
			v = 1
		}
		if r.PathValue("source") == "inventory" {
			v = 2
		}
		store.failure.Store(v)
		http.Redirect(w, r, "/inventory/groups?siteResourceId="+fixtureGroupID(1), 303)
	})
	stop := make(chan struct{}, 1)
	mux.HandleFunc("POST /__fixture_stop", func(w http.ResponseWriter, r *http.Request) {
		select {
		case stop <- struct{}{}:
		default:
		}
		w.WriteHeader(204)
	})
	dist := os.Getenv("GROUPS_BROWSER_DIST")
	if dist == "" {
		t.Fatal("built fixture SPA directory required")
	}
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
		if info, err := os.Stat(asset); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	go server.Serve(l)
	if e = os.WriteFile(os.Getenv("GROUPS_BROWSER_ADDRESS_FILE"), []byte(l.Addr().String()), 0600); e != nil {
		t.Fatal(e)
	}
	t.Log("DEMO browser fixture ready: owned mongod, files, loopback HTTP and explicit fixture principals")
	select {
	case <-stop:
	case <-time.After(45 * time.Minute):
		t.Fatal("owned browser fixture timed out")
	}
}
