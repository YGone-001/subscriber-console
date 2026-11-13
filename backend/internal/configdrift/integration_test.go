package configdrift_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"subscriber/internal/auth"
	"subscriber/internal/configdrift"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/investigation"
	"subscriber/internal/notify"
	"subscriber/internal/operationsview"
	"subscriber/internal/user"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const sourceID = "10000000-0000-4000-8000-000000000001"
const resourceID = "20000000-0000-4000-8000-000000000001"

func id(n int) string { return fmt.Sprintf("40000000-0000-4000-8000-%012d", n) }
func ownedMongo(t *testing.T) *mongo.Database {
	t.Helper()
	bin := os.Getenv("CONFIG_DRIFT_TEST_MONGOD")
	if bin == "" {
		t.Skip("CONFIG_DRIFT_TEST_MONGOD must name an owned test executable")
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	dir := t.TempDir()
	cmd := exec.Command(bin, "--bind_ip", "127.0.0.1", "--port", fmt.Sprint(port), "--dbpath", dir, "--logpath", filepath.Join(dir, "mongo.log"), "--quiet")
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	c, e := mongo.Connect(options.Client().ApplyURI(fmt.Sprintf("mongodb://127.0.0.1:%d", port)).SetServerSelectionTimeout(200 * time.Millisecond))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = c.Disconnect(context.Background()) })
	for deadline := time.Now().Add(20 * time.Second); ; {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		e = c.Ping(ctx, nil)
		cancel()
		if e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("owned Mongo not ready", e)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return c.Database("config_drift_isolated")
}

type actors struct{ disabled atomic.Bool }

func (a *actors) FindByUsernameIdentity(context.Context, string) (*user.UserIdentity, error) {
	status := "active"
	if a.disabled.Load() {
		status = "disabled"
	}
	return &user.UserIdentity{SafeUser: user.SafeUser{Username: "operator", Role: "operator", Status: status}}, nil
}

type resources struct{ retired atomic.Bool }

func (r *resources) GetByID(context.Context, string) (*inventory.Resource, error) {
	v := &inventory.Resource{ResourceID: resourceID}
	if r.retired.Load() {
		v.LifecycleState = inventory.LifecycleRetired
	}
	return v, nil
}

type publicationFault struct {
	configsnapshots.Repository
	fail atomic.Bool
}

func (r *publicationFault) Publish(c context.Context, p *configsnapshots.Pending) error {
	if r.fail.Swap(false) {
		return errors.New("synthetic publication interruption")
	}
	return r.Repository.Publish(c, p)
}

type materializationFault struct {
	configdrift.Store
	fail atomic.Bool
}

