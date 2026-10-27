package discovery

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ObservationSummary is the full-collection candidate observation population
// for the operations summary. Every candidate contributes exactly one
// observationState bucket (one document per (sourceId, externalNfInstanceId)
// is enforced by the unique index), and link association is counted
// independently of state.
type ObservationSummary struct {
	Seen     int64 `json:"seen"`
	Missing  int64 `json:"missing"`
	Stale    int64 `json:"stale"`
	Linked   int64 `json:"linked"`
	Unlinked int64 `json:"unlinked"`
}

// observationStateRow decodes one per-state group bucket.
type observationStateRow struct {
	State  *string `bson:"_id"`
	Total  int64   `bson:"total"`
	Linked int64   `bson:"linked"`
}

// ObservationSummary aggregates the authoritative observationState buckets
// plus link association counts in one bounded aggregation served by the
// nf_obs_source_state_seen index. Counts are full-collection counts, never
// page counts.
func (r *Repository) ObservationSummary(ctx context.Context) (ObservationSummary, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":   "$observationState",
			"total": bson.M{"$sum": 1},
			"linked": bson.M{"$sum": bson.M{"$cond": bson.A{
				bson.M{"$ne": bson.A{"$linkedResourceId", nil}},
				1,
				0,
			}}},
		}}},
	}
	cursor, err := r.observations.Aggregate(ctx, pipeline)
	if err != nil {
		return ObservationSummary{}, err
	}
	var rows []observationStateRow
	if err := cursor.All(ctx, &rows); err != nil {
		return ObservationSummary{}, err
	}

	summary := ObservationSummary{}
	for _, row := range rows {
		summary.Linked += row.Linked
		summary.Unlinked += row.Total - row.Linked
		if row.State == nil {
			// Historical documents without a state never enter the
			// seen/missing/stale buckets; a fabricated bucket would be worse
			// than an honest gap.
			continue
		}
		switch *row.State {
		case ObservationSeen:
			summary.Seen = row.Total
		case ObservationMissing:
			summary.Missing = row.Total
		case ObservationStale:
			summary.Stale = row.Total
		}
	}
	return summary, nil
}
