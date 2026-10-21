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

	cleanup := func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer dropCancel()
		_ = db.Drop(dropCtx)
		_ = client.Disconnect(dropCtx)
	}
	return repo, cleanup
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
