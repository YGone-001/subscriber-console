package nfhealth

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// createTargetIndexes applies the production partial unique index semantics to
// an isolated test collection: a candidate-scoped unique index and a
// resource-scoped unique index, both partial so absent identifiers never
// collide.
func createTargetIndexes(t *testing.T, targets *mongo.Collection) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := targets.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{
			Keys:    bson.D{{Key: "candidateId", Value: 1}},
			Options: options.Index().SetUnique(true).SetPartialFilterExpression(bson.M{"candidateId": bson.M{"$type": "string"}}),
		},
		{
			Keys:    bson.D{{Key: "resourceId", Value: 1}},
			Options: options.Index().SetUnique(true).SetPartialFilterExpression(bson.M{"resourceId": bson.M{"$type": "string"}}),
		},
	})
	if err != nil {
		t.Fatalf("create target indexes: %v", err)
	}
}

func createResourceNativeTarget(t *testing.T, repo *Repository, resourceID, name string) *HealthTarget {
	t.Helper()
	enabled := true
	target, err := repo.CreateTarget(context.Background(), &CreateTargetRequest{
		ResourceID:       resourceID,
		Name:             name,
		CollectorProfile: CollectorProcessOnly,
		ServiceUnit:      "pcscfd",
		ServiceKind:      "process",
		CollectionMode:   CollectionManual,
		IntervalSeconds:  DefaultIntervalSeconds,
		Enabled:          &enabled,
		ResolvedDomain:   "ims",
		ResolvedNFType:   NFTypePCSCF,
	}, "integration-tester")
	if err != nil {
		t.Fatalf("create resource-native target: %v", err)
	}
	return target
}

// Group F: persistence.
func TestMultipleInventoryOnlyTargetsCoexistWithoutCandidate(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)

	first := createResourceNativeTarget(t, repo, testResourceIMS, "P-CSCF node-a")
	second := createResourceNativeTarget(t, repo, testResource5GC, "AMF node-b")
	if first.CandidateID != "" || second.CandidateID != "" {
		t.Fatal("Inventory-only targets must keep candidateId absent")
	}
	if first.Domain != "ims" || first.NFType != NFTypePCSCF {
		t.Fatalf("unexpected derived identity: %+v", first)
	}
	if first.IdentityState != IdentityInventoryAuthoritative {
		t.Fatalf("unexpected identity state: %s", first.IdentityState)
	}

	loaded, err := repo.GetTarget(context.Background(), first.TargetID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.ResourceID != testResourceIMS || loaded.Domain != "ims" {
		t.Fatalf("resource association must persist: %+v", loaded)
	}
}

func TestDuplicateLogicalTargetIsPreventedByIndex(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)

	createResourceNativeTarget(t, repo, testResourceIMS, "P-CSCF node-a")
	enabled := true
	_, err := repo.CreateTarget(context.Background(), &CreateTargetRequest{
		ResourceID:       testResourceIMS,
		Name:             "P-CSCF duplicate",
		CollectorProfile: CollectorProcessOnly,
		ServiceUnit:      "pcscfd",
		ServiceKind:      "process",
		CollectionMode:   CollectionManual,
		Enabled:          &enabled,
		ResolvedDomain:   "ims",
		ResolvedNFType:   NFTypePCSCF,
	}, "integration-tester")
	if err != ErrDuplicate {
		t.Fatalf("expected ErrDuplicate for duplicate resource target, got %v", err)
	}
}

