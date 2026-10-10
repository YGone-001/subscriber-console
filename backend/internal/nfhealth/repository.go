package nfhealth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository persists NF health targets, runs and samples.
type Repository struct {
	targets *mongo.Collection
	runs    *mongo.Collection
	samples *mongo.Collection
}

// NewRepository constructs the NF health persistence adapter.
func NewRepository(targets, runs, samples *mongo.Collection) *Repository {
	return &Repository{targets: targets, runs: runs, samples: samples}
}

// CursorData is the keyset pagination cursor payload.
type CursorData struct {
	At string `json:"at"`
	ID string `json:"id"`
}

// CreateTarget inserts a new monitoring target with a server-generated identity.
func (r *Repository) CreateTarget(ctx context.Context, req *CreateTargetRequest, actor string) (*HealthTarget, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	interval := req.IntervalSeconds
	if interval == 0 {
		interval = DefaultIntervalSeconds
	}
	doc := HealthTarget{
		TargetID:         newUUID(),
		SchemaVersion:    SchemaVersion,
		CandidateID:      req.CandidateID,
		Name:             strings.TrimSpace(req.Name),
		CollectorProfile: req.CollectorProfile,
		MetricsEndpoint:  strings.TrimSpace(req.MetricsEndpoint),
		ServiceUnit:      strings.TrimSpace(req.ServiceUnit),
		ServiceKind:      req.ServiceKind,
		CollectionMode:   req.CollectionMode,
		IntervalSeconds:  interval,
		Enabled:          enabled,
		Revision:         1,
		CreatedAt:        now,
		CreatedBy:        actor,
		UpdatedAt:        now,
		UpdatedBy:        actor,
	}
	if _, err := r.targets.InsertOne(ctx, doc); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil, ErrDuplicate
		}
		return nil, err
	}
	return &doc, nil
}

// GetTarget loads one monitoring target.
func (r *Repository) GetTarget(ctx context.Context, targetID string) (*HealthTarget, error) {
	var doc HealthTarget
	err := r.targets.FindOne(ctx, bson.M{"_id": targetID}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &doc, nil
}

// ListTargets returns a keyset-paginated target listing.
func (r *Repository) ListTargets(ctx context.Context, filter TargetListFilter) ([]HealthTarget, *string, bool, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultPageLimit
	}
	q := bson.M{}
	if filter.Query != "" {
		q = bson.M{"$or": []bson.M{
			{"name": bson.M{"$regex": escapeRegex(filter.Query), "$options": "i"}},
			{"candidateId": bson.M{"$regex": escapeRegex(filter.Query), "$options": "i"}},
			{"targetId": filter.Query},
		}}
	}
	if filter.Enabled == "true" {
		q["enabled"] = true
	} else if filter.Enabled == "false" {
		q["enabled"] = false
	}

	cursorQuery := bson.M{"_id": 1, "updatedAt": 1}
	opts := options.Find().SetSort(bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(limit) + 1)
	if filter.Cursor != "" {
		var cur CursorData
		if err := decodeCursor(filter.Cursor, &cur); err != nil {
			return nil, nil, false, err
		}
		q = bson.M{"$and": []bson.M{q, {"$or": []bson.M{
			{"updatedAt": bson.M{"$lt": cur.At}},
			{"updatedAt": cur.At, "_id": bson.M{"$lt": cur.ID}},
		}}}}
	}
	_ = cursorQuery

	cur, err := r.targets.Find(ctx, q, opts)
	if err != nil {
		return nil, nil, false, err
	}
	var items []HealthTarget
	if err := cur.All(ctx, &items); err != nil {
		return nil, nil, false, err
	}
	return paginateTargets(items, limit)
}

