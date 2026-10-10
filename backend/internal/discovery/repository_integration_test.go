package discovery

import (
	"context"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// discoveryTestRepo connects to a real MongoDB instance and provisions an
// isolated throwaway database. It returns the repository, the database handle
// for direct assertions, and a cleanup function. Tests skip when MongoDB is
// unreachable so unit-only environments stay green.
func discoveryTestRepo(t *testing.T) (*Repository, *mongo.Database, func()) {
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

	dbName := "xcloud_test_discovery_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)

	repo := NewRepository(
		db.Collection("app_discovery_sources"),
		db.Collection("app_discovery_runs"),
		db.Collection("app_nf_observations"),
	)

	cleanup := func() {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		_ = db.Drop(ctx2)
		_ = client.Disconnect(ctx2)
	}

	return repo, db, cleanup
}

func discoveryTestSource(t *testing.T, repo *Repository) *DiscoverySource {
	t.Helper()
	src, err := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name:          "integration-registry",
		AdapterType:   AdapterNRF,
		BaseURL:       "http://127.0.0.10:7777",
		TransportMode: TransportH2C,
	}, "integration-tester")
	if err != nil {
		t.Fatalf("create source: %v", err)
	}
	return src
}

func discoveryTestProfile(id, nfType string) *NormalizedProfile {
	return &NormalizedProfile{
		ExternalNfInstanceID: id,
		NfType:               nfType,
		NfStatus:             "REGISTERED",
		IPv4Addresses:        []string{},
		IPv6Addresses:        []string{},
		ObservedEndpoints:    []ObservedEndpoint{},
		ObservedServices:     []ObservedService{},
	}
}

// TestUpsertObservationRefreshesLastSeenAtOnRealObservation verifies that
// lastSeenAt moves only when an NF is actually observed again.
func TestUpsertObservationRefreshesLastSeenAtOnRealObservation(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, _, cleanup := discoveryTestRepo(t)
	defer cleanup()

	src := discoveryTestSource(t, repo)
	ctx := context.Background()

	if _, _, _, err := repo.UpsertObservation(ctx, src.SourceID, AdapterNRF, discoveryTestProfile("nf-1", "AMF"), "2026-01-01T00:00:00.000Z"); err != nil {
		t.Fatalf("first upsert: %v", err)
	}

	listed, _, _, err := repo.ListCandidates(ctx, CandidateListFilter{SourceID: src.SourceID})
	if err != nil || len(listed) != 1 {
		t.Fatalf("list after first upsert: items=%d err=%v", len(listed), err)
	}
	if listed[0].LastSeenAt != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("first lastSeenAt = %q", listed[0].LastSeenAt)
	}

	if _, _, _, err := repo.UpsertObservation(ctx, src.SourceID, AdapterNRF, discoveryTestProfile("nf-1", "AMF"), "2026-01-02T00:00:00.000Z"); err != nil {
		t.Fatalf("second upsert: %v", err)
	}

	listed, _, _, err = repo.ListCandidates(ctx, CandidateListFilter{SourceID: src.SourceID})
	if err != nil || len(listed) != 1 {
		t.Fatalf("list after second upsert: items=%d err=%v", len(listed), err)
	}
	if listed[0].LastSeenAt != "2026-01-02T00:00:00.000Z" {
		t.Fatalf("observed lastSeenAt = %q, want the new observation time", listed[0].LastSeenAt)
	}
	if listed[0].ObservationState != ObservationSeen {
		t.Fatalf("observationState = %q, want %q", listed[0].ObservationState, ObservationSeen)
	}
}

