package discovery

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"subscriber/internal/audit"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// CursorData is the opaque keyset cursor payload shared with Inventory/Topology.
type CursorData struct {
	UpdatedAt string `json:"u"`
	ID        string `json:"i"`
}

// SourceListFilter filters discovery source listings.
type SourceListFilter struct {
	Query  string
	Limit  int
	Cursor string
}

// RunListFilter filters discovery run listings.
type RunListFilter struct {
	SourceID string
	Status   string
	Limit    int
	Cursor   string
}

// CandidateListFilter filters NF observation listings.
type CandidateListFilter struct {
	SourceID         string
	NfType           string
	NfStatus         string
	ObservationState string
	LinkedResourceID string
	Limit            int
	Cursor           string
}

// Repository persists discovery sources, runs, and NF observations in xcloud_ops.
type Repository struct {
	sources      *mongo.Collection
	runs         *mongo.Collection
	observations *mongo.Collection
}

// NewRepository constructs the discovery persistence layer.
func NewRepository(sources, runs, observations *mongo.Collection) *Repository {
	return &Repository{
		sources:      sources,
		runs:         runs,
		observations: observations,
	}
}

// CreateSource inserts a new authorized discovery source.
func (r *Repository) CreateSource(ctx context.Context, req *CreateSourceRequest, actor string) (*DiscoverySource, error) {
	now := CurrentTimestamp()
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	src := &DiscoverySource{
		SourceID:      audit.GenerateUUID(),
		SchemaVersion: SchemaVersion,
		Name:          strings.TrimSpace(req.Name),
		AdapterType:   req.AdapterType,
		BaseURL:       strings.TrimSpace(req.BaseURL),
		Enabled:       enabled,
		TransportMode: req.TransportMode,
		Revision:      1,
		CreatedAt:     now,
		CreatedBy:     actor,
		UpdatedAt:     now,
		UpdatedBy:     actor,
	}
	if _, err := r.sources.InsertOne(ctx, src); err != nil {
		return nil, fmt.Errorf("failed to insert discovery source: %w", err)
	}
	return src, nil
}

// GetSource retrieves a discovery source by id.
func (r *Repository) GetSource(ctx context.Context, sourceID string) (*DiscoverySource, error) {
	var src DiscoverySource
	err := r.sources.FindOne(ctx, bson.M{"_id": sourceID}).Decode(&src)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("failed to read discovery source: %w", err)
	}
	return &src, nil
}

// ListSources returns a bounded, cursor-paginated source page.
func (r *Repository) ListSources(ctx context.Context, filter SourceListFilter) ([]DiscoverySource, *string, bool, error) {
	limit := clampLimit(filter.Limit)
	filterDoc := bson.M{}
	if q := strings.TrimSpace(filter.Query); q != "" {
		filterDoc["name"] = bson.M{"$regex": strings.ToLower(q), "$options": "i"}
	}
	if err := applyCursor(filterDoc, filter.Cursor, "updatedAt", "_id"); err != nil {
		return nil, nil, false, err
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(limit + 1))

	cur, err := r.sources.Find(ctx, filterDoc, opts)
	if err != nil {
		return nil, nil, false, fmt.Errorf("failed to query discovery sources: %w", err)
	}
	defer cur.Close(ctx)

	var items []DiscoverySource
	for cur.Next(ctx) {
		var item DiscoverySource
		if err := cur.Decode(&item); err != nil {
			return nil, nil, false, fmt.Errorf("failed to decode discovery source: %w", err)
		}
		items = append(items, item)
	}
	if err := cur.Err(); err != nil {
		return nil, nil, false, fmt.Errorf("cursor iteration error: %w", err)
	}
	return paginateSources(items, limit)
}

