package knowledge

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func knowledgeTestRepo(t *testing.T) (*Repository, func()) {
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
	}

	db := client.Database("xcloud_test_knowledge_" + bson.NewObjectID().Hex())
	repo := NewRepository(db.Collection(CollectionEntries), db.Collection(CollectionFiles))
	repo.UseVersionStore(db.Collection(CollectionVersions))
	repo.UseInvestigationStore(db.Collection("app_investigations"))
	repo.UseAuditStore(db.Collection("app_audit_logs"))

	cleanup := func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer dropCancel()
		_ = db.Drop(dropCtx)
		_ = client.Disconnect(dropCtx)
	}
	return repo, cleanup
}

func TestStatsReportsTagLimits(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := knowledgeTestRepo(t)
	defer cleanup()

	meta, err := repo.Stats(context.Background())
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if meta.MaxTags != MaxTags || meta.MaxTagLength != MaxTagLength {
		t.Fatalf("tag limits = %d/%d, want %d/%d", meta.MaxTags, meta.MaxTagLength, MaxTags, MaxTagLength)
	}

	_, err = repo.Create(context.Background(), "11111111-1111-4111-8111-111111111111", &CreateEntryRequest{Title: "tagged one"}, "General", []string{"SIP", "VoLTE"}, nil, "tester")
	if err != nil {
		t.Fatalf("create tagged one: %v", err)
	}
	_, err = repo.Create(context.Background(), "22222222-2222-4222-8222-222222222222", &CreateEntryRequest{Title: "tagged two"}, "General", []string{"SIP"}, nil, "tester")
	if err != nil {
		t.Fatalf("create tagged two: %v", err)
	}
	tags, err := repo.ListTags(context.Background(), 10)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	if len(tags) != 2 || tags[0].Tag != "SIP" || tags[0].Count != 2 || tags[1].Tag != "VoLTE" || tags[1].Count != 1 {
		t.Fatalf("unexpected tag dictionary: %+v", tags)
	}

	entry, err := repo.Create(context.Background(), validEntryID, &CreateEntryRequest{Title: "trashed"}, "General", nil, nil, "tester")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Verify stats before soft delete: 3 active entries ("tagged one", "tagged two", "trashed"), 0 deleted.
	repo.InvalidateMeta()
	meta, err = repo.Stats(context.Background())
	if err != nil {
		t.Fatalf("stats before delete: %v", err)
	}
	if meta.Total != 3 || meta.DeletedTotal != 0 {
		t.Fatalf("expected total=3 deletedTotal=0, got total=%d deletedTotal=%d", meta.Total, meta.DeletedTotal)
	}

	if _, err := repo.SoftDelete(context.Background(), entry.ID, entry.Revision); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	repo.InvalidateMeta()
	meta, err = repo.Stats(context.Background())
	if err != nil {
		t.Fatalf("stats after delete: %v", err)
	}
	// The 2 tagged entries remain active; the soft-deleted entry is excluded from Total and counted in DeletedTotal.
	if meta.Total != 2 || meta.DeletedTotal != 1 {
		t.Fatalf("expected total=2 deletedTotal=1, got total=%d deletedTotal=%d", meta.Total, meta.DeletedTotal)
	}

	active, totalActive, _, _, err := repo.List(context.Background(), ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list active entries: %v", err)
	}
	if totalActive != 2 || len(active) != 2 {
		t.Fatalf("expected 2 active entries after soft delete, got total=%d len=%d", totalActive, len(active))
	}

	deleted, totalDeleted, _, _, err := repo.List(context.Background(), ListFilter{Status: StatusDeleted, Limit: 10})
	if err != nil {
		t.Fatalf("list deleted entries: %v", err)
	}
	if totalDeleted != 1 || len(deleted) != 1 || deleted[0].Title != "trashed" {
		t.Fatalf("expected 1 deleted entry 'trashed', got total=%d len=%d", totalDeleted, len(deleted))
	}
}

// TestListTotalRemainsStableAcrossPages guards the contract that total describes
// the filtered set rather than the remainder after the cursor.
func TestListTotalRemainsStableAcrossPages(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := knowledgeTestRepo(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	now := time.Now().UTC().Format(time.RFC3339)
	for i := 0; i < 25; i++ {
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
		_, err := repo.entries.InsertOne(ctx, bson.M{
			"_id":           id,
			"schemaVersion": SchemaVersion,
			"title":         fmt.Sprintf("entry %02d", i),
			"protocol":      "General",
			"phenomenon":    "phenomenon",
			"rootCause":     "root cause",
			"solution":      "solution",
			"tags":          []string{},
			"attachments":   []Attachment{},
			"revision":      1,
			"createdAt":     now,
			"createdBy":     "integration-tester",
			"updatedAt":     now,
			"updatedBy":     "integration-tester",
		})
		if err != nil {
			t.Fatalf("insert entry %d: %v", i, err)
		}
	}

	first, total, cursor, hasMore, err := repo.List(ctx, ListFilter{Limit: 20})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if total != 25 || len(first) != 20 || !hasMore || cursor == nil {
		t.Fatalf("first page total=%d items=%d hasMore=%v cursor=%v", total, len(first), hasMore, cursor)
	}

	second, total, _, hasMore, err := repo.List(ctx, ListFilter{Limit: 20, Cursor: *cursor})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if total != 25 || len(second) != 5 || hasMore {
		t.Fatalf("second page total=%d items=%d hasMore=%v", total, len(second), hasMore)
	}

	seen := make(map[string]bool, len(first))
	for _, entry := range first {
		seen[entry.ID] = true
	}
	for _, entry := range second {
		if seen[entry.ID] {
			t.Fatalf("entry %s repeated across pages", entry.ID)
		}
	}
}
