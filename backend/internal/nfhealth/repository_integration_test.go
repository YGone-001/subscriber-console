package nfhealth

import (
	"context"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// nfhealthTestRepo connects to a real MongoDB instance and provisions an
// isolated throwaway database. Tests skip when MongoDB is unreachable so
// unit-only environments stay green.
func nfhealthTestRepo(t *testing.T) (*Repository, *mongo.Database, func()) {
	t.Helper()

	uri := os.Getenv("MONGODB_URI")
	if uri == "" {
		uri = "mongodb://127.0.0.1:27017"
	}

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		t.Skipf("MongoDB ping failed: %v", err)
		return nil, nil, func() {}
	}

	dbName := "xcloud_test_nfhealth_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)

	repo := NewRepository(
		db.Collection("app_nf_health_targets"),
		db.Collection("app_nf_health_runs"),
		db.Collection("app_nf_health_samples"),
	)

	cleanup := func() {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		_ = db.Drop(ctx2)
		_ = client.Disconnect(ctx2)
	}

	return repo, db, cleanup
}

func nfhealthTestTarget(t *testing.T, repo *Repository, name string) *HealthTarget {
	t.Helper()
	enabled := true
	target, err := repo.CreateTarget(context.Background(), &CreateTargetRequest{
		CandidateID:      "3301e63a-c3b7-41f1-a512-9f6322e6f4c2",
		Name:             name,
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  "http://127.0.0.1:9/metrics",
		ServiceKind:      EvidenceProcess,
		CollectionMode:   CollectionScheduled,
		IntervalSeconds:  120,
		Enabled:          &enabled,
	}, "integration-tester")
	if err != nil {
		t.Fatalf("create target: %v", err)
	}
	return target
}

func nfhealthTestSample(targetID, runID, sampleID, collectedAt string, expires time.Time) *HealthSample {
	measured := true
	return &HealthSample{
		SampleID:      sampleID,
		SchemaVersion: 1,
		TargetID:      targetID,
		RunID:         runID,
		CollectedAt:   collectedAt,
		ExpiresAt:     NewBSONTime(expires),
		Layers: LayerSet{
			Process: LayerEvidence{
				State:          StateHealthy,
				EvidenceKind:   EvidenceProcess,
				Measured:       measured,
				ProcessOutcome: "running",
				MainPID:        4242,
			},
			Interface: LayerEvidence{
				State:        StateNotConfigured,
				EvidenceKind: EvidenceNone,
				Measured:     false,
			},
			Service: LayerEvidence{
				State:        StateNotConfigured,
				EvidenceKind: EvidenceNone,
				Measured:     false,
			},
		},
		Metrics: []MetricSample{},
	}
}

// TestSampleExpiresAtPersistsAsBSONDate verifies the TTL data type correction:
// a stored sample keeps expiresAt as a BSON Date so the MongoDB TTL index with
// expireAfterSeconds 0 can consume it, while the JSON projection stays ISO 8601.
func TestSampleExpiresAtPersistsAsBSONDate(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := nfhealthTestTarget(t, repo, "ttl-date-target")
	expires := time.Now().UTC().AddDate(0, 0, DefaultRetentionDays).Truncate(time.Millisecond)
	sample := nfhealthTestSample(target.TargetID, "run-ttl-1", "sample-ttl-1",
		time.Now().UTC().Format(time.RFC3339Nano), expires)
	if err := repo.InsertSample(context.Background(), sample); err != nil {
		t.Fatalf("insert sample: %v", err)
	}

	// Assert on the raw BSON value type, not the decoded Go representation.
	findRaw := db.Collection("app_nf_health_samples").FindOne(context.Background(), bson.M{"_id": "sample-ttl-1"})
	var rawDoc bson.Raw
	if err := findRaw.Decode(&rawDoc); err != nil {
		t.Fatalf("decode raw document: %v", err)
	}
	lookup, lkErr := rawDoc.LookupErr("expiresAt")
	if lkErr != nil {
		t.Fatalf("expiresAt missing: %v", lkErr)
	}
	if lookup.Type != bson.TypeDateTime {
		t.Fatalf("expected BSON Date for expiresAt, got %v", lookup.Type)
	}

	// The typed read path must reconstruct the same instant.
	stored, err := repo.GetSample(context.Background(), "sample-ttl-1")
	if err != nil {
		t.Fatalf("get sample: %v", err)
	}
	if stored.ExpiresAt.IsZero() {
		t.Fatal("expiresAt must round-trip through BSON Date")
	}
	if delta := stored.ExpiresAt.Time.UTC().Sub(expires.UTC()); delta > time.Millisecond || delta < -time.Millisecond {
		t.Fatalf("expiresAt drifted: got %v want %v", stored.ExpiresAt.Time.UTC(), expires.UTC())
	}
}

