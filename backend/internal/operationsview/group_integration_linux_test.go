//go:build linux

package operationsview_test

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/agents"
	"subscriber/internal/configsnapshots"
	"subscriber/internal/inventory"
	"subscriber/internal/nfalert"
	"subscriber/internal/operationsview"
	"subscriber/internal/opsreports"
)

func ownedGroupDB(t *testing.T) *mongo.Database {
	t.Helper()
	if os.Getenv("GROUPS_TEST_MONGOD") != "1" {
		t.Skip("explicit owned mongod integration flag required")
	}
	bin, e := exec.LookPath("mongod")
	if e != nil {
		t.Fatal(e)
	}
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	dir := t.TempDir()
	cmd := exec.Command(bin, "--bind_ip", "127.0.0.1", "--port", fmt.Sprint(port), "--dbpath", dir, "--logpath", filepath.Join(dir, "mongo.log"), "--quiet")
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
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		e = client.Ping(ctx, nil)
		cancel()
		if e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("owned mongod readiness timeout")
		}
		time.Sleep(100 * time.Millisecond)
	}
	return client.Database("groups_isolated_test")
}
func fixtureGroupID(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012x", n) }
func fixtureGroupResource(n int, kind, network string) inventory.Resource {
	attrs := map[string]any{}
	if network != "" {
		attrs[inventory.OperationalScopesAttribute] = []inventory.OperationalScope{{NetworkKey: network, OperatorName: "DEMO Operator " + network, PLMNs: []string{"00101", "001001"}}}
	}
	return inventory.Resource{ResourceID: fixtureGroupID(n), Kind: kind, Name: fmt.Sprintf("demo-%s-%d", kind, n), NameNormalized: fmt.Sprintf("demo-%s-%d", kind, n), DisplayName: fmt.Sprintf("DEMO / %s %d", kind, n), Domain: "platform", LifecycleState: "active", Revision: 1, Attributes: attrs, Source: inventory.SourceMetadata{Kind: "manual", System: "xcloud", Authority: "authoritative"}, CreatedAt: time.Now().UTC().Format(time.RFC3339), UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
}
func seedGroupData(t *testing.T, db *mongo.Database) {
	t.Helper()
	ctx := context.Background()
	resources := []any{fixtureGroupResource(1, "site", "a"), fixtureGroupResource(2, "site", "b"), fixtureGroupResource(3, "host", "a"), fixtureGroupResource(4, "host", "b"), fixtureGroupResource(5, "network_function", "a"), fixtureGroupResource(6, "network_function_instance", "a"), fixtureGroupResource(7, "network_function", "b"), fixtureGroupResource(8, "host", "")}
	for _, r := range []inventory.Resource{fixtureGroupResource(5, "network_function", "a"), fixtureGroupResource(6, "network_function_instance", "a"), fixtureGroupResource(7, "network_function", "b")} {
		for i := range resources {
			if res := resources[i].(inventory.Resource); res.ResourceID == r.ResourceID {
				r.Domain = "5gc"
				resources[i] = r
			}
		}
	}
	if _, e := db.Collection("app_inventory_resources").InsertMany(ctx, resources); e != nil {
		t.Fatal(e)
	}
	for i, pair := range [][2]int{{1, 3}, {2, 4}, {3, 5}, {3, 6}, {4, 7}} {
		_, e := db.Collection("app_topology_edges").InsertOne(ctx, bson.M{"_id": fixtureGroupID(100 + i), "fromResourceId": fixtureGroupID(pair[0]), "toResourceId": fixtureGroupID(pair[1]), "relationshipType": "contains", "lifecycleState": "active", "revision": 1})
		if e != nil {
			t.Fatal(e)
		}
	}
	_, e := db.Collection("app_topology_edges").Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "fromResourceId", Value: 1}, {Key: "toResourceId", Value: 1}, {Key: "relationshipType", Value: 1}}, Options: options.Index().SetName("uniq_topology_active_edge").SetUnique(true).SetPartialFilterExpression(bson.M{"lifecycleState": "active"})})
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	agentRecords := []any{agents.Record{AgentID: "01234567890123456789012345678901", Metadata: agents.Metadata{Name: "DEMO collector A", Scope: agents.Scope{NetworkKey: "a", OperatorName: "DEMO Operator a", SiteResourceID: fixtureGroupID(1), HostResourceID: fixtureGroupID(3), PLMNs: []string{"00101"}}}, Enabled: true, Revision: 1, LastReceivedAt: &now, Observation: &agents.Observation{CollectedAt: now.Format(time.RFC3339), HostName: "demo-host-a", ScanComplete: true, Visibility: "host", Metrics: agents.Metrics{}}}, agents.Record{AgentID: "01234567890123456789012345678902", Metadata: agents.Metadata{Name: "DEMO conflicting collector", Scope: agents.Scope{NetworkKey: "b", OperatorName: "DEMO Operator b", SiteResourceID: fixtureGroupID(2), HostResourceID: fixtureGroupID(3), PLMNs: []string{"001001"}}}, Enabled: true, Revision: 1}}
	if _, e = db.Collection("app_agents").InsertMany(ctx, agentRecords); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 61; i++ {
		state := "active"
		if i == 60 {
			state = "resolved"
		}
		_, e = db.Collection("app_nf_alerts").InsertOne(ctx, nfalert.Alert{AlertID: fixtureGroupID(200 + i), RuleName: fmt.Sprintf("DEMO alert %d", i), TargetName: "DEMO AMF", ResourceID: fixtureGroupID(5), Severity: "warning", State: state, ConditionType: "state", Condition: nfalert.RuleCondition{Scope: "overall", State: "unhealthy"}, TriggerCount: 1, FirstTriggeredAt: now.Add(-time.Hour).Format(time.RFC3339), LastTriggeredAt: now.Format(time.RFC3339), UpdatedAt: now.Format(time.RFC3339)})
		if e != nil {
			t.Fatal(e)
		}
	}
}

