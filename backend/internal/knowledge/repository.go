package knowledge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Canonical collection names in xcloud_ops.
const (
	CollectionEntries = "app_knowledge_entries"
	CollectionFiles   = "app_knowledge_files"
)

// MaxSearchQueryLength bounds the search needle before it is escaped.
const MaxSearchQueryLength = 64

// CursorData is the opaque keyset cursor payload.
type CursorData struct {
	UpdatedAt string `json:"u"`
	ID        string `json:"i"`
}

// ListFilter carries the list/search query parameters.
type ListFilter struct {
	Query    string
	Protocol string
	Tag      string
	Limit    int
	Cursor   string
}

// Repository persists knowledge entries and attachment metadata in xcloud_ops.
type Repository struct {
	entries *mongo.Collection
	files   *mongo.Collection
}

// NewRepository creates a knowledge repository over the two collections.
func NewRepository(entries, files *mongo.Collection) *Repository {
	return &Repository{entries: entries, files: files}
}

// Create inserts a new entry with revision 1. The caller owns the identity so
// it can pre-claim attachment files against the same id.
func (r *Repository) Create(ctx context.Context, id string, req *CreateEntryRequest, protocol string, tags []string, attachments []Attachment, actor string) (*Entry, error) {
	now := CurrentTimestamp()
	entry := &Entry{
		ID:            id,
		SchemaVersion: SchemaVersion,
		Title:         req.Title,
		Protocol:      protocol,
		Phenomenon:    req.Phenomenon,
		RootCause:     req.RootCause,
		Solution:      req.Solution,
		Tags:          tags,
		Attachments:   attachments,
		Revision:      1,
		CreatedAt:     now,
		CreatedBy:     actor,
		UpdatedAt:     now,
		UpdatedBy:     actor,
	}
	if entry.Attachments == nil {
		entry.Attachments = []Attachment{}
	}
	if entry.Tags == nil {
		entry.Tags = []string{}
	}

	if _, err := r.entries.InsertOne(ctx, entry); err != nil {
		return nil, fmt.Errorf("failed to insert knowledge entry: %w", err)
	}
	return entry, nil
}

// GetByID retrieves a single entry by its UUID.
func (r *Repository) GetByID(ctx context.Context, id string) (*Entry, error) {
	if !IsValidID(id) {
		return nil, ErrNotFound
	}
	var entry Entry
	err := r.entries.FindOne(ctx, bson.M{"_id": id}).Decode(&entry)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("failed to find knowledge entry: %w", err)
	}
	return &entry, nil
}

// List queries entries with filters and keyset cursor pagination. The solution
// body is excluded from the projection so the list remains cheap.
func (r *Repository) List(ctx context.Context, filter ListFilter) ([]EntrySummary, int64, *string, bool, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	filterDoc, err := buildListFilter(filter)
	if err != nil {
		return nil, 0, nil, false, err
	}

	// The total describes the whole filtered set, not the page remaining after
	// the cursor. Counting with the cursor would shrink the total on every page.
	countFilter := filter
	countFilter.Cursor = ""
	countFilterDoc, err := buildListFilter(countFilter)
	if err != nil {
		return nil, 0, nil, false, err
	}
	total, err := r.entries.CountDocuments(ctx, countFilterDoc)
	if err != nil {
		return nil, 0, nil, false, fmt.Errorf("failed to count knowledge entries: %w", err)
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(limit + 1)).
		SetProjection(bson.M{"solution": 0})

	cursor, err := r.entries.Find(ctx, filterDoc, opts)
	if err != nil {
		return nil, 0, nil, false, fmt.Errorf("failed to query knowledge entries: %w", err)
	}
	defer cursor.Close(ctx)

	var items []EntrySummary
	for cursor.Next(ctx) {
		var item EntrySummary
		if err := cursor.Decode(&item); err != nil {
			return nil, 0, nil, false, fmt.Errorf("failed to decode knowledge entry: %w", err)
		}
		items = append(items, item)
	}
	if err := cursor.Err(); err != nil {
		return nil, 0, nil, false, fmt.Errorf("cursor iteration error: %w", err)
	}

	hasMore := false
	var nextCursor *string
	if len(items) > limit {
		hasMore = true
		items = items[:limit]
		last := items[limit-1]
		cData := CursorData{UpdatedAt: last.UpdatedAt, ID: last.ID}
		cBytes, _ := json.Marshal(cData)
		encoded := base64.URLEncoding.EncodeToString(cBytes)
		nextCursor = &encoded
	}
	if items == nil {
		items = []EntrySummary{}
	}
	return items, total, nextCursor, hasMore, nil
}