// TestLegacyStringExpiresAtStaysReadable proves previously stored samples are
// preserved: a legacy string-typed expiresAt still loads through the typed read
// path and is never deleted or rewritten by ordinary reads.
func TestLegacyStringExpiresAtStaysReadable(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := nfhealthTestTarget(t, repo, "legacy-string-target")
	legacyExpiry := time.Now().UTC().AddDate(0, 0, 2).Truncate(time.Millisecond)
	_, err := db.Collection("app_nf_health_samples").InsertOne(context.Background(), bson.M{
		"_id":           "sample-legacy-1",
		"schemaVersion": 1,
		"targetId":      target.TargetID,
		"runId":         "run-legacy-1",
		"collectedAt":   time.Now().UTC().Format(time.RFC3339Nano),
		"expiresAt":     legacyExpiry.Format(time.RFC3339Nano),
		"layers":        bson.M{},
		"metrics":       bson.A{},
	})
	if err != nil {
		t.Fatalf("insert legacy sample: %v", err)
	}

	stored, err := repo.GetSample(context.Background(), "sample-legacy-1")
	if err != nil {
		t.Fatalf("legacy sample must remain readable: %v", err)
	}
	if stored.ExpiresAt.IsZero() {
		t.Fatal("legacy string expiresAt must decode through the compatibility reader")
	}

	// Ordinary reads must not convert or delete the legacy document.
	findRaw := db.Collection("app_nf_health_samples").FindOne(context.Background(), bson.M{"_id": "sample-legacy-1"})
	var rawDoc bson.Raw
	if err := findRaw.Decode(&rawDoc); err != nil {
		t.Fatalf("decode legacy raw: %v", err)
	}
	lookup, lkErr := rawDoc.LookupErr("expiresAt")
	if lkErr != nil {
		t.Fatalf("expiresAt missing after read: %v", lkErr)
	}
	if lookup.Type != bson.TypeString {
		t.Fatalf("read path must not rewrite legacy expiresAt, got %v", lookup.Type)
	}
}

// TestMigrateSampleExpiresDryRunWritesNothing verifies the explicitly invoked
// migration honors DryRun: it reports conversions without mutating storage.
func TestMigrateSampleExpiresDryRunWritesNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := nfhealthTestTarget(t, repo, "migrate-dry-run-target")
	for i := 0; i < 3; i++ {
		id := "sample-dry-" + string(rune('a'+i))
		_, err := db.Collection("app_nf_health_samples").InsertOne(context.Background(), bson.M{
			"_id":           id,
			"schemaVersion": 1,
			"targetId":      target.TargetID,
			"runId":         "run-dry",
			"collectedAt":   time.Now().UTC().Format(time.RFC3339Nano),
			"expiresAt":     time.Now().UTC().AddDate(0, 0, 7).Format(time.RFC3339Nano),
			"layers":        bson.M{},
			"metrics":       bson.A{},
		})
		if err != nil {
			t.Fatalf("insert legacy sample %s: %v", id, err)
		}
	}

	result, err := repo.MigrateSampleExpiresToBSONDate(context.Background(), MigrationScope{
		Limit:  DefaultMigrationBatchLimit,
		DryRun: true,
	})
	if err != nil {
		t.Fatalf("dry-run migration: %v", err)
	}
	if result.DryRun != true {
		t.Fatal("dry-run must be reported")
	}
	if result.Converted != 3 {
		t.Fatalf("dry-run must report 3 convertible documents, got %d", result.Converted)
	}

	count, err := db.Collection("app_nf_health_samples").CountDocuments(context.Background(),
		bson.M{"expiresAt": bson.M{"$type": "string"}})
	if err != nil {
		t.Fatalf("count legacy: %v", err)
	}
	if count != 3 {
		t.Fatalf("dry-run must not write; expected 3 legacy documents, got %d", count)
	}
}