func TestGroupMongoScopeDirectoryAndFullQueue(t *testing.T) {
	db := ownedGroupDB(t)
	seedGroupData(t, db)
	ctx := context.Background()
	repo := operationsview.NewGroupRepository(db)
	service := operationsview.NewGroupService(repo, nil, nil)
	scope, e := service.ResolveGroupScope(ctx, operationsview.GroupFilter{SiteResourceID: fixtureGroupID(1), NetworkKey: "a"})
	if e != nil || len(scope.IDs) != 4 {
		t.Fatalf("site/network intersection: %d %v", len(scope.IDs), e)
	}
	rows, more, e := repo.Directory(ctx, operationsview.GroupQuery{GroupBy: "network", Limit: 50})
	if e != nil || more || len(rows) != 2 {
		t.Fatalf("directory aggregation: %#v %v", rows, e)
	}
	malformed := fixtureGroupResource(10, "host", "")
	malformed.Attributes[inventory.OperationalScopesAttribute] = []any{bson.M{"networkKey": "invalid-only", "operatorName": "x", "plmns": bson.A{"00101", "00101"}}}
	if _, e = db.Collection("app_inventory_resources").InsertOne(ctx, malformed); e != nil {
		t.Fatal(e)
	}
	rows, _, e = repo.Directory(ctx, operationsview.GroupQuery{GroupBy: "network", Limit: 50})
	if e != nil || len(rows) != 2 {
		t.Fatalf("malformed declaration made a group: %#v %v", rows, e)
	}
	page, e := service.Members(ctx, operationsview.GroupQuery{GroupFilter: operationsview.GroupFilter{SiteResourceID: fixtureGroupID(1)}, Section: "alerts", Limit: 10})
	if e != nil || len(page.Items) != 10 || !page.HasMore || page.Coverage.ObservedCount != 60 {
		t.Fatalf("queue totals counted a page: %#v %v", page, e)
	}
	q := operationsview.GroupQuery{GroupFilter: operationsview.GroupFilter{SiteResourceID: fixtureGroupID(1)}, Section: "alerts", Limit: 10, Cursor: *page.NextCursor}
	next, e := service.Members(ctx, q)
	if e != nil || len(next.Items) != 10 {
		t.Fatal("queue cursor failed", e)
	}
	firstJSON, _ := bson.Marshal(page.Items[0])
	nextJSON, _ := bson.Marshal(next.Items[0])
	if string(firstJSON) == string(nextJSON) {
		t.Fatal("queue repeated first page")
	}
	decoded, e := repo.Resource(ctx, fixtureGroupID(3))
	if e != nil {
		t.Fatal(e)
	}
	if _, ok := decoded.Attributes[inventory.OperationalScopesAttribute].([]inventory.OperationalScope); !ok {
		t.Fatal("reserved metadata was not normalized for JSON")
	}
	before, _ := db.Collection("app_inventory_resources").CountDocuments(ctx, bson.M{})
	summary, e := service.Summary(ctx, operationsview.GroupFilter{NetworkKey: "a"})
	if e != nil || summary.Counts["agents"] == nil || *summary.Counts["agents"] != 1 {
		t.Fatal("diagnostic Agent references contaminated the declared population", e)
	}
	issuePage, e := service.Members(ctx, operationsview.GroupQuery{GroupFilter: operationsview.GroupFilter{NetworkKey: "a"}, Section: "issues", Limit: 200})
	if e != nil {
		t.Fatal(e)
	}
	foundConflict := false
	for _, v := range issuePage.Items {
		issue := v.(operationsview.GroupIssue)
		foundConflict = foundConflict || issue.Code == "agent_network_conflict"
	}
	if !foundConflict {
		t.Fatal("network filter hid a conflicting Agent bound to a selected host")
	}
	after, _ := db.Collection("app_inventory_resources").CountDocuments(ctx, bson.M{})
	if before != after {
		t.Fatal("read projection changed inventory")
	}
	reportRepo := opsreports.NewRepository(db)
	reports := opsreports.NewService(reportRepo, nil)
	reports.SetGroups(service, nil)
	r := reports.Generate(ctx, opsreports.Query{From: time.Now().Add(-2 * time.Hour), To: time.Now(), SiteResourceID: fixtureGroupID(1)}, "")
	if r.Alerts.Completeness != "complete" || r.Alerts.Data.(map[string]any)["currentOpen"] != int64(60) {
		t.Fatalf("report scope differs from workbench: %#v", r.Alerts)
	}
	r = reports.Generate(ctx, opsreports.Query{From: time.Now().Add(-2 * time.Hour), To: time.Now(), SiteResourceID: fixtureGroupID(2)}, "")
	if r.Alerts.Completeness != "complete" || r.Alerts.Data.(map[string]any)["currentOpen"] != int64(0) {
		t.Fatalf("empty site report became global: %#v", r.Alerts)
	}
}