func buildListFilter(filter ListFilter) (bson.M, error) {
	doc := bson.M{}
	if filter.Protocol != "" {
		doc["protocol"] = filter.Protocol
	}
	if filter.Tag != "" {
		doc["tags"] = filter.Tag
	}
	if q := strings.TrimSpace(filter.Query); q != "" {
		if utf8.RuneCountInString(q) > MaxSearchQueryLength {
			return nil, fmt.Errorf("search query must not exceed %d characters", MaxSearchQueryLength)
		}
		pattern := regexp.QuoteMeta(q)
		doc["$or"] = []bson.M{
			{"title": bson.M{"$regex": pattern, "$options": "i"}},
			{"phenomenon": bson.M{"$regex": pattern, "$options": "i"}},
			{"rootCause": bson.M{"$regex": pattern, "$options": "i"}},
			{"tags": bson.M{"$regex": pattern, "$options": "i"}},
			{"protocol": bson.M{"$regex": pattern, "$options": "i"}},
		}
	}
	if filter.Cursor != "" {
		cursorBytes, err := base64.URLEncoding.DecodeString(filter.Cursor)
		if err != nil {
			return nil, fmt.Errorf("invalid pagination cursor encoding")
		}
		var cur CursorData
		if err := json.Unmarshal(cursorBytes, &cur); err != nil || cur.UpdatedAt == "" || cur.ID == "" {
			return nil, fmt.Errorf("invalid pagination cursor payload")
		}
		cursorFilter := bson.M{
			"$or": []bson.M{
				{"updatedAt": bson.M{"$lt": cur.UpdatedAt}},
				{"updatedAt": cur.UpdatedAt, "_id": bson.M{"$gt": cur.ID}},
			},
		}
		if len(doc) == 0 {
			doc = cursorFilter
		} else {
			doc = bson.M{"$and": []bson.M{doc, cursorFilter}}
		}
	}
	return doc, nil
}

// Update performs an atomic CAS update of mutable fields and attachment set.
func (r *Repository) Update(ctx context.Context, id string, req *UpdateEntryRequest, protocol string, tags []string, attachments []Attachment, actor string) (*Entry, *Entry, error) {
	if !IsValidID(id) {
		return nil, nil, ErrNotFound
	}
	existing, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}

	now := CurrentTimestamp()
	updateFilter := bson.M{"_id": id, "revision": req.ExpectedRevision}
	updateDoc := bson.M{
		"$set": bson.M{
			"title":       req.Title,
			"protocol":    protocol,
			"phenomenon":  req.Phenomenon,
			"rootCause":   req.RootCause,
			"solution":    req.Solution,
			"tags":        tags,
			"attachments": attachments,
			"updatedAt":   now,
			"updatedBy":   actor,
			"revision":    req.ExpectedRevision + 1,
		},
	}

	result, err := r.entries.UpdateOne(ctx, updateFilter, updateDoc)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to update knowledge entry: %w", err)
	}
	if result.MatchedCount == 0 {
		if _, gerr := r.GetByID(ctx, id); gerr != nil {
			return nil, nil, gerr
		}
		return nil, nil, ErrRevisionConflict
	}

	updated, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	return existing, updated, nil
}