// UpdateTarget applies a revision-bound mutation.
func (r *Repository) UpdateTarget(ctx context.Context, targetID string, req *UpdateTargetRequest, actor string) (*HealthTarget, *HealthTarget, error) {
	existing, err := r.GetTarget(ctx, targetID)
	if err != nil {
		return nil, nil, err
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := r.targets.UpdateOne(ctx, bson.M{
		"_id":      targetID,
		"revision": req.ExpectedRevision,
	}, bson.M{"$set": bson.M{
		"name":            strings.TrimSpace(req.Target.Name),
		"metricsEndpoint": strings.TrimSpace(req.Target.MetricsEndpoint),
		"serviceUnit":     strings.TrimSpace(req.Target.ServiceUnit),
		"serviceKind":     req.Target.ServiceKind,
		"collectionMode":  req.Target.CollectionMode,
		"intervalSeconds": req.Target.IntervalSeconds,
		"enabled":         req.Target.Enabled,
		"updatedAt":       now,
		"updatedBy":       actor,
		"revision":        req.ExpectedRevision + 1,
	}})
	if err != nil {
		return nil, nil, err
	}
	if res.MatchedCount == 0 {
		return nil, nil, ErrRevisionConflict
	}
	updated, err := r.GetTarget(ctx, targetID)
	if err != nil {
		return nil, nil, err
	}
	return updated, existing, nil
}

// InsertRun records a collection execution outcome.
func (r *Repository) InsertRun(ctx context.Context, run *HealthRun) error {
	_, err := r.runs.InsertOne(ctx, run)
	return err
}

// GetRun loads one collection run.
func (r *Repository) GetRun(ctx context.Context, runID string) (*HealthRun, error) {
	var doc HealthRun
	err := r.runs.FindOne(ctx, bson.M{"_id": runID}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrRunNotFound
		}
		return nil, err
	}
	return &doc, nil
}