// TestMigrateSampleExpiresConvertsAndIsIdempotent verifies the bounded
// migration converts string-typed expiresAt to BSON Date exactly once and is
// safe to re-invoke. It never deletes samples.
func TestMigrateSampleExpiresConvertsAndIsIdempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := nfhealthTestTarget(t, repo, "migrate-convert-target")
	_, err := db.Collection("app_nf_health_samples").InsertOne(context.Background(), bson.M{
		"_id":           "sample-convert-1",
		"schemaVersion": 1,
		"targetId":      target.TargetID,
		"runId":         "run-convert",
		"collectedAt":   time.Now().UTC().Format(time.RFC3339Nano),
		"expiresAt":     time.Now().UTC().AddDate(0, 0, 7).Format(time.RFC3339Nano),
		"layers":        bson.M{},
		"metrics":       bson.A{},
	})
	if err != nil {
		t.Fatalf("insert legacy sample: %v", err)
	}

	first, err := repo.MigrateSampleExpiresToBSONDate(context.Background(), MigrationScope{Limit: 100})
	if err != nil {
		t.Fatalf("migration: %v", err)
	}
	if first.Converted != 1 {
		t.Fatalf("first migration must convert 1 document, got %d", first.Converted)
	}

	findRaw := db.Collection("app_nf_health_samples").FindOne(context.Background(), bson.M{"_id": "sample-convert-1"})
	var rawDoc bson.Raw
	if err := findRaw.Decode(&rawDoc); err != nil {
		t.Fatalf("decode converted: %v", err)
	}
	lookup, lkErr := rawDoc.LookupErr("expiresAt")
	if lkErr != nil {
		t.Fatalf("expiresAt missing after migration: %v", lkErr)
	}
	if lookup.Type != bson.TypeDateTime {
		t.Fatalf("migration must store BSON Date, got %v", lookup.Type)
	}

	second, err := repo.MigrateSampleExpiresToBSONDate(context.Background(), MigrationScope{Limit: 100})
	if err != nil {
		t.Fatalf("re-run migration: %v", err)
	}
	if second.Converted != 0 {
		t.Fatalf("migration must be idempotent; second run converted %d", second.Converted)
	}

	// The sample itself must still exist: migration never deletes data.
	count, err := db.Collection("app_nf_health_samples").CountDocuments(context.Background(), bson.M{})
	if err != nil {
		t.Fatalf("count samples: %v", err)
	}
	if count != 1 {
		t.Fatalf("migration must preserve samples; found %d", count)
	}
}

