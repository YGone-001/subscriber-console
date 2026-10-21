package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// RateLimiter defines the interface for rate limiting HTTP requests.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// AuditWriter defines the interface for recording audit log entries.
type AuditWriter interface {
	WriteBestEffort(input audit.WriteAuditInput)
}

// Handler handles HTTP requests for the knowledge base.
type Handler struct {
	repo        *Repository
	store       *FileStore
	limiter     RateLimiter
	auditWriter AuditWriter
}

// NewHandler creates a knowledge base HTTP handler.
func NewHandler(repo *Repository, store *FileStore, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{repo: repo, store: store, limiter: limiter, auditWriter: auditWriter}
}

// Meta handles GET /api/knowledge/meta.
func (h *Handler) Meta(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "knowledge:meta")
	if p == nil {
		return
	}
	meta, err := h.repo.Stats(r.Context())
	if err != nil {
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, meta)
}

// List handles GET /api/knowledge/entries.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "knowledge:list")
	if p == nil {
		return
	}

	q := r.URL.Query()
	allowed := map[string]bool{"q": true, "protocol": true, "tag": true, "cursor": true, "limit": true}
	for param := range q {
		if !allowed[param] {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}

	limit := 20
	if limitStr := q.Get("limit"); limitStr != "" {
		parsed, err := strconv.Atoi(limitStr)
		if err != nil || parsed < 1 || parsed > 100 {
			response.BadRequest(w, "limit must be an integer between 1 and 100", "INVALID_LIMIT")
			return
		}
		limit = parsed
	}

	filter := ListFilter{
		Query:    strings.TrimSpace(q.Get("q")),
		Protocol: strings.TrimSpace(q.Get("protocol")),
		Tag:      strings.TrimSpace(q.Get("tag")),
		Limit:    limit,
		Cursor:   strings.TrimSpace(q.Get("cursor")),
	}

	items, total, nextCursor, hasMore, err := h.repo.List(r.Context(), filter)
	if err != nil {
		if strings.Contains(err.Error(), "cursor") || strings.Contains(err.Error(), "search query") {
			response.BadRequest(w, err.Error(), "INVALID_QUERY")
			return
		}
		response.InternalError(w)
		return
	}

	response.JSON(w, http.StatusOK, ListEntriesResponse{
		Entries: items,
		Total:   total,
		Page:    PageInfo{Limit: limit, NextCursor: nextCursor, HasMore: hasMore},
	})
}

// Get handles GET /api/knowledge/entries/{entryId}.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "knowledge:get")
	if p == nil {
		return
	}
	entryID := r.PathValue("entryId")
	if !IsValidID(entryID) {
		response.BadRequest(w, "entryId must be a valid UUID v4", "INVALID_ENTRY_ID")
		return
	}
	entry, err := h.repo.GetByID(r.Context(), entryID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Knowledge entry not found", "KNOWLEDGE_ENTRY_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	response.JSON(w, http.StatusOK, entry)
}

// Create handles POST /api/knowledge/entries.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/knowledge/entries")
	if p == nil {
		return
	}

	var req CreateEntryRequest
	if err := decodeStrictJSON(r.Body, MaxJSONBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_JSON")
		return
	}
	protocol, tags, err := ValidateCreateRequest(&req)
	if err != nil {
		response.BadRequest(w, err.Error(), "VALIDATION_FAILED")
		return
	}

	entryID := audit.GenerateUUID()
	attachments, err := h.claimFiles(r.Context(), req.AttachmentFileIDs, entryID)
	if err != nil {
		h.mapFileError(w, err)
		return
	}

	entry, err := h.repo.Create(r.Context(), entryID, &req, protocol, tags, attachments, p.Username)
	if err != nil {
		response.InternalError(w)
		return
	}

	h.audit(p, "knowledge.entry.create", "knowledge_entry", entry.ID, entry.Title, nil, entry, nil)
	response.JSON(w, http.StatusCreated, entry)
}

