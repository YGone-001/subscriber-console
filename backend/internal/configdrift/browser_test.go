package configdrift_test

import (
	"context"
	"encoding/json"
	"go.mongodb.org/mongo-driver/v2/bson"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"subscriber/internal/auth"
	"subscriber/internal/configdrift"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/investigation"
	"subscriber/internal/nfalert"
	"subscriber/internal/notify"
	"subscriber/internal/user"
	"sync/atomic"
	"testing"
	"time"
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

// This harness owns the database, files, listener and synthetic identities.
// It is an opt-in integration fixture, never a production authentication path.
func TestBrowserPreview(t *testing.T) {
	if os.Getenv("CONFIG_DRIFT_BROWSER_PREVIEW") != "1" {
		t.Skip("explicit browser preview flag required")
	}
	db := ownedMongo(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	path := filepath.Join(dir, "mme.yaml")
	write := func(v string) error { return os.WriteFile(path, []byte("mme: {s1ap: {address: "+v+"}}"), 0600) }
	manifest := configsnapshots.Manifest{CollectorID: id(90), Root: dir, Sources: []configsnapshots.SourceDeclaration{{SourceID: sourceID, ResourceID: resourceID, Name: "SYNTHETIC MME configuration", Path: path, Format: "yaml", Profile: configsnapshots.PolicyVersion}}}
	raw, _ := json.Marshal(manifest)
	catalog, e := configsnapshots.ParseCatalog(raw)
	if e != nil {
		t.Fatal(e)
	}
	a := &browserActors{}
	r := &resources{}
	cr := configsnapshots.NewRepository(db)
	if e = cr.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	sources := configsnapshots.NewService(cr, catalog, []byte("synthetic-test-key-at-least-32-bytes"), a, r, nil)
	dr := configdrift.NewRepository(db)
	if e = dr.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	d := configdrift.NewService(dr, sources, a, nil)
	nr := notify.NewRepository(db.Collection("app_nf_notification_channels"), db.Collection("app_nf_notification_escalations"), db.Collection("app_nf_notification_deliveries"), nil)
	d.SetSink(nr)
	_, e = nr.CreateChannel(ctx, &notify.CreateChannelRequest{Name: "SYNTHETIC pending-only channel", Kind: "webhook", URL: "http://127.0.0.1:9/unused"}, "operator")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Collection("app_inventory_resources").InsertOne(ctx, bson.M{"_id": resourceID, "name": "SYNTHETIC MME", "kind": "network_function", "domain": "epc", "role": "mme", "lifecycleState": "active", "revision": int64(1)}); e != nil {
		t.Fatal(e)
	}
	kbID := id(80)
	_, e = db.Collection("app_knowledge_entries").InsertOne(ctx, bson.M{"_id": kbID, "title": "SYNTHETIC configuration checks", "protocol": "S1AP", "revision": int64(1)})
	if e != nil {
		t.Fatal(e)
	}
	if e = write("127.0.0.1"); e != nil {
		t.Fatal(e)
	}
	base, e := sources.Capture(ctx, operator(), sourceID, configsnapshots.CaptureRequest{RequestID: id(1)})
	if e != nil {
		t.Fatal(e)
	}
	v, e := sources.Get(ctx, sourceID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = sources.Baseline(ctx, operator(), sourceID, configsnapshots.BaselineRequest{ExpectedRevision: v.Revision, SnapshotID: &base.SnapshotID}); e != nil {
		t.Fatal(e)
	}
	enabled := true
	if _, e = d.SetPolicy(ctx, operator(), sourceID, configsnapshots.DriftPolicyRequest{Enabled: &enabled, ExpectedRevision: 0, Severity: "warning"}); e != nil {
		t.Fatal(e)
	}
	if e = write("127.0.0.2"); e != nil {
		t.Fatal(e)
	}
	if _, e = sources.Capture(ctx, operator(), sourceID, configsnapshots.CaptureRequest{RequestID: id(2)}); e != nil {
		t.Fatal(e)
	}
	if e = d.RunOnce(ctx); e != nil {
		t.Fatal(e)
	}
	for n := 100; n < 127; n++ {
		at := time.Now().UTC().Add(-time.Duration(n) * time.Minute)
		end := at.Add(time.Minute)
		alert := configdrift.Alert{ID: id(n), SourceID: sourceID, SourceName: "SYNTHETIC historical MME", ResourceID: resourceID, Generation: catalog.Sources[0].Generation, Profile: configsnapshots.PolicyVersion, BaselineID: base.SnapshotID, BaselineRevision: 2, PolicyRevision: 1, Severity: "warning", State: "resolved", EndReason: "returned_to_baseline", Revision: 2, TriggerCount: 1, OpenedAt: at, ResolvedAt: &end, Trigger: configdrift.Evidence{At: at, SnapshotID: base.SnapshotID}, Latest: configdrift.Evidence{At: end, SnapshotID: base.SnapshotID}}
		if _, e = db.Collection("app_config_drift_alerts").InsertOne(ctx, alert); e != nil {
			t.Fatal(e)
		}
	}
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); d.Run(ctx) }()
	defer func() { cancel(); <-workerDone }()
	principal := func(req *http.Request) *auth.Principal {
		role := "operator"
		if c, e := req.Cookie("fixture_role"); e == nil && (c.Value == "viewer" || c.Value == "admin") {
			role = c.Value
		}
		return &auth.Principal{Username: "demo-" + role, Role: role, NormalizedRole: role}
	}
	withActor := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			if c, e := req.Cookie("fixture_error"); e == nil && c.Value == "1" && req.Method == "GET" && strings.HasPrefix(req.URL.Path, "/api/config-drift/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(503)
				_, _ = w.Write([]byte(`{"error":"Synthetic evidence read failure"}`))
				return
			}
			handler(w, req.WithContext(auth.ContextWithPrincipal(req.Context(), principal(req))))
		}
	}
	mux := http.NewServeMux()
	dh := configdrift.NewHandler(d, nil)
	sh := configsnapshots.NewHandler(sources, nil)
	for _, route := range []string{"GET /api/config-drift/meta", "GET /api/config-drift/sources/{sourceId}/policy", "PUT /api/config-drift/sources/{sourceId}/policy", "GET /api/config-drift/alerts", "GET /api/config-drift/alerts/{driftAlertId}", "POST /api/config-drift/alerts/{driftAlertId}/acknowledge", "GET /api/config-drift/alerts/{driftAlertId}/events"} {
		mux.HandleFunc(route, withActor(dh.Handle))
	}
	for _, route := range []string{"GET /api/config-snapshots/meta", "GET /api/config-snapshots/sources", "GET /api/config-snapshots/sources/{sourceId}", "POST /api/config-snapshots/sources/{sourceId}/captures", "GET /api/config-snapshots/sources/{sourceId}/observations", "GET /api/config-snapshots/sources/{sourceId}/snapshots", "GET /api/config-snapshots/sources/{sourceId}/snapshots/{snapshotId}", "GET /api/config-snapshots/sources/{sourceId}/diff", "PUT /api/config-snapshots/sources/{sourceId}/baseline"} {
		mux.HandleFunc(route, withActor(sh.Handle))
	}
	nh := notify.NewHandler(nr, nil, nil)
	nh.UseActorRepository(a)
	for route, handler := range map[string]http.HandlerFunc{"GET /api/nf-notifications/channels": nh.ListChannels, "GET /api/nf-notifications/escalations": nh.ListEscalations, "POST /api/nf-notifications/escalations": nh.CreateEscalation, "GET /api/nf-notifications/deliveries": nh.ListDeliveries} {
		mux.HandleFunc(route, withActor(handler))
	}
	ir := investigation.NewRepository(db)
	ih := investigation.NewHandler(investigation.NewService(ir, ir, a, nil, []byte("synthetic-investigation-key-at-least-32")), nil)
	for _, route := range []string{"GET /api/investigations", "GET /api/investigations/context", "POST /api/investigations", "GET /api/investigations/{investigationId}", "PATCH /api/investigations/{investigationId}"} {
		mux.HandleFunc(route, withActor(ih.Handle))
	}
	nf := nfalert.NewHandler(nfalert.NewRepository(db.Collection("app_nf_alert_rules"), db.Collection("app_nf_alerts")), nil, nil)
	mux.HandleFunc("GET /api/nf-alerts", withActor(nf.ListAlerts))
	mux.HandleFunc("GET /api/nf-alerts/meta", withActor(nf.Meta))
	mux.HandleFunc("GET /api/nf-alerts/rules", withActor(nf.ListRules))
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, req *http.Request) {
		p := principal(req)
		reply(w, map[string]any{"username": p.Username, "role": p.Role, "normalizedRole": p.Role, "status": "active", "permissions": auth.PermissionsFor(p)})
	})
	mux.HandleFunc("GET /api/auth/permissions", func(w http.ResponseWriter, req *http.Request) {
		p := principal(req)
		reply(w, map[string]any{"username": p.Username, "role": p.Role, "permissions": auth.PermissionsFor(p), "capabilities": auth.CapabilitiesFor(p.Role)})
	})
	mux.HandleFunc("GET /api/notifications/stream", func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-req.Context().Done()
	})
	mux.HandleFunc("GET /api/operations/summary", func(w http.ResponseWriter, req *http.Request) {
		reply(w, map[string]any{"sections": []string{"alerts"}, "alerts": map[string]any{"completeness": "complete", "scope": "full_collection", "alerts": map[string]any{"totalRules": 0, "enabledRules": 0, "alertsByState": map[string]int{}, "openBySeverity": map[string]int{}}}})
	})
	mux.HandleFunc("GET /api/knowledge/entries", func(w http.ResponseWriter, req *http.Request) {
		reply(w, map[string]any{"entries": []map[string]any{{"id": kbID, "title": "SYNTHETIC configuration checks", "protocol": "S1AP", "revision": 1}}})
	})
	var sequence atomic.Int64
	sequence.Store(1000)
	mux.HandleFunc("POST /__fixture/capture/{version}", func(w http.ResponseWriter, req *http.Request) {
		ver := req.PathValue("version")
		var fileErr error
		if ver == "missing" {
			fileErr = os.Remove(path)
		} else {
			value := "127.0.0.2"
			if ver == "baseline" {
				value = "127.0.0.1"
			}
			fileErr = write(value)
		}
		if fileErr != nil {
			w.WriteHeader(500)
			return
		}
		_, err := sources.Capture(req.Context(), operator(), sourceID, configsnapshots.CaptureRequest{RequestID: id(int(sequence.Add(1)))})
		if err != nil {
			w.WriteHeader(500)
			return
		}
		if err = d.RunOnce(req.Context()); err != nil {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /__fixture_actor/{state}", func(w http.ResponseWriter, req *http.Request) {
		a.disabled.Store(req.PathValue("state") == "disabled")
		w.WriteHeader(204)
	})
	stop := make(chan struct{}, 1)
	mux.HandleFunc("POST /__fixture_stop", func(w http.ResponseWriter, req *http.Request) {
		select {
		case stop <- struct{}{}:
		default:
		}
		w.WriteHeader(204)
	})
	dist := os.Getenv("CONFIG_DRIFT_BROWSER_DIST")
	if _, e = os.Stat(filepath.Join(dist, "index.html")); e != nil {
		t.Fatal(e)
	}
	files := http.FileServer(http.Dir(dist))
	mux.Handle("GET /assets/", files)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, req *http.Request) {
		if strings.HasPrefix(req.URL.Path, "/api/") {
			http.NotFound(w, req)
			return
		}
		asset := filepath.Join(dist, strings.TrimPrefix(filepath.Clean("/"+req.URL.Path), "/"))
		if info, e := os.Stat(asset); e == nil && !info.IsDir() {
			files.ServeHTTP(w, req)
			return
		}
		http.ServeFile(w, req, filepath.Join(dist, "index.html"))
	})
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	go server.Serve(listener)
	if e = os.WriteFile(os.Getenv("CONFIG_DRIFT_BROWSER_ADDRESS_FILE"), []byte(listener.Addr().String()), 0600); e != nil {
		t.Fatal(e)
	}
	t.Log("owned browser fixture ready; synthetic data only")
	select {
	case <-stop:
	case <-time.After(30 * time.Minute):
		t.Fatal("owned browser fixture timed out")
	}
}
