//go:build linux

package investigation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func ownedMongo(t *testing.T) *mongo.Database {
	t.Helper()
	if os.Getenv("INVESTIGATION_TEST_MONGOD") != "1" {
		t.Skip("set INVESTIGATION_TEST_MONGOD=1 for a test-owned isolated Mongo")
	}
	binary, err := exec.LookPath("mongod")
	if err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	dir := t.TempDir()
	cmd := exec.Command(binary, "--bind_ip", "127.0.0.1", "--port", fmt.Sprint(port), "--dbpath", dir, "--logpath", filepath.Join(dir, "mongo.log"), "--quiet")
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(syscall.SIGTERM); _ = cmd.Wait() })
	client, err := mongo.Connect(options.Client().ApplyURI(fmt.Sprintf("mongodb://127.0.0.1:%d", port)).SetServerSelectionTimeout(300 * time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	for deadline := time.Now().Add(15 * time.Second); ; {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		err = client.Ping(ctx, nil)
		cancel()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("owned Mongo not ready")
		}
		time.Sleep(100 * time.Millisecond)
	}
	return client.Database("investigation_isolated_test")
}
func seedEvidence(t *testing.T, db *mongo.Database, at time.Time) {
	t.Helper()
	ctx := context.Background()
	insert := func(collection string, v any) {
		if _, err := db.Collection(collection).InsertOne(ctx, v); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []int{1, 2, 3} {
		insert("app_inventory_resources", bson.M{"_id": testID(n), "name": fmt.Sprintf("DEMO NF %d", n), "kind": "network_function", "domain": "5gc", "role": "smf", "lifecycleState": "active", "managementEndpoints": []string{"SENSITIVE-ENDPOINT"}})
	}
	insert("app_topology_edges", bson.M{"_id": testID(20), "fromResourceId": testID(1), "toResourceId": testID(2), "relationshipType": "depends_on", "lifecycleState": "active", "revision": 1})
	insert("app_topology_edges", bson.M{"_id": testID(21), "fromResourceId": testID(1), "toResourceId": testID(3), "relationshipType": "depends_on", "lifecycleState": "retired", "revision": 1})
	insert("app_nf_alerts", bson.M{"_id": testID(10), "resourceId": testID(1), "targetId": testID(30), "ruleName": "DEMO process observation", "severity": "warning", "state": "active", "firstTriggeredAt": at.In(time.FixedZone("CST", 8*3600)).Format(time.RFC3339Nano), "lastTriggeredAt": at.Add(time.Minute).Format(time.RFC3339Nano), "updatedAt": at.Format(time.RFC3339Nano), "triggerCount": 2, "privateData": "SENSITIVE-ALERT"})
	for _, n := range []int{1, 2, 3} {
		insert("app_nf_health_runs", bson.M{"_id": testID(50 + n), "resourceId": testID(n), "targetId": testID(30 + n), "sampleId": testID(60 + n), "startedAt": at.Add(time.Duration(n) * time.Minute).Format(time.RFC3339Nano), "status": "success", "errorSummary": "SENSITIVE-ERROR"})
		insert("app_nf_health_samples", bson.M{"_id": testID(60 + n), "runId": testID(50 + n), "resourceId": testID(n), "targetId": testID(30 + n), "collectedAt": at.Add(time.Duration(n) * time.Minute).Format(time.RFC3339Nano), "layers": bson.M{"process": bson.M{"state": "unhealthy", "detail": "SENSITIVE-RAW"}, "interface": bson.M{"state": "unknown"}, "service": bson.M{"state": "not_configured"}}, "metrics": []string{"SENSITIVE-METRICS"}})
	}
	insert("app_nf_health_runs", bson.M{"_id": testID(59), "targetId": testID(31), "startedAt": at.Format(time.RFC3339Nano), "status": "failed"})
	for i, published := range []bool{true, false} {
		insert("app_config_observations", bson.M{"_id": testID(40 + i), "resourceId": testID(1), "sourceId": testID(42), "snapshotId": testID(43), "collectedAt": at.Add(-5 * time.Minute), "status": "ok", "changed": true, "published": published, "projection": "SENSITIVE-CONFIG"})
	}
	insert("app_knowledge_entries", bson.M{"_id": testID(70), "title": "DEMO process checks", "protocol": "HTTP", "revision": 1, "solution": "SENSITIVE-KNOWLEDGE-BODY"})
}
func TestMongoEvidenceProjectionAndConcurrentCaseLifecycle(t *testing.T) {
	db := ownedMongo(t)
	seedEvidence(t, db, instant)
	repo := NewRepository(db)
	actors := &testActors{}
	s := NewService(repo, repo, actors, nil, []byte(strings.Repeat("k", 32)))
	s.clock = func() time.Time { return instant.Add(2 * time.Hour) }
	ctx := context.Background()
	before := map[string]int64{}
	names, _ := db.ListCollectionNames(ctx, bson.M{})
	for _, name := range names {
		before[name], _ = db.Collection(name).CountDocuments(ctx, bson.M{})
	}
	v, err := s.Context(ctx, testWindow())
	if err != nil {
		t.Fatal(err)
	}
	if v.Completeness != "complete" || len(v.Relations) != 1 || len(v.Resources) != 2 || v.Coverage["health"].Returned != 2 || v.Coverage["configuration"].Returned != 1 {
		t.Fatalf("projection incomplete: %+v", v)
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "SENSITIVE") {
		t.Fatal("positive projection leaked excluded data")
	}
	for _, event := range v.Events {
		if event.ResourceID == testID(3) {
			t.Fatal("retired edge broadened evidence")
		}
		if event.Kind == "health" && (event.Layers == nil || event.Layers.Process.State != "unhealthy") {
			t.Fatal("run/sample evidence lost")
		}
	}
	for name, n := range before {
		after, e := db.Collection(name).CountDocuments(ctx, bson.M{})
		if e != nil || after != n {
			t.Fatalf("GET changed source %s", name)
		}
	}
	q := CreateRequest{testID(100), testID(10), "DEMO investigation", testWindow().From, testWindow().To}
	record, err := s.Create(ctx, operator(), q)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Create(ctx, operator(), q)
	if err != nil || again.ID != record.ID {
		t.Fatal("native idempotency failed")
	}
	var success, conflict atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.Update(ctx, operator(), record.ID, UpdateRequest{ExpectedRevision: 1, Title: record.Title, Status: "investigating", Notes: "Manual observation", KnowledgeIDs: []string{testID(70)}})
			if e == nil {
				success.Add(1)
			} else if errors.Is(e, ErrConflict) {
				conflict.Add(1)
			} else {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if success.Load() != 1 || conflict.Load() != 11 {
		t.Fatalf("CAS winners %d conflicts %d", success.Load(), conflict.Load())
	}
	read, err := s.Get(ctx, record.ID)
	if err != nil || read.Record.Revision != 2 || len(read.Knowledge) != 1 || len(read.Record.RecentChanges) != 2 {
		t.Fatalf("saved record: %+v %v", read, err)
	}
	b, _ = json.Marshal(read)
	if strings.Contains(string(b), "SENSITIVE") {
		t.Fatal("knowledge body leaked")
	}
	actors.disabled = true
	if _, err = s.Update(ctx, operator(), record.ID, UpdateRequest{ExpectedRevision: 2, Title: record.Title, Status: "resolved", Conclusion: "Manual inconclusive result"}); err == nil {
		t.Fatal("revoked actor updated")
	}
	actors.disabled = false
	for _, n := range []int{101, 102} {
		q.RequestID = testID(n)
		if _, err = s.Create(ctx, operator(), q); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	filter := ListQuery{Limit: 1}
	for {
		page, e := s.List(ctx, filter)
		if e != nil {
			t.Fatal(e)
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatal("cursor duplicated record")
			}
			seen[item.ID] = true
		}
		if !page.HasMore {
			break
		}
		filter.Cursor = *page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatalf("cursor missed records: %v", seen)
	}
	for i := 0; i < MaxEvidence+2; i++ {
		_, err = db.Collection("app_config_observations").InsertOne(ctx, bson.M{"_id": testID(200 + i), "resourceId": testID(1), "sourceId": testID(42), "collectedAt": instant, "status": "ok", "changed": false, "published": true})
		if err != nil {
			t.Fatal(err)
		}
	}
	v, err = s.Context(ctx, testWindow())
	if err != nil || v.Coverage["configuration"].State != "partial" || v.Coverage["configuration"].Returned != MaxEvidence {
		t.Fatal("native truncation not exposed")
	}
	for i := 0; i < MaxEvidence+2; i++ {
		at := instant.Add(20*time.Minute + time.Duration(i)*time.Second)
		if i%2 == 0 {
			at = at.In(time.FixedZone("CST", 8*3600))
		}
		_, err = db.Collection("app_nf_health_runs").InsertOne(ctx, bson.M{"_id": testID(500 + i), "resourceId": testID(1), "targetId": testID(31), "startedAt": at.Format(time.RFC3339Nano), "status": "failed"})
		if err != nil {
			t.Fatal(err)
		}
	}
	runs, more, err := repo.Runs(ctx, []string{testID(1)}, instant.Add(-time.Hour), instant.Add(time.Hour))
	if err != nil || !more || len(runs) != MaxEvidence || runs[0].ID != testID(500+MaxEvidence+1) {
		t.Fatal("mixed-offset row-limit ordering lost actual time")
	}
}