// Update handles PUT /api/knowledge/entries/{entryId}.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "PUT", "/api/knowledge/entries/{entryId}")
	if p == nil {
		return
	}
	entryID := r.PathValue("entryId")
	if !IsValidID(entryID) {
		response.BadRequest(w, "entryId must be a valid UUID v4", "INVALID_ENTRY_ID")
		return
	}

	var req UpdateEntryRequest
	if err := decodeStrictJSON(r.Body, MaxJSONBodyBytes, &req); err != nil {
		response.BadRequest(w, err.Error(), "INVALID_JSON")
		return
	}
	protocol, tags, err := ValidateUpdateRequest(&req)
	if err != nil {
		response.BadRequest(w, err.Error(), "VALIDATION_FAILED")
		return
	}

	existing, err := h.repo.GetByID(r.Context(), entryID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Knowledge entry not found", "KNOWLEDGE_ENTRY_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	if existing.Revision != req.ExpectedRevision {
		response.Error(w, http.StatusConflict, "Concurrent modification detected", "KNOWLEDGE_REVISION_CONFLICT")
		return
	}

	attachments, removed, err := h.reconcileFiles(r.Context(), entryID, existing.Attachments, req.AttachmentFileIDs)
	if err != nil {
		h.mapFileError(w, err)
		return
	}

	before, after, err := h.repo.Update(r.Context(), entryID, &req, protocol, tags, attachments, p.Username)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Knowledge entry not found", "KNOWLEDGE_ENTRY_NOT_FOUND")
			return
		}
		if errors.Is(err, ErrRevisionConflict) {
			response.Error(w, http.StatusConflict, "Concurrent modification detected", "KNOWLEDGE_REVISION_CONFLICT")
			return
		}
		response.InternalError(w)
		return
	}

	h.releaseFiles(r.Context(), removed)
	h.audit(p, "knowledge.entry.update", "knowledge_entry", after.ID, after.Title, before, after, nil)
	response.JSON(w, http.StatusOK, after)
}

// Delete handles DELETE /api/knowledge/entries/{entryId}?revision=.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "DELETE", "/api/knowledge/entries/{entryId}")
	if p == nil {
		return
	}
	entryID := r.PathValue("entryId")
	if !IsValidID(entryID) {
		response.BadRequest(w, "entryId must be a valid UUID v4", "INVALID_ENTRY_ID")
		return
	}
	revision, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("revision")), 10, 64)
	if err != nil || revision <= 0 {
		response.BadRequest(w, "revision query parameter is required", "INVALID_REVISION")
		return
	}

	entry, err := h.repo.Delete(r.Context(), entryID, revision)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			response.Error(w, http.StatusNotFound, "Knowledge entry not found", "KNOWLEDGE_ENTRY_NOT_FOUND")
			return
		}
		if errors.Is(err, ErrRevisionConflict) {
			response.Error(w, http.StatusConflict, "Concurrent modification detected", "KNOWLEDGE_REVISION_CONFLICT")
			return
		}
		response.InternalError(w)
		return
	}

	h.releaseEntryFiles(r.Context(), entry)
	h.audit(p, "knowledge.entry.delete", "knowledge_entry", entry.ID, entry.Title, entry, nil, nil)
	response.JSON(w, http.StatusOK, map[string]any{"deleted": true, "id": entry.ID})
}

// Upload handles POST /api/knowledge/files (multipart/form-data).
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	p := h.requireConfigure(w, r, "POST", "/api/knowledge/files")
	if p == nil {
		return
	}

	if err := r.ParseMultipartForm(MaxFileBytes); err != nil {
		response.BadRequest(w, "invalid multipart form", "INVALID_MULTIPART")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		response.BadRequest(w, "multipart field \"file\" is required", "INVALID_MULTIPART")
		return
	}
	defer file.Close()

	fileID := audit.GenerateUUID()
	kind, contentType, size, sum, err := h.store.SaveAttachment(fileID, header.Filename, file)
	if err != nil {
		h.mapFileError(w, err)
		return
	}

	meta := &FileMeta{
		ID:           fileID,
		OriginalName: sanitizeOriginalName(header.Filename),
		ContentType:  contentType,
		Kind:         kind,
		Size:         size,
		SHA256:       sum,
		EntryID:      "",
		CreatedAt:    CurrentTimestamp(),
		CreatedBy:    p.Username,
	}
	if err := h.repo.InsertFileMeta(r.Context(), meta); err != nil {
		_ = h.store.Trash(fileID)
		response.InternalError(w)
		return
	}

	h.audit(p, "knowledge.file.upload", "knowledge_file", fileID, meta.OriginalName, nil, meta, nil)
	response.JSON(w, http.StatusCreated, UploadResponse{
		FileID:       fileID,
		OriginalName: meta.OriginalName,
		ContentType:  contentType,
		Kind:         kind,
		Size:         size,
		SHA256:       sum,
	})
}

