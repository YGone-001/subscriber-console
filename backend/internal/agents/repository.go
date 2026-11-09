package agents

import (
	"context"
	"errors"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type MongoRepository struct{ collection *mongo.Collection }

func NewRepository(db *mongo.Database) *MongoRepository {
	return &MongoRepository{db.Collection("app_agents")}
}
func (r *MongoRepository) Create(ctx context.Context, v *Record) error {
	_, err := r.collection.InsertOne(ctx, v)
	return err
}
func (r *MongoRepository) Get(ctx context.Context, id string) (*Record, error) {
	var v Record
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&v)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	return &v, err
}
func (r *MongoRepository) List(ctx context.Context, q ListQuery, now time.Time) (*Page, error) {
	match := bson.M{}
	if q.Q != "" {
		re := bson.M{"$regex": regexp.QuoteMeta(q.Q), "$options": "i"}
		match["$or"] = bson.A{bson.M{"name": re}, bson.M{"scope.networkKey": re}, bson.M{"scope.operatorName": re}, bson.M{"observation.hostName": re}}
	}
	pageMatch := bson.M{}
	if q.Cursor != "" {
		pageMatch["_id"] = bson.M{"$gt": q.Cursor}
	}
	state := bson.M{"$switch": bson.M{
		"branches": bson.A{
			bson.M{"case": bson.M{"$eq": bson.A{"$enabled", false}}, "then": "disabled"},
			bson.M{"case": bson.M{"$eq": bson.A{bson.M{"$ifNull": bson.A{"$lastReceivedAt", nil}}, nil}}, "then": "pending"},
			bson.M{"case": bson.M{"$gte": bson.A{"$lastReceivedAt", now.Add(-StaleAfterSeconds * time.Second)}}, "then": "online"},
			bson.M{"case": bson.M{"$gte": bson.A{"$lastReceivedAt", now.Add(-OfflineAfterSeconds * time.Second)}}, "then": "stale"},
		}, "default": "offline",
	}}
	pipeline := bson.A{
		bson.M{"$match": match},
		bson.M{"$facet": bson.M{
			"items":  bson.A{bson.M{"$match": pageMatch}, bson.M{"$sort": bson.D{{Key: "_id", Value: 1}}}, bson.M{"$limit": q.Limit + 1}},
			"counts": bson.A{bson.M{"$group": bson.M{"_id": state, "count": bson.M{"$sum": 1}}}},
		}},
	}
	cur, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var out struct {
		Items  []Record `bson:"items"`
		Counts []struct {
			State string `bson:"_id"`
			Count int64  `bson:"count"`
		} `bson:"counts"`
	}
	if !cur.Next(ctx) {
		if err = cur.Err(); err != nil {
			return nil, err
		}
		return &Page{Records: []Record{}}, nil
	}
	if err = cur.Decode(&out); err != nil {
		return nil, err
	}
	page := &Page{Records: out.Items}
	if page.Records == nil {
		page.Records = []Record{}
	}
	for _, c := range out.Counts {
		page.Summary.Total += c.Count
		switch c.State {
		case "online":
			page.Summary.Online = c.Count
		case "stale":
			page.Summary.Stale = c.Count
		case "offline":
			page.Summary.Offline = c.Count
		case "pending":
			page.Summary.Pending = c.Count
		case "disabled":
			page.Summary.Disabled = c.Count
		}
	}
	if len(page.Records) > q.Limit {
		page.HasMore = true
		page.Records = page.Records[:q.Limit]
		next := page.Records[len(page.Records)-1].AgentID
		page.NextCursor = &next
	}
	return page, nil
}
func (r *MongoRepository) change(ctx context.Context, id string, revision int64, set bson.M) (*Record, error) {
	var out Record
	err := r.collection.FindOneAndUpdate(ctx, bson.M{"_id": id, "revision": revision}, bson.M{"$set": set, "$inc": bson.M{"revision": 1}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrConflict
	}
	return &out, err
}
func (r *MongoRepository) Update(ctx context.Context, id string, req UpdateRequest, now time.Time) (*Record, error) {
	return r.change(ctx, id, req.ExpectedRevision, bson.M{
		"name": req.Name, "scope": req.Scope, "enabled": *req.Enabled, "updatedAt": now,
		"sessionHash": "", "sessionExpiresAt": time.Time{}, "sequence": int64(0), "reportHash": "",
	})
}
func (r *MongoRepository) Rotate(ctx context.Context, id string, revision int64, keyHash string, now time.Time) (*Record, error) {
	return r.change(ctx, id, revision, bson.M{"keyHash": keyHash, "sessionHash": "", "sessionExpiresAt": time.Time{}, "sequence": int64(0), "reportHash": "", "updatedAt": now})
}
func (r *MongoRepository) StartSession(ctx context.Context, id, keyHash, sessionHash string, expiry, now time.Time) error {
	res, err := r.collection.UpdateOne(ctx, bson.M{"_id": id, "keyHash": keyHash, "enabled": true}, bson.M{"$set": bson.M{
		"sessionHash": sessionHash, "sessionExpiresAt": expiry, "sequence": int64(0), "reportHash": "",
	}})
	if err != nil {
		return err
	}
	if res.MatchedCount != 1 {
		return ErrUnauthorized
	}
	return nil
}
func (r *MongoRepository) Accept(ctx context.Context, id, keyHash, sessionHash string, sequence int64, digest string, o *Observation, now time.Time) (bool, error) {
	filter := bson.M{"_id": id, "keyHash": keyHash, "enabled": true, "sessionHash": sessionHash, "sessionExpiresAt": bson.M{"$gt": now}, "sequence": bson.M{"$lt": sequence}}
	res, err := r.collection.UpdateOne(ctx, filter, bson.M{"$set": bson.M{"observation": o, "lastReceivedAt": now, "sequence": sequence, "reportHash": digest}})
	if err != nil {
		return false, err
	}
	if res.MatchedCount == 1 {
		return false, nil
	}
	current, err := r.Get(ctx, id)
	if err != nil {
		return false, err
	}
	if !current.Enabled || current.KeyHash != keyHash {
		return false, ErrUnauthorized
	}
	if current.SessionHash != sessionHash || !current.SessionExpiresAt.After(now) {
		return false, ErrSession
	}
	// A retried acknowledgement never advances liveness.
	if current.Sequence == sequence && current.ReportHash == digest {
		return true, nil
	}
	return false, ErrSequence
}
