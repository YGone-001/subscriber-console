package knowledge

import (
	"context"
	"fmt"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func seedEntry(t *testing.T, repo *Repository, id, title string, attachments []Attachment) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	if attachments == nil {
		attachments = []Attachment{}
	}
	_, err := repo.entries.InsertOne(context.Background(), bson.M{
		"_id":           id,
		"schemaVersion": SchemaVersion,
		"title":         title,
		"protocol":      "General",
		"phenomenon":    "p",
		"rootCause":     "r",
		"solution":      "s",
		"tags":          []string{},
		"attachments":   attachments,
		"revision":      1,
		"createdAt":     now,
		"createdBy":     "integration-tester",
		"updatedAt":     now,
		"updatedBy":     "integration-tester",
	})
	if err != nil {
		t.Fatalf("seed entry %s: %v", id, err)
	}
}

func TestListSortByTitleAsc(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := knowledgeTestRepo(t)
	defer cleanup()

	seedEntry(t, repo, "00000000-0000-4000-8000-000000000001", "charlie", nil)
	seedEntry(t, repo, "00000000-0000-4000-8000-000000000002", "alpha", nil)
	seedEntry(t, repo, "00000000-0000-4000-8000-000000000003", "bravo", nil)

	items, total, _, _, err := repo.List(context.Background(), ListFilter{Sort: "title", Order: "asc", Limit: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 3 || len(items) != 3 {
		t.Fatalf("expected 3 items, got total=%d len=%d", total, len(items))
	}
	want := []string{"alpha", "bravo", "charlie"}
	for i, title := range want {
		if items[i].Title != title {
			t.Fatalf("position %d: expected %q, got %q", i, title, items[i].Title)
		}
	}
}

func TestListSortPaginatesWithBoundCursor(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := knowledgeTestRepo(t)
	defer cleanup()

	for i, title := range []string{"delta", "alpha", "echo", "bravo", "charlie"} {
		seedEntry(t, repo, fmt.Sprintf("00000000-0000-4000-8000-%012d", i), title, nil)
	}

	first, _, cursor, hasMore, err := repo.List(context.Background(), ListFilter{Sort: "title", Order: "asc", Limit: 2})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if !hasMore || cursor == nil || len(first) != 2 || first[0].Title != "alpha" || first[1].Title != "bravo" {
		t.Fatalf("unexpected first page: %+v hasMore=%v", first, hasMore)
	}

	second, _, _, _, err := repo.List(context.Background(), ListFilter{Sort: "title", Order: "asc", Limit: 2, Cursor: *cursor})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second) != 2 || second[0].Title != "charlie" || second[1].Title != "delta" {
		t.Fatalf("unexpected second page: %+v", second)
	}

	// Reusing the title-bound cursor under a different sort must fail.
	_, _, _, _, err = repo.List(context.Background(), ListFilter{Sort: "updatedAt", Order: "desc", Limit: 2, Cursor: *cursor})
	if err == nil {
		t.Fatalf("expected cursor sort mismatch error")
	}
}

func TestListStatusFilterSeparatesRecycleBin(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := knowledgeTestRepo(t)
	defer cleanup()

	seedEntry(t, repo, "00000000-0000-4000-8000-000000000001", "kept", nil)
	seedEntry(t, repo, "00000000-0000-4000-8000-000000000002", "trashed", nil)
	if _, err := repo.SoftDelete(context.Background(), "00000000-0000-4000-8000-000000000002", 1); err != nil {
		t.Fatalf("soft delete: %v", err)
	}

	active, activeTotal, _, _, err := repo.List(context.Background(), ListFilter{Status: StatusActive, Limit: 10})
	if err != nil || activeTotal != 1 || len(active) != 1 || active[0].Title != "kept" {
		t.Fatalf("active list: total=%d len=%d err=%v", activeTotal, len(active), err)
	}
	deleted, deletedTotal, _, _, err := repo.List(context.Background(), ListFilter{Status: StatusDeleted, Limit: 10})
	if err != nil || deletedTotal != 1 || len(deleted) != 1 || deleted[0].Title != "trashed" {
		t.Fatalf("deleted list: total=%d len=%d err=%v", deletedTotal, len(deleted), err)
	}
	_, allTotal, _, _, err := repo.List(context.Background(), ListFilter{Status: "all", Limit: 10})
	if err != nil || allTotal != 2 {
		t.Fatalf("all list: total=%d err=%v", allTotal, err)
	}
}

func TestListProjectsAttachmentCount(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := knowledgeTestRepo(t)
	defer cleanup()

	attachments := []Attachment{
		{FileID: "00000000-0000-4000-8000-0000000000a1", OriginalName: "a.png", Kind: FileKindImage, Size: 10},
		{FileID: "00000000-0000-4000-8000-0000000000a2", OriginalName: "b.pdf", Kind: FileKindPDF, Size: 20},
	}
	seedEntry(t, repo, "00000000-0000-4000-8000-000000000001", "with attachments", attachments)
	seedEntry(t, repo, "00000000-0000-4000-8000-000000000002", "no attachments", nil)

	items, _, _, _, err := repo.List(context.Background(), ListFilter{Sort: "title", Order: "asc", Limit: 10})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	byTitle := map[string]EntrySummary{}
	for _, item := range items {
		byTitle[item.Title] = item
	}
	if byTitle["with attachments"].AttachmentCount != 2 {
		t.Fatalf("expected attachmentCount 2, got %d", byTitle["with attachments"].AttachmentCount)
	}
	if byTitle["no attachments"].AttachmentCount != 0 {
		t.Fatalf("expected attachmentCount 0, got %d", byTitle["no attachments"].AttachmentCount)
	}
}