// TestFailedCollectionPreservesLastMeasuredAt verifies Correction C: a failed
// collection records attempt state and historical evidence but never advances
// the accepted measurement timestamp.
func TestFailedCollectionPreservesLastMeasuredAt(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := nfhealthTestTarget(t, repo, "freshness-preserve-target")
	goodSample := nfhealthTestSample(target.TargetID, "run-good", "sample-good",
		time.Now().UTC().Add(-2*time.Minute).Format(time.RFC3339Nano),
		time.Now().UTC().AddDate(0, 0, DefaultRetentionDays))
	if err := repo.RecordCollection(context.Background(), target, &CollectionResult{
		Run: HealthRun{
			RunID:          "run-good",
			SchemaVersion:  1,
			TargetID:       target.TargetID,
			StartedAt:      time.Now().UTC().Add(-2 * time.Minute).Format(time.RFC3339Nano),
			CompletedAt:    time.Now().UTC().Add(-2 * time.Minute).Format(time.RFC3339Nano),
			Status:         RunStatusSuccess,
			SampleID:       "sample-good",
			LayersMeasured: 1,
			InitiatedBy:    "integration-tester",
		},
		Sample: goodSample,
	}); err != nil {
		t.Fatalf("record good collection: %v", err)
	}

	afterGood, err := repo.GetTarget(context.Background(), target.TargetID)
	if err != nil {
		t.Fatalf("reload target: %v", err)
	}
	if afterGood.LastMeasuredAt == "" {
		t.Fatal("successful collection must set lastMeasuredAt")
	}
	if afterGood.LastSuccessAt == "" {
		t.Fatal("successful collection must set lastSuccessAt")
	}

	// A later failed run emits a sample as historical evidence but must not
	// advance lastMeasuredAt.
	failedSample := nfhealthTestSample(target.TargetID, "run-bad", "sample-bad",
		time.Now().UTC().Format(time.RFC3339Nano),
		time.Now().UTC().AddDate(0, 0, DefaultRetentionDays))
	failedSample.Layers.Process.Measured = true
	if err := repo.RecordCollection(context.Background(), afterGood, &CollectionResult{
		Run: HealthRun{
			RunID:          "run-bad",
			SchemaVersion:  1,
			TargetID:       target.TargetID,
			StartedAt:      time.Now().UTC().Format(time.RFC3339Nano),
			CompletedAt:    time.Now().UTC().Format(time.RFC3339Nano),
			Status:         RunStatusFailed,
			SampleID:       "sample-bad",
			LayersMeasured: 1,
			ErrorCode:      "COLLECTION_FAILED",
			ErrorSummary:   "metrics endpoint unreachable",
			InitiatedBy:    "integration-tester",
		},
		Sample: failedSample,
	}); err != nil {
		t.Fatalf("record failed collection: %v", err)
	}

	afterFail, err := repo.GetTarget(context.Background(), target.TargetID)
	if err != nil {
		t.Fatalf("reload after failure: %v", err)
	}
	if afterFail.LastMeasuredAt != afterGood.LastMeasuredAt {
		t.Fatalf("failed collection must preserve lastMeasuredAt: got %q want %q",
			afterFail.LastMeasuredAt, afterGood.LastMeasuredAt)
	}
	if afterFail.LastAttemptAt == "" {
		t.Fatal("failed collection must still record lastAttemptAt")
	}
	if afterFail.LastError == "" {
		t.Fatal("failed collection must surface the error summary")
	}
	if afterFail.LastSuccessAt != afterGood.LastSuccessAt {
		t.Fatal("failed collection must not overwrite lastSuccessAt")
	}

	// The failed sample stays available as historical evidence.
	if _, err := repo.GetSample(context.Background(), "sample-bad"); err != nil {
		t.Fatalf("failed-run sample must remain as historical evidence: %v", err)
	}
}

