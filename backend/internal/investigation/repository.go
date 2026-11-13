package investigation

import (
	"context"
	"errors"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoRepository owns only app_investigations writes. Every other handle is read-only.
type MongoRepository struct {
	cases, alerts, resources, edges, runs, samples, configs, knowledge *mongo.Collection
}

func NewRepository(db *mongo.Database) *MongoRepository {
	return &MongoRepository{db.Collection("app_investigations"), db.Collection("app_nf_alerts"), db.Collection("app_inventory_resources"), db.Collection("app_topology_edges"), db.Collection("app_nf_health_runs"), db.Collection("app_nf_health_samples"), db.Collection("app_config_observations"), db.Collection("app_knowledge_entries")}
}
func projection(fields ...string) bson.M {
	m := bson.M{"_id": 1}
	for _, f := range fields {
		m[f] = 1
	}
	return m
}

var alertProjection = projection("resourceId", "targetId", "ruleName", "severity", "state", "firstTriggeredAt", "lastTriggeredAt", "acknowledgedAt", "assignedAt", "recoveringAt", "resolvedAt", "triggerCount")

func missing(err error) error {
	if errors.Is(err, mongo.ErrNoDocuments) {
		return ErrNotFound
	}
	return err
}
func facts[T any](ctx context.Context, c *mongo.Collection, filter, fields bson.M, order bson.D, limit int) ([]T, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cur, err := c.Find(ctx, filter, options.Find().SetProjection(fields).SetSort(order).SetLimit(int64(limit+1)))
	if err != nil {
		return nil, false, err
	}
	defer cur.Close(ctx)
	out := []T{}
	if err = cur.All(ctx, &out); err != nil {
		return nil, false, err
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}
func (r *MongoRepository) Anchor(ctx context.Context, id string) (*AlertFact, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var out AlertFact
	err := r.alerts.FindOne(ctx, bson.M{"_id": id}, options.FindOne().SetProjection(alertProjection)).Decode(&out)
	return &out, missing(err)
}
func (r *MongoRepository) Resources(ctx context.Context, ids []string) ([]ResourceFact, error) {
	if len(ids) == 0 {
		return []ResourceFact{}, nil
	}
	out, _, err := facts[ResourceFact](ctx, r.resources, bson.M{"_id": bson.M{"$in": ids}}, projection("name", "domain", "role", "kind", "lifecycleState"), bson.D{{Key: "_id", Value: 1}}, MaxEdges+1)
	return out, err
}
func (r *MongoRepository) Edges(ctx context.Context, id string) ([]EdgeFact, bool, error) {
	return facts[EdgeFact](ctx, r.edges, bson.M{"lifecycleState": "active", "$or": bson.A{bson.M{"fromResourceId": id}, bson.M{"toResourceId": id}}}, projection("fromResourceId", "toResourceId", "relationshipType", "revision"), bson.D{{Key: "_id", Value: 1}}, MaxEdges)
}

// Timestamp conversion preserves offsets and variable RFC3339 precision. A successful
// bounded read is not proof of historical coverage or an outage-free interval.
func inWindow(field string, from, to time.Time) bson.M {
	date := bson.M{"$convert": bson.M{"input": "$" + field, "to": "date", "onError": nil, "onNull": nil}}
	return bson.M{"$and": bson.A{bson.M{"$gte": bson.A{date, from}}, bson.M{"$lte": bson.A{date, to}}}}
}

func temporalFacts[T any](ctx context.Context, c *mongo.Collection, filter, fields bson.M, times []string, from, to time.Time) ([]T, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	dates := bson.A{}
	for _, field := range times {
		dates = append(dates, bson.M{"$convert": bson.M{"input": "$" + field, "to": "date", "onError": nil, "onNull": nil}})
	}
	selected := bson.M{"$filter": bson.M{"input": dates, "as": "at", "cond": bson.M{"$and": bson.A{bson.M{"$gte": bson.A{"$$at", from}}, bson.M{"$lte": bson.A{"$$at", to}}}}}}
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: filter}},
		{{Key: "$project", Value: fields}},
		{{Key: "$set", Value: bson.M{"_investigationAt": bson.M{"$max": selected}}}},
		{{Key: "$match", Value: bson.M{"_investigationAt": bson.M{"$ne": nil}}}},
		{{Key: "$sort", Value: bson.D{{Key: "_investigationAt", Value: -1}, {Key: "_id", Value: 1}}}},
		{{Key: "$limit", Value: MaxEvidence + 1}},
		{{Key: "$project", Value: fields}},
	}
	cur, err := c.Aggregate(ctx, pipeline, options.Aggregate().SetAllowDiskUse(false))
	if err != nil {
		return nil, false, err
	}
	defer cur.Close(ctx)
	out := []T{}
	if err = cur.All(ctx, &out); err != nil {
		return nil, false, err
	}
	more := len(out) > MaxEvidence
	if more {
		out = out[:MaxEvidence]
	}
	return out, more, nil
}
func (r *MongoRepository) Alerts(ctx context.Context, ids []string, from, to time.Time) ([]AlertFact, bool, error) {
	if len(ids) == 0 {
		return []AlertFact{}, false, nil
	}
	return temporalFacts[AlertFact](ctx, r.alerts, bson.M{"resourceId": bson.M{"$in": ids}}, alertProjection, []string{"firstTriggeredAt", "lastTriggeredAt", "acknowledgedAt", "assignedAt", "recoveringAt", "resolvedAt"}, from, to)
}
func (r *MongoRepository) Runs(ctx context.Context, ids []string, from, to time.Time) ([]RunFact, bool, error) {
	if len(ids) == 0 {
		return []RunFact{}, false, nil
	}
	return temporalFacts[RunFact](ctx, r.runs, bson.M{"resourceId": bson.M{"$in": ids}}, projection("resourceId", "targetId", "sampleId", "startedAt", "status"), []string{"startedAt"}, from, to)
}
func (r *MongoRepository) Samples(ctx context.Context, ids []string) ([]SampleFact, error) {
	if len(ids) == 0 {
		return []SampleFact{}, nil
	}
	out, _, err := facts[SampleFact](ctx, r.samples, bson.M{"_id": bson.M{"$in": ids}}, projection("runId", "resourceId", "targetId", "collectedAt", "layers.process.state", "layers.interface.state", "layers.service.state"), bson.D{{Key: "_id", Value: 1}}, MaxEvidence)
	return out, err
}
func (r *MongoRepository) Configurations(ctx context.Context, ids []string, from, to time.Time) ([]ConfigFact, bool, error) {
	if len(ids) == 0 {
		return []ConfigFact{}, false, nil
	}
	return facts[ConfigFact](ctx, r.configs, bson.M{"resourceId": bson.M{"$in": ids}, "published": true, "collectedAt": bson.M{"$gte": from, "$lte": to}}, projection("sourceId", "resourceId", "snapshotId", "collectedAt", "status", "changed"), bson.D{{Key: "collectedAt", Value: -1}, {Key: "_id", Value: 1}}, MaxEvidence)
}
func (r *MongoRepository) Knowledge(ctx context.Context, ids []string) ([]KnowledgeFact, error) {
	if len(ids) == 0 {
		return []KnowledgeFact{}, nil
	}
	out, _, err := facts[KnowledgeFact](ctx, r.knowledge, bson.M{"_id": bson.M{"$in": ids}}, projection("title", "protocol", "revision"), bson.D{{Key: "_id", Value: 1}}, MaxKnowledge)
	return out, err
}
func (r *MongoRepository) Get(ctx context.Context, id string) (*Record, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var out Record
	err := r.cases.FindOne(ctx, bson.M{"_id": id}).Decode(&out)
	return &out, missing(err)
}
func (r *MongoRepository) Create(ctx context.Context, v *Record) (*Record, error) {
	_, err := r.cases.InsertOne(ctx, v)
	if mongo.IsDuplicateKeyError(err) {
		old, e := r.Get(ctx, v.ID)
		if e != nil {
			return nil, e
		}
		if old.RequestDigest != v.RequestDigest || old.CreatedBy != v.CreatedBy {
			return nil, ErrConflict
		}
		return old, nil
	}
	if err != nil {
		return nil, err
	}
	return v, nil
}
func (r *MongoRepository) Update(ctx context.Context, id string, version int64, req UpdateRequest, actor string, at time.Time) (*Record, error) {
	var out Record
	err := r.cases.FindOneAndUpdate(ctx, bson.M{"_id": id, "revision": version}, bson.M{"$set": bson.M{"title": req.Title, "status": req.Status, "notes": req.Notes, "conclusion": req.Conclusion, "knowledgeIds": req.KnowledgeIDs, "updatedBy": actor, "updatedAt": at}, "$inc": bson.M{"revision": 1}, "$push": bson.M{"recentChanges": bson.M{"$each": []Change{{Revision: version + 1, At: at, Actor: actor, Status: req.Status}}, "$slice": -MaxHistory}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrConflict
	}
	return &out, err
}
func (r *MongoRepository) List(ctx context.Context, q ListQuery, after *cursorData) ([]Record, bool, error) {
	f := bson.M{}
	if q.AnchorKind == "config_drift" {
		f["anchorKind"] = "config_drift"
		if q.AnchorID != "" {
			f["anchorId"] = q.AnchorID
		}
	} else if q.AnchorKind != "all" {
		f["$and"] = bson.A{bson.M{"$or": bson.A{bson.M{"anchorKind": bson.M{"$exists": false}}, bson.M{"anchorKind": ""}, bson.M{"anchorKind": "nf_alert"}}}}
		if q.AnchorID != "" {
			f["alertId"] = q.AnchorID
		}
	}
	if q.Q != "" {
		f["title"] = bson.M{"$regex": regexp.QuoteMeta(q.Q), "$options": "i"}
	}
	for k, v := range map[string]string{"status": q.Status, "alertId": q.AlertID, "resourceId": q.ResourceID} {
		if v != "" {
			f[k] = v
		}
	}
	if after != nil {
		f["$or"] = bson.A{bson.M{"updatedAt": bson.M{"$lt": after.At}}, bson.M{"updatedAt": after.At, "_id": bson.M{"$lt": after.ID}}}
	}
	return facts[Record](ctx, r.cases, f, projection("alertId", "anchorKind", "anchorId", "resourceId", "title", "status", "revision", "updatedAt", "updatedBy"), bson.D{{Key: "updatedAt", Value: -1}, {Key: "_id", Value: -1}}, q.Limit)
}