// ListRuns returns a keyset-paginated run listing.
func (r *Repository) ListRuns(ctx context.Context, filter RunListFilter) ([]HealthRun, *string, bool, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultPageLimit
	}
	q := bson.M{}
	if filter.TargetID != "" {
		q["targetId"] = filter.TargetID
	}
	if filter.Status != "" {
		q["status"] = filter.Status
	}
	opts := options.Find().SetSort(bson.D{{Key: "startedAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(limit) + 1)
	if filter.Cursor != "" {
		var cur CursorData
		if err := decodeCursor(filter.Cursor, &cur); err != nil {
			return nil, nil, false, err
		}
		q = bson.M{"$and": []bson.M{q, {"$or": []bson.M{
			{"startedAt": bson.M{"$lt": cur.At}},
			{"startedAt": cur.At, "_id": bson.M{"$lt": cur.ID}},
		}}}}
	}
	cursor, err := r.runs.Find(ctx, q, opts)
	if err != nil {
		return nil, nil, false, err
	}
	var items []HealthRun
	if err := cursor.All(ctx, &items); err != nil {
		return nil, nil, false, err
	}
	return paginateRuns(items, limit)
}

// InsertSample persists a bounded telemetry sample.
func (r *Repository) InsertSample(ctx context.Context, sample *HealthSample) error {
	_, err := r.samples.InsertOne(ctx, sample)
	return err
}

// GetSample loads one telemetry sample.
func (r *Repository) GetSample(ctx context.Context, sampleID string) (*HealthSample, error) {
	var doc HealthSample
	err := r.samples.FindOne(ctx, bson.M{"_id": sampleID}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrSampleNotFound
		}
		return nil, err
	}
	return &doc, nil
}

// ListSamples returns a keyset-paginated historical sample listing.
func (r *Repository) ListSamples(ctx context.Context, filter SampleListFilter) ([]HealthSample, *string, bool, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = DefaultPageLimit
	}
	q := bson.M{}
	if filter.TargetID != "" {
		q["targetId"] = filter.TargetID
	}
	if filter.From != "" || filter.To != "" {
		rangeQ := bson.M{}
		if filter.From != "" {
			rangeQ["$gte"] = filter.From
		}
		if filter.To != "" {
			rangeQ["$lte"] = filter.To
		}
		q["collectedAt"] = rangeQ
	}
	opts := options.Find().SetSort(bson.D{{Key: "collectedAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(limit) + 1)
	if filter.Cursor != "" {
		var cur CursorData
		if err := decodeCursor(filter.Cursor, &cur); err != nil {
			return nil, nil, false, err
		}
		q = bson.M{"$and": []bson.M{q, {"$or": []bson.M{
			{"collectedAt": bson.M{"$lt": cur.At}},
			{"collectedAt": cur.At, "_id": bson.M{"$lt": cur.ID}},
		}}}}
	}
	cursor, err := r.samples.Find(ctx, q, opts)
	if err != nil {
		return nil, nil, false, err
	}
	var items []HealthSample
	if err := cursor.All(ctx, &items); err != nil {
		return nil, nil, false, err
	}
	return paginateSamples(items, limit)
}

// RecordCollection persists the run and, when present, the sample, then updates
// target freshness. Failed collection never overwrites lastMeasuredAt.
func (r *Repository) RecordCollection(ctx context.Context, target *HealthTarget, result *CollectionResult) error {
	if result == nil {
		return nil
	}
	if err := r.InsertRun(ctx, &result.Run); err != nil {
		return err
	}
	if result.Sample != nil {
		if err := r.InsertSample(ctx, result.Sample); err != nil {
			return err
		}
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	set := bson.M{
		"lastAttemptAt": now,
	}
	if result.Run.Status == RunStatusSuccess {
		set["lastSuccessAt"] = now
		set["lastError"] = ""
	} else {
		set["lastError"] = result.Run.ErrorSummary
	}
	if result.Sample != nil {
		set["lastMeasuredAt"] = result.Sample.CollectedAt
	}
	_, err := r.targets.UpdateOne(ctx, bson.M{"_id": target.TargetID}, bson.M{"$set": set})
	return err
}

// ListScheduledTargets returns enabled scheduled targets for the scheduler.
func (r *Repository) ListScheduledTargets(ctx context.Context, limit int) ([]HealthTarget, error) {
	if limit <= 0 {
		limit = 8
	}
	opts := options.Find().SetSort(bson.D{{Key: "lastAttemptAt", Value: 1}}).SetLimit(int64(limit))
	cursor, err := r.targets.Find(ctx, bson.M{"enabled": true, "collectionMode": CollectionScheduled}, opts)
	if err != nil {
		return nil, err
	}
	var items []HealthTarget
	if err := cursor.All(ctx, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// CandidateExists checks that a Discovery candidate reference exists.
// NF Health never creates or mutates Discovery candidates.
func (r *Repository) CandidateExists(ctx context.Context, observations *mongo.Collection, candidateID string) (bool, error) {
	if observations == nil {
		return false, nil
	}
	count, err := observations.CountDocuments(ctx, bson.M{"_id": candidateID})
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// EnforceSampleRetention deletes samples older than the retention horizon.
// Only samples expire; targets, runs and audit records are never purged.
func (r *Repository) EnforceSampleRetention(ctx context.Context, retentionDays int) (int64, error) {
	if retentionDays <= 0 {
		retentionDays = DefaultRetentionDays
	}
	if retentionDays > MaxRetentionDays {
		retentionDays = MaxRetentionDays
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays).Format(time.RFC3339Nano)
	res, err := r.samples.DeleteMany(ctx, bson.M{"collectedAt": bson.M{"$lt": cutoff}})
	if err != nil {
		return 0, err
	}
	return res.DeletedCount, nil
}

// TargetSummarise attaches coverage counters to a target.
func TargetSummarise(target *HealthTarget, sample *HealthSample) HealthTargetSummary {
	sum := HealthTargetSummary{HealthTarget: *target}
	if sample != nil {
		sum.Coverage = CoverageFromLayers(sample.Layers)
	}
	return sum
}

func encodeCursor(at, id string) string {
	b, _ := json.Marshal(CursorData{At: at, ID: id})
	return base64.URLEncoding.EncodeToString(b)
}

func decodeCursor(raw string, out *CursorData) error {
	data, err := base64.URLEncoding.DecodeString(raw)
	if err != nil {
		return errors.New("invalid pagination cursor encoding")
	}
	if err := json.Unmarshal(data, out); err != nil || out.At == "" || out.ID == "" {
		return errors.New("invalid pagination cursor payload")
	}
	return nil
}

func paginateTargets(items []HealthTarget, limit int) ([]HealthTarget, *string, bool, error) {
	hasMore := false
	var next *string
	if len(items) > limit {
		hasMore = true
		items = items[:limit]
		last := items[limit-1]
		enc := encodeCursor(last.UpdatedAt, last.TargetID)
		next = &enc
	}
	if items == nil {
		items = []HealthTarget{}
	}
	return items, next, hasMore, nil
}

func paginateRuns(items []HealthRun, limit int) ([]HealthRun, *string, bool, error) {
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
		items = []HealthRun{}
	}
	return items, next, hasMore, nil
}

func paginateSamples(items []HealthSample, limit int) ([]HealthSample, *string, bool, error) {
	hasMore := false
	var next *string
	if len(items) > limit {
		hasMore = true
		items = items[:limit]
		last := items[limit-1]
		enc := encodeCursor(last.CollectedAt, last.SampleID)
		next = &enc
	}
	if items == nil {
		items = []HealthSample{}
	}
	return items, next, hasMore, nil
}

func escapeRegex(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(`\.+*?()|[]{}^$`, r) {
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
