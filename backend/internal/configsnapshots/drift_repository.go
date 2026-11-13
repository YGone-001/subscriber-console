package configsnapshots

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Worker enumeration reads IDs only, never the bounded per-source journal bodies.
func (r *MongoRepository) DriftSourceIDs(ctx context.Context) ([]string, error) {
	cur, e := r.sources.Find(ctx, bson.M{"$or": bson.A{bson.M{"driftPolicy.enabled": true}, bson.M{"driftQueue.0": bson.M{"$exists": true}}, bson.M{"pending.observation.driftInput": bson.M{"$exists": true}}}}, options.Find().SetProjection(bson.M{"_id": 1}).SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(4097))
	if e != nil {
		return nil, e
	}
	defer cur.Close(ctx)
	var rows []struct {
		ID string `bson:"_id"`
	}
	if e = cur.All(ctx, &rows); e != nil {
		return nil, e
	}
	if len(rows) > 4096 {
		return nil, fail(503, "CONFIG_HISTORY_LIMIT", "Drift source inventory exceeds its supported bound")
	}
	out := []string{}
	for _, v := range rows {
		out = append(out, v.ID)
	}
	return out, nil
}
