package subscriber

import (
	"context"
	"fmt"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The typed list documents keep stored timestamps as raw BSON values, which
// point into the decoded wire batch. A list that spans several batches must
// still report every stored timestamp, so this seeds more subscribers than one
// batch holds, mixes the two shapes xCloud actually stores (BSON dates and RFC
// 3339 strings) and checks each row individually.
func TestSubscriberListLastActiveAcrossBatches(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	const total = 300
	base := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	docs := make([]any, 0, total)
	want := make(map[string]string, total)
	for index := 0; index < total; index++ {
		imsi := fmt.Sprintf("46002000000%04d", index)
		timestamp := base.Add(time.Duration(index) * time.Minute)
		expected := timestamp.UTC().Format("2006-01-02T15:04:05.000Z")
		doc := bson.M{
			// A string identifier keeps the document's own creation instant out of
			// the candidate set, so the row can only report the stored value.
			"_id":                     fmt.Sprintf("sub-%04d", index),
			"imsi":                    imsi,
			"access_restriction_data": 32,
		}
		if index%2 == 0 {
			doc["updated_at"] = timestamp
		} else {
			doc["updated_at"] = expected
		}
		docs = append(docs, doc)
		want[imsi] = expected
	}
	if _, err := repo.subscribers.InsertMany(ctx, docs); err != nil {
		t.Fatalf("seed subscribers: %v", err)
	}

	filters := SubscriberListFilters{SearchBy: "imsi", Status: "all"}
	checked := 0
	for page := 1; page <= 2; page++ {
		result, err := repo.ListSubscriberRowsFiltered(ctx, page, 200, "", filters, "imsi", "asc")
		if err != nil {
			t.Fatalf("list page %d: %v", page, err)
		}
		if result.Total != total {
			t.Fatalf("total = %d, want %d", result.Total, total)
		}
		for _, row := range result.Subscribers {
			if row.LastActive != want[row.IMSI] {
				t.Fatalf("%s lastActive = %q, want %q", row.IMSI, row.LastActive, want[row.IMSI])
			}
			checked++
		}
	}
	if checked != total {
		t.Fatalf("checked %d rows, want %d", checked, total)
	}
}

// The legacy msisdnList form is stored as an array of documents, which the
// driver decodes as bson.D. The row must read it instead of falling through to
// the contract number.
func TestSubscriberListReadsLegacyMsisdnList(t *testing.T) {
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := repo.subscribers.InsertOne(ctx, bson.M{
		"imsi":       "460020000000101",
		"msisdnList": bson.A{bson.M{"msisdn": "18800000101"}},
	}); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := repo.ocsSubs.InsertOne(ctx, bson.M{
		"imsi": "460020000000101", "status": "active", "plan_id": "", "msisdn": "18800000901",
	}); err != nil {
		t.Fatalf("seed contract: %v", err)
	}

	result, err := repo.ListSubscriberRowsFiltered(ctx, 1, 50, "",
		SubscriberListFilters{SearchBy: "imsi", Status: "all"}, "imsi", "asc")
	if err != nil {
		t.Fatalf("list subscribers: %v", err)
	}
	if len(result.Subscribers) != 1 {
		t.Fatalf("rows = %d, want 1", len(result.Subscribers))
	}
	row := result.Subscribers[0]
	if row.MSISDN != "18800000101" {
		t.Fatalf("MSISDN = %q, want the subscriber's msisdnList value", row.MSISDN)
	}
	if row.Policy != "" || row.Provisioning.TariffPlan {
		t.Fatalf("an empty plan id must not resolve to a tariff plan, got policy=%q provisioning=%+v",
			row.Policy, row.Provisioning)
	}
}
