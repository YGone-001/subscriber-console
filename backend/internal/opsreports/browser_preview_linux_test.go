//go:build linux

package opsreports

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/auth"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/user"
)

type previewActors struct{}

func (previewActors) FindByUsernameIdentity(context.Context, string) (*user.UserIdentity, error) {
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: "demo-operator", Role: "operator", Status: "active"}}, nil
}

// This opt-in harness exposes only test-owned DEMO files and an isolated mongod.
// It is never included in the production executable or normal test execution.
func TestEvidenceBrowserPreview(t *testing.T) {
	if os.Getenv("CONFIG_EVIDENCE_PREVIEW") != "1" {
		t.Skip("explicit loopback DEMO preview only")
	}
	db := reportTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	sourceID := "53fc53b9-d7f2-421c-9526-f94c1e9d9501"
	diamID := "53fc53b9-d7f2-421c-9526-f94c1e9d9502"
	file := filepath.Join(dir, "demo-amf.yaml")
	diameter := filepath.Join(dir, "demo-smf.conf")
	write := func(address string) {
		if e := os.WriteFile(file, []byte("# DEMO isolated fixture\namf:\n  sbi:\n    server:\n      - address: "+address+"\n        port: 7777\n  security:\n    key: SYNTHETIC_SECRET_NEVER_DISPLAYED\n"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("127.0.0.5")
	_ = os.WriteFile(diameter, []byte("Identity=\"DEMO\";\nTLS_Cred=\"SYNTHETIC_SECRET\";"), 0600)
	manifest := configsnapshots.Manifest{CollectorID: "81d367af-eafc-4673-b307-c68958ed75b1", Root: dir, Sources: []configsnapshots.SourceDeclaration{{SourceID: sourceID, Name: "DEMO / AMF configuration", Path: file, Format: "yaml", Profile: configsnapshots.PolicyVersion}, {SourceID: diamID, Name: "DEMO / SMF Diameter", Path: diameter, Format: "diameter_conf", Profile: "metadata-only-v1"}}}
	b, _ := json.Marshal(manifest)
	catalog, e := configsnapshots.ParseCatalog(b)
	if e != nil {
		t.Fatal(e)
	}
	repo := configsnapshots.NewRepository(db)
	if e = repo.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	sourceService := configsnapshots.NewService(repo, catalog, []byte(strings.Repeat("demonstration-only-key-", 3)), previewActors{}, nil, nil)
	p := &auth.Principal{Username: "demo-operator", Role: "operator", NormalizedRole: "operator"}
	first, e := sourceService.Capture(ctx, p, sourceID, configsnapshots.CaptureRequest{RequestID: "215a2326-06bb-4912-a37e-78c17e232a01"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = sourceService.Baseline(ctx, p, sourceID, configsnapshots.BaselineRequest{ExpectedRevision: 1, SnapshotID: &first.SnapshotID}); e != nil {
		t.Fatal(e)
	}
	write("127.0.0.9")
	if _, e = sourceService.Capture(ctx, p, sourceID, configsnapshots.CaptureRequest{RequestID: "215a2326-06bb-4912-a37e-78c17e232a02"}); e != nil {
		t.Fatal(e)
	}
	if _, e = sourceService.Capture(ctx, p, diamID, configsnapshots.CaptureRequest{RequestID: "215a2326-06bb-4912-a37e-78c17e232a03"}); e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	resource := "935d12c2-9b44-4146-92f7-730b47b95fe1"
	_, e = db.Collection("app_inventory_resources").InsertOne(ctx, bson.M{"_id": resource, "domain": "5gc"})
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Collection("app_nf_alerts").InsertMany(ctx, []any{bson.M{"_id": "demo-alert-a", "ruleName": "DEMO / Interface measurement unavailable", "resourceId": resource, "targetId": "demo-amf", "targetName": "DEMO AMF", "severity": "warning", "state": "acknowledged", "firstTriggeredAt": now.Add(-2 * time.Hour).Format(time.RFC3339), "acknowledgedAt": now.Add(-110 * time.Minute).Format(time.RFC3339)}, bson.M{"_id": "demo-alert-b", "ruleName": "DEMO / Previous process observation", "resourceId": resource, "targetName": "DEMO SMF", "severity": "critical", "state": "resolved", "firstTriggeredAt": now.Add(-5 * time.Hour).Format(time.RFC3339), "resolvedAt": now.Add(-4 * time.Hour).Format(time.RFC3339), "resolvedReason": "recovery"}})
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 4; i++ {
		_, e = db.Collection("app_nf_health_samples").InsertOne(ctx, bson.M{"_id": i, "targetId": "demo-amf", "resourceId": resource, "collectedAt": now.Add(time.Duration(i-4) * time.Hour).Format(time.RFC3339), "metrics": bson.A{bson.M{"key": "process_resident_memory_bytes", "type": "gauge", "unit": "bytes", "value": float64((32 + i) * 1024 * 1024)}, bson.M{"key": "process_cpu_seconds_total", "type": "counter", "unit": "seconds", "value": float64(100 + i*20)}}})
		if e != nil {
			t.Fatal(e)
		}
	}
	_, e = db.Collection("app_agents").InsertOne(ctx, bson.M{"_id": "demo-agent", "enabled": true, "lastReceivedAt": now})
	if e != nil {
		t.Fatal(e)
	}
	reportService := NewService(NewRepository(db), sourceService.Meta)
	reportService.SetConfigCounts(func(c context.Context, id string) (*map[string]int, error) {
		v, e := sourceService.List(c, configsnapshots.ListQuery{Limit: 1, ResourceID: id})
		if e != nil {
			return nil, e
		}
		return v.Summary, nil
	})
	configHandler := configsnapshots.NewHandler(sourceService, nil)
	reportHandler := NewHandler(reportService, nil)
	mux := http.NewServeMux()
	wrap := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			h(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), p)))
		}
	}
	for _, pattern := range []string{"GET /api/config-snapshots/meta", "GET /api/config-snapshots/sources", "GET /api/config-snapshots/sources/{sourceId}", "POST /api/config-snapshots/sources/{sourceId}/captures", "GET /api/config-snapshots/sources/{sourceId}/observations", "GET /api/config-snapshots/sources/{sourceId}/snapshots", "GET /api/config-snapshots/sources/{sourceId}/snapshots/{snapshotId}", "GET /api/config-snapshots/sources/{sourceId}/diff", "PUT /api/config-snapshots/sources/{sourceId}/baseline"} {
		mux.HandleFunc(pattern, wrap(configHandler.Handle))
	}
	for _, pattern := range []string{"GET /api/ops-reports/summary", "GET /api/ops-reports/alerts", "GET /api/ops-reports/metrics", "GET /api/ops-reports/export"} {
		mux.HandleFunc(pattern, wrap(reportHandler.Handle))
	}
	mux.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"username": "demo-operator", "role": "operator", "normalizedRole": "operator", "status": "active", "permissions": auth.PermissionsFor(p)})
	})
	mux.HandleFunc("GET /api/notifications/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	stop := make(chan struct{}, 1)
	mux.HandleFunc("POST /__fixture_stop", func(w http.ResponseWriter, r *http.Request) {
		select {
		case stop <- struct{}{}:
		default:
		}
		w.WriteHeader(204)
	})
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	go server.Serve(listener)
	if e = os.WriteFile(os.Getenv("CONFIG_PREVIEW_ADDRESS_FILE"), []byte(listener.Addr().String()), 0600); e != nil {
		t.Fatal(e)
	}
	t.Log("DEMO preview ready; no production configuration, database or service is used")
	select {
	case <-stop:
	case <-time.After(15 * time.Minute):
		t.Fatal("owned preview timed out")
	}
}