// Delete removes an entry atomically guarded by its revision.
func (r *Repository) Delete(ctx context.Context, id string, revision int64) (*Entry, error) {
	if !IsValidID(id) {
		return nil, ErrNotFound
	}
	existing, err := r.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if existing.Revision != revision {
		return nil, ErrRevisionConflict
	}
	result, err := r.entries.DeleteOne(ctx, bson.M{"_id": id, "revision": revision})
	if err != nil {
		return nil, fmt.Errorf("failed to delete knowledge entry: %w", err)
	}
	if result.DeletedCount == 0 {
		if _, gerr := r.GetByID(ctx, id); gerr != nil {
			return nil, gerr
		}
		return nil, ErrRevisionConflict
	}
	return existing, nil
}

// Stats computes the meta aggregates: total count, top tags and per-protocol
// distribution.
func (r *Repository) Stats(ctx context.Context) (*MetaResponse, error) {
	total, err := r.entries.CountDocuments(ctx, bson.M{})
	if err != nil {
		return nil, fmt.Errorf("failed to count knowledge entries: %w", err)
	}

	topTags, err := r.topTags(ctx)
	if err != nil {
		return nil, err
	}
	protocols, err := r.protocolCounts(ctx)
	if err != nil {
		return nil, err
	}

	return &MetaResponse{
		SchemaVersion:   SchemaVersion,
		Protocols:       CanonicalProtocols,
		TopTags:         topTags,
		ProtocolCounts:  protocols,
		Total:           total,
		MaxFileBytes:    MaxFileBytes,
		MaxAttachments:  MaxAttachments,
		MaxInlineImages: MaxInlineImages,
		MaxTags:         MaxTags,
		MaxTagLength:    MaxTagLength,
	}, nil
}

func (r *Repository) topTags(ctx context.Context) ([]TagCount, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$unwind", Value: "$tags"}},
		{{Key: "$group", Value: bson.M{"_id": "$tags", "count": bson.M{"$sum": 1}}}},
		{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}, {Key: "_id", Value: 1}}}},
		{{Key: "$limit", Value: 10}},
	}
	cursor, err := r.entries.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("failed to aggregate knowledge tags: %w", err)
	}
	defer cursor.Close(ctx)

	out := []TagCount{}
	for cursor.Next(ctx) {
		var row struct {
			ID    string `bson:"_id"`
			Count int64  `bson:"count"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, fmt.Errorf("failed to decode tag aggregate: %w", err)
		}
		out = append(out, TagCount{Tag: row.ID, Count: row.Count})
	}
	return out, nil
}

func (r *Repository) protocolCounts(ctx context.Context) ([]ProtocolCount, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{"_id": "$protocol", "count": bson.M{"$sum": 1}}}},
		{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}, {Key: "_id", Value: 1}}}},
		{{Key: "$limit", Value: 20}},
	}
	cursor, err := r.entries.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("failed to aggregate knowledge protocols: %w", err)
	}
	defer cursor.Close(ctx)

	out := []ProtocolCount{}
	for cursor.Next(ctx) {
		var row struct {
			ID    string `bson:"_id"`
			Count int64  `bson:"count"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, fmt.Errorf("failed to decode protocol aggregate: %w", err)
		}
		name := row.ID
		if name == "" {
			name = "General"
		}
		out = append(out, ProtocolCount{Protocol: name, Count: row.Count})
	}
	return out, nil
}

// InsertFileMeta persists attachment metadata for a freshly uploaded file.
func (r *Repository) InsertFileMeta(ctx context.Context, meta *FileMeta) error {
	if _, err := r.files.InsertOne(ctx, meta); err != nil {
		return fmt.Errorf("failed to insert knowledge file metadata: %w", err)
	}
	return nil
}

