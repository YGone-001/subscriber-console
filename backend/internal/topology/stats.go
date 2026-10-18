package topology

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// EdgeSummary is the full-collection declared-edge population for the
// operations summary. Declared relationships are explicitly NOT connectivity
// truth: they only describe what operators have recorded.
type EdgeSummary struct {
	Total               int64            `json:"total"`
	Active              int64            `json:"active"`
	Retired             int64            `json:"retired"`
	ActiveByRelationship map[string]int64 `json:"activeByRelationship"`
}

// edgeCountRow decodes one { _id, count } group bucket.
type edgeCountRow struct {
	ID    *string `bson:"_id"`
	Count int64   `bson:"count"`
}

// EdgeSummary returns the declared-edge population grouped by lifecycle state
// and, for active edges only, by relationship type. One $facet aggregation
// (served by the topology_from_type_state_updated index) answers all counts
// in a single round trip.
func (r *Repository) EdgeSummary(ctx context.Context) (EdgeSummary, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$facet", Value: bson.M{
			"total": mongo.Pipeline{
				{{Key: "$count", Value: "value"}},
			},
			"byLifecycleState": mongo.Pipeline{
				{{Key: "$group", Value: bson.M{"_id": "$lifecycleState", "count": bson.M{"$sum": 1}}}},
			},
			"activeByRelationship": mongo.Pipeline{
				{{Key: "$match", Value: bson.M{"lifecycleState": LifecycleActive}}},
				{{Key: "$group", Value: bson.M{"_id": "$relationshipType", "count": bson.M{"$sum": 1}}}},
			},
		}}},
	}
	cursor, err := r.edges.Aggregate(ctx, pipeline)
	if err != nil {
		return EdgeSummary{}, err
	}
	var rows []struct {
		Total []struct {
			Value int64 `bson:"value"`
		} `bson:"total"`
		ByLifecycleState    []edgeCountRow `bson:"byLifecycleState"`
		ActiveByRelationship []edgeCountRow `bson:"activeByRelationship"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return EdgeSummary{}, err
	}

	summary := EdgeSummary{ActiveByRelationship: map[string]int64{}}
	if len(rows) == 0 {
		return summary, nil
	}
	row := rows[0]
	if len(row.Total) > 0 {
		summary.Total = row.Total[0].Value
	}
	for _, bucket := range row.ByLifecycleState {
		if bucket.ID == nil {
			continue
		}
		switch *bucket.ID {
		case LifecycleActive:
			summary.Active = bucket.Count
		case LifecycleRetired:
			summary.Retired = bucket.Count
		}
	}
	for _, bucket := range row.ActiveByRelationship {
		if bucket.ID != nil {
			summary.ActiveByRelationship[*bucket.ID] = bucket.Count
		}
	}
	return summary, nil
}