// UpdateSource applies a CAS-protected source update.
func (r *Repository) UpdateSource(ctx context.Context, sourceID string, req *UpdateSourceRequest, actor string) (*DiscoverySource, *DiscoverySource, error) {
	before, err := r.GetSource(ctx, sourceID)
	if err != nil {
		return nil, nil, err
	}
	now := CurrentTimestamp()
	res := r.sources.FindOneAndUpdate(ctx,
		bson.M{"_id": sourceID, "revision": req.ExpectedRevision},
		bson.M{"$set": bson.M{
			"name":          strings.TrimSpace(req.Source.Name),
			"baseUrl":       strings.TrimSpace(req.Source.BaseURL),
			"transportMode": req.Source.TransportMode,
			"enabled":       req.Source.Enabled,
			"updatedAt":     now,
			"updatedBy":     actor,
		}, "$inc": bson.M{"revision": 1}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var after DiscoverySource
	if err := res.Decode(&after); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil, ErrConflict
		}
		return nil, nil, fmt.Errorf("failed to update discovery source: %w", err)
	}
	return before, &after, nil
}

// InsertRun records the start of a discovery run.
func (r *Repository) InsertRun(ctx context.Context, run *DiscoveryRun) error {
	if _, err := r.runs.InsertOne(ctx, run); err != nil {
		return fmt.Errorf("failed to insert discovery run: %w", err)
	}
	return nil
}

// CompleteRun finalizes a discovery run record.
func (r *Repository) CompleteRun(ctx context.Context, run *DiscoveryRun) error {
	_, err := r.runs.ReplaceOne(ctx, bson.M{"_id": run.RunID}, run)
	if err != nil {
		return fmt.Errorf("failed to finalize discovery run: %w", err)
	}
	return nil
}

// GetRun retrieves a run by id.
func (r *Repository) GetRun(ctx context.Context, runID string) (*DiscoveryRun, error) {
	var run DiscoveryRun
	err := r.runs.FindOne(ctx, bson.M{"_id": runID}).Decode(&run)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("failed to read discovery run: %w", err)
	}
	return &run, nil
}

