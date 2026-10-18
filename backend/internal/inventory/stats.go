package inventory

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ResourceCounts is the platform-wide inventory population for the operations
// summary. Every count is a full-collection count derived from bounded
// aggregations, never a page count, so summary KPIs cannot disagree with the
// real collection size.
type ResourceCounts struct {
	Total            int64            `json:"total"`
	ByKind           map[string]int64 `json:"byKind"`
	ByLifecycleState map[string]int64 `json:"byLifecycleState"`
	ByDomain         map[string]int64 `json:"byDomain"`
}

// groupCountRow decodes one { _id, count } group bucket. _id is decoded as a
// pointer so historical documents with a missing or null grouping field never
// fail the whole projection; such rows are skipped instead of being folded
// into a fabricated bucket.
type groupCountRow struct {
	ID    *string `bson:"_id"`
	Count int64   `bson:"count"`
}

// ResourceCounts returns the full inventory population grouped by the same
// canonical projections the network element view filters on. One $facet
// aggregation answers all four counts in a single round trip; the
// inventory_kind_domain_lifecycle_updated index serves the grouped scans.
func (r *Repository) ResourceCounts(ctx context.Context) (ResourceCounts, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$facet", Value: bson.M{
			"total": mongo.Pipeline{
				{{Key: "$count", Value: "value"}},
			},
			"byKind": mongo.Pipeline{
				{{Key: "$group", Value: bson.M{"_id": "$kind", "count": bson.M{"$sum": 1}}}},
			},
			"byLifecycleState": mongo.Pipeline{
				{{Key: "$group", Value: bson.M{"_id": "$lifecycleState", "count": bson.M{"$sum": 1}}}},
			},
			"byDomain": mongo.Pipeline{
				{{Key: "$group", Value: bson.M{"_id": "$domain", "count": bson.M{"$sum": 1}}}},
			},
		}}},
	}
	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return ResourceCounts{}, err
	}
	var rows []struct {
		Total []struct {
			Value int64 `bson:"value"`
		} `bson:"total"`
		ByKind           []groupCountRow `bson:"byKind"`
		ByLifecycleState []groupCountRow `bson:"byLifecycleState"`
		ByDomain         []groupCountRow `bson:"byDomain"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return ResourceCounts{}, err
	}

	counts := ResourceCounts{
		ByKind:           map[string]int64{},
		ByLifecycleState: map[string]int64{},
		ByDomain:         map[string]int64{},
	}
	// $facet always returns exactly one document (with empty arrays on an
	// empty collection); the len check is defensive only.
	if len(rows) == 0 {
		return counts, nil
	}
	row := rows[0]
	if len(row.Total) > 0 {
		counts.Total = row.Total[0].Value
	}
	for _, bucket := range row.ByKind {
		if bucket.ID != nil {
			counts.ByKind[*bucket.ID] = bucket.Count
		}
	}
	for _, bucket := range row.ByLifecycleState {
		if bucket.ID != nil {
			counts.ByLifecycleState[*bucket.ID] = bucket.Count
		}
	}
	for _, bucket := range row.ByDomain {
		if bucket.ID != nil {
			counts.ByDomain[*bucket.ID] = bucket.Count
		}
	}
	return counts, nil
}