// TestMarkMissingPreservesLastSeenAt is the core observation-timestamp contract:
// a complete scan that no longer sees an NF flips the state to missing but must
// not fabricate a new observation time.
func TestMarkMissingPreservesLastSeenAt(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, _, cleanup := discoveryTestRepo(t)
	defer cleanup()

	src := discoveryTestSource(t, repo)
	ctx := context.Background()

	const observedAt = "2026-02-01T10:00:00.000Z"
	const scanAt = "2026-02-02T10:00:00.000Z"

	if _, _, _, err := repo.UpsertObservation(ctx, src.SourceID, AdapterNRF, discoveryTestProfile("nf-keep", "AMF"), observedAt); err != nil {
		t.Fatalf("upsert keep: %v", err)
	}
	if _, _, _, err := repo.UpsertObservation(ctx, src.SourceID, AdapterNRF, discoveryTestProfile("nf-gone", "UDM"), observedAt); err != nil {
		t.Fatalf("upsert gone: %v", err)
	}

	seen := map[string]struct{}{"nf-keep": {}}
	missing, err := repo.MarkMissing(ctx, src.SourceID, seen, scanAt)
	if err != nil {
		t.Fatalf("mark missing: %v", err)
	}
	if missing != 1 {
		t.Fatalf("missing count = %d, want 1", missing)
	}

	listed, _, _, err := repo.ListCandidates(ctx, CandidateListFilter{SourceID: src.SourceID})
	if err != nil || len(listed) != 2 {
		t.Fatalf("list after mark missing: items=%d err=%v", len(listed), err)
	}

	byID := map[string]NFObservation{}
	for _, item := range listed {
		byID[item.ExternalNfInstanceID] = item
	}

	gone := byID["nf-gone"]
	if gone.ObservationState != ObservationMissing {
		t.Fatalf("nf-gone state = %q, want %q", gone.ObservationState, ObservationMissing)
	}
	if gone.LastSeenAt != observedAt {
		t.Fatalf("nf-gone lastSeenAt = %q, want preserved observation time %q", gone.LastSeenAt, observedAt)
	}
	if gone.LastSeenAt == scanAt {
		t.Fatal("nf-gone lastSeenAt must not equal the absence-scan timestamp")
	}

	keep := byID["nf-keep"]
	if keep.ObservationState != ObservationSeen {
		t.Fatalf("nf-keep state = %q, want %q", keep.ObservationState, ObservationSeen)
	}
	if keep.LastSeenAt != observedAt {
		t.Fatalf("nf-keep lastSeenAt = %q, want %q", keep.LastSeenAt, observedAt)
	}
}