// Download handles GET /api/knowledge/files/{fileId}. Images are served inline
// (unless ?download=1); every other class is served as an attachment. Responses
// carry nosniff, an explicit content type, ETag and cache controls.
func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "knowledge:file")
	if p == nil {
		return
	}
	fileID := r.PathValue("fileId")
	if !IsValidID(fileID) {
		response.BadRequest(w, "fileId must be a valid UUID v4", "INVALID_FILE_ID")
		return
	}

	meta, err := h.repo.GetFileMeta(r.Context(), fileID)
	if err != nil {
		if errors.Is(err, ErrFileNotFound) {
			response.Error(w, http.StatusNotFound, "Attachment not found", "KNOWLEDGE_FILE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}

	f, err := h.store.Open(fileID)
	if err != nil {
		if errors.Is(err, ErrFileNotFound) {
			response.Error(w, http.StatusNotFound, "Attachment not found", "KNOWLEDGE_FILE_NOT_FOUND")
			return
		}
		response.InternalError(w)
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", meta.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private")
	w.Header().Set("ETag", `"`+meta.SHA256+`"`)

	forceDownload := r.URL.Query().Get("download") == "1"
	inline := meta.Kind == FileKindImage && !forceDownload
	if inline {
		w.Header().Set("Content-Disposition", "inline")
	} else {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, sanitizeOriginalName(meta.OriginalName)))
	}

	if match := r.Header.Get("If-None-Match"); match != "" && match == `"`+meta.SHA256+`"` {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	http.ServeContent(w, r, meta.OriginalName, time.Time{}, f)
}

// --- helpers ---

func (h *Handler) requireRead(w http.ResponseWriter, r *http.Request, key string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, r.Method, r.URL.Path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, key+":"+p.Username, 120, 60) {
		return nil
	}
	return p
}

func (h *Handler) requireConfigure(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.configure") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "authorization.denied",
		Module: "knowledge",
		Actor:  audit.ActorInput{Type: "user", Username: p.Username, Role: p.Role},
		Result: "denied",
		Metadata: map[string]any{
			"method": method,
			"path":   path,
		},
	})
}

func (h *Handler) audit(p *auth.Principal, action, resourceType, id, name string, before, after any, reason *string) {
	if h.auditWriter == nil {
		return
	}
	reasonStr := ""
	if reason != nil {
		reasonStr = *reason
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: action,
		Module: "knowledge",
		Actor:  audit.ActorInput{Type: "user", Username: p.Username, Role: p.Role},
		Resource: &audit.ResourceInput{
			Type: resourceType,
			ID:   id,
			Name: name,
		},
		TargetID: id,
		Reason:   reasonStr,
		Before:   before,
		After:    after,
		Result:   "success",
	})
}

func (h *Handler) mapFileError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrFileTooLarge):
		response.Error(w, http.StatusRequestEntityTooLarge, "Attachment exceeds the size limit", "KNOWLEDGE_FILE_TOO_LARGE")
	case errors.Is(err, ErrFileTypeRejected):
		response.BadRequest(w, "Attachment type is not allowed", "KNOWLEDGE_FILE_TYPE_REJECTED")
	case errors.Is(err, ErrFileUnavailable):
		response.BadRequest(w, "Attachment is not available", "KNOWLEDGE_FILE_NOT_AVAILABLE")
	case errors.Is(err, ErrFileNotFound):
		response.Error(w, http.StatusNotFound, "Attachment not found", "KNOWLEDGE_FILE_NOT_FOUND")
	default:
		response.InternalError(w)
	}
}

