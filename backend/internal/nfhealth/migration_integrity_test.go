package nfhealth

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// seedLegacyTarget inserts a pre-phase candidate-only target document.
func seedLegacyTarget(t *testing.T, repo *Repository, targetID, candidateID string, revision int64) {
	t.Helper()
	if _, err := repo.targets.InsertOne(context.Background(), bson.M{
		"_id":              targetID,
		"schemaVersion":    1,
		"candidateId":      candidateID,
		"name":             "legacy candidate-only target",
		"collectorProfile": CollectorHTTPMetrics,
		"serviceKind":      "none",
		"collectionMode":   CollectionManual,
		"intervalSeconds":  DefaultIntervalSeconds,
		"enabled":          true,
		"revision":         revision,
		"createdAt":        "2026-01-01T00:00:00Z",
		"createdBy":        "operator1",
		"updatedAt":        "2026-01-01T00:00:00Z",
		"updatedBy":        "operator1",
	}); err != nil {
		t.Fatalf("insert legacy target: %v", err)
	}
}

func seedLinkedCandidate(t *testing.T, observations *mongo.Collection, candidateID, nfType, resourceID string) {
	t.Helper()
	if _, err := observations.InsertOne(context.Background(), bson.M{
		"_id":              candidateID,
		"nfType":           nfType,
		"linkedResourceId": resourceID,
	}); err != nil {
		t.Fatalf("insert observation: %v", err)
	}
}

func seedResource(t *testing.T, resources *mongo.Collection, resourceID, kind, domain, role, lifecycle string) {
	t.Helper()
	if _, err := resources.InsertOne(context.Background(), bson.M{
		"_id": resourceID, "kind": kind, "domain": domain,
		"role": role, "lifecycleState": lifecycle,
	}); err != nil {
		t.Fatalf("insert resource: %v", err)
	}
}

// Correction C — migration must reject a mismatched candidate/resource
// association and must never rewrite the target.
func TestLegacyMigrationRejectsMismatchedCandidateType(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	observations := db.Collection("app_nf_observations")
	resources := db.Collection("app_inventory_resources")
	seedLegacyTarget(t, repo, "95000000-0000-4000-8000-000000000001", "66000000-0000-4000-8000-000000000001", 2)
	seedResource(t, resources, testResourceIMS, "network_function", "ims", "pcscf", "active")
	// The candidate claims an AMF identity while linked to a P-CSCF resource.
	seedLinkedCandidate(t, observations, "66000000-0000-4000-8000-000000000001", "AMF", testResourceIMS)

	result, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{})
	if err != nil {
		t.Fatalf("migration: %v", err)
	}
	if result.Examined != 1 || result.Resolved != 0 || result.Invalid != 1 {
		t.Fatalf("mismatched association must be counted invalid: %+v", result)
	}
	target, err := repo.GetTarget(ctx, "95000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if target.ResourceID != "" || target.IdentityState == IdentityInventoryAuthoritative {
		t.Fatalf("mismatched association must never be adopted: %+v", target)
	}
	if target.Revision != 2 {
		t.Fatalf("revision must be preserved, got %d", target.Revision)
	}
}

func TestLegacyMigrationRejectsMissingCandidateType(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	observations := db.Collection("app_nf_observations")
	resources := db.Collection("app_inventory_resources")
	seedLegacyTarget(t, repo, "95000000-0000-4000-8000-000000000002", "66000000-0000-4000-8000-000000000002", 1)
	seedResource(t, resources, testResourceIMS, "network_function", "ims", "pcscf", "active")
	seedLinkedCandidate(t, observations, "66000000-0000-4000-8000-000000000002", "", testResourceIMS)

	result, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{})
	if err != nil {
		t.Fatalf("migration: %v", err)
	}
	if result.Invalid != 1 || result.Resolved != 0 {
		t.Fatalf("an unverifiable observed type must not be adopted: %+v", result)
	}
}

func TestLegacyMigrationDryRunWritesNothingAndDoesNotCountWrites(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	observations := db.Collection("app_nf_observations")
	resources := db.Collection("app_inventory_resources")
	seedLegacyTarget(t, repo, "95000000-0000-4000-8000-000000000003", "66000000-0000-4000-8000-000000000003", 4)
	seedResource(t, resources, testResourceIMS, "network_function", "ims", "pcscf", "active")
	seedLinkedCandidate(t, observations, "66000000-0000-4000-8000-000000000003", "P-CSCF", testResourceIMS)

	result, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{DryRun: true})
	if err != nil {
		t.Fatalf("dry-run: %v", err)
	}
	if !result.DryRun || result.Resolved != 1 {
		t.Fatalf("dry-run must report the resolvable association: %+v", result)
	}
	var stored struct {
		ResourceID string `bson:"resourceId"`
		Revision   int64  `bson:"revision"`
	}
	if err := repo.targets.FindOne(ctx, bson.M{"_id": "95000000-0000-4000-8000-000000000003"}).Decode(&stored); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if stored.ResourceID != "" || stored.Revision != 4 {
		t.Fatalf("dry-run must not write: %+v", stored)
	}
}