func TestLegacyCandidateOnlyDocumentStaysReadable(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)

	// A pre-phase document: no resourceId, no identityState, unknown future
	// field preserved verbatim.
	legacy := bson.M{
		"_id":              "90000000-0000-4000-8000-000000000001",
		"schemaVersion":    1,
		"candidateId":      "55555555-5555-4555-8555-555555555555",
		"name":             "legacy AMF metrics",
		"collectorProfile": "http_metrics",
		"metricsEndpoint":  "http://127.0.0.1:9/metrics",
		"serviceKind":      "none",
		"collectionMode":   "scheduled",
		"intervalSeconds":  120,
		"enabled":          true,
		"revision":         3,
		"createdAt":        "2026-01-01T00:00:00Z",
		"createdBy":        "operator1",
		"updatedAt":        "2026-01-01T00:00:00Z",
		"updatedBy":        "operator1",
		"futureUnknown":    "preserve-me",
	}
	ctx := context.Background()
	if _, err := repo.targets.InsertOne(ctx, legacy); err != nil {
		t.Fatalf("insert legacy doc: %v", err)
	}

	target, err := repo.GetTarget(ctx, "90000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatalf("legacy doc must stay readable: %v", err)
	}
	if target.IdentityState != IdentityLegacyUnresolved {
		t.Fatalf("expected legacy_unresolved, got %s", target.IdentityState)
	}
	if target.CandidateID != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("legacy candidate must be retained, got %q", target.CandidateID)
	}

	// Historical samples for the legacy target remain accessible.
	sample := &HealthSample{
		SampleID:      "90000000-0000-4000-8000-0000000000f1",
		SchemaVersion: 1,
		TargetID:      target.TargetID,
		RunID:         "90000000-0000-4000-8000-0000000000r1",
		CandidateID:   target.CandidateID,
		CollectedAt:   "2026-01-01T01:00:00Z",
		ExpiresAt:     NewBSONTime(time.Now().UTC().AddDate(0, 0, 7)),
		Metrics:       []MetricSample{},
	}
	if err := repo.InsertSample(ctx, sample); err != nil {
		t.Fatalf("insert legacy sample: %v", err)
	}
	samples, _, _, err := repo.ListSamples(ctx, SampleListFilter{TargetID: target.TargetID, Limit: 10})
	if err != nil || len(samples) != 1 {
		t.Fatalf("legacy history must stay readable: %v", err)
	}
	if samples[0].CandidateID != target.CandidateID || samples[0].ResourceID != "" {
		t.Fatalf("historical evidence must not gain a fabricated resource association: %+v", samples[0])
	}
}

