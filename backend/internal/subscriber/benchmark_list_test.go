package subscriber

import (
	"context"
	"fmt"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// seedListBenchmarkData builds a production-shaped dataset: one subscriber, one
// active OCS contract and one balance account per IMSI, plus the tariff plan the
// contracts reference. Indexes mirror the declared production index set so the
// measurement reflects the intended deployment rather than a collection scan.
func seedListBenchmarkData(b testing.TB, repo *Repository, count int) {
	b.Helper()
	ctx := context.Background()

	indexes := []struct {
		collection *mongo.Collection
		model      mongo.IndexModel
	}{
		{repo.subscribers, mongo.IndexModel{Keys: bson.D{{Key: "imsi", Value: 1}}, Options: options.Index().SetUnique(true)}},
		{repo.subscribers, mongo.IndexModel{Keys: bson.D{{Key: "msisdn", Value: 1}}}},
		{repo.ocsSubs, mongo.IndexModel{Keys: bson.D{{Key: "imsi", Value: 1}}, Options: options.Index().SetUnique(true)}},
		{repo.ocsBalances, mongo.IndexModel{Keys: bson.D{{Key: "imsi", Value: 1}}, Options: options.Index().SetUnique(true)}},
		{repo.tariffPlans, mongo.IndexModel{Keys: bson.D{{Key: "plan_id", Value: 1}}, Options: options.Index().SetUnique(true)}},
	}
	for _, index := range indexes {
		if _, err := index.collection.Indexes().CreateOne(ctx, index.model); err != nil {
			b.Fatalf("create benchmark index: %v", err)
		}
	}

	if _, err := repo.tariffPlans.InsertOne(ctx, bson.M{
		"plan_id":          "bench_plan",
		"status":           "active",
		"volume_threshold": int64(100 * 1024 * 1024),
	}); err != nil {
		b.Fatalf("seed benchmark plan: %v", err)
	}

	const batchSize = 1000
	for start := 0; start < count; start += batchSize {
		end := start + batchSize
		if end > count {
			end = count
		}
		subscribers := make(bson.A, 0, end-start)
		contracts := make(bson.A, 0, end-start)
		balances := make(bson.A, 0, end-start)
		for i := start; i < end; i++ {
			imsi := fmt.Sprintf("46000%010d", i)
			msisdn := fmt.Sprintf("%011d", 10000000000+i)
			subscribers = append(subscribers, bson.M{
				"imsi":                    imsi,
				"msisdn":                  bson.A{msisdn},
				"access_restriction_data": 32,
				"slice":                   []any{},
				"webui_meta":              bson.M{"profile_name": "bench_profile"},
			})
			contracts = append(contracts, bson.M{
				"imsi": imsi, "plan_id": "bench_plan", "status": "active",
			})
			balances = append(balances, bson.M{
				"imsi": imsi, "plan_id": "bench_plan", "status": "active",
				"data_total": int64(1024 * 1024 * 1024), "data_used": int64(0),
				"data_reserved": int64(0), "data_available": int64(1024 * 1024 * 1024),
				"voice_total": int64(0), "voice_used": int64(0), "voice_reserved": int64(0), "voice_available": int64(0),
				"sms_total": int64(0), "sms_used": int64(0), "sms_available": int64(0),
			})
		}
		if _, err := repo.subscribers.InsertMany(ctx, subscribers); err != nil {
			b.Fatalf("seed subscribers: %v", err)
		}
		if _, err := repo.ocsSubs.InsertMany(ctx, contracts); err != nil {
			b.Fatalf("seed contracts: %v", err)
		}
		if _, err := repo.ocsBalances.InsertMany(ctx, balances); err != nil {
			b.Fatalf("seed balances: %v", err)
		}
	}
}

// BenchmarkSubscriberListRows measures the current read path that the capacity
// trigger protects. It is intentionally a repository benchmark: the HTTP layer
// is a thin wrapper, while the fetch-all + enrichment cost lives here.
//
// Run on the Linux host with MongoDB available:
//
//	GOTOOLCHAIN=go1.24.0 go test -run '^$' -bench BenchmarkSubscriberListRows \
//	  -benchtime=3x ./internal/subscriber
func BenchmarkSubscriberListRows(b *testing.B) {
	for _, count := range []int{1000, 10000} {
		b.Run(fmt.Sprintf("n=%d", count), func(b *testing.B) {
			repo, cleanup := ocsTestRepo(b)
			defer cleanup()

			b.StopTimer()
			seedListBenchmarkData(b, repo, count)
			b.ResetTimer()
			b.StartTimer()

			ctx := context.Background()
			filters := SubscriberListFilters{Status: "all"}
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				result, err := repo.ListSubscriberRowsFiltered(ctx, 1, 50, "", filters, "imsi", "asc")
				if err != nil {
					b.Fatalf("list subscribers: %v", err)
				}
				if result.Total != count {
					b.Fatalf("total = %d, want %d", result.Total, count)
				}
			}
		})
	}
}