// TestFreshnessProjectionMatchesStoredMeasurement verifies the freshness
// policy runs against the persisted measurement timestamp and never presents a
// stale measurement as healthy.
func TestFreshnessProjectionMatchesStoredMeasurement(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := nfhealthTestTarget(t, repo, "freshness-projection-target")
	oldSample := nfhealthTestSample(target.TargetID, "run-old", "sample-old",
		time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano),
		time.Now().UTC().AddDate(0, 0, DefaultRetentionDays))
	if err := repo.RecordCollection(context.Background(), target, &CollectionResult{
		Run: HealthRun{
			RunID:          "run-old",
			SchemaVersion:  1,
			TargetID:       target.TargetID,
			StartedAt:      time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano),
			CompletedAt:    time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano),
			Status:         RunStatusSuccess,
			SampleID:       "sample-old",
			LayersMeasured: 1,
			InitiatedBy:    "integration-tester",
		},
		Sample: oldSample,
	}); err != nil {
		t.Fatalf("record old collection: %v", err)
	}

	stored, err := repo.GetTarget(context.Background(), target.TargetID)
	if err != nil {
		t.Fatalf("reload target: %v", err)
	}

	fresh := EvaluateFreshness(stored, time.Now().UTC())
	if fresh.State != FreshnessStale {
		t.Fatalf("an hour-old measurement on a 120s cadence must be stale, got %s", fresh.State)
	}

	projected := ProjectOverallState(fresh, &oldSample.Layers)
	if projected == StateHealthy {
		t.Fatal("stale measurement must never project as healthy")
	}

	// A recent valid measurement is fresh and may project healthy.
	recent := time.Now().UTC().Add(-30 * time.Second)
	stored.LastMeasuredAt = recent.Format(time.RFC3339Nano)
	stored.Enabled = true
	stored.CollectionMode = CollectionScheduled
	stored.IntervalSeconds = 120
	freshNow := EvaluateFreshness(stored, time.Now().UTC())
	if freshNow.State != FreshnessFresh {
		t.Fatalf("recent measurement must be fresh, got %s", freshNow.State)
	}
}

// TestSharedCollectionGateBoundsManualAndScheduled verifies Correction B:
// the global concurrency bound is shared across manual and scheduled paths.
func TestSharedCollectionGateBoundsManualAndScheduled(t *testing.T) {
	gate := NewCollectionGate()
	if gate.TryAcquire() != true {
		t.Fatal("first admission must succeed")
	}
	if gate.TryAcquire() != true {
		t.Fatal("second admission within MaxGlobalConcurrent must succeed")
	}
	if gate.TryAcquire() != false {
		t.Fatal("third admission must fail fast once MaxGlobalConcurrent is reached")
	}
	gate.Release()
	if gate.TryAcquire() != true {
		t.Fatal("release must return capacity to the shared gate")
	}
}

// TestSchedulerDueCalculationHonorsPerTargetInterval verifies Correction B:
// each target's own interval drives due calculation and no startup burst runs
// every target at once.
func TestSchedulerDueCalculationHonorsPerTargetInterval(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)

	enabled := true
	recent := &HealthTarget{
		TargetID:        "t-recent",
		Enabled:         true,
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 60,
		LastAttemptAt:   now.Add(-10 * time.Second).Format(time.RFC3339Nano),
	}
	if IsDue(recent, now) {
		t.Fatal("a target attempted 10s ago on a 60s interval is not due")
	}

	overdue := &HealthTarget{
		TargetID:        "t-overdue",
		Enabled:         true,
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 60,
		LastAttemptAt:   now.Add(-90 * time.Second).Format(time.RFC3339Nano),
	}
	if !IsDue(overdue, now) {
		t.Fatal("a target attempted 90s ago on a 60s interval must be due")
	}

	// First-ever tick uses createdAt/updatedAt so a restart does not burst.
	neverRun := &HealthTarget{
		TargetID:        "t-never",
		Enabled:         true,
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 300,
		CreatedAt:       now.Format(time.RFC3339Nano),
	}
	if IsDue(neverRun, now) {
		t.Fatal("a never-run target must wait one full interval before the first collection")
	}
	if !IsDue(neverRun, now.Add(301*time.Second)) {
		t.Fatal("a never-run target becomes due after one full interval")
	}

	manual := &HealthTarget{
		TargetID:        "t-manual",
		Enabled:         true,
		CollectionMode:  CollectionManual,
		IntervalSeconds: 60,
		LastAttemptAt:   now.Add(-time.Hour).Format(time.RFC3339Nano),
	}
	if IsDue(manual, now) {
		t.Fatal("manual targets are never auto-scheduled")
	}

	disabled := &HealthTarget{
		TargetID:        "t-disabled",
		Enabled:         false,
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 60,
		LastAttemptAt:   now.Add(-time.Hour).Format(time.RFC3339Nano),
	}
	if IsDue(disabled, now) {
		t.Fatal("disabled targets are never scheduled")
	}

	_ = enabled
}