// TestMarkMissingPreservesCandidateIdentityAndInventoryLink verifies that the
// absence transition never rewrites candidate identity or the Inventory link.
func TestMarkMissingPreservesCandidateIdentityAndInventoryLink(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, _, cleanup := discoveryTestRepo(t)
	defer cleanup()

	src := discoveryTestSource(t, repo)
	ctx := context.Background()

	if _, _, _, err := repo.UpsertObservation(ctx, src.SourceID, AdapterNRF, discoveryTestProfile("nf-linked", "AMF"), "2026-03-01T00:00:00.000Z"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	listed, _, _, err := repo.ListCandidates(ctx, CandidateListFilter{SourceID: src.SourceID})
	if err != nil || len(listed) != 1 {
		t.Fatalf("list: items=%d err=%v", len(listed), err)
	}
	before := listed[0]

	resourceID := "inv-resource-1"
	linked, err := repo.SetCandidateLink(ctx, before.CandidateID, before.Revision, &resourceID, "integration-tester")
	if err != nil {
		t.Fatalf("link: %v", err)
	}

	if _, err := repo.MarkMissing(ctx, src.SourceID, map[string]struct{}{}, "2026-03-02T00:00:00.000Z"); err != nil {
		t.Fatalf("mark missing: %v", err)
	}

	after, err := repo.GetCandidate(ctx, before.CandidateID)
	if err != nil {
		t.Fatalf("get candidate: %v", err)
	}
	if after.CandidateID != before.CandidateID {
		t.Fatalf("candidateId changed: %q -> %q", before.CandidateID, after.CandidateID)
	}
	if after.ExternalNfInstanceID != before.ExternalNfInstanceID {
		t.Fatalf("externalNfInstanceId changed: %q -> %q", before.ExternalNfInstanceID, after.ExternalNfInstanceID)
	}
	if after.LinkedResourceID == nil || *after.LinkedResourceID != resourceID {
		t.Fatalf("linkedResourceId not preserved: %+v", after.LinkedResourceID)
	}
	if after.LastSeenAt != "2026-03-01T00:00:00.000Z" {
		t.Fatalf("lastSeenAt = %q, want the last real observation", after.LastSeenAt)
	}
	if after.Revision != linked.Revision {
		t.Fatalf("revision drifted: %d -> %d", linked.Revision, after.Revision)
	}
}

// TestUpdateSourceScanMetaSuccessMovesLastSuccessAt covers the complete
// successful-scan path: lastScanAt and lastSuccessAt both move.
func TestUpdateSourceScanMetaSuccessMovesLastSuccessAt(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, db, cleanup := discoveryTestRepo(t)
	defer cleanup()

	src := discoveryTestSource(t, repo)
	ctx := context.Background()

	if err := repo.UpdateSourceScanMeta(ctx, src.SourceID, "2026-04-01T00:00:00.000Z", ""); err != nil {
		t.Fatalf("update scan meta: %v", err)
	}

	var stored DiscoverySource
	if err := db.Collection("app_discovery_sources").FindOne(ctx, bson.M{"_id": src.SourceID}).Decode(&stored); err != nil {
		t.Fatalf("read source: %v", err)
	}
	if stored.LastScanAt != "2026-04-01T00:00:00.000Z" {
		t.Fatalf("lastScanAt = %q", stored.LastScanAt)
	}
	if stored.LastSuccessAt != "2026-04-01T00:00:00.000Z" {
		t.Fatalf("lastSuccessAt = %q, want the successful completion time", stored.LastSuccessAt)
	}
	if stored.LastError != "" {
		t.Fatalf("lastError = %q, want empty on success", stored.LastError)
	}
}

// TestUpdateSourceScanMetaNonSuccessPreservesLastSuccessAt covers partial and
// failed attempts: lastScanAt moves, lastSuccessAt does not, and the outcomes
// stay distinguishable through lastError.
func TestUpdateSourceScanMetaNonSuccessPreservesLastSuccessAt(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, db, cleanup := discoveryTestRepo(t)
	defer cleanup()

	src := discoveryTestSource(t, repo)
	ctx := context.Background()

	if err := repo.UpdateSourceScanMeta(ctx, src.SourceID, "2026-05-01T00:00:00.000Z", ""); err != nil {
		t.Fatalf("seed success: %v", err)
	}

	// Partial attempt: truncated scan, absence not inferred.
	partialSummary := "scan truncated; absence not inferred"
	if err := repo.UpdateSourceScanMeta(ctx, src.SourceID, "2026-05-02T00:00:00.000Z", partialSummary); err != nil {
		t.Fatalf("partial scan meta: %v", err)
	}

	var afterPartial DiscoverySource
	if err := db.Collection("app_discovery_sources").FindOne(ctx, bson.M{"_id": src.SourceID}).Decode(&afterPartial); err != nil {
		t.Fatalf("read source: %v", err)
	}
	if afterPartial.LastScanAt != "2026-05-02T00:00:00.000Z" {
		t.Fatalf("partial lastScanAt = %q", afterPartial.LastScanAt)
	}
	if afterPartial.LastSuccessAt != "2026-05-01T00:00:00.000Z" {
		t.Fatalf("partial lastSuccessAt = %q, want the previous complete success", afterPartial.LastSuccessAt)
	}
	if afterPartial.LastError != partialSummary {
		t.Fatalf("partial lastError = %q, want %q", afterPartial.LastError, partialSummary)
	}

	// Failed attempt: transport error, still no success time.
	failedSummary := "transport error: connection refused"
	if err := repo.UpdateSourceScanMeta(ctx, src.SourceID, "2026-05-03T00:00:00.000Z", failedSummary); err != nil {
		t.Fatalf("failed scan meta: %v", err)
	}

	var afterFailed DiscoverySource
	if err := db.Collection("app_discovery_sources").FindOne(ctx, bson.M{"_id": src.SourceID}).Decode(&afterFailed); err != nil {
		t.Fatalf("read source: %v", err)
	}
	if afterFailed.LastScanAt != "2026-05-03T00:00:00.000Z" {
		t.Fatalf("failed lastScanAt = %q", afterFailed.LastScanAt)
	}
	if afterFailed.LastSuccessAt != "2026-05-01T00:00:00.000Z" {
		t.Fatalf("failed lastSuccessAt = %q, want the previous complete success", afterFailed.LastSuccessAt)
	}
	if afterFailed.LastError != failedSummary {
		t.Fatalf("failed lastError = %q, want %q", afterFailed.LastError, failedSummary)
	}
	if afterFailed.LastError == afterPartial.LastError {
		t.Fatal("partial and failed attempts must remain distinguishable through lastError")
	}
}
