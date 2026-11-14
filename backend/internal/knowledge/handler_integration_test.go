package knowledge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func knowledgeTestHandler(t *testing.T) (*Handler, func()) {
	t.Helper()
	repo, cleanup := knowledgeTestRepo(t)
	store, err := NewFileStore(t.TempDir(), t.TempDir())
	if err != nil {
		cleanup()
		t.Fatalf("file store: %v", err)
	}
	h := NewHandler(repo, store, noopLimiter{}, nil)
	h.UseActorRepository(fakeActorRepo{})
	return h, cleanup
}

func createEntryForTest(t *testing.T, h *Handler) Entry {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Create(rec, knowledgeRequest(http.MethodPost, "/api/knowledge/entries", "operator",
		`{"title":"round trip","protocol":"SIP","phenomenon":"p","rootCause":"r","solution":"s","tags":["a"]}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var entry Entry
	if err := json.Unmarshal(rec.Body.Bytes(), &entry); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	return entry
}

func TestHandlerCreateGetRoundTrip(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	if created.Revision != 1 || created.Protocol != "SIP" {
		t.Fatalf("unexpected created entry: %+v", created)
	}

	rec := httptest.NewRecorder()
	h.Get(rec, withEntryID(knowledgeRequest(http.MethodGet, "/api/knowledge/entries/"+created.ID, "viewer", ""), created.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("get: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var fetched Entry
	if err := json.Unmarshal(rec.Body.Bytes(), &fetched); err != nil {
		t.Fatalf("decode get response: %v", err)
	}
	if fetched.ID != created.ID || fetched.Title != "round trip" {
		t.Fatalf("round trip mismatch: %+v", fetched)
	}
}

func TestHandlerUpdateRevisionConflict(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	rec := httptest.NewRecorder()
	h.Update(rec, withEntryID(knowledgeRequest(http.MethodPut, "/api/knowledge/entries/"+created.ID, "operator",
		`{"title":"changed","expectedRevision":99}`), created.ID))
	if rec.Code != http.StatusConflict || errorCode(t, rec) != "KNOWLEDGE_REVISION_CONFLICT" {
		t.Fatalf("expected 409 KNOWLEDGE_REVISION_CONFLICT, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerUpdateSucceedsWithCorrectRevision(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	rec := httptest.NewRecorder()
	h.Update(rec, withEntryID(knowledgeRequest(http.MethodPut, "/api/knowledge/entries/"+created.ID, "operator",
		`{"title":"changed","expectedRevision":1}`), created.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updated Entry
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if updated.Revision != 2 || updated.Title != "changed" {
		t.Fatalf("unexpected updated entry: %+v", updated)
	}
}

func TestHandlerDeleteRevisionConflict(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	rec := httptest.NewRecorder()
	h.Delete(rec, withEntryID(knowledgeRequest(http.MethodDelete, "/api/knowledge/entries/"+created.ID+"?revision=99", "operator", ""), created.ID))
	if rec.Code != http.StatusConflict || errorCode(t, rec) != "KNOWLEDGE_REVISION_CONFLICT" {
		t.Fatalf("expected 409 KNOWLEDGE_REVISION_CONFLICT, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerDeleteSucceedsWithCorrectRevision(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	rec := httptest.NewRecorder()
	h.Delete(rec, withEntryID(knowledgeRequest(http.MethodDelete, "/api/knowledge/entries/"+created.ID+"?revision=1", "operator", ""), created.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("soft delete: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// A soft-deleted entry is retained and readable for recovery.
	getRec := httptest.NewRecorder()
	h.Get(getRec, withEntryID(knowledgeRequest(http.MethodGet, "/api/knowledge/entries/"+created.ID, "viewer", ""), created.ID))
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected soft-deleted entry to remain readable, got %d", getRec.Code)
	}
	var deleted Entry
	if err := json.Unmarshal(getRec.Body.Bytes(), &deleted); err != nil {
		t.Fatalf("decode deleted entry: %v", err)
	}
	if deleted.Status != StatusDeleted {
		t.Fatalf("expected status deleted, got %q", deleted.Status)
	}

	// Permanent purge removes the document.
	purgeRec := httptest.NewRecorder()
	h.Delete(purgeRec, withEntryID(knowledgeRequest(http.MethodDelete, "/api/knowledge/entries/"+created.ID+"?revision=2&permanent=1", "operator", ""), created.ID))
	if purgeRec.Code != http.StatusOK {
		t.Fatalf("purge: expected 200, got %d: %s", purgeRec.Code, purgeRec.Body.String())
	}

	goneRec := httptest.NewRecorder()
	h.Get(goneRec, withEntryID(knowledgeRequest(http.MethodGet, "/api/knowledge/entries/"+created.ID, "viewer", ""), created.ID))
	if goneRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after purge, got %d", goneRec.Code)
	}
}

func TestHandlerRestoreSoftDeletedEntry(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	delRec := httptest.NewRecorder()
	h.Delete(delRec, withEntryID(knowledgeRequest(http.MethodDelete, "/api/knowledge/entries/"+created.ID+"?revision=1", "operator", ""), created.ID))
	if delRec.Code != http.StatusOK {
		t.Fatalf("soft delete: expected 200, got %d", delRec.Code)
	}

	restoreRec := httptest.NewRecorder()
	h.Update(restoreRec, withEntryID(knowledgeRequest(http.MethodPut, "/api/knowledge/entries/"+created.ID, "operator", `{"restore":true,"expectedRevision":2}`), created.ID))
	if restoreRec.Code != http.StatusOK {
		t.Fatalf("restore: expected 200, got %d: %s", restoreRec.Code, restoreRec.Body.String())
	}
	var restored Entry
	if err := json.Unmarshal(restoreRec.Body.Bytes(), &restored); err != nil {
		t.Fatalf("decode restored entry: %v", err)
	}
	if restored.Status != StatusActive || restored.Revision != 3 {
		t.Fatalf("expected active revision 3, got status=%q revision=%d", restored.Status, restored.Revision)
	}
}

func TestHandlerVersionHistoryAndRestore(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	updRec := httptest.NewRecorder()
	h.Update(updRec, withEntryID(knowledgeRequest(http.MethodPut, "/api/knowledge/entries/"+created.ID, "operator",
		`{"title":"changed","expectedRevision":1}`), created.ID))
	if updRec.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d: %s", updRec.Code, updRec.Body.String())
	}

	getRec := httptest.NewRecorder()
	h.Get(getRec, withEntryID(knowledgeRequest(http.MethodGet, "/api/knowledge/entries/"+created.ID, "viewer", ""), created.ID))
	if getRec.Code != http.StatusOK {
		t.Fatalf("get: expected 200, got %d", getRec.Code)
	}
	var detail Entry
	if err := json.Unmarshal(getRec.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if len(detail.Versions) != 1 || detail.Versions[0].Title != "round trip" {
		t.Fatalf("expected one snapshot of the original title, got %+v", detail.Versions)
	}

	restoreRec := httptest.NewRecorder()
	body := `{"restoreVersionId":"` + detail.Versions[0].VersionID + `","expectedRevision":2}`
	h.Update(restoreRec, withEntryID(knowledgeRequest(http.MethodPut, "/api/knowledge/entries/"+created.ID, "operator", body), created.ID))
	if restoreRec.Code != http.StatusOK {
		t.Fatalf("restore version: expected 200, got %d: %s", restoreRec.Code, restoreRec.Body.String())
	}
	var reverted Entry
	if err := json.Unmarshal(restoreRec.Body.Bytes(), &reverted); err != nil {
		t.Fatalf("decode reverted: %v", err)
	}
	if reverted.Title != "round trip" || reverted.Revision != 3 {
		t.Fatalf("expected restored original title at revision 3, got title=%q revision=%d", reverted.Title, reverted.Revision)
	}
}

func TestHandlerExportEntry(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	h, cleanup := knowledgeTestHandler(t)
	defer cleanup()

	created := createEntryForTest(t, h)
	rec := httptest.NewRecorder()
	h.Get(rec, withEntryID(knowledgeRequest(http.MethodGet, "/api/knowledge/entries/"+created.ID+"?export=1", "viewer", ""), created.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("export: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("expected application/json, got %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="knowledge-`+created.ID+`.json"` {
		t.Fatalf("unexpected Content-Disposition: %q", cd)
	}
	var payload struct {
		EntryID string `json:"entry_id"`
		Entry   Entry  `json:"entry"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode export: %v", err)
	}
	if payload.EntryID != created.ID || payload.Entry.Title != "round trip" {
		t.Fatalf("unexpected export payload: %+v", payload)
	}
}
