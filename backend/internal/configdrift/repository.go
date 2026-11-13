package configdrift

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/configsnapshots"
	"time"
)

type MongoRepository struct{ sources, alerts, events *mongo.Collection }

func NewRepository(db *mongo.Database) *MongoRepository {
	return &MongoRepository{db.Collection("app_config_drift_sources"), db.Collection("app_config_drift_alerts"), db.Collection("app_config_drift_events")}
}
func missing(e error) error {
	if errors.Is(e, mongo.ErrNoDocuments) {
		return ErrNotFound
	}
	return e
}
func (r *MongoRepository) State(ctx context.Context, id string) (*State, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var s State
	e := r.sources.FindOne(ctx, bson.M{"_id": id}).Decode(&s)
	if errors.Is(e, mongo.ErrNoDocuments) {
		return &State{SourceID: id}, nil
	}
	return &s, e
}
func (r *MongoRepository) Save(ctx context.Context, s *State, version int64) error {
	s.Version = version + 1
	if version == 0 {
		_, e := r.sources.InsertOne(ctx, s)
		if mongo.IsDuplicateKeyError(e) {
			return ErrConflict
		}
		return e
	}
	v, e := r.sources.ReplaceOne(ctx, bson.M{"_id": s.SourceID, "version": version}, s)
	if e != nil {
		return e
	}
	if v.MatchedCount != 1 {
		return ErrConflict
	}
	return nil
}
func (r *MongoRepository) Materialize(ctx context.Context, m *Mutation) error {
	_, e := r.alerts.ReplaceOne(ctx, bson.M{"_id": m.Alert.ID, "revision": bson.M{"$lt": m.Alert.Revision}}, m.Alert, options.Replace().SetUpsert(true))
	if mongo.IsDuplicateKeyError(e) {
		old, err := r.Alert(ctx, m.Alert.ID)
		if err != nil {
			return err
		}
		if old.Revision < m.Alert.Revision {
			return e
		}
		e = nil
	}
	if e != nil {
		return e
	}
	_, e = r.events.UpdateOne(ctx, bson.M{"_id": m.Event.ID}, bson.M{"$setOnInsert": m.Event}, options.UpdateOne().SetUpsert(true))
	return e
}
func (r *MongoRepository) Alert(ctx context.Context, id string) (*Alert, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var a Alert
	e := r.alerts.FindOne(ctx, bson.M{"_id": id, "expiredAt": bson.M{"$exists": false}}).Decode(&a)
	return &a, missing(e)
}

type cursor struct {
	At    time.Time `json:"at"`
	ID    string    `json:"id"`
	Scope string    `json:"scope"`
}

