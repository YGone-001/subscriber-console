package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"subscriber/internal/auth"
	"subscriber/internal/user"
)

// noopLimiter allows every request so tests exercise the governance path rather
// than rate limiting.
type noopLimiter struct{}

func (noopLimiter) Enforce(http.ResponseWriter, *http.Request, string, int, int) bool { return true }

// fakeActorRepo returns an active identity whose role mirrors the username, so a
// principal built with Username == role passes fresh-actor revalidation.
type fakeActorRepo struct{}

func (fakeActorRepo) FindByUsernameIdentity(_ context.Context, username string) (*user.UserIdentity, error) {
	return &user.UserIdentity{
		SafeUser: user.SafeUser{Username: username, Role: username, Status: "active"},
		MongoID:  "usr_" + username,
	}, nil
}

// newTestHandler builds a handler with no persistence. The auth and validation
// paths exercised here reject before touching the repository or file store, so
// nil repo/store are safe; a permissive limiter and fake actor repo let writes
// reach validation.
func newTestHandler() *Handler {
	h := NewHandler(nil, nil, noopLimiter{}, nil)
	h.UseActorRepository(fakeActorRepo{})
	return h
}

func knowledgeRequest(method, target, role, body string) *http.Request {
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	if role != "" {
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), &auth.Principal{
			Username:       role,
			Role:           role,
			NormalizedRole: role,
		}))
	}
	return req
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return payload.Code
}

// withEntryID injects the routed path value the handler reads via PathValue.
// Direct handler invocation bypasses ServeMux, so the value must be set manually.
func withEntryID(req *http.Request, id string) *http.Request {
	req.SetPathValue("entryId", id)
	return req
}

const validEntryID = "00000000-0000-4000-8000-000000000000"

func TestWriteEndpointsRejectViewer(t *testing.T) {
	h := newTestHandler()
	cases := []struct {
		name   string
		method string
		target string
		body   string
		call   func(http.ResponseWriter, *http.Request)
	}{
		{"create", http.MethodPost, "/api/knowledge/entries", `{"title":"x"}`, h.Create},
		{"update", http.MethodPut, "/api/knowledge/entries/" + validEntryID, `{"title":"x","expectedRevision":1}`, h.Update},
		{"delete", http.MethodDelete, "/api/knowledge/entries/" + validEntryID + "?revision=1", "", h.Delete},
		{"upload", http.MethodPost, "/api/knowledge/files", "", h.Upload},
		{"delete file", http.MethodDelete, "/api/knowledge/files/" + validEntryID, "", h.DeleteFile},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.call(rec, knowledgeRequest(tc.method, tc.target, "viewer", tc.body))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
			}
			if code := errorCode(t, rec); code != "FORBIDDEN" {
				t.Fatalf("expected FORBIDDEN, got %q", code)
			}
		})
	}
}

func TestEndpointsRejectUnauthenticated(t *testing.T) {
	h := newTestHandler()
	cases := []struct {
		name   string
		method string
		target string
		call   func(http.ResponseWriter, *http.Request)
	}{
		{"meta", http.MethodGet, "/api/knowledge/meta", h.Meta},
		{"list", http.MethodGet, "/api/knowledge/entries", h.List},
		{"get", http.MethodGet, "/api/knowledge/entries/" + validEntryID, h.Get},
		{"create", http.MethodPost, "/api/knowledge/entries", h.Create},
		{"upload", http.MethodPost, "/api/knowledge/files", h.Upload},
		{"delete file", http.MethodDelete, "/api/knowledge/files/" + validEntryID, h.DeleteFile},
		{"get version", http.MethodGet, "/api/knowledge/entries/" + validEntryID + "/versions/" + validEntryID, h.GetVersion},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.call(rec, knowledgeRequest(tc.method, tc.target, "", ""))
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
			}
			if code := errorCode(t, rec); code != "AUTH_INVALID_TOKEN" {
				t.Fatalf("expected AUTH_INVALID_TOKEN, got %q", code)
			}
		})
	}
}

func TestCreateValidation(t *testing.T) {
	h := newTestHandler()

	tooManyIDs := make([]string, MaxAttachments+1)
	for i := range tooManyIDs {
		tooManyIDs[i] = validEntryID
	}
	tooManyBody := `{"title":"x","attachmentFileIds":["` + strings.Join(tooManyIDs, `","`) + `"]}`

	cases := []struct {
		name string
		body string
		code string
	}{
		{"invalid json", `{`, "INVALID_JSON"},
		{"empty title", `{"title":"   "}`, "VALIDATION_FAILED"},
		{"non-canonical protocol", `{"title":"x","protocol":"FTP"}`, "VALIDATION_FAILED"},
		{"malformed attachment id", `{"title":"x","attachmentFileIds":["nope"]}`, "VALIDATION_FAILED"},
		{"too many attachments", tooManyBody, "VALIDATION_FAILED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.Create(rec, knowledgeRequest(http.MethodPost, "/api/knowledge/entries", "operator", tc.body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if code := errorCode(t, rec); code != tc.code {
				t.Fatalf("expected %s, got %q", tc.code, code)
			}
		})
	}
}