func TestRunAndSampleCarryResourceProvenance(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := createResourceNativeTarget(t, repo, testResourceIMS, "P-CSCF provenance")
	ctx := context.Background()
	now := time.Now().UTC()
	run := &HealthRun{
		RunID:         "91000000-0000-4000-8000-000000000001",
		SchemaVersion: 1,
		TargetID:      target.TargetID,
		ResourceID:    target.ResourceID,
		StartedAt:     now.Format(time.RFC3339Nano),
		Status:        RunStatusSuccess,
		InitiatedBy:   "operator1",
	}
	if err := repo.InsertRun(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	loaded, err := repo.GetRun(ctx, run.RunID)
	if err != nil {
		t.Fatalf("reload run: %v", err)
	}
	if loaded.ResourceID != testResourceIMS {
		t.Fatalf("run must retain the canonical resource association, got %q", loaded.ResourceID)
	}
}

func TestRetiredResourceHistoryStaysReadable(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()

	target := createResourceNativeTarget(t, repo, testResourceIMS, "P-CSCF retired later")
	ctx := context.Background()
	sample := &HealthSample{
		SampleID:      "92000000-0000-4000-8000-000000000001",
		SchemaVersion: 1,
		TargetID:      target.TargetID,
		RunID:         "92000000-0000-4000-8000-0000000000r1",
		ResourceID:    target.ResourceID,
		CollectedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		ExpiresAt:     NewBSONTime(time.Now().UTC().AddDate(0, 0, 7)),
		Metrics:       []MetricSample{},
	}
	if err := repo.InsertSample(ctx, sample); err != nil {
		t.Fatalf("insert sample: %v", err)
	}

	// Retirement is an Inventory lifecycle event; NF Health evidence is never
	// deleted or reassigned. The target and its history stay readable.
	loaded, err := repo.GetTarget(ctx, target.TargetID)
	if err != nil {
		t.Fatalf("target must stay readable after resource retirement: %v", err)
	}
	if loaded.ResourceID != testResourceIMS {
		t.Fatalf("resource association must be preserved, got %q", loaded.ResourceID)
	}
	samples, _, _, err := repo.ListSamples(ctx, SampleListFilter{TargetID: target.TargetID, Limit: 10})
	if err != nil || len(samples) != 1 {
		t.Fatalf("history must stay readable: %v", err)
	}
}

func TestLegacyLinkMigrationDryRunWritesNothing(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	observations := db.Collection("app_nf_observations")
	resources := db.Collection("app_inventory_resources")
	linked := testResourceIMS
	if _, err := observations.InsertOne(ctx, bson.M{
		"_id":              "55555555-5555-4555-8555-555555555555",
		"nfType":           "P-CSCF",
		"linkedResourceId": linked,
	}); err != nil {
		t.Fatalf("insert observation: %v", err)
	}
	if _, err := resources.InsertOne(ctx, bson.M{
		"_id": linked, "kind": "network_function", "domain": "ims",
		"role": "pcscf", "lifecycleState": "active",
	}); err != nil {
		t.Fatalf("insert resource: %v", err)
	}
	if _, err := repo.targets.InsertOne(ctx, bson.M{
		"_id":              "93000000-0000-4000-8000-000000000001",
		"schemaVersion":    1,
		"candidateId":      "55555555-5555-4555-8555-555555555555",
		"name":             "legacy candidate-only target",
		"collectorProfile": "http_metrics",
		"serviceKind":      "none",
		"collectionMode":   "manual",
		"intervalSeconds":  120,
		"enabled":          true,
		"revision":         1,
	}); err != nil {
		t.Fatalf("insert legacy target: %v", err)
	}

	result, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{DryRun: true})
	if err != nil {
		t.Fatalf("dry-run migration: %v", err)
	}
	if result.Examined != 1 || result.Resolved != 1 || !result.DryRun {
		t.Fatalf("unexpected dry-run result: %+v", result)
	}
	var stored struct {
		ResourceID string `bson:"resourceId"`
	}
	if err := repo.targets.FindOne(ctx, bson.M{"_id": "93000000-0000-4000-8000-000000000001"}).Decode(&stored); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if stored.ResourceID != "" {
		t.Fatal("dry-run must not write")
	}

	// Real invocation resolves the explicit link and is idempotent.
	if _, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{}); err != nil {
		t.Fatalf("migration: %v", err)
	}
	target, err := repo.GetTarget(ctx, "93000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatalf("reload migrated: %v", err)
	}
	if target.ResourceID != testResourceIMS || target.NFType != NFTypePCSCF || target.Domain != "ims" {
		t.Fatalf("migration must resolve the explicit link: %+v", target)
	}
	if target.Revision != 1 {
		t.Fatalf("migration must preserve the revision counter, got %d", target.Revision)
	}
	second, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{})
	if err != nil {
		t.Fatalf("second migration: %v", err)
	}
	if second.Examined != 0 || second.Resolved != 0 {
		t.Fatalf("migration must be idempotent, got %+v", second)
	}
}

func TestLegacyLinkMigrationLeavesUnmatchedTargetsUntouched(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	createTargetIndexes(t, repo.targets)
	ctx := context.Background()

	observations := db.Collection("app_nf_observations")
	resources := db.Collection("app_inventory_resources")
	// Candidate exists but carries no link.
	if _, err := observations.InsertOne(ctx, bson.M{
		"_id": "66666666-6666-4666-8666-666666666666", "nfType": "AMF",
	}); err != nil {
		t.Fatalf("insert observation: %v", err)
	}
	if _, err := repo.targets.InsertOne(ctx, bson.M{
		"_id":              "94000000-0000-4000-8000-000000000001",
		"schemaVersion":    1,
		"candidateId":      "66666666-6666-4666-8666-666666666666",
		"name":             "unmatched legacy target",
		"collectorProfile": "http_metrics",
		"serviceKind":      "none",
		"collectionMode":   "manual",
		"intervalSeconds":  120,
		"enabled":          true,
		"revision":         2,
	}); err != nil {
		t.Fatalf("insert legacy target: %v", err)
	}

	result, err := MigrateLegacyTargetResourceLinks(ctx, repo.targets, observations, resources, LegacyLinkMigrationScope{})
	if err != nil {
		t.Fatalf("migration: %v", err)
	}
	if result.Examined != 1 || result.Unmatched != 1 || result.Resolved != 0 {
		t.Fatalf("unexpected migration result: %+v", result)
	}
	target, err := repo.GetTarget(ctx, "94000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if target.ResourceID != "" || target.IdentityState != IdentityLegacyUnresolved {
		t.Fatalf("unmatched legacy target must stay untouched: %+v", target)
	}
}
