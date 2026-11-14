package knowledge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func trashTestStore(t *testing.T) (*FileStore, string) {
	t.Helper()
	trash := t.TempDir()
	store, err := NewFileStore(t.TempDir(), trash)
	if err != nil {
		t.Fatalf("file store: %v", err)
	}
	return store, trash
}

func seedTrashedFile(t *testing.T, store *FileStore, id string, age time.Duration) {
	t.Helper()
	if _, _, _, _, err := store.SaveAttachment(id, "note.txt", strings.NewReader("data")); err != nil {
		t.Fatalf("save attachment: %v", err)
	}
	if err := store.Trash(id); err != nil {
		t.Fatalf("trash: %v", err)
	}
	if age > 0 {
		stamped := time.Now().Add(-age)
		if err := os.Chtimes(filepath.Join(store.trashDir, id), stamped, stamped); err != nil {
			t.Fatalf("chtimes: %v", err)
		}
	}
}

func TestTrashStampsDeletionTime(t *testing.T) {
	store, trash := trashTestStore(t)
	id := "00000000-0000-4000-8000-000000000000"
	seedTrashedFile(t, store, id, 0)
	info, err := os.Stat(filepath.Join(trash, id))
	if err != nil {
		t.Fatalf("stat trashed file: %v", err)
	}
	if time.Since(info.ModTime()) > time.Minute {
		t.Fatalf("trash mtime should be stamped to deletion time, got %v", info.ModTime())
	}
}

func TestPurgeTrashBeforeRemovesOnlyExpired(t *testing.T) {
	store, trash := trashTestStore(t)
	oldID := "00000000-0000-4000-8000-000000000001"
	newID := "00000000-0000-4000-8000-000000000002"
	seedTrashedFile(t, store, oldID, 48*time.Hour)
	seedTrashedFile(t, store, newID, 0)

	removed, err := store.PurgeTrashBefore(time.Now().Add(-24*time.Hour), 10)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if removed != 1 {
		t.Fatalf("expected 1 expired file removed, got %d", removed)
	}
	if _, err := os.Stat(filepath.Join(trash, oldID)); !os.IsNotExist(err) {
		t.Fatalf("expired file should be gone")
	}
	if _, err := os.Stat(filepath.Join(trash, newID)); err != nil {
		t.Fatalf("recent file should survive: %v", err)
	}
}

func TestPurgeTrashBeforeRespectsLimit(t *testing.T) {
	store, _ := trashTestStore(t)
	for i := 1; i <= 3; i++ {
		id := "00000000-0000-4000-8000-00000000000" + string(rune('0'+i))
		seedTrashedFile(t, store, id, 48*time.Hour)
	}
	removed, err := store.PurgeTrashBefore(time.Now().Add(-24*time.Hour), 2)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if removed != 2 {
		t.Fatalf("expected purge bounded to 2, got %d", removed)
	}
}