func scope(q ListQuery) string {
	b, _ := json.Marshal([]string{q.State, q.Severity, q.SourceID, q.ResourceID, q.Scope})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func encode(at time.Time, id, scope string) *string {
	b, _ := json.Marshal(cursor{at, id, scope})
	v := hex.EncodeToString(b)
	return &v
}
func after(value, scope, field string) (bson.M, error) {
	if value == "" {
		return bson.M{}, nil
	}
	if len(value) > 2048 {
		return nil, fail(400, "CONFIG_DRIFT_INVALID_CURSOR", "Invalid cursor")
	}
	b, e := hex.DecodeString(value)
	var c cursor
	if e != nil || json.Unmarshal(b, &c) != nil || c.At.IsZero() || !configsnapshots.ValidID(c.ID) || c.Scope != scope {
		return nil, fail(400, "CONFIG_DRIFT_INVALID_CURSOR", "Cursor belongs to another filter")
	}
	return bson.M{"$or": bson.A{bson.M{field: bson.M{"$lt": c.At}}, bson.M{field: c.At, "_id": bson.M{"$lt": c.ID}}}}, nil
}
func (r *MongoRepository) List(ctx context.Context, q ListQuery) (*ListView, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	f := bson.M{"expiredAt": bson.M{"$exists": false}}
	if q.State == "open" {
		f["state"] = bson.M{"$in": bson.A{"active", "acknowledged"}}
	} else if q.State != "" {
		f["state"] = q.State
	}
	if q.Severity != "" {
		f["severity"] = q.Severity
	}
	if q.SourceID != "" {
		f["sourceId"] = q.SourceID
	}
	if q.ResourceID != "" {
		f["resourceId"] = q.ResourceID
	}
	if q.ResourceIDs != nil {
		f["resourceId"] = bson.M{"$in": q.ResourceIDs}
		if q.ResourceID != "" {
			f["$and"] = bson.A{bson.M{"resourceId": q.ResourceID}}
		}
	}
	cfilter, e := after(q.Cursor, scope(q), "openedAt")
	if e != nil {
		return nil, e
	}
	summary := map[string]int{"total": 0, "active": 0, "acknowledged": 0, "resolved": 0}
	count, e := r.alerts.Aggregate(ctx, mongo.Pipeline{{{Key: "$match", Value: f}}, {{Key: "$group", Value: bson.M{"_id": "$state", "count": bson.M{"$sum": 1}}}}}, options.Aggregate().SetAllowDiskUse(false))
	if e != nil {
		return nil, e
	}
	var counts []struct {
		State string `bson:"_id"`
		Count int    `bson:"count"`
	}
	e = count.All(ctx, &counts)
	count.Close(ctx)
	if e != nil {
		return nil, e
	}
	for _, v := range counts {
		summary[v.State] = v.Count
		summary["total"] += v.Count
	}
	for k, v := range cfilter {
		f[k] = v
	}
	cur, e := r.alerts.Find(ctx, f, options.Find().SetSort(bson.D{{Key: "openedAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(q.Limit+1)))
	if e != nil {
		return nil, e
	}
	defer cur.Close(ctx)
	out := &ListView{Page: Page[Alert]{Items: []Alert{}}, Summary: summary, Completeness: "complete"}
	if e = cur.All(ctx, &out.Items); e != nil {
		return nil, e
	}
	if len(out.Items) > q.Limit {
		out.HasMore = true
		out.Items = out.Items[:q.Limit]
		v := out.Items[q.Limit-1]
		out.NextCursor = encode(v.OpenedAt, v.ID, scope(q))
	}
	return out, nil
}
func (r *MongoRepository) Events(ctx context.Context, id, value string, limit int) (*Page[Event], error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	f, e := after(value, id, "at")
	if e != nil {
		return nil, e
	}
	f["alertId"] = id
	cur, e := r.events.Find(ctx, f, options.Find().SetSort(bson.D{{Key: "at", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(limit+1)))
	if e != nil {
		return nil, e
	}
	defer cur.Close(ctx)
	out := &Page[Event]{Items: []Event{}}
	if e = cur.All(ctx, &out.Items); e != nil {
		return nil, e
	}
	if len(out.Items) > limit {
		out.HasMore = true
		out.Items = out.Items[:limit]
		v := out.Items[limit-1]
		out.NextCursor = encode(v.At, v.ID, id)
	}
	return out, nil
}

// Initialize is explicit and is never called by GET or normal server startup.
func (r *MongoRepository) Initialize(ctx context.Context) error {
	for _, c := range []struct {
		C *mongo.Collection
		I []mongo.IndexModel
	}{
		{r.alerts, []mongo.IndexModel{
			{Keys: bson.D{{Key: "sourceId", Value: 1}}, Options: options.Index().SetName("uniq_config_drift_open").SetUnique(true).SetPartialFilterExpression(bson.M{"state": bson.M{"$in": bson.A{"active", "acknowledged"}}})},
			{Keys: bson.D{{Key: "openedAt", Value: -1}, {Key: "_id", Value: -1}}, Options: options.Index().SetName("config_drift_time")},
			{Keys: bson.D{{Key: "resourceId", Value: 1}, {Key: "openedAt", Value: -1}, {Key: "_id", Value: -1}}, Options: options.Index().SetName("config_drift_resource")},
			{Keys: bson.D{{Key: "sourceId", Value: 1}, {Key: "openedAt", Value: -1}, {Key: "_id", Value: -1}}, Options: options.Index().SetName("config_drift_source")},
			{Keys: bson.D{{Key: "state", Value: 1}, {Key: "openedAt", Value: -1}, {Key: "_id", Value: -1}}, Options: options.Index().SetName("config_drift_state")},
		}},
		{r.events, []mongo.IndexModel{{Keys: bson.D{{Key: "alertId", Value: 1}, {Key: "at", Value: -1}, {Key: "_id", Value: -1}}, Options: options.Index().SetName("config_drift_event_time")}}},
	} {
		if _, e := c.C.Indexes().CreateMany(ctx, c.I); e != nil {
			return e
		}
	}
	return nil
}
