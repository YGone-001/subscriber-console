//go:build linux

package configsnapshots

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/auth"
	"subscriber/internal/user"
)

type testActors struct{ disabled bool }

type interruptedPublication struct {
	Repository
	fail bool
}

func (r *interruptedPublication) Publish(ctx context.Context, p *Pending) error {
	if r.fail {
		r.fail = false
		return errors.New("synthetic storage interruption")
	}
	return r.Repository.Publish(ctx, p)
}

func (a *testActors) FindByUsernameIdentity(context.Context, string) (*user.UserIdentity, error) {
	state := "active"
	if a.disabled {
		state = "disabled"
	}
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: "operator", Role: "operator", Status: state}}, nil
}

func isolatedMongo(t *testing.T) *mongo.Database {
	t.Helper()
	if os.Getenv("CONFIG_TEST_MONGOD") != "1" {
		t.Skip("set CONFIG_TEST_MONGOD=1 to launch a test-owned isolated mongod")
	}
	binary, e := exec.LookPath("mongod")
	if e != nil {
		t.Fatal("mongod is required for this explicit integration run")
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	dir := t.TempDir()
	cmd := exec.Command(binary, "--bind_ip", "127.0.0.1", "--port", fmt.Sprint(port), "--dbpath", dir, "--logpath", filepath.Join(dir, "mongo.log"), "--quiet")
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(syscall.SIGTERM); _ = cmd.Wait() })
	client, e := mongo.Connect(options.Client().ApplyURI(fmt.Sprintf("mongodb://127.0.0.1:%d", port)).SetServerSelectionTimeout(300 * time.Millisecond))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	for deadline := time.Now().Add(15 * time.Second); ; {
		c, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		e = client.Ping(c, nil)
		cancel()
		if e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("isolated mongod did not become ready")
		}
		time.Sleep(100 * time.Millisecond)
	}
	return client.Database("config_snapshot_isolated_test")
}
func TestMongoCaptureBaselineRetentionAndRevocation(t *testing.T) {
	db := isolatedMongo(t)
	repo := NewRepository(db)
	ctx := context.Background()
	if e := repo.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "amf.yaml")
	write := func(address string) {
		t.Helper()
		if e := os.WriteFile(path, []byte("db_uri: SYNTHETIC_SECRET\namf:\n  sbi:\n    server:\n      - address: "+address+"\n        port: 7777\n"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("127.0.0.5")
	id := randomID()
	source := Source{SourceID: id, Name: "AMF", Path: path, CollectorID: randomID(), Format: "yaml", Profile: PolicyVersion, Generation: "generation-a"}
	actors := &testActors{}
	s := NewService(repo, Catalog{Sources: []Source{source}, Root: dir, State: "configured"}, []byte(strings.Repeat("private-key-", 4)), actors, nil, nil)
	p := &auth.Principal{Username: "operator", Role: "operator", NormalizedRole: "operator"}
	req := CaptureRequest{randomID()}
	o, e := s.Capture(ctx, p, id, req)
	if e != nil {
		t.Fatal(e)
	}
	if o.Status != "ok" || o.Changed != nil {
		t.Fatal("first observation invented a baseline")
	}
	first := o.SnapshotID
	again, e := s.Capture(ctx, p, id, req)
	if e != nil || again.ObservationID != o.ObservationID || !again.CollectedAt.Equal(o.CollectedAt) {
		t.Fatal("idempotency refreshed evidence")
	}
	snap, e := s.Snapshot(ctx, id, first)
	if e != nil || strings.Contains(snap.Projection, "SYNTHETIC") {
		t.Fatal("unsafe stored projection")
	}
	baseline, e := s.Baseline(ctx, p, id, BaselineRequest{1, &first})
	if e != nil || baseline.Comparison != "unchanged" {
		t.Fatal(e)
	}
	if _, e = s.Baseline(ctx, p, id, BaselineRequest{1, &first}); e != ErrConflict {
		t.Fatal("CAS conflict not enforced")
	}
	o, e = s.Capture(ctx, p, id, CaptureRequest{randomID()})
	if e != nil || o.Changed == nil || *o.Changed || o.SnapshotID != first {
		t.Fatal("unchanged content created a new version")
	}
	write("127.0.0.6")
	o, e = s.Capture(ctx, p, id, CaptureRequest{randomID()})
	if e != nil || o.Changed == nil || !*o.Changed {
		t.Fatal(e)
	}
	v, e := s.Get(ctx, id)
	if e != nil || v.Comparison != "visible_changed" {
		t.Fatal("drift missing")
	}
	interrupted := &interruptedPublication{Repository: repo, fail: true}
	s.repo = interrupted
	write("127.0.0.7")
	retry := CaptureRequest{randomID()}
	if _, err := s.Capture(ctx, p, id, retry); err == nil {
		t.Fatal("interrupted publication reported success")
	}
	v, e = s.Get(ctx, id)
	if e != nil || !v.Pending || v.LatestSnapshot.SnapshotID != o.SnapshotID {
		t.Fatal("interrupted publication hid the previous observation")
	}
	o, e = s.Capture(ctx, p, id, retry)
	if e != nil {
		t.Fatal("publication journal did not recover")
	}
	v, e = s.Get(ctx, id)
	if e != nil || v.Pending || v.LatestSnapshot.SnapshotID != o.SnapshotID {
		t.Fatal("recovered publication not visible")
	}
	s.repo = repo
	write("127.0.0.5")
	o, e = s.Capture(ctx, p, id, CaptureRequest{randomID()})
	if e != nil || o.SnapshotID == first || o.Changed == nil || !*o.Changed {
		t.Fatal("returning to earlier content overwrote immutable history")
	}
	v, e = s.Get(ctx, id)
	if e != nil || v.Comparison != "unchanged" {
		t.Fatal("return to baseline was not distinguished from a new content observation")
	}
	beforeRevocation, e := db.Collection("app_config_observations").CountDocuments(ctx, bson.M{})
	if e != nil {
		t.Fatal(e)
	}
	s.read = func(c context.Context, root string, source Source) ([]byte, string) {
		data, reason := readSource(c, root, source)
		actors.disabled = true
		return data, reason
	}
	if _, e = s.Capture(ctx, p, id, CaptureRequest{randomID()}); e == nil {
		t.Fatal("actor revoked during file reading was accepted for publication")
	}
	if count, err := db.Collection("app_config_observations").CountDocuments(ctx, bson.M{}); err != nil || count != beforeRevocation {
		t.Fatal("revoked actor published an observation")
	}
	actors.disabled = false
	s.read = readSource
	if e = os.Remove(path); e != nil {
		t.Fatal(e)
	}
	failed, e := s.Capture(ctx, p, id, CaptureRequest{randomID()})
	if e != nil || failed.Status != "unreadable" {
		t.Fatal("read failure not recorded")
	}
	v, e = s.Get(ctx, id)
	if e != nil || v.LatestSnapshot == nil || v.LatestSnapshot.SnapshotID != o.SnapshotID || v.CollectionState != "unreadable" {
		t.Fatal("failed capture erased history")
	}
	state, e := repo.GetState(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	token := randomID()
	locked, e := repo.Acquire(ctx, source, token, time.Now().UTC())
	if e != nil {
		t.Fatal(e)
	}
	if _, e = repo.Acquire(ctx, source, randomID(), time.Now().UTC()); e != ErrBusy {
		t.Fatal("two writers acquired the same source")
	}
	if e = repo.Prune(ctx, locked, time.Now().AddDate(1, 0, 0)); e != nil {
		t.Fatal(e)
	}
	_ = repo.Release(ctx, id, token)
	if _, e = s.Snapshot(ctx, id, first); e != nil {
		t.Fatal("baseline was removed by retention")
	}
	if _, e = s.Snapshot(ctx, id, state.LatestSnapshotID); e != nil {
		t.Fatal("latest was removed by retention")
	}
	actors.disabled = true
	if _, e = s.Capture(ctx, p, id, CaptureRequest{randomID()}); e == nil {
		t.Fatal("disabled actor was accepted")
	}
	viewer := &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}
	if _, e = s.Capture(ctx, viewer, id, CaptureRequest{randomID()}); e == nil {
		t.Fatal("viewer mutation accepted")
	}
	// Check raw Mongo documents, not only API serialization.
	c, e := db.Collection("app_config_snapshots").Find(ctx, bson.M{})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close(ctx)
	for c.Next(ctx) {
		var doc bson.M
		if c.Decode(&doc) != nil {
			t.Fatal("decode")
		}
		if strings.Contains(fmt.Sprint(doc), "SYNTHETIC_SECRET") {
			t.Fatal("original secret persisted")
		}
	}
	h := NewHandler(s, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/config-snapshots/sources/{sourceId}/captures", h.Handle)
	r := httptest.NewRequest("POST", "/api/config-snapshots/sources/"+id+"/captures", strings.NewReader(`{"requestId":"`+randomID()+`","path":"/etc/shadow"}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("anonymous request accepted")
	}
	for _, tc := range []struct {
		principal *auth.Principal
		body      string
		status    int
	}{
		{viewer, `{"requestId":"` + randomID() + `"}`, 403},
		{p, `{"requestId":"` + randomID() + `","path":"/etc/shadow"}`, 400},
	} {
		r = httptest.NewRequest("POST", "/api/config-snapshots/sources/"+id+"/captures", strings.NewReader(tc.body))
		r = r.WithContext(auth.ContextWithPrincipal(r.Context(), tc.principal))
		w = httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("HTTP permission or bounded body contract not enforced")
		}
	}
}

func TestApprovedFilesAreReadWithoutMutation(t *testing.T) {
	manifest := os.Getenv("CONFIG_TEST_APPROVED_MANIFEST")
	if manifest == "" {
		t.Skip("explicit approved-source manifest is required")
	}
	c, e := LoadCatalog(manifest)
	if e != nil {
		t.Fatal(e)
	}
	projected, metadata := 0, 0
	db := isolatedMongo(t)
	repo := NewRepository(db)
	if e = repo.Initialize(context.Background()); e != nil {
		t.Fatal(e)
	}
	service := NewService(repo, c, []byte(strings.Repeat("test-only-approved-read-key", 2)), &testActors{}, nil, nil)
	principal := &auth.Principal{Username: "operator", Role: "operator", NormalizedRole: "operator"}
	for _, source := range c.Sources {
		before, e := os.ReadFile(source.Path)
		if e != nil {
			t.Fatal("approved source not readable")
		}
		data, reason := readSource(context.Background(), c.Root, source)
		if reason != "" {
			t.Fatalf("approved source read failed: %s / %s", source.Name, reason)
		}
		mode, _, projection := Projection(data, source.Format, source.Profile)
		if mode == "projected" {
			projected++
		} else {
			metadata++
		}
		if !json.Valid([]byte(projection)) && projection != "" {
			t.Fatal("invalid safe projection")
		}
		observation, e := service.Capture(context.Background(), principal, source.SourceID, CaptureRequest{randomID()})
		if e != nil || observation.Status != "ok" {
			t.Fatal("approved source did not complete the isolated publication pipeline")
		}
		saved, e := service.Snapshot(context.Background(), source.SourceID, observation.SnapshotID)
		if e != nil || saved.Mode != mode || saved.Projection != projection {
			t.Fatal("approved safe projection changed during persistence")
		}
		after, e := os.ReadFile(source.Path)
		if e != nil || sum(before) != sum(after) {
			t.Fatal("source file changed during read-only acceptance")
		}
	}
	t.Logf("approved_sources=%d projected=%d metadata_only=%d source_writes=0", len(c.Sources), projected, metadata)
}

func TestScheduleCollectsOtherSourcesAndStopsWorkers(t *testing.T) {
	db := isolatedMongo(t)
	dir := t.TempDir()
	slowID, fastID := randomID(), randomID()
	sources := []Source{
		{SourceID: slowID, Name: "slow", CollectorID: randomID(), Format: "yaml", Profile: PolicyVersion, Generation: "g", IntervalSeconds: 60},
		{SourceID: fastID, Name: "fast", CollectorID: randomID(), Format: "yaml", Profile: PolicyVersion, Generation: "g", IntervalSeconds: 60},
	}
	s := NewService(NewRepository(db), Catalog{Sources: sources, Root: dir, State: "configured"}, []byte(strings.Repeat("test-only-key-", 3)), nil, nil, nil)
	slowStarted := make(chan struct{}, 1)
	fastStarted := make(chan struct{}, 1)
	s.read = func(ctx context.Context, _ string, source Source) ([]byte, string) {
		if source.SourceID == slowID {
			slowStarted <- struct{}{}
			<-ctx.Done()
			return nil, "cancelled"
		}
		fastStarted <- struct{}{}
		return []byte("amf: {sbi: {server: {address: 127.0.0.5}}}"), ""
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); s.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	for deadline := time.Now().Add(time.Second); ; {
		s.workerMu.Lock()
		ready := s.workerState == "running"
		if ready {
			for _, source := range sources {
				s.next[source.SourceID] = time.Now().Add(-time.Second)
			}
		}
		s.workerMu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker did not start")
		}
		time.Sleep(time.Millisecond)
	}
	for _, started := range []chan struct{}{slowStarted, fastStarted} {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("one slow source serialized the other scheduled source")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("scheduled worker survived cancellation")
	}
	if s.Meta()["workerState"] != "stopped" {
		t.Fatal("worker exit was not visible")
	}
}