// ListRuns returns a bounded, cursor-paginated run page.
func (r *Repository) ListRuns(ctx context.Context, filter RunListFilter) ([]DiscoveryRun, *string, bool, error) {
	limit := clampLimit(filter.Limit)
	filterDoc := bson.M{}
	if filter.SourceID != "" {
		filterDoc["sourceId"] = filter.SourceID
	}
	if filter.Status != "" {
		filterDoc["status"] = filter.Status
	}
	if err := applyCursor(filterDoc, filter.Cursor, "startedAt", "_id"); err != nil {
		return nil, nil, false, err
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "startedAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(limit + 1))

	cur, err := r.runs.Find(ctx, filterDoc, opts)
	if err != nil {
		return nil, nil, false, fmt.Errorf("failed to query discovery runs: %w", err)
	}
	defer cur.Close(ctx)

	var items []DiscoveryRun
	for cur.Next(ctx) {
		var item DiscoveryRun
		if err := cur.Decode(&item); err != nil {
			return nil, nil, false, fmt.Errorf("failed to decode discovery run: %w", err)
		}
		items = append(items, item)
	}
	if err := cur.Err(); err != nil {
		return nil, nil, false, fmt.Errorf("cursor iteration error: %w", err)
	}
	return paginateRuns(items, limit)
}

// UpsertObservation records one observed NF candidate with stable identity.
// Uniqueness is (sourceId, externalNfInstanceId).
func (r *Repository) UpsertObservation(ctx context.Context, sourceID, adapterType string, profile *NormalizedProfile, now string) (created, updated, unchanged bool, err error) {
	filter := bson.M{
		"sourceId":             sourceID,
		"externalNfInstanceId": profile.ExternalNfInstanceID,
	}

	existing := r.observations.FindOne(ctx, filter)
	var current NFObservation
	findErr := existing.Decode(&current)

	if findErr != nil {
		if !errors.Is(findErr, mongo.ErrNoDocuments) {
			return false, false, false, fmt.Errorf("failed to read nf observation: %w", findErr)
		}
		doc := &NFObservation{
			CandidateID:          audit.GenerateUUID(),
			SchemaVersion:        SchemaVersion,
			SourceID:             sourceID,
			AdapterType:          adapterType,
			ExternalNfInstanceID: profile.ExternalNfInstanceID,
			NfType:               profile.NfType,
			NfStatus:             profile.NfStatus,
			Fqdn:                 profile.Fqdn,
			IPv4Addresses:        profile.IPv4Addresses,
			IPv6Addresses:        profile.IPv6Addresses,
			ObservedEndpoints:    profile.ObservedEndpoints,
			ObservedServices:     profile.ObservedServices,
			HeartBeatTimer:       profile.HeartBeatTimer,
			PlmnList:             profile.PlmnList,
			SNssaiList:           profile.SNssaiList,
			FirstSeenAt:          now,
			LastSeenAt:           now,
			ObservationState:     ObservationSeen,
			LinkedResourceID:     nil,
			Revision:             1,
		}
		if doc.ObservedEndpoints == nil {
			doc.ObservedEndpoints = []ObservedEndpoint{}
		}
		if doc.ObservedServices == nil {
			doc.ObservedServices = []ObservedService{}
		}
		if _, err := r.observations.InsertOne(ctx, doc); err != nil {
			return false, false, false, fmt.Errorf("failed to insert nf observation: %w", err)
		}
		return true, false, false, nil
	}

	// Existing candidate: keep candidateId and linkedResourceId stable.
	setFields := bson.M{
		"nfType":            profile.NfType,
		"nfStatus":          profile.NfStatus,
		"fqdn":              profile.Fqdn,
		"ipv4Addresses":     profile.IPv4Addresses,
		"ipv6Addresses":     profile.IPv6Addresses,
		"observedEndpoints": profile.ObservedEndpoints,
		"observedServices":  profile.ObservedServices,
		"heartBeatTimer":    profile.HeartBeatTimer,
		"plmnList":          profile.PlmnList,
		"sNssaiList":        profile.SNssaiList,
		"lastSeenAt":        now,
		"observationState":  ObservationSeen,
	}

	changed := current.NfType != profile.NfType ||
		current.NfStatus != profile.NfStatus ||
		current.Fqdn != profile.Fqdn ||
		!stringSlicesEqual(current.IPv4Addresses, profile.IPv4Addresses) ||
		!stringSlicesEqual(current.IPv6Addresses, profile.IPv6Addresses) ||
		!servicesEqual(current.ObservedServices, profile.ObservedServices)

	if !changed {
		// Still refresh lastSeenAt so temporal evidence is retained.
		_, err := r.observations.UpdateOne(ctx, filter, bson.M{"$set": bson.M{"lastSeenAt": now, "observationState": ObservationSeen}})
		if err != nil {
			return false, false, false, fmt.Errorf("failed to touch nf observation: %w", err)
		}
		return false, false, true, nil
	}

	setFields["revision"] = current.Revision + 1
	if _, err := r.observations.UpdateOne(ctx, filter, bson.M{"$set": setFields}); err != nil {
		return false, false, false, fmt.Errorf("failed to update nf observation: %w", err)
	}
	return false, true, false, nil
}

// MarkMissing marks previously seen candidates as missing after a complete scan.
// Only call this when the scan completed successfully and was not truncated.
func (r *Repository) MarkMissing(ctx context.Context, sourceID string, seenIDs map[string]struct{}, now string) (int, error) {
	filter := bson.M{
		"sourceId":         sourceID,
		"observationState": bson.M{"$ne": ObservationMissing},
	}
	if len(seenIDs) > 0 {
		notIn := make([]string, 0, len(seenIDs))
		for id := range seenIDs {
			notIn = append(notIn, id)
		}
		filter["externalNfInstanceId"] = bson.M{"$nin": notIn}
	}

	res, err := r.observations.UpdateMany(ctx, filter, bson.M{"$set": bson.M{
		"observationState": ObservationMissing,
		"lastSeenAt":       now,
	}})
	if err != nil {
		return 0, fmt.Errorf("failed to mark missing nf observations: %w", err)
	}
	return int(res.ModifiedCount), nil
}

// GetCandidate retrieves one NF observation by candidate id.
func (r *Repository) GetCandidate(ctx context.Context, candidateID string) (*NFObservation, error) {
	var item NFObservation
	err := r.observations.FindOne(ctx, bson.M{"_id": candidateID}).Decode(&item)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("failed to read nf observation: %w", err)
	}
	return &item, nil
}

