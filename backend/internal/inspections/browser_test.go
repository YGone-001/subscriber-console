package inspections

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/auth"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/nfhealth"
	"subscriber/internal/operationsview"
)

type browserConfigurations struct {
	mu     sync.RWMutex
	source configsnapshots.SourceView
	stale  bool
}

func (b *browserConfigurations) List(context.Context, configsnapshots.ListQuery) (*configsnapshots.SourceList, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	v := b.source
	o := *v.Latest
	v.Latest = &o
	if b.stale {
		o.CollectedAt = o.CollectedAt.Add(-48 * time.Hour)
	}
	return &configsnapshots.SourceList{CatalogState: "configured", Completeness: "complete", Page: configsnapshots.Page[configsnapshots.SourceView]{Items: []configsnapshots.SourceView{v}}}, nil
}

// This opt-in fixture owns its isolated database, random loopback listener and
// synthetic identities. None of these routes is compiled into the application.
func TestInspectionBrowserFixture(t *testing.T) {
	if os.Getenv("INSPECTIONS_BROWSER_FIXTURE") != "1" {
		t.Skip("explicit owned-browser-fixture flag required")
	}
	stateFile := os.Getenv("INSPECTIONS_BROWSER_STATE")
	if stateFile == "" {
		t.Fatal("owned fixture state path required")
	}
	db, repo := mongoFixture(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	now := time.Now().UTC().Truncate(time.Millisecond)
	siteID, hostID, nfID, targetID, healthRunID, sampleID, sourceID, baselineID, observationID, agentID := newID(), newID(), newID(), newID(), newID(), newID(), newID(), newID(), newID(), newID()
	for _, r := range []struct{ id, name, kind, domain string }{{siteID, "SYNTHETIC station", "site", "shared"}, {hostID, "SYNTHETIC host", "host", "shared"}, {nfID, "SYNTHETIC MME", "network_function", "epc"}} {
		_, e := db.Collection("app_inventory_resources").InsertOne(ctx, bson.M{"_id": r.id, "name": r.name, "displayName": r.name, "kind": r.kind, "domain": r.domain, "role": "mme", "lifecycleState": "active", "revision": int64(1), "updatedAt": now.Format(time.RFC3339Nano), "attributes": bson.M{"xcloudOperationalScopes": bson.A{bson.M{"networkKey": "synthetic-lab", "operatorName": "SYNTHETIC operator", "plmns": bson.A{"00101"}}}}})
		if e != nil {
			t.Fatal(e)
		}
	}
	for _, pair := range [][2]string{{siteID, hostID}, {hostID, nfID}} {
		if _, e := db.Collection("app_topology_edges").InsertOne(ctx, bson.M{"_id": newID(), "fromResourceId": pair[0], "toResourceId": pair[1], "relationshipType": "contains", "lifecycleState": "active", "revision": int64(1)}); e != nil {
			t.Fatal(e)
		}
	}
	stamp := now.Format(time.RFC3339Nano)
	layers := nfhealth.LayerSet{Process: nfhealth.LayerEvidence{Measured: true, State: "unhealthy"}, Interface: nfhealth.LayerEvidence{Measured: true, State: "healthy"}, Service: nfhealth.LayerEvidence{State: "unknown"}}
	for collection, document := range map[string]any{
		"app_nf_health_targets": nfhealth.HealthTarget{TargetID: targetID, ResourceID: nfID, Enabled: true, LastMeasuredAt: stamp, CollectionMode: "manual", CollectorProfile: "http_metrics"},
		"app_nf_health_runs":    nfhealth.HealthRun{RunID: healthRunID, TargetID: targetID, ResourceID: nfID, SampleID: sampleID, Status: "success", StartedAt: stamp},
		"app_nf_health_samples": nfhealth.HealthSample{SampleID: sampleID, RunID: healthRunID, TargetID: targetID, ResourceID: nfID, CollectedAt: stamp, Layers: layers},
		"app_nf_alerts":         bson.M{"_id": newID(), "resourceId": nfID, "state": "active", "severity": "critical"},
		"app_agents":            bson.M{"_id": agentID, "name": "SYNTHETIC remote Agent", "revision": int64(1), "enabled": true, "lastReceivedAt": now, "scope": bson.M{"siteResourceId": siteID, "hostResourceId": hostID, "networkKey": "synthetic-lab", "operatorName": "SYNTHETIC operator", "plmns": bson.A{"00101"}}},
	} {
		if _, e := db.Collection(collection).InsertOne(ctx, document); e != nil {
			t.Fatal(e)
		}
	}
	configs := &browserConfigurations{source: configsnapshots.SourceView{Source: configsnapshots.Source{SourceID: sourceID, ResourceID: nfID, Name: "SYNTHETIC MME configuration", Generation: "g1", Profile: "metadata-only-v1"}, Registered: true, ResourceState: "valid", BaselineID: baselineID, Comparison: "unchanged", Latest: &configsnapshots.Observation{ObservationID: observationID, ResourceID: nfID, Generation: "g1", Status: "ok", Published: true, CollectedAt: now}}}
	_, _ = db.Collection("app_config_sources").InsertOne(ctx, bson.M{"_id": sourceID, "driftSequence": int64(2), "driftPolicy": bson.M{"enabled": true, "revision": int64(1)}})
	_, _ = db.Collection("app_config_drift_sources").InsertOne(ctx, bson.M{"_id": sourceID, "sequence": int64(2), "input": bson.M{"resourceId": nfID, "generation": "g1", "profile": "metadata-only-v1", "baselineId": baselineID, "observationId": observationID, "policy": bson.M{"enabled": true, "revision": int64(1)}}, "evaluation": bson.M{"state": "in_sync", "processedSequence": int64(2)}})
	actors := &fixtureActors{role: "operator", status: "active"}
	health := nfhealth.NewRepository(db.Collection("app_nf_health_targets"), db.Collection("app_nf_health_runs"), db.Collection("app_nf_health_samples"))
	groupRepo := operationsview.NewGroupRepository(db)
	groups := operationsview.NewGroupService(groupRepo, health, configs.List)
	service := NewService(repo, NewEvidenceReader(db, groups, groupRepo, health, configs), actors, nil, []byte("synthetic inspection browser key"))
	handler := NewHandler(service, nil)
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); service.Run(ctx) }()
	defer func() { cancel(); <-workerDone }()
	mux := http.NewServeMux()
	for _, pattern := range []string{"GET /api/inspections/meta", "GET /api/inspection-plans", "POST /api/inspection-plans/preview", "POST /api/inspection-plans", "GET /api/inspection-plans/{planId}", "PUT /api/inspection-plans/{planId}", "POST /api/inspection-plans/{planId}/runs", "GET /api/inspection-runs", "GET /api/inspection-runs/{runId}", "GET /api/inspection-runs/{runId}/items", "GET /api/inspection-runs/{runId}/export"} {
		mux.HandleFunc(pattern, handler.Handle)
	}
	principal := func(req *http.Request) *auth.Principal {
		role := "operator"
		if c, e := req.Cookie("inspection_fixture_role"); e == nil && c.Value == "viewer" {
			role = "viewer"
		}
		return &auth.Principal{Username: "synthetic-" + role, Role: role, NormalizedRole: role}
	}
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /api/auth/me", func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		reply(w, map[string]any{"username": p.Username, "role": p.Role, "databaseRole": p.Role, "normalizedRole": p.Role, "permissions": auth.PermissionsFor(p), "status": "active"})
	})
	mux.HandleFunc("GET /api/auth/permissions", func(w http.ResponseWriter, r *http.Request) {
		p := principal(r)
		reply(w, map[string]any{"username": p.Username, "role": p.Role, "permissions": auth.PermissionsFor(p), "capabilities": auth.CapabilitiesFor(p.Role)})
	})
	mux.HandleFunc("GET /api/notifications/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("GET /api/operations/summary", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"sections": []string{"alerts"}, "alerts": map[string]any{"completeness": "complete", "scope": "full_collection", "alerts": map[string]any{"alertsByState": map[string]int{}, "openBySeverity": map[string]int{}}}})
	})
	mux.HandleFunc("GET /api/inventory/resources", func(w http.ResponseWriter, r *http.Request) {
		resources, _, e := groupRepo.Resources(r.Context(), operationsview.GroupFilter{}, nil, 200)
		if e != nil {
			w.WriteHeader(503)
			return
		}
		selected := []inventory.Resource{}
		q := r.URL.Query()
		ids := strings.Split(q.Get("resourceIds"), ",")
		for _, v := range resources {
			if q.Get("kind") != "" && q.Get("kind") != v.Kind {
				continue
			}
			if q.Get("q") != "" && !strings.Contains(strings.ToLower(v.Name), strings.ToLower(q.Get("q"))) {
				continue
			}
			if q.Has("resourceIds") {
				match := false
				for _, id := range ids {
					match = match || id == v.ResourceID
				}
				if !match {
					continue
				}
			}
			selected = append(selected, v)
		}
		reply(w, map[string]any{"resources": selected, "page": map[string]any{"nextCursor": nil, "hasMore": false, "limit": 20}})
	})
	mux.HandleFunc("POST /__fixture/evidence/{state}", func(w http.ResponseWriter, r *http.Request) {
		configs.mu.Lock()
		configs.stale = r.PathValue("state") == "stale"
		configs.mu.Unlock()
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /__fixture/conflict/{planId}", func(w http.ResponseWriter, r *http.Request) {
		if !validID(r.PathValue("planId")) {
			w.WriteHeader(400)
			return
		}
		_, e := repo.plans.UpdateOne(r.Context(), bson.M{"_id": r.PathValue("planId")}, bson.M{"$inc": bson.M{"revision": int64(1)}, "$set": bson.M{"description": "SYNTHETIC external edit"}})
		if e != nil {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /__fixture/due/{planId}", func(w http.ResponseWriter, r *http.Request) {
		if !validID(r.PathValue("planId")) {
			w.WriteHeader(400)
			return
		}
		at := time.Now().Add(-time.Second)
		if r.URL.Query().Get("missed") == "1" {
			at = time.Now().Add(-time.Hour)
		}
		_, e := repo.plans.UpdateOne(r.Context(), bson.M{"_id": r.PathValue("planId"), "enabled": true}, bson.M{"$set": bson.M{"nextAt": at}})
		if e == nil {
			e = service.Tick(r.Context())
		}
		if e != nil {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /__fixture/state", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"synthetic": true, "siteId": siteID, "hostId": hostID, "nfId": nfID})
	})
	stop := make(chan struct{}, 1)
	mux.HandleFunc("POST /__fixture/stop", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
		w.(http.Flusher).Flush()
		select {
		case stop <- struct{}{}:
		default:
		}
	})
	token := newID()
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Inspection-Fixture") != token {
			http.Error(w, "owned fixture token required", 403)
			return
		}
		mux.ServeHTTP(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), principal(r))))
	})}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	state, _ := json.Marshal(map[string]any{"synthetic": true, "address": listener.Addr().String(), "token": token, "database": db.Name()})
	if e = os.MkdirAll(filepath.Dir(stateFile), 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(stateFile, state, 0600); e != nil {
		t.Fatal(e)
	}
	t.Log("owned synthetic inspection fixture ready")
	select {
	case <-stop:
	case <-time.After(30 * time.Minute):
		t.Fatal("owned browser fixture timed out")
	}
}
