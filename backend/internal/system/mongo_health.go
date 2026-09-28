package system

import (
	"context"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

var (
	boolTrue   = true
	expireZero = int32(0)
)

type expectedCollectionDef struct {
	database   string // "xcloud" or "app"
	collection string
}

type expectedIndexDef struct {
	database           string // "xcloud" or "app"
	collection         string
	name               string
	key                bson.D
	unique             *bool
	expireAfterSeconds *int32
}

var expectedCollections = []expectedCollectionDef{
	{database: "xcloud", collection: "subscribers"},
	{database: "xcloud", collection: "ocs_tariff_plans"},
	{database: "xcloud", collection: "ocs_subscribers"},
	{database: "xcloud", collection: "ocs_balances"},
	{database: "app", collection: "app_profiles"},
	{database: "app", collection: "app_profile_versions"},
	{database: "app", collection: "app_users"},
	{database: "app", collection: "app_audit_logs"},
	{database: "app", collection: "app_alerts"},
	{database: "app", collection: "app_rate_limits"},
	{database: "app", collection: "app_metrics"},
}

var expectedIndexes = []expectedIndexDef{
	{database: "xcloud", collection: "subscribers", name: "uniq_imsi", key: bson.D{{Key: "imsi", Value: 1}}, unique: &boolTrue},
	{database: "xcloud", collection: "ocs_tariff_plans", name: "uniq_plan_id", key: bson.D{{Key: "plan_id", Value: 1}}, unique: &boolTrue},
	{database: "xcloud", collection: "ocs_tariff_plans", name: "rules_rating_group", key: bson.D{{Key: "rules.rating_group", Value: 1}}},
	{database: "xcloud", collection: "ocs_subscribers", name: "uniq_ocs_subscriber_imsi", key: bson.D{{Key: "imsi", Value: 1}}, unique: &boolTrue},
	{database: "xcloud", collection: "ocs_subscribers", name: "ocs_subscriber_plan_id", key: bson.D{{Key: "plan_id", Value: 1}}},
	{database: "xcloud", collection: "ocs_balances", name: "uniq_ocs_balance_imsi", key: bson.D{{Key: "imsi", Value: 1}}, unique: &boolTrue},
	{database: "xcloud", collection: "ocs_balances", name: "ocs_balance_updated_at_desc", key: bson.D{{Key: "updated_at", Value: -1}}},
	{database: "app", collection: "app_profiles", name: "uniq_profile_name", key: bson.D{{Key: "name", Value: 1}}, unique: &boolTrue},
	{database: "app", collection: "app_profiles", name: "profile_updated_at_desc", key: bson.D{{Key: "updated_at", Value: -1}}},
	{database: "app", collection: "app_profile_versions", name: "profile_versions_by_profile", key: bson.D{{Key: "profileName", Value: 1}, {Key: "savedAt", Value: -1}}},
	{database: "app", collection: "app_profile_versions", name: "uniq_profile_version_id", key: bson.D{{Key: "versionId", Value: 1}}, unique: &boolTrue},
	{database: "app", collection: "app_users", name: "uniq_username", key: bson.D{{Key: "username", Value: 1}}, unique: &boolTrue},
	{database: "app", collection: "app_audit_logs", name: "audit_timestamp_desc", key: bson.D{{Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_target_timestamp", key: bson.D{{Key: "targetId", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_action_timestamp", key: bson.D{{Key: "action", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_module_timestamp", key: bson.D{{Key: "module", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_result_timestamp", key: bson.D{{Key: "result", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_risk_timestamp", key: bson.D{{Key: "riskLevel", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_actor_timestamp", key: bson.D{{Key: "actor", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_actor_username_timestamp", key: bson.D{{Key: "actorContext.username", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_resource_timestamp", key: bson.D{{Key: "resource.type", Value: 1}, {Key: "resource.id", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_request_id", key: bson.D{{Key: "request.requestId", Value: 1}}},
	{database: "app", collection: "app_audit_logs", name: "audit_request_correlation_id", key: bson.D{{Key: "request.correlationId", Value: 1}}},
	{database: "app", collection: "app_alerts", name: "alerts_timestamp_desc", key: bson.D{{Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_alerts", name: "alerts_active_by_level", key: bson.D{{Key: "is_acknowledged", Value: 1}, {Key: "level", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_alerts", name: "alerts_imsi_timestamp", key: bson.D{{Key: "imsi", Value: 1}, {Key: "timestamp", Value: -1}}},
	{database: "app", collection: "app_rate_limits", name: "uniq_rate_limit_key", key: bson.D{{Key: "key", Value: 1}}, unique: &boolTrue},
	{database: "app", collection: "app_rate_limits", name: "ttl_rate_limit_reset_at", key: bson.D{{Key: "reset_at", Value: 1}}, expireAfterSeconds: &expireZero},
	{database: "app", collection: "app_metrics", name: "uniq_metric_key", key: bson.D{{Key: "key", Value: 1}}, unique: &boolTrue},
	{database: "app", collection: "app_metrics", name: "metrics_updated_at_desc", key: bson.D{{Key: "updated_at", Value: -1}}},
}

func toInt(v any) int64 {
	switch val := v.(type) {
	case int:
		return int64(val)
	case int32:
		return int64(val)
	case int64:
		return val
	case float64:
		return int64(val)
	case float32:
		return int64(val)
	default:
		return 0
	}
}

func sameKey(actual any, expected bson.D) bool {
	if actual == nil {
		return false
	}
	switch k := actual.(type) {
	case bson.D:
		if len(k) != len(expected) {
			return false
		}
		for i := range k {
			if k[i].Key != expected[i].Key {
				return false
			}
			if toInt(k[i].Value) != toInt(expected[i].Value) {
				return false
			}
		}
		return true
	case bson.M:
		if len(k) != len(expected) {
			return false
		}
		for _, exp := range expected {
			val, ok := k[exp.Key]
			if !ok {
				return false
			}
			if toInt(val) != toInt(exp.Value) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func indexMatches(doc bson.M, expected expectedIndexDef) bool {
	if doc == nil {
		return false
	}
	name, _ := doc["name"].(string)
	if name != expected.name {
		return false
	}
	if !sameKey(doc["key"], expected.key) {
		return false
	}
	if expected.unique != nil {
		actualUnique := false
		if u, ok := doc["unique"].(bool); ok {
			actualUnique = u
		}
		if actualUnique != *expected.unique {
			return false
		}
	}
	if expected.expireAfterSeconds != nil {
		val, ok := doc["expireAfterSeconds"]
		if !ok || val == nil {
			return false
		}
		if toInt(val) != int64(*expected.expireAfterSeconds) {
			return false
		}
	}
	return true
}

// CheckMongoHealth generates a MongoHealthReport by checking connection and schemas.
func CheckMongoHealth(ctx context.Context, xcloudDb, appDb *mongo.Database) (*MongoHealthReport, error) {
	if os.Getenv("TEST_FAIL_PLATFORM_READS") == "1" {
		return nil, fmt.Errorf("ping xcloud failed: connection refused")
	}

	startedAt := time.Now()

	// Ping both databases
	if err := xcloudDb.RunCommand(ctx, bson.D{{Key: "ping", Value: 1}}).Err(); err != nil {
		return nil, fmt.Errorf("ping xcloud failed: %w", err)
	}
	if err := appDb.RunCommand(ctx, bson.D{{Key: "ping", Value: 1}}).Err(); err != nil {
		return nil, fmt.Errorf("ping app failed: %w", err)
	}

	databases := &DatabaseNames{
		XCloud: xcloudDb.Name(),
		App:    appDb.Name(),
	}

	dbByRole := map[string]*mongo.Database{
		"xcloud": xcloudDb,
		"app":    appDb,
	}

	xcloudColls, err := xcloudDb.ListCollectionNames(ctx, bson.M{})
	if err != nil {
		return nil, fmt.Errorf("list collections xcloud: %w", err)
	}
	appColls, err := appDb.ListCollectionNames(ctx, bson.M{})
	if err != nil {
		return nil, fmt.Errorf("list collections app: %w", err)
	}

	existingCollectionsByRole := map[string]map[string]bool{
		"xcloud": make(map[string]bool, len(xcloudColls)),
		"app":    make(map[string]bool, len(appColls)),
	}
	for _, c := range xcloudColls {
		existingCollectionsByRole["xcloud"][c] = true
	}
	for _, c := range appColls {
		existingCollectionsByRole["app"][c] = true
	}

	missingCollections := make([]string, 0)
	for _, exp := range expectedCollections {
		if !existingCollectionsByRole[exp.database][exp.collection] {
			dbName := databases.XCloud
			if exp.database == "app" {
				dbName = databases.App
			}
			missingCollections = append(missingCollections, fmt.Sprintf("%s.%s", dbName, exp.collection))
		}
	}

	collections := make([]CollectionHealth, 0, len(expectedCollections))
	missingIndexes := make([]MissingIndexRef, 0)

	for _, exp := range expectedCollections {
		db := dbByRole[exp.database]
		dbName := databases.XCloud
		if exp.database == "app" {
			dbName = databases.App
		}
		displayName := fmt.Sprintf("%s.%s", dbName, exp.collection)

		if !existingCollectionsByRole[exp.database][exp.collection] {
			collectionIndexes := make([]string, 0)
			for _, idx := range expectedIndexes {
				if idx.database == exp.database && idx.collection == exp.collection {
					collectionIndexes = append(collectionIndexes, idx.name)
					missingIndexes = append(missingIndexes, MissingIndexRef{
						Collection: displayName,
						Index:      idx.name,
					})
				}
			}
			collections = append(collections, CollectionHealth{
				Database:       dbName,
				Name:           exp.collection,
				Exists:         false,
				DocumentCount:  nil,
				MissingIndexes: collectionIndexes,
			})
			continue
		}

		coll := db.Collection(exp.collection)
		count, err := coll.EstimatedDocumentCount(ctx)
		var docCount *int64
		if err == nil {
			docCount = &count
		}

		cursor, err := coll.Indexes().List(ctx)
		var actualIndexes []bson.M
		if err == nil {
			_ = cursor.All(ctx, &actualIndexes)
		}

		collectionMissingIndexes := make([]string, 0)
		for _, expIdx := range expectedIndexes {
			if expIdx.database == exp.database && expIdx.collection == exp.collection {
				found := false
				for _, act := range actualIndexes {
					if indexMatches(act, expIdx) {
						found = true
						break
					}
				}
				if !found {
					collectionMissingIndexes = append(collectionMissingIndexes, expIdx.name)
					missingIndexes = append(missingIndexes, MissingIndexRef{
						Collection: displayName,
						Index:      expIdx.name,
					})
				}
			}
		}

		collections = append(collections, CollectionHealth{
			Database:       dbName,
			Name:           exp.collection,
			Exists:         true,
			DocumentCount:  docCount,
			MissingIndexes: collectionMissingIndexes,
		})
	}

	latency := time.Since(startedAt).Milliseconds()
	dbSummary := fmt.Sprintf("%s / %s", databases.XCloud, databases.App)
	checkedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	return &MongoHealthReport{
		OK:                 len(missingCollections) == 0 && len(missingIndexes) == 0,
		Database:           &dbSummary,
		Databases:          databases,
		CheckedAt:          checkedAt,
		LatencyMs:          &latency,
		Collections:        collections,
		MissingCollections: missingCollections,
		MissingIndexes:     missingIndexes,
	}, nil
}
