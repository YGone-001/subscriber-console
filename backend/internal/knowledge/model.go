// Package knowledge implements the xCloud knowledge base: fault phenomena,
// root causes and resolutions with secure attachment storage.
//
// Storage is split by authority: entry and attachment metadata live in
// xcloud_ops (app_knowledge_entries / app_knowledge_files), while attachment
// bytes live on the local filesystem under a configured upload directory.
// Deleted files are moved to a sibling trash directory rather than removed, so
// an operator can recover a mistakenly discarded attachment.
package knowledge

import (
	"errors"
	"time"
)

// SchemaVersion defines the authoritative schema version for knowledge entries.
const SchemaVersion = 1

// Canonical protocols offered by the editor and reported by the meta endpoint.
// The list is server-owned so the console and the API never drift apart.
var CanonicalProtocols = []string{
	"General",
	"SIP",
	"Diameter",
	"GTP",
	"HTTP/2",
	"PFCP",
	"NAS",
	"VoLTE",
	"5G SA",
	"Other",
}

// Storage and validation limits.
const (
	MaxTitleLength      = 200
	MaxProtocolLength   = 32
	MaxPhenomenonLength = 4000
	MaxRootCauseLength  = 4000
	MaxSolutionLength   = 200 * 1024
	MaxTags             = 20
	MaxTagLength        = 32
	MaxAttachments      = 10
	MaxInlineImages     = 20
	MaxJSONBodyBytes    = 512 * 1024
	MaxFileBytes        = 8 * 1024 * 1024

	// DefaultUploadDir and DefaultTrashDir are the production persistence and
	// recovery roots for attachment bytes.
	DefaultUploadDir = "/srv/internal-resource-server/uploads"
	DefaultTrashDir  = "/srv/internal-resource-server/.trash"
)

// FileKind is the coarse content class of a stored attachment. It is derived
// from the file's magic bytes, never from the client-declared extension.
type FileKind string

const (
	FileKindImage FileKind = "image"
	FileKindPDF   FileKind = "pdf"
	FileKindText  FileKind = "text"
	FileKindPcap  FileKind = "pcap"
)

// Attachment is the server-owned view of a file bound to one entry. Every field
// is back-filled from the file metadata; clients never author these values.
type Attachment struct {
	FileID       string   `json:"fileId" bson:"fileId"`
	OriginalName string   `json:"originalName" bson:"originalName"`
	ContentType  string   `json:"contentType" bson:"contentType"`
	Kind         FileKind `json:"kind" bson:"kind"`
	Size         int64    `json:"size" bson:"size"`
	SHA256       string   `json:"sha256" bson:"sha256"`
}

// Entry is a knowledge base article stored in app_knowledge_entries.
type Entry struct {
	ID            string       `json:"id" bson:"_id"`
	SchemaVersion int          `json:"schemaVersion" bson:"schemaVersion"`
	Title         string       `json:"title" bson:"title"`
	Protocol      string       `json:"protocol" bson:"protocol"`
	Phenomenon    string       `json:"phenomenon" bson:"phenomenon"`
	RootCause     string       `json:"rootCause" bson:"rootCause"`
	Solution      string       `json:"solution" bson:"solution"`
	Tags          []string     `json:"tags" bson:"tags"`
	Attachments   []Attachment `json:"attachments" bson:"attachments"`
	Revision      int64        `json:"revision" bson:"revision"`
	CreatedAt     string       `json:"createdAt" bson:"createdAt"`
	CreatedBy     string       `json:"createdBy" bson:"createdBy"`
	UpdatedAt     string       `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy     string       `json:"updatedBy" bson:"updatedBy"`
}

// FileMeta is the attachment metadata record stored in app_knowledge_files.
// The bytes live on disk under the upload directory; entryID is empty until the
// owning entry claims the file.
type FileMeta struct {
	ID           string   `json:"id" bson:"_id"`
	OriginalName string   `json:"originalName" bson:"originalName"`
	ContentType  string   `json:"contentType" bson:"contentType"`
	Kind         FileKind `json:"kind" bson:"kind"`
	Size         int64    `json:"size" bson:"size"`
	SHA256       string   `json:"sha256" bson:"sha256"`
	EntryID      string   `json:"entryId" bson:"entryId"`
	CreatedAt    string   `json:"createdAt" bson:"createdAt"`
	CreatedBy    string   `json:"createdBy" bson:"createdBy"`
}

// EntrySummary is the list projection of an entry; the solution body is omitted
// so the list stays cheap and the detail endpoint remains the sole source of the
// full Markdown content.
type EntrySummary struct {
	ID          string       `json:"id" bson:"_id"`
	Title       string       `json:"title" bson:"title"`
	Protocol    string       `json:"protocol" bson:"protocol"`
	Phenomenon  string       `json:"phenomenon" bson:"phenomenon"`
	Tags        []string     `json:"tags" bson:"tags"`
	Attachments []Attachment `json:"attachments" bson:"attachments"`
	Revision    int64        `json:"revision" bson:"revision"`
	CreatedAt   string       `json:"createdAt" bson:"createdAt"`
	CreatedBy   string       `json:"createdBy" bson:"createdBy"`
	UpdatedAt   string       `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy   string       `json:"updatedBy" bson:"updatedBy"`
}

