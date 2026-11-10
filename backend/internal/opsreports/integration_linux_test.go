//go:build linux

package opsreports

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
)

func reportTestDB(t *testing.T) *mongo.Database {
	t.Helper()
	if os.Getenv("CONFIG_TEST_MONGOD") != "1" {
		t.Skip("explicit isolated mongod integration flag required")
	}
	bin, e := exec.LookPath("mongod")
	if e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	dir := t.TempDir()
	command := exec.Command(bin, "--bind_ip", "127.0.0.1", "--port", fmt.Sprint(port), "--dbpath", dir, "--logpath", filepath.Join(dir, "mongo.log"), "--quiet")
	if e = command.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = command.Process.Signal(syscall.SIGTERM); _ = command.Wait() })
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
	return client.Database("ops_report_isolated_test")
}
func TestMongoWindowsScopesMetricsAndReadOnly(t *testing.T) {
	db := reportTestDB(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	q := Query{From: now.Add(-24 * time.Hour), To: now, Limit: 50}
	resource := "11111111-1111-4111-8111-111111111111"
	target := "22222222-2222-4222-8222-222222222222"
	stamp := func(d time.Duration) string { return q.From.Add(d).Format(time.RFC3339) }
	rows := []any{
		bson.M{"_id": "a", "resourceId": resource, "severity": "critical", "state": "resolved", "firstTriggeredAt": stamp(time.Hour), "acknowledgedAt": stamp(2 * time.Hour), "resolvedAt": q.To.Add(time.Hour).Format(time.RFC3339), "resolvedReason": "recovery"},
		bson.M{"_id": "b", "resourceId": resource, "severity": "warning", "state": "resolved", "firstTriggeredAt": stamp(-time.Hour), "acknowledgedAt": stamp(time.Hour), "resolvedAt": stamp(2 * time.Hour), "resolvedReason": "manual"},
		bson.M{"_id": "c", "resourceId": resource, "severity": "critical", "state": "active", "firstTriggeredAt": q.To.Format(time.RFC3339)},
		bson.M{"_id": "bad-time", "resourceId": resource, "state": "active", "firstTriggeredAt": "not-a-date"},
	}
	for i := 0; i < 65; i++ {
		rows = append(rows, bson.M{"_id": fmt.Sprintf("extra-%03d", i), "resourceId": resource, "severity": "info", "state": "active", "firstTriggeredAt": stamp(3 * time.Hour), "triggerCount": 999})
	}
	if _, e := db.Collection("app_nf_alerts").InsertMany(ctx, rows); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Collection("app_inventory_resources").InsertOne(ctx, bson.M{"_id": resource, "domain": "5gc"}); e != nil {
		t.Fatal(e)
	}
	metrics := []any{}
	for i := 0; i < 3; i++ {
		instance := "A"
		value := float64(10 + i*10)
		if i == 2 {
			instance = "B"
			value = 90
		}
		metrics = append(metrics, bson.M{"_id": fmt.Sprint(i), "targetId": target, "resourceId": resource, "collectedAt": stamp(time.Duration(i+1) * time.Hour), "metrics": bson.A{bson.M{"key": "process_cpu_seconds_total", "value": float64(5 + i), "type": "counter", "unit": "seconds", "labels": bson.M{"instance": "A"}}, bson.M{"key": "memory_usage", "value": value, "type": "gauge", "unit": "bytes", "labels": bson.M{"instance": instance}}}})
	}
	if _, e := db.Collection("app_nf_health_samples").InsertMany(ctx, metrics); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Collection("app_agents").InsertOne(ctx, bson.M{"_id": "agent-a", "enabled": true, "lastReceivedAt": now}); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Collection("app_config_observations").InsertOne(ctx, bson.M{"_id": "capture-a", "sourceId": "source-a", "resourceId": resource, "published": true, "collectedAt": now.Add(-time.Hour), "status": "ok", "changed": true}); e != nil {
		t.Fatal(e)
	}
	before, e := db.ListCollectionNames(ctx, bson.M{})
	if e != nil {
		t.Fatal(e)
	}
	s := NewService(NewRepository(db), func() map[string]any { return map[string]any{"catalogState": "configured"} })
	r := s.Generate(ctx, q, "")
	if r.Alerts.Completeness != "partial" {
		t.Fatalf("alert aggregation unavailable: %#v", r.Alerts)
	}
	a := r.Alerts.Data.(map[string]any)
	if a["new"] != int64(66) || a["acknowledged"] != int64(2) || a["closed"] != int64(1) {
		t.Fatalf("window cohorts incorrect: %#v", a)
	}
	if len(r.AlertRows) != 67 {
		t.Fatalf("detail cohort differs: %d", len(r.AlertRows))
	}
	if r.Metrics.Completeness != "complete" || len(r.MetricRows) != 3 {
		t.Fatalf("metric scopes collapsed: %#v / %d", r.Metrics, len(r.MetricRows))
	}
	for _, row := range r.MetricRows {
		if row["type"] == "counter" && row["mean"] != nil {
			t.Fatal("counter acquired a mean")
		}
		if row["type"] == "gauge" && row["label_instance"] == "A" && row["mean"] != float64(15) {
			t.Fatal("gauge mean incorrect")
		}
	}
	p, e := s.Page(ctx, q, "alerts")
	if e != nil || len(p.Items) != 50 || !p.HasMore {
		t.Fatal("full summary was replaced by current page")
	}
	q.Cursor = *p.NextCursor
	p, e = s.Page(ctx, q, "alerts")
	if e != nil || len(p.Items) != 17 || p.HasMore {
		t.Fatal("report cursor continuation wrong")
	}
	q.Cursor = ""
	q.Domain = "5gc"
	r = s.Generate(ctx, q, "")
	if r.Agents.Completeness != "unavailable" || r.Agents.Scope != "unsupported_filter" {
		t.Fatal("resource-filtered report leaked global agent counts")
	}
	if r.Alerts.Completeness != "partial" {
		t.Fatal("explicit domain lookup failed")
	}
	q.Domain = ""
	q.Severity = "critical"
	r = s.Generate(ctx, q, "")
	if r.Metrics.Completeness != "unavailable" || r.Config.Completeness != "unavailable" {
		t.Fatal("unsupported severity scope showed platform totals")
	}
	after, e := db.ListCollectionNames(ctx, bson.M{})
	if e != nil || len(before) != len(after) {
		t.Fatal("report created a collection")
	}
	count, e := db.Collection("app_nf_alerts").CountDocuments(ctx, bson.M{})
	if e != nil || count != 69 {
		t.Fatal("report changed alert records")
	}
}
