package ueinfo

import (
	"context"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoSubscriberLookup reads the xCloud subscriber collection for MSISDN
// enrichment and the total subscriber count. It never writes.
type MongoSubscriberLookup struct {
	collection *mongo.Collection
}

func NewMongoSubscriberLookup(collection *mongo.Collection) *MongoSubscriberLookup {
	return &MongoSubscriberLookup{collection: collection}
}

func (r *MongoSubscriberLookup) LookupMSISDNs(ctx context.Context, imsis []string) (map[string]string, error) {
	out := map[string]string{}
	if r == nil || r.collection == nil || len(imsis) == 0 {
		return out, nil
	}
	filter := bson.M{"imsi": bson.M{"$in": imsis}}
	opts := options.Find().SetProjection(bson.M{"imsi": 1, "msisdn": 1})
	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	for cursor.Next(ctx) {
		var doc struct {
			IMSI   string `bson:"imsi"`
			MSISDN any    `bson:"msisdn"`
		}
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		if doc.IMSI == "" {
			continue
		}
		if value := firstMSISDN(doc.MSISDN); value != "" {
			out[doc.IMSI] = value
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *MongoSubscriberLookup) Count(ctx context.Context) (int64, error) {
	if r == nil || r.collection == nil {
		return 0, nil
	}
	return r.collection.CountDocuments(ctx, bson.M{})
}

func firstMSISDN(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case bson.A:
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}