// claimFiles binds a set of unclaimed uploads to an entry and returns their
// server-computed attachment projections. Any failure rolls the prior claims
// back so no file is left bound to a half-created entry.
func (h *Handler) claimFiles(ctx context.Context, fileIDs []string, entryID string) ([]Attachment, error) {
	if len(fileIDs) == 0 {
		return []Attachment{}, nil
	}
	metas := make([]*FileMeta, 0, len(fileIDs))
	for _, fid := range fileIDs {
		meta, err := h.repo.GetFileMeta(ctx, fid)
		if err != nil {
			h.rollbackClaims(ctx, metas)
			return nil, err
		}
		if meta.EntryID != "" {
			h.rollbackClaims(ctx, metas)
			return nil, ErrFileUnavailable
		}
		metas = append(metas, meta)
	}
	for _, meta := range metas {
		if err := h.repo.ClaimFile(ctx, meta.ID, entryID); err != nil {
			h.rollbackClaims(ctx, metas)
			return nil, err
		}
	}
	attachments := make([]Attachment, 0, len(metas))
	for _, meta := range metas {
		attachments = append(attachments, Attachment{
			FileID:       meta.ID,
			OriginalName: meta.OriginalName,
			ContentType:  meta.ContentType,
			Kind:         meta.Kind,
			Size:         meta.Size,
			SHA256:       meta.SHA256,
		})
	}
	return attachments, nil
}

func (h *Handler) rollbackClaims(ctx context.Context, metas []*FileMeta) {
	for _, meta := range metas {
		_ = h.repo.UnbindFile(ctx, meta.ID)
	}
}

// reconcileFiles computes the new attachment set for an update, preserving
// already-bound files and claiming only newly-added uploads.
func (h *Handler) reconcileFiles(ctx context.Context, entryID string, existing []Attachment, requested []string) ([]Attachment, []Attachment, error) {
	existingByID := make(map[string]Attachment, len(existing))
	for _, a := range existing {
		existingByID[a.FileID] = a
	}
	requestedSet := make(map[string]bool, len(requested))
	for _, id := range requested {
		requestedSet[id] = true
	}

	removed := []Attachment{}
	for _, a := range existing {
		if !requestedSet[a.FileID] {
			removed = append(removed, a)
		}
	}

	addIDs := []string{}
	for _, id := range requested {
		if _, ok := existingByID[id]; !ok {
			addIDs = append(addIDs, id)
		}
	}

	added, err := h.claimFiles(ctx, addIDs, entryID)
	if err != nil {
		return nil, nil, err
	}
	addedByID := make(map[string]Attachment, len(added))
	for _, a := range added {
		addedByID[a.FileID] = a
	}

	attachments := make([]Attachment, 0, len(requested))
	for _, id := range requested {
		if a, ok := existingByID[id]; ok {
			attachments = append(attachments, a)
		} else if a, ok := addedByID[id]; ok {
			attachments = append(attachments, a)
		}
	}
	return attachments, removed, nil
}

// releaseFiles trashes and releases attachment bytes for files no longer
// referenced. Both steps are best-effort and never block the business response.
func (h *Handler) releaseFiles(ctx context.Context, attachments []Attachment) {
	for _, a := range attachments {
		if err := h.store.Trash(a.FileID); err != nil {
			continue
		}
		if err := h.repo.ReleaseFile(ctx, a.FileID); err != nil {
			continue
		}
	}
}

// releaseEntryFiles releases every attachment bound to a deleted entry.
func (h *Handler) releaseEntryFiles(ctx context.Context, entry *Entry) {
	h.releaseFiles(ctx, entry.Attachments)
}

func decodeStrictJSON(r io.Reader, maxBytes int64, dst any) error {
	limited := io.LimitReader(r, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("failed to read request body: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return errors.New("request body is empty")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("unexpected trailing content after JSON")
	}
	return nil
}

func sanitizeOriginalName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "\"", "")
	name = strings.ReplaceAll(name, "\\", "")
	name = strings.ReplaceAll(name, "\r", "")
	name = strings.ReplaceAll(name, "\n", "")
	if len(name) > 255 {
		name = name[:255]
	}
	if name == "" {
		return "attachment"
	}
	return name
}