func TestGroupMongoConfigurationScopeIsMetadataOnly(t *testing.T) {
	db := ownedGroupDB(t)
	seedGroupData(t, db)
	ctx := context.Background()
	first := configsnapshots.Source{SourceID: fixtureGroupID(501), ResourceID: fixtureGroupID(5), Name: "DEMO selected"}
	other := configsnapshots.Source{SourceID: fixtureGroupID(502), ResourceID: fixtureGroupID(7), Name: "DEMO other"}
	for _, source := range []configsnapshots.Source{first, other} {
		state := configsnapshots.State{SourceID: source.SourceID, Source: source, Revision: 1, LatestEvidence: &configsnapshots.Snapshot{Projection: "PRIVATE_PROJECTION_NOT_FOR_GROUPS"}}
		if _, e := db.Collection("app_config_sources").InsertOne(ctx, state); e != nil {
			t.Fatal(e)
		}
	}
	repo := configsnapshots.NewRepository(db)
	states, more, e := repo.StatesForResources(ctx, []string{first.ResourceID}, nil, 1000)
	if e != nil || more || len(states) != 1 || states[0].SourceID != first.SourceID || states[0].LatestEvidence.Projection != "" {
		t.Fatalf("scoped state leaked another source or projection: %#v %v", states, e)
	}
	service := configsnapshots.NewService(repo, configsnapshots.Catalog{State: "configured", Sources: []configsnapshots.Source{first, other}}, nil, nil, inventory.NewRepository(db.Collection("app_inventory_resources")), nil)
	page, e := service.List(ctx, configsnapshots.ListQuery{Limit: 10, ResourceIDs: []string{first.ResourceID}})
	if e != nil || page.Completeness != "complete" || len(page.Items) != 1 || (*page.Summary)["total"] != 1 || page.Items[0].LatestSnapshot != nil {
		t.Fatalf("scoped listing differs from metadata projection: %#v %v", page, e)
	}
	empty, e := service.List(ctx, configsnapshots.ListQuery{Limit: 10, ResourceIDs: []string{}})
	if e != nil || len(empty.Items) != 0 || empty.Summary == nil || (*empty.Summary)["total"] != 0 {
		t.Fatalf("empty configuration scope became global: %#v %v", empty, e)
	}
}