// GetFileMeta retrieves attachment metadata by UUID.
func (r *Repository) GetFileMeta(ctx context.Context, id string) (*FileMeta, error) {
	if !IsValidID(id) {
		return nil, ErrFileNotFound
	}
	var meta FileMeta
	err := r.files.FindOne(ctx, bson.M{"_id": id}).Decode(&meta)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrFileNotFound
		}
		return nil, fmt.Errorf("failed to find knowledge file metadata: %w", err)
	}
	return &meta, nil
}

// ClaimFile atomically binds an unbound file to an entry. A file already bound
// to another entry is reported as unavailable.
func (r *Repository) ClaimFile(ctx context.Context, fileID, entryID string) error {
	result := r.files.FindOneAndUpdate(
		ctx,
		bson.M{"_id": fileID, "entryId": ""},
		bson.M{"$set": bson.M{"entryId": entryID}},
	)
	if err := result.Err(); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return ErrFileUnavailable
		}
		return fmt.Errorf("failed to claim knowledge file: %w", err)
	}
	return nil
}

// UnbindFile clears a file's entry binding, restoring it to the unclaimed pool.
// Used to roll back a partial claim when a later claim fails.
func (r *Repository) UnbindFile(ctx context.Context, fileID string) error {
	_, err := r.files.UpdateOne(ctx, bson.M{"_id": fileID}, bson.M{"$set": bson.M{"entryId": ""}})
	if err != nil {
		return fmt.Errorf("failed to unbind knowledge file: %w", err)
	}
	return nil
}

// ReleaseFile deletes attachment metadata. The caller is responsible for moving
// the on-disk bytes to trash first.
func (r *Repository) ReleaseFile(ctx context.Context, fileID string) error {
	_, err := r.files.DeleteOne(ctx, bson.M{"_id": fileID})
	if err != nil {
		return fmt.Errorf("failed to release knowledge file: %w", err)
	}
	return nil
}

// ListFilesByEntry returns metadata for every file bound to an entry.
func (r *Repository) ListFilesByEntry(ctx context.Context, entryID string) ([]FileMeta, error) {
	cursor, err := r.files.Find(ctx, bson.M{"entryId": entryID})
	if err != nil {
		return nil, fmt.Errorf("failed to list entry files: %w", err)
	}
	defer cursor.Close(ctx)
	var metas []FileMeta
	if err := cursor.All(ctx, &metas); err != nil {
		return nil, fmt.Errorf("failed to decode entry files: %w", err)
	}
	return metas, nil
}

// ListUnboundBefore returns unbound files older than the cutoff, bounded by
// limit, for janitor cleanup.
func (r *Repository) ListUnboundBefore(ctx context.Context, cutoff string, limit int) ([]FileMeta, error) {
	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(int64(limit))
	cursor, err := r.files.Find(ctx, bson.M{"entryId": "", "createdAt": bson.M{"$lt": cutoff}}, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to list unbound files: %w", err)
	}
	defer cursor.Close(ctx)
	var metas []FileMeta
	if err := cursor.All(ctx, &metas); err != nil {
		return nil, fmt.Errorf("failed to decode unbound files: %w", err)
	}
	return metas, nil
}

// ListOrphanFiles returns files whose entryId points at a deleted entry, bounded
// by limit, via a single aggregation lookup.
func (r *Repository) ListOrphanFiles(ctx context.Context, limit int) ([]FileMeta, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.M{"entryId": bson.M{"$ne": ""}}}},
		{{Key: "$lookup", Value: bson.M{
			"from":         CollectionEntries,
			"localField":   "entryId",
			"foreignField": "_id",
			"as":           "entry",
		}}},
		{{Key: "$match", Value: bson.M{"entry": bson.M{"$size": 0}}}},
		{{Key: "$limit", Value: limit}},
		{{Key: "$project", Value: bson.M{"entry": 0}}},
	}
	cursor, err := r.files.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("failed to aggregate orphan files: %w", err)
	}
	defer cursor.Close(ctx)
	var metas []FileMeta
	if err := cursor.All(ctx, &metas); err != nil {
		return nil, fmt.Errorf("failed to decode orphan files: %w", err)
	}
	return metas, nil
}