// ListCandidates returns a bounded, cursor-paginated candidate page.
func (r *Repository) ListCandidates(ctx context.Context, filter CandidateListFilter) ([]NFObservation, *string, bool, error) {
	limit := clampLimit(filter.Limit)
	filterDoc := bson.M{}
	if filter.SourceID != "" {
		filterDoc["sourceId"] = filter.SourceID
	}
	if filter.NfType != "" {
		filterDoc["nfType"] = filter.NfType
	}
	if filter.NfStatus != "" {
		filterDoc["nfStatus"] = filter.NfStatus
	}
	if filter.ObservationState != "" {
		filterDoc["observationState"] = filter.ObservationState
	}
	if filter.LinkedResourceID != "" {
		filterDoc["linkedResourceId"] = filter.LinkedResourceID
	}
	if err := applyCursor(filterDoc, filter.Cursor, "lastSeenAt", "_id"); err != nil {
		return nil, nil, false, err
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "lastSeenAt", Value: -1}, {Key: "_id", Value: 1}}).
		SetLimit(int64(limit + 1))

	cur, err := r.observations.Find(ctx, filterDoc, opts)
	if err != nil {
		return nil, nil, false, fmt.Errorf("failed to query nf observations: %w", err)
	}
	defer cur.Close(ctx)

	var items []NFObservation
	for cur.Next(ctx) {
		var item NFObservation
		if err := cur.Decode(&item); err != nil {
			return nil, nil, false, fmt.Errorf("failed to decode nf observation: %w", err)
		}
		items = append(items, item)
	}
	if err := cur.Err(); err != nil {
		return nil, nil, false, fmt.Errorf("cursor iteration error: %w", err)
	}
	return paginateCandidates(items, limit)
}

// SetCandidateLink sets or clears the Inventory association on a candidate.
// This never mutates Inventory or Topology documents.
func (r *Repository) SetCandidateLink(ctx context.Context, candidateID string, expectedRevision int64, resourceID *string, actor string) (*NFObservation, error) {
	setFields := bson.M{
		"linkedResourceId": resourceID,
	}
	res := r.observations.FindOneAndUpdate(ctx,
		bson.M{"_id": candidateID, "revision": expectedRevision},
		bson.M{"$set": setFields, "$inc": bson.M{"revision": 1}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var after NFObservation
	if err := res.Decode(&after); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrConflict
		}
		return nil, fmt.Errorf("failed to update nf observation link: %w", err)
	}
	return &after, nil
}

// UpdateSourceScanMeta records scan outcome metadata on a source document.
func (r *Repository) UpdateSourceScanMeta(ctx context.Context, sourceID, completedAt, lastError string) error {
	setFields := bson.M{"lastScanAt": completedAt}
	if lastError == "" {
		setFields["lastSuccessAt"] = completedAt
		setFields["lastError"] = ""
	} else {
		setFields["lastError"] = SanitizeSummary(lastError)
	}
	_, err := r.sources.UpdateOne(ctx, bson.M{"_id": sourceID}, bson.M{"$set": setFields})
	if err != nil {
		return fmt.Errorf("failed to update discovery source scan metadata: %w", err)
	}
	return nil
}

