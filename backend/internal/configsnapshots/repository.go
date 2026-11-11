package configsnapshots

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MongoRepository struct {
	sources, snapshots, observations *mongo.Collection
	db                               *mongo.Database
}

func NewRepository(db *mongo.Database) *MongoRepository {
	return &MongoRepository{db.Collection("app_config_sources"), db.Collection("app_config_snapshots"), db.Collection("app_config_observations"), db}
}
func missing(err error) error {
	if errors.Is(err, mongo.ErrNoDocuments) {
		return ErrNotFound
	}
	return err
}
func (r *MongoRepository) States(ctx context.Context) ([]State, error) {
	c, err := r.sources.Find(ctx, bson.M{}, options.Find().SetLimit(4097))
	if err != nil {
		return nil, err
	}
	defer c.Close(ctx)
	out := []State{}
	if err = c.All(ctx, &out); err != nil {
		return nil, err
	}
	if len(out) > 4096 {
		return nil, fail(503, "CONFIG_HISTORY_LIMIT", "Source history exceeds the supported bound")
	}
	return out, nil
}

func (r *MongoRepository) StatesForResources(ctx context.Context, resourceIDs, declaredSourceIDs []string, limit int) ([]State, bool, error) {
	if len(resourceIDs) == 0 && len(declaredSourceIDs) == 0 {
		return []State{}, false, nil
	}
	if resourceIDs == nil {
		resourceIDs = []string{}
	}
	if declaredSourceIDs == nil {
		declaredSourceIDs = []string{}
	}
	filter := bson.M{"$or": bson.A{bson.M{"source.resourceId": bson.M{"$in": resourceIDs}}, bson.M{"_id": bson.M{"$in": declaredSourceIDs}}}}
	opts := options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(int64(limit + 1)).SetProjection(bson.M{"latestEvidence.projection": 0, "baselineEvidence.projection": 0, "pending.snapshot.projection": 0})
	cur, err := r.sources.Find(ctx, filter, opts)
	if err != nil {
		return nil, false, err
	}
	defer cur.Close(ctx)
	out := []State{}
	for cur.Next(ctx) {
		var v State
		if err = cur.Decode(&v); err != nil {
			return nil, false, err
		}
		out = append(out, v)
	}
	if err = cur.Err(); err != nil {
		return nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}
func (r *MongoRepository) GetState(ctx context.Context, id string) (*State, error) {
	var s State
	err := r.sources.FindOne(ctx, bson.M{"_id": id}).Decode(&s)
	return &s, missing(err)
}
func (r *MongoRepository) Acquire(ctx context.Context, source Source, token string, now time.Time) (*State, error) {
	_, err := r.sources.UpdateOne(ctx, bson.M{"_id": source.SourceID}, bson.M{"$setOnInsert": bson.M{"source": source, "revision": int64(1), "version": int64(0), "leaseToken": "", "leaseUntil": time.Time{}}}, options.UpdateOne().SetUpsert(true))
	if err != nil && !mongo.IsDuplicateKeyError(err) {
		return nil, err
	}
	var state State
	err = r.sources.FindOneAndUpdate(ctx, bson.M{"_id": source.SourceID, "$or": bson.A{bson.M{"leaseToken": ""}, bson.M{"leaseUntil": bson.M{"$lte": now}}}}, bson.M{"$set": bson.M{"leaseToken": token, "leaseUntil": now.Add(30 * time.Second)}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&state)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrBusy
	}
	return &state, err
}
func (r *MongoRepository) Save(ctx context.Context, s *State) error {
	res, err := r.sources.UpdateOne(ctx, bson.M{"_id": s.SourceID, "version": s.Version, "leaseToken": s.LeaseToken, "leaseUntil": bson.M{"$gt": time.Now().UTC()}}, bson.M{"$set": bson.M{"source": s.Source, "revision": s.Revision, "latestSnapshotId": s.LatestSnapshotID, "latestEvidence": s.LatestEvidence, "baselineEvidence": s.BaselineEvidence, "latest": s.Latest, "baselineId": s.BaselineID, "baselineBy": s.BaselineBy, "baselineAt": s.BaselineAt, "pending": s.Pending}, "$inc": bson.M{"version": 1}})
	if err != nil {
		return err
	}
	if res.MatchedCount != 1 {
		return ErrConflict
	}
	s.Version++
	return nil
}
func (r *MongoRepository) Release(ctx context.Context, id, token string) error {
	_, err := r.sources.UpdateOne(ctx, bson.M{"_id": id, "leaseToken": token}, bson.M{"$set": bson.M{"leaseToken": "", "leaseUntil": time.Time{}}})
	return err
}
func (r *MongoRepository) InsertSnapshot(ctx context.Context, s *Snapshot) error {
	_, err := r.snapshots.InsertOne(ctx, s)
	if mongo.IsDuplicateKeyError(err) {
		previous, e := r.Snapshot(ctx, s.SourceID, s.SnapshotID)
		if e != nil {
			return e
		}
		if previous.Published || previous.Fingerprint != s.Fingerprint || previous.Generation != s.Generation || previous.Policy != s.Policy || previous.KeyVersion != s.KeyVersion {
			return ErrConflict
		}
		return nil
	}
	return err
}
func (r *MongoRepository) InsertObservation(ctx context.Context, o *Observation) error {
	_, err := r.observations.InsertOne(ctx, o)
	if mongo.IsDuplicateKeyError(err) {
		return nil
	}
	return err
}
func (r *MongoRepository) Publish(ctx context.Context, p *Pending) error {
	if p.NewSnapshot {
		v, e := r.snapshots.UpdateOne(ctx, bson.M{"_id": p.SnapshotID, "sourceId": p.Observation.SourceID}, bson.M{"$set": bson.M{"published": true}})
		if e != nil {
			return e
		}
		if v.MatchedCount != 1 {
			return ErrNotFound
		}
	}
	v, e := r.observations.UpdateOne(ctx, bson.M{"_id": p.Observation.ObservationID, "sourceId": p.Observation.SourceID}, bson.M{"$set": bson.M{"published": true}})
	if e != nil {
		return e
	}
	if v.MatchedCount != 1 {
		return ErrNotFound
	}
	return nil
}
func (r *MongoRepository) Snapshot(ctx context.Context, source, id string) (*Snapshot, error) {
	var s Snapshot
	err := r.snapshots.FindOne(ctx, bson.M{"_id": id, "sourceId": source}).Decode(&s)
	return &s, missing(err)
}
func (r *MongoRepository) Observation(ctx context.Context, source, id string) (*Observation, error) {
	var o Observation
	err := r.observations.FindOne(ctx, bson.M{"_id": id, "sourceId": source}).Decode(&o)
	return &o, missing(err)
}

type cursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func EncodeCursor(at time.Time, id string) string {
	b, _ := json.Marshal(cursor{at, id})
	return hex.EncodeToString(b)
}
func validCursor(value string) bool {
	if value == "" {
		return true
	}
	_, e := cursorFilter(value)
	return e == nil
}
func cursorFilter(value string) (bson.M, error) {
	if value == "" {
		return bson.M{}, nil
	}
	if len(value) > 512 {
		return nil, ErrConflict
	}
	b, err := hex.DecodeString(value)
	if err != nil {
		return nil, ErrConflict
	}
	var c cursor
	if json.Unmarshal(b, &c) != nil || c.At.IsZero() || !ValidID(c.ID) {
		return nil, ErrConflict
	}
	return bson.M{"$or": bson.A{bson.M{"collectedAt": bson.M{"$lt": c.At}}, bson.M{"collectedAt": c.At, "_id": bson.M{"$lt": c.ID}}}}, nil
}
func (r *MongoRepository) Snapshots(ctx context.Context, id, after string, limit int) ([]Snapshot, error) {
	q, e := cursorFilter(after)
	if e != nil {
		return nil, e
	}
	q["sourceId"] = id
	q["published"] = true
	c, e := r.snapshots.Find(ctx, q, options.Find().SetSort(bson.D{{Key: "collectedAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(limit)))
	if e != nil {
		return nil, e
	}
	defer c.Close(ctx)
	out := []Snapshot{}
	e = c.All(ctx, &out)
	return out, e
}
func (r *MongoRepository) Observations(ctx context.Context, id, after string, limit int) ([]Observation, error) {
	q, e := cursorFilter(after)
	if e != nil {
		return nil, e
	}
	q["sourceId"] = id
	q["published"] = true
	c, e := r.observations.Find(ctx, q, options.Find().SetSort(bson.D{{Key: "collectedAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(limit)))
	if e != nil {
		return nil, e
	}
	defer c.Close(ctx)
	out := []Observation{}
	e = c.All(ctx, &out)
	return out, e
}
func (r *MongoRepository) Prune(ctx context.Context, s *State, now time.Time) error {
	rows, err := r.Snapshots(ctx, s.SourceID, "", 10001)
	if err != nil {
		return err
	}
	if len(rows) > 10000 {
		return fail(503, "CONFIG_RETENTION_LIMIT", "Retention work exceeds its bounded budget")
	}
	remove := []string{}
	for i, v := range rows {
		if v.SnapshotID == s.BaselineID || v.SnapshotID == s.LatestSnapshotID || (s.Pending != nil && v.SnapshotID == s.Pending.SnapshotID) {
			continue
		}
		if i >= MaxVersions || v.CollectedAt.Before(now.AddDate(0, 0, -RetentionDays)) {
			remove = append(remove, v.SnapshotID)
		}
	}
	if len(remove) > 0 {
		if _, err = r.snapshots.DeleteMany(ctx, bson.M{"sourceId": s.SourceID, "_id": bson.M{"$in": remove}}); err != nil {
			return err
		}
	}
	// Prepared records can only be reclaimed while holding the same source lease.
	keep := []string{s.LatestSnapshotID, s.BaselineID}
	if s.Pending != nil {
		keep = append(keep, s.Pending.SnapshotID)
	}
	if _, err = r.snapshots.DeleteMany(ctx, bson.M{"sourceId": s.SourceID, "published": false, "_id": bson.M{"$nin": keep}, "collectedAt": bson.M{"$lt": now.Add(-time.Hour)}}); err != nil {
		return err
	}
	_, err = r.observations.DeleteMany(ctx, bson.M{"sourceId": s.SourceID, "collectedAt": bson.M{"$lt": now.AddDate(0, 0, -RetentionDays)}})
	return err
}
func (r *MongoRepository) Usage(ctx context.Context) (int64, int64, error) {
	stat := func(name string) (int64, error) {
		var out struct {
			Size int64 `bson:"size"`
		}
		e := r.db.RunCommand(ctx, bson.D{{Key: "collStats", Value: name}, {Key: "scale", Value: 1}}).Decode(&out)
		var command mongo.CommandError
		if errors.As(e, &command) && command.Code == 26 {
			return 0, nil
		}
		return out.Size, e
	}
	a, e := stat("app_config_snapshots")
	if e != nil {
		return 0, 0, e
	}
	b, e := stat("app_config_observations")
	return a, b, e
}

// Initialize is deliberately separate from reads and normal server startup.
func (r *MongoRepository) Initialize(ctx context.Context) error {
	for _, c := range []*mongo.Collection{r.snapshots, r.observations} {
		_, e := c.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "sourceId", Value: 1}, {Key: "collectedAt", Value: -1}, {Key: "_id", Value: -1}}, Options: options.Index().SetName("config_source_time")})
		if e != nil {
			return e
		}
	}
	return nil
}