func TestUpdateValidation(t *testing.T) {
	h := newTestHandler()

	t.Run("rejects malformed entry id", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.Update(rec, withEntryID(knowledgeRequest(http.MethodPut, "/api/knowledge/entries/nope", "operator", `{"title":"x","expectedRevision":1}`), "nope"))
		if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "INVALID_ENTRY_ID" {
			t.Fatalf("expected 400 INVALID_ENTRY_ID, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("rejects missing expectedRevision", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.Update(rec, withEntryID(knowledgeRequest(http.MethodPut, "/api/knowledge/entries/"+validEntryID, "operator", `{"title":"x"}`), validEntryID))
		if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "VALIDATION_FAILED" {
			t.Fatalf("expected 400 VALIDATION_FAILED, got %d: %s", rec.Code, rec.Body.String())
		}
	})
}

func TestDeleteValidation(t *testing.T) {
	h := newTestHandler()
	cases := []struct {
		name   string
		id     string
		target string
		code   string
	}{
		{"malformed entry id", "nope", "/api/knowledge/entries/nope?revision=1", "INVALID_ENTRY_ID"},
		{"missing revision", validEntryID, "/api/knowledge/entries/" + validEntryID, "INVALID_REVISION"},
		{"zero revision", validEntryID, "/api/knowledge/entries/" + validEntryID + "?revision=0", "INVALID_REVISION"},
		{"non-numeric revision", validEntryID, "/api/knowledge/entries/" + validEntryID + "?revision=abc", "INVALID_REVISION"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.Delete(rec, withEntryID(knowledgeRequest(http.MethodDelete, tc.target, "operator", ""), tc.id))
			if rec.Code != http.StatusBadRequest || errorCode(t, rec) != tc.code {
				t.Fatalf("expected 400 %s, got %d: %s", tc.code, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestGetAllowsViewerThroughReadGate(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestHandler().Get(rec, withEntryID(knowledgeRequest(http.MethodGet, "/api/knowledge/entries/nope", "viewer", ""), "nope"))
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "INVALID_ENTRY_ID" {
		t.Fatalf("viewer must pass the read gate and reach id validation, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestListQueryValidation(t *testing.T) {
	h := newTestHandler()
	cases := []struct {
		name   string
		target string
		code   string
	}{
		{"unsupported parameter", "/api/knowledge/entries?foo=1", "UNSUPPORTED_QUERY_PARAMETER"},
		{"zero limit", "/api/knowledge/entries?limit=0", "INVALID_LIMIT"},
		{"over limit", "/api/knowledge/entries?limit=101", "INVALID_LIMIT"},
		{"non-numeric limit", "/api/knowledge/entries?limit=abc", "INVALID_LIMIT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.List(rec, knowledgeRequest(http.MethodGet, tc.target, "viewer", ""))
			if rec.Code != http.StatusBadRequest || errorCode(t, rec) != tc.code {
				t.Fatalf("expected 400 %s, got %d: %s", tc.code, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestGetVersionValidation(t *testing.T) {
	h := newTestHandler()
	cases := []struct {
		name      string
		entryID   string
		versionID string
		code      string
	}{
		{"invalid entry", "nope", validEntryID, "INVALID_ENTRY_ID"},
		{"invalid version", validEntryID, "nope", "INVALID_VERSION_ID"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := knowledgeRequest(http.MethodGet, "/api/knowledge/entries/"+tc.entryID+"/versions/"+tc.versionID, "viewer", "")
			req.SetPathValue("entryId", tc.entryID)
			req.SetPathValue("versionId", tc.versionID)
			h.GetVersion(rec, req)
			if rec.Code != http.StatusBadRequest || errorCode(t, rec) != tc.code {
				t.Fatalf("expected 400 %s, got %d: %s", tc.code, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestDeleteFileValidation(t *testing.T) {
	rec := httptest.NewRecorder()
	req := knowledgeRequest(http.MethodDelete, "/api/knowledge/files/nope", "operator", "")
	req.SetPathValue("fileId", "nope")
	newTestHandler().DeleteFile(rec, req)
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "INVALID_FILE_ID" {
		t.Fatalf("expected 400 INVALID_FILE_ID, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSaveAttachmentRejectsEmptyFile(t *testing.T) {
	store, err := NewFileStore(t.TempDir(), t.TempDir())
	if err != nil {
		t.Fatalf("file store: %v", err)
	}
	_, _, _, _, err = store.SaveAttachment(validEntryID, "empty.txt", strings.NewReader(""))
	if !errors.Is(err, ErrFileEmpty) {
		t.Fatalf("expected ErrFileEmpty, got %v", err)
	}
}

func TestEntryAuditSnapshotExcludesBody(t *testing.T) {
	entry := &Entry{
		ID:          validEntryID,
		Title:       "audit",
		Protocol:    "SIP",
		Status:      StatusActive,
		Revision:    3,
		Phenomenon:  "sensitive phenomenon",
		RootCause:   "sensitive root cause",
		Solution:    "sensitive solution body",
		Tags:        []string{"sip"},
		Attachments: []Attachment{{FileID: validEntryID}},
	}
	snapshot := entryAuditSnapshot(entry)
	for _, forbidden := range []string{"phenomenon", "rootCause", "solution", "attachments"} {
		if _, ok := snapshot[forbidden]; ok {
			t.Fatalf("audit snapshot must not carry %q: %+v", forbidden, snapshot)
		}
	}
	if snapshot["attachmentCount"] != 1 || snapshot["revision"] != int64(3) {
		t.Fatalf("unexpected audit snapshot: %+v", snapshot)
	}
}