// CreateEntryRequest is the body of POST /api/knowledge/entries.
type CreateEntryRequest struct {
	Title             string   `json:"title"`
	Protocol          string   `json:"protocol,omitempty"`
	Phenomenon        string   `json:"phenomenon,omitempty"`
	RootCause         string   `json:"rootCause,omitempty"`
	Solution          string   `json:"solution,omitempty"`
	Tags              []string `json:"tags,omitempty"`
	AttachmentFileIDs []string `json:"attachmentFileIds,omitempty"`
}

// UpdateEntryRequest is the body of PUT /api/knowledge/entries/{entryId}. The
// expected revision gates the write against concurrent modification.
type UpdateEntryRequest struct {
	ExpectedRevision  int64    `json:"expectedRevision"`
	Title             string   `json:"title"`
	Protocol          string   `json:"protocol,omitempty"`
	Phenomenon        string   `json:"phenomenon,omitempty"`
	RootCause         string   `json:"rootCause,omitempty"`
	Solution          string   `json:"solution,omitempty"`
	Tags              []string `json:"tags,omitempty"`
	AttachmentFileIDs []string `json:"attachmentFileIds,omitempty"`
}

// TagCount and ProtocolCount describe aggregate buckets for the meta endpoint.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int64  `json:"count"`
}

type ProtocolCount struct {
	Protocol string `json:"protocol"`
	Count    int64  `json:"count"`
}

// MetaResponse is the payload of GET /api/knowledge/meta.
type MetaResponse struct {
	SchemaVersion   int             `json:"schemaVersion"`
	Protocols       []string        `json:"protocols"`
	TopTags         []TagCount      `json:"topTags"`
	ProtocolCounts  []ProtocolCount `json:"protocolCounts"`
	Total           int64           `json:"total"`
	MaxFileBytes    int64           `json:"maxFileBytes"`
	MaxAttachments  int             `json:"maxAttachments"`
	MaxInlineImages int             `json:"maxInlineImages"`
}

// PageInfo mirrors the cursor-pagination shape used across the console.
type PageInfo struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}

// ListEntriesResponse is the payload of GET /api/knowledge/entries.
type ListEntriesResponse struct {
	Entries []EntrySummary `json:"entries"`
	Total   int64          `json:"total"`
	Page    PageInfo       `json:"page"`
}

// UploadResponse is the payload of POST /api/knowledge/files.
type UploadResponse struct {
	FileID       string   `json:"fileId"`
	OriginalName string   `json:"originalName"`
	ContentType  string   `json:"contentType"`
	Kind         FileKind `json:"kind"`
	Size         int64    `json:"size"`
	SHA256       string   `json:"sha256"`
}

// Sentinel errors mapped to HTTP responses by the handler.
var (
	ErrNotFound         = errors.New("KNOWLEDGE_ENTRY_NOT_FOUND")
	ErrRevisionConflict = errors.New("KNOWLEDGE_REVISION_CONFLICT")
	ErrFileNotFound     = errors.New("KNOWLEDGE_FILE_NOT_FOUND")
	ErrFileUnavailable  = errors.New("KNOWLEDGE_FILE_NOT_AVAILABLE")
	ErrFileTooLarge     = errors.New("KNOWLEDGE_FILE_TOO_LARGE")
	ErrFileTypeRejected = errors.New("KNOWLEDGE_FILE_TYPE_REJECTED")
)

// CurrentTimestamp returns an RFC3339 formatted UTC timestamp.
func CurrentTimestamp() string {
	return time.Now().UTC().Format(time.RFC3339)
}