// CountSources returns the number of configured discovery sources.
func (r *Repository) CountSources(ctx context.Context) (int, error) {
	n, err := r.sources.CountDocuments(ctx, bson.M{})
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// CountCandidates returns the number of observed candidates with optional filters.
func (r *Repository) CountCandidates(ctx context.Context, sourceID, linkedOnly string) (int, error) {
	filter := bson.M{}
	if sourceID != "" {
		filter["sourceId"] = sourceID
	}
	if linkedOnly == "true" {
		filter["linkedResourceId"] = bson.M{"$ne": nil}
	}
	n, err := r.observations.CountDocuments(ctx, filter)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// LatestRun returns the most recent run across sources, if any.
func (r *Repository) LatestRun(ctx context.Context) (*DiscoveryRun, error) {
	opts := options.FindOne().SetSort(bson.D{{Key: "startedAt", Value: -1}})
	var run DiscoveryRun
	err := r.runs.FindOne(ctx, bson.M{}, opts).Decode(&run)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &run, nil
}

// ListSourceIDs returns every configured source id.
func (r *Repository) ListSourceIDs(ctx context.Context) ([]string, error) {
	opts := options.Find().SetProjection(bson.M{"_id": 1})
	cur, err := r.sources.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var ids []string
	for cur.Next(ctx) {
		var row struct {
			ID string `bson:"_id"`
		}
		if err := cur.Decode(&row); err != nil {
			return nil, err
		}
		ids = append(ids, row.ID)
	}
	return ids, cur.Err()
}

// --- helpers ---

func clampLimit(limit int) int {
	if limit <= 0 {
		return DefaultPageLimit
	}
	if limit > MaxPageLimit {
		return MaxPageLimit
	}
	return limit
}

func applyCursor(filterDoc bson.M, cursor, timeField, idField string) error {
	if cursor == "" {
		return nil
	}
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return errors.New("invalid pagination cursor encoding")
	}
	var cur CursorData
	if err := json.Unmarshal(raw, &cur); err != nil || cur.UpdatedAt == "" || cur.ID == "" {
		return errors.New("invalid pagination cursor payload")
	}
	cursorFilter := bson.M{
		"$or": []bson.M{
			{timeField: bson.M{"$lt": cur.UpdatedAt}},
			{timeField: cur.UpdatedAt, idField: bson.M{"$gt": cur.ID}},
		},
	}
	if len(filterDoc) == 0 {
		for k, v := range cursorFilter {
			filterDoc[k] = v
		}
	} else {
		merged := bson.M{"$and": []bson.M{filterDoc, cursorFilter}}
		for k := range filterDoc {
			delete(filterDoc, k)
		}
		for k, v := range merged {
			filterDoc[k] = v
		}
	}
	return nil
}

func encodeCursor(updatedAt, id string) string {
	b, _ := json.Marshal(CursorData{UpdatedAt: updatedAt, ID: id})
	return base64.URLEncoding.EncodeToString(b)
}

func paginateSources(items []DiscoverySource, limit int) ([]DiscoverySource, *string, bool, error) {
	hasMore := false
	var next *string
	if len(items) > limit {
		hasMore = true
		items = items[:limit]
		last := items[limit-1]
		enc := encodeCursor(last.UpdatedAt, last.SourceID)
		next = &enc
	}
	if items == nil {
		items = []DiscoverySource{}
	}
	return items, next, hasMore, nil
}

func paginateRuns(items []DiscoveryRun, limit int) ([]DiscoveryRun, *string, bool, error) {
	hasMore := false
	var next *string
	if len(items) > limit {
		hasMore = true
		items = items[:limit]
		last := items[limit-1]
		enc := encodeCursor(last.StartedAt, last.RunID)
		next = &enc
	}
	if items == nil {
		items = []DiscoveryRun{}
	}
	return items, next, hasMore, nil
}

func paginateCandidates(items []NFObservation, limit int) ([]NFObservation, *string, bool, error) {
	hasMore := false
	var next *string
	if len(items) > limit {
		hasMore = true
		items = items[:limit]
		last := items[limit-1]
		enc := encodeCursor(last.LastSeenAt, last.CandidateID)
		next = &enc
	}
	if items == nil {
		items = []NFObservation{}
	}
	return items, next, hasMore, nil
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func servicesEqual(a, b []ObservedService) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ServiceName != b[i].ServiceName || a[i].Status != b[i].Status {
			return false
		}
		if !stringSlicesEqual(a[i].APIVersions, b[i].APIVersions) {
			return false
		}
		if len(a[i].Endpoints) != len(b[i].Endpoints) {
			return false
		}
		for j := range a[i].Endpoints {
			if a[i].Endpoints[j] != b[i].Endpoints[j] {
				return false
			}
		}
	}
	return true
}