func TestLegacyMigrationReportsAssociationCollisionWithoutReassignment(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	observations := db.Collection("app_nf_observations")
	resources := db.Collection("app_inventory_resources")
	seedResource(t, resources, testResourceIMS, "network_function", "ims", "pcscf", "active")
	// Two legacy targets whose candidates link to the same Inventory resource.
	seedLegacyTarget(t, repo, "95000000-0000-4000-8000-000000000004", "66000000-0000-4000-8000-000000000004", 1)
	seedLegacyTarget(t, repo, "95000000-0000-4000-8000-000000000005", "66000000-0000-4000-8000-000000000005", 1)
	seedLinkedCandidate(t, observations, "66000000-0000-4000-8000-000000000004", "P-CSCF", testResourceIMS)
	seedLinkedCandidate(t, observations, "66000000-0000-4000-8000-000000000005", "P-CSCF", testResourceIMS)

	result, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{})
	if err != nil {
		t.Fatalf("migration: %v", err)
	}
	if result.Resolved != 1 || result.Conflicts != 1 {
		t.Fatalf("expected one migration and one reported collision: %+v", result)
	}
	if len(result.ConflictTargets) != 1 {
		t.Fatalf("the colliding target must be reported: %+v", result)
	}
	// Exactly one target holds the association; the other is untouched.
	var withResource int
	for _, id := range []string{"95000000-0000-4000-8000-000000000004", "95000000-0000-4000-8000-000000000005"} {
		target, err := repo.GetTarget(ctx, id)
		if err != nil {
			t.Fatalf("reload %s: %v", id, err)
		}
		if target.ResourceID != "" {
			withResource++
			if target.ResourceID != testResourceIMS {
				t.Fatalf("unexpected association: %+v", target)
			}
		}
	}
	if withResource != 1 {
		t.Fatalf("exactly one target may hold the association, got %d", withResource)
	}
}

// The migration update is revision-bound: the same conditional filter matches
// nothing once the stored revision has moved, so a concurrently modified target
// is never overwritten and an unmatched update is never counted as a migration.
func TestLegacyMigrationConditionalUpdateIsRevisionBound(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	seedLegacyTarget(t, repo, "95000000-0000-4000-8000-000000000006", "66000000-0000-4000-8000-000000000006", 1)

	// A concurrent operator edit advances the revision.
	if _, err := repo.targets.UpdateOne(ctx,
		bson.M{"_id": "95000000-0000-4000-8000-000000000006"},
		bson.M{"$set": bson.M{"revision": 2, "name": "renamed concurrently"}},
	); err != nil {
		t.Fatalf("concurrent edit: %v", err)
	}

	// The migration's conditional update, issued with the stale observed
	// revision, must match nothing.
	res, err := repo.targets.UpdateOne(ctx,
		bson.M{
			"_id":      "95000000-0000-4000-8000-000000000006",
			"revision": int64(1),
			"$or": []bson.M{
				{"resourceId": bson.M{"$exists": false}},
				{"resourceId": ""},
			},
		},
		bson.M{"$set": bson.M{"resourceId": testResourceIMS}},
	)
	if err != nil {
		t.Fatalf("conditional update: %v", err)
	}
	if res.MatchedCount != 0 {
		t.Fatal("a revision-bound update must not match a concurrently modified target")
	}
	target, err := repo.GetTarget(ctx, "95000000-0000-4000-8000-000000000006")
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if target.ResourceID != "" {
		t.Fatal("a concurrently modified target must never be overwritten")
	}
	if target.Name != "renamed concurrently" || target.Revision != 2 {
		t.Fatalf("the concurrent edit must be preserved: %+v", target)
	}
}

func TestLegacyMigrationPreservesHistoricalEvidence(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	observations := db.Collection("app_nf_observations")
	resources := db.Collection("app_inventory_resources")
	seedLegacyTarget(t, repo, "95000000-0000-4000-8000-000000000007", "66000000-0000-4000-8000-000000000007", 1)
	seedResource(t, resources, testResourceIMS, "network_function", "ims", "pcscf", "active")
	seedLinkedCandidate(t, observations, "66000000-0000-4000-8000-000000000007", "P-CSCF", testResourceIMS)

	// Historical evidence recorded before the association existed.
	historical := bson.M{
		"_id":         "95000000-0000-4000-8000-0000000000f7",
		"targetId":    "95000000-0000-4000-8000-000000000007",
		"runId":       "95000000-0000-4000-8000-0000000000r7",
		"collectedAt": "2026-01-01T00:00:00Z",
		"expiresAt":   NewBSONTime(time.Now().UTC().AddDate(0, 0, 7)),
		"layers":      bson.M{},
		"metrics":     []bson.M{},
	}
	if _, err := repo.samples.InsertOne(ctx, historical); err != nil {
		t.Fatalf("insert historical sample: %v", err)
	}

	if _, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{}); err != nil {
		t.Fatalf("migration: %v", err)
	}

	var sample struct {
		ResourceID string `bson:"resourceId"`
		TargetID   string `bson:"targetId"`
	}
	if err := repo.samples.FindOne(ctx, bson.M{"_id": "95000000-0000-4000-8000-0000000000f7"}).Decode(&sample); err != nil {
		t.Fatalf("reload sample: %v", err)
	}
	if sample.ResourceID != "" {
		t.Fatal("historical samples must never be rewritten to claim a newly established identity")
	}
	if sample.TargetID != "95000000-0000-4000-8000-000000000007" {
		t.Fatal("historical provenance must stay unchanged")
	}
}