func (r *materializationFault) Materialize(c context.Context, m *configdrift.Mutation) error {
	if e := r.Store.Materialize(c, m); e != nil {
		return e
	}
	if r.fail.Swap(false) {
		return errors.New("synthetic post-materialization interruption")
	}
	return nil
}
func operator() *auth.Principal {
	return &auth.Principal{Username: "operator", Role: "operator", NormalizedRole: "operator"}
}
func TestMongoPublicationDriftRecoveryAndGovernance(t *testing.T) {
	db := ownedMongo(t)
	ctx := context.Background()
	cr := configsnapshots.NewRepository(db)
	if e := cr.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "mme.yaml")
	write := func(v string) {
		t.Helper()
		if e := os.WriteFile(path, []byte("mme: {s1ap: {address: "+v+"}}"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	manifest := configsnapshots.Manifest{CollectorID: id(90), Root: dir, Sources: []configsnapshots.SourceDeclaration{{SourceID: sourceID, Name: "Synthetic MME", ResourceID: resourceID, Path: path, Format: "yaml", Profile: configsnapshots.PolicyVersion}}}
	b, _ := json.Marshal(manifest)
	catalog, e := configsnapshots.ParseCatalog(b)
	if e != nil {
		t.Fatal(e)
	}
	a := &actors{}
	res := &resources{}
	fault := &publicationFault{Repository: cr}
	s := configsnapshots.NewService(fault, catalog, []byte("synthetic-test-key-at-least-32-bytes"), a, res, nil)
	dr := configdrift.NewRepository(db)
	if e = dr.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	projection := &materializationFault{Store: dr}
	d := configdrift.NewService(projection, s, a, nil)
	nr := notify.NewRepository(db.Collection("app_nf_notification_channels"), db.Collection("app_nf_notification_escalations"), db.Collection("app_nf_notification_deliveries"), nil)
	channel, e := nr.CreateChannel(ctx, &notify.CreateChannelRequest{Name: "Isolated fixture", Kind: "webhook", URL: "http://127.0.0.1:9/unused"}, "operator")
	if e != nil {
		t.Fatal(e)
	}
	_, e = nr.CreateEscalation(ctx, &notify.CreateEscalationRequest{Name: "Explicit configuration subscription", SubjectKinds: []string{"config_drift"}, Severities: []string{"warning"}, ChannelIDs: []string{channel.ID}}, "operator")
	if e != nil {
		t.Fatal(e)
	}
	d.SetSink(nr)
	empty, _, _, e := nr.ListDeliveries(ctx, notify.DeliveryListFilter{SubjectKind: "config_drift", Limit: 50})
	if e != nil || empty == nil || len(empty) != 0 {
		t.Fatal("new configuration delivery envelope must contain an empty array", e)
	}
	capture := func(n int) *configsnapshots.Observation {
		t.Helper()
		o, e := s.Capture(ctx, operator(), sourceID, configsnapshots.CaptureRequest{RequestID: id(n)})
		if e != nil {
			t.Fatal(e)
		}
		return o
	}
	run := func() {
		t.Helper()
		if e := d.RunOnce(ctx); e != nil {
			t.Fatal(e)
		}
	}
	alerts := func(state string) []configdrift.Alert {
		t.Helper()
		p, e := d.List(ctx, configdrift.ListQuery{State: state, Limit: 50}, operationsview.GroupFilter{})
		if e != nil {
			t.Fatal(e)
		}
		return p.Items
	}
	write("127.0.0.1")
	base := capture(1)
	v, e := s.Get(ctx, sourceID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Baseline(ctx, operator(), sourceID, configsnapshots.BaselineRequest{ExpectedRevision: v.Revision, SnapshotID: &base.SnapshotID}); e != nil {
		t.Fatal(e)
	}
	enabled := true
	req := configsnapshots.DriftPolicyRequest{ExpectedRevision: 0, Enabled: &enabled, Severity: "warning"}
	if _, e = d.SetPolicy(ctx, operator(), sourceID, req); e != nil {
		t.Fatal(e)
	}
	run()
	if len(alerts("")) != 0 {
		t.Fatal("enabling replayed history")
	}
	write("127.0.0.2")
	fault.fail.Store(true)
	if _, e = s.Capture(ctx, operator(), sourceID, configsnapshots.CaptureRequest{RequestID: id(2)}); e == nil {
		t.Fatal("publication fault not hit")
	}
	// A new service instance repairs the durable pending publication before draining.
	restarted := configsnapshots.NewService(cr, catalog, []byte("synthetic-test-key-at-least-32-bytes"), a, res, nil)
	d = configdrift.NewService(projection, restarted, a, nil)
	d.SetSink(nr)
	projection.fail.Store(true)
	if e = d.RunOnce(ctx); e == nil {
		t.Fatal("post-write projection interruption not hit")
	}
	run()
	open := alerts("open")
	if len(open) != 1 {
		t.Fatal("drift episode missing")
	}
	first := open[0]
	duplicate := capture(3)
	if duplicate.Changed == nil || *duplicate.Changed {
		t.Fatal("adjacent comparison was overwritten by baseline drift")
	}
	run()
	open = alerts("open")
	if len(open) != 1 || open[0].ID != first.ID || open[0].TriggerCount != 2 {
		t.Fatal("duplicate observation reopened episode")
	}
	if _, e = d.Acknowledge(ctx, operator(), first.ID, configdrift.AckRequest{ExpectedRevision: 1}); e == nil {
		t.Fatal("stale acknowledgment accepted")
	}
	projection.fail.Store(true)
	if _, e = d.Acknowledge(ctx, operator(), first.ID, configdrift.AckRequest{ExpectedRevision: open[0].Revision}); e == nil {
		t.Fatal("acknowledgment interruption not hit")
	}
	run()
	ack, e := dr.Alert(ctx, first.ID)
	if e != nil || ack.State != "acknowledged" {
		t.Fatal("acknowledgment journal was not repaired without a new observation", e)
	}
	if e = os.Remove(path); e != nil {
		t.Fatal(e)
	}
	capture(4)
	run()
	if len(alerts("open")) != 1 {
		t.Fatal("missing file caused recovery")
	}
	write("127.0.0.1")
	capture(5)
	run()
	if len(alerts("open")) != 0 || alerts("resolved")[0].EndReason != "returned_to_baseline" {
		t.Fatal("return to baseline not recovered")
	}
	deliveries, _, _, e := nr.ListDeliveries(ctx, notify.DeliveryListFilter{SubjectKind: "config_drift", SubjectID: first.ID, Limit: 50})
	if e != nil || len(deliveries) != 2 {
		t.Fatalf("opening/recovery outbox %d %v", len(deliveries), e)
	}
	write("127.0.0.3")
	capture(6)
	run()
	second := alerts("open")[0]
	if second.ID == first.ID {
		t.Fatal("reopened closed ID")
	}
	v, e = s.Get(ctx, sourceID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Baseline(ctx, operator(), sourceID, configsnapshots.BaselineRequest{ExpectedRevision: v.Revision, SnapshotID: &v.LatestSnapshot.SnapshotID}); e != nil {
		t.Fatal(e)
	}
	run()
	ended, e := dr.Alert(ctx, second.ID)
	if e != nil || ended.EndReason != "baseline_superseded" {
		t.Fatal("baseline change forged recovery")
	}
	viewer := &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}
	if _, e = d.SetPolicy(ctx, viewer, sourceID, req); e == nil {
		t.Fatal("viewer configured")
	}
	a.disabled.Store(true)
	req.ExpectedRevision = 1
	if _, e = d.SetPolicy(ctx, operator(), sourceID, req); e == nil {
		t.Fatal("revoked actor configured")
	}
	a.disabled.Store(false)
	// Concurrent CAS contenders produce exactly one durable policy revision.
	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := d.SetPolicy(ctx, operator(), sourceID, req); e == nil {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("CAS winners=%d", wins.Load())
	}
	run()
	if n, _ := db.Collection("app_config_drift_alerts").CountDocuments(ctx, bson.M{}); n != 2 {
		t.Fatalf("duplicate alerts %d", n)
	}
	state, e := cr.GetState(ctx, sourceID)
	if e != nil || len(state.DriftQueue) != 0 {
		t.Fatal("journal not drained", e)
	}

	ir := investigation.NewRepository(db)
	inv := investigation.NewService(ir, ir, a, nil, []byte("synthetic-investigation-cursor-key"))
	invReq := investigation.CreateRequest{RequestID: id(290), AnchorKind: "config_drift", AnchorID: first.ID, Title: "SYNTHETIC drift investigation", From: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), To: time.Now().UTC().Format(time.RFC3339Nano)}
	record, e := inv.Create(ctx, operator(), invReq)
	if e != nil || record.AlertID != "" || record.AnchorID != first.ID {
		t.Fatal("configuration anchor masqueraded as NF alert", e)
	}
	legacy, e := inv.List(ctx, investigation.ListQuery{Limit: 50})
	if e != nil || len(legacy.Items) != 0 {
		t.Fatal("legacy NF directory scope changed", e)
	}
	configCases, e := inv.List(ctx, investigation.ListQuery{AnchorKind: "config_drift", Limit: 50})
	if e != nil || len(configCases.Items) != 1 {
		t.Fatal("configuration investigation missing", e)
	}
	if _, e = inv.Update(ctx, operator(), record.ID, investigation.UpdateRequest{ExpectedRevision: record.Revision, Title: record.Title, Status: "resolved", Conclusion: "SYNTHETIC human conclusion"}); e != nil {
		t.Fatal(e)
	}
	unchanged, e := dr.Alert(ctx, first.ID)
	if e != nil || unchanged.EndReason != "returned_to_baseline" {
		t.Fatal("investigation changed source alert", e)
	}
	if _, e = inv.Context(ctx, investigation.ContextQuery{AlertID: first.ID, AnchorKind: "config_drift", AnchorID: first.ID}); e == nil {
		t.Fatal("mixed anchors accepted")
	}
	old := time.Now().UTC().AddDate(0, 0, -100)
	oldEnd := old.Add(time.Hour)
	for n := 300; n < 305; n++ {
		v := configdrift.Alert{ID: id(n), SourceID: id(n + 20), State: "resolved", ResolvedAt: &oldEnd, OpenedAt: old, Revision: 1}
		if n == 303 {
			v.State = "active"
		}
		if n == 304 {
			v.ExpiredAt = &oldEnd
		}
		if _, e = db.Collection("app_config_drift_alerts").InsertOne(ctx, v); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Collection("app_config_drift_events").InsertOne(ctx, configdrift.Event{ID: id(n + 30), AlertID: v.ID, At: old}); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = db.Collection("app_config_drift_sources").InsertOne(ctx, configdrift.State{SourceID: id(321), Version: 1, Pending: &configdrift.Mutation{Alert: configdrift.Alert{ID: id(301)}}}); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Collection("app_nf_notification_deliveries").InsertOne(ctx, notify.Delivery{ID: id(350), DeliveryKey: id(350), SubjectKind: "config_drift", SubjectID: id(302), Status: "failed"}); e != nil {
		t.Fatal(e)
	}
	if _, e = dr.Alert(ctx, id(304)); !errors.Is(e, configdrift.ErrNotFound) {
		t.Fatal("expiration marker exposed an empty-looking history")
	}
	if e = dr.Prune(ctx, time.Now().UTC()); e != nil {
		t.Fatal(e)
	}
	for _, n := range []int{300, 304} {
		if _, e = dr.Alert(ctx, id(n)); !errors.Is(e, configdrift.ErrNotFound) {
			t.Fatal("expired episode retained", n)
		}
	}
	for _, n := range []int{301, 302, 303} {
		if _, e = dr.Alert(ctx, id(n)); e != nil {
			t.Fatal("protected episode removed", n, e)
		}
	}
	before, _ := db.Collection("app_config_drift_events").CountDocuments(ctx, bson.M{})
	if _, e = d.Policy(ctx, sourceID); e != nil {
		t.Fatal(e)
	}
	after, _ := db.Collection("app_config_drift_events").CountDocuments(ctx, bson.M{})
	if before != after {
		t.Fatal("GET wrote state")
	}
}
