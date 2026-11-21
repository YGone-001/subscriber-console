package notify

import (
	"context"
	"encoding/json"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"io"
	"net/http"
	"net/http/httptest"
	"subscriber/internal/nfalert"
	"sync"
	"testing"
	"time"
)

func TestMetricOutboxDeduplicatesAndRetainsWebhookSummary(t *testing.T) {
	ctx := context.Background()
	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017").SetServerSelectionTimeout(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect(ctx)
	if err := client.Ping(ctx, nil); err != nil {
		t.Skip("MongoDB unavailable")
	}
	db := client.Database("xcloud_test_metric_notify_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	deliveries := db.Collection("app_nf_notification_deliveries")
	if _, err := deliveries.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "deliveryKey", Value: 1}}, Options: options.Index().SetUnique(true)}); err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db.Collection("channels"), db.Collection("escalations"), deliveries, nil)
	if _, err := repo.escalations.InsertOne(ctx, Escalation{ID: "esc", Enabled: true, Severities: []string{"warning"}, ChannelIDs: []string{"initial"}, EscalateAfterSeconds: 60, EscalateChannelIDs: []string{"later"}}); err != nil {
		t.Fatal(err)
	}
	threshold, recovery := 100.0, 50.0
	event := nfalert.AlertEvent{Event: nfalert.AlertEventOpened, AlertID: "alert", RuleID: "rule", Severity: "warning", Metric: &nfalert.MetricAlertSummary{RuleRevision: 7, Condition: &nfalert.MetricCondition{Metric: "process_resident_memory_bytes", Series: "unlabeled", Operator: "gt", Threshold: &threshold, RecoveryThreshold: &recovery}, Trigger: &nfalert.MetricEvidence{Metric: "process_resident_memory_bytes", Value: 150, Unit: "bytes", Subject: "exporter_process", SampleID: "expired-sample"}}}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); repo.NotifyAlert(ctx, event) }()
	}
	wg.Wait()
	n, err := deliveries.CountDocuments(ctx, bson.M{})
	if err != nil || n != 2 {
		t.Fatalf("replay duplicated delivery/escalation: %d %v", n, err)
	}
	var delayed Delivery
	if err := deliveries.FindOne(ctx, bson.M{"event": DeliveryEventEscalate}).Decode(&delayed); err != nil {
		t.Fatal(err)
	}
	if delayed.NotBefore.IsZero() || delayed.Metric.RuleRevision != 7 {
		t.Fatal("escalation lost snapshot or delay")
	}
	event.Event = nfalert.AlertEventResolved
	event.ResolvedReason = nfalert.ResolveReasonConfigurationChanged
	repo.NotifyAlert(ctx, event)
	repo.NotifyAlert(ctx, event)
	var closed Delivery
	if err := deliveries.FindOne(ctx, bson.M{"event": nfalert.AlertEventResolved}).Decode(&closed); err != nil {
		t.Fatal(err)
	}
	var payload WebhookPayload
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Error(err)
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	if err := NewWebhookSender(server.Client()).Send(ctx, &NotificationChannel{URL: server.URL}, &closed); err != nil {
		t.Fatal(err)
	}
	if payload.Metric == nil || payload.Metric.Trigger.Value != 150 || payload.Metric.Condition.Operator != "gt" || payload.ResolvedReason != "configuration_changed" || payload.Metric.Recovery != nil {
		t.Fatalf("webhook summary incomplete: %+v", payload)
	}
	n, _ = deliveries.CountDocuments(ctx, bson.M{})
	if n != 3 {
		t.Fatal("resolved retry duplicated delivery")
	}
}
