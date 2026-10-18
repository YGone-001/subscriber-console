package nfalert

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// AlertSummary is the full-collection alert and rule population for the
// operations summary. Counts are full-collection counts derived from bounded
// aggregations, never page counts.
type AlertSummary struct {
	TotalRules    int64            `json:"totalRules"`
	EnabledRules  int64            `json:"enabledRules"`
	AlertsByState map[string]int64 `json:"alertsByState"`
	// OpenBySeverity counts unresolved (active/acknowledged) alert instances
	// per severity. This is the queue the on-call view needs first.
	OpenBySeverity map[string]int64 `json:"openBySeverity"`
}

// alertCountRow decodes one { _id, count } group bucket. _id is decoded as a
// pointer so malformed historical documents never fail the whole projection.
type alertCountRow struct {
	ID    *string `bson:"_id"`
	Count int64   `bson:"count"`
}

// AlertSummary returns the alert population grouped by state, the unresolved
// population grouped by severity, and the rule totals. One $facet aggregation
// (served by the nf_alerts_state_severity_updated index) answers both alert
// groupings in a single round trip; rule totals use two indexed counts.
func (r *Repository) AlertSummary(ctx context.Context) (AlertSummary, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$facet", Value: bson.M{
			"byState": mongo.Pipeline{
				{{Key: "$group", Value: bson.M{"_id": "$state", "count": bson.M{"$sum": 1}}}},
			},
			"openBySeverity": mongo.Pipeline{
				{{Key: "$match", Value: bson.M{"state": bson.M{"$in": []string{AlertStateActive, AlertStateAcknowledged}}}}},
				{{Key: "$group", Value: bson.M{"_id": "$severity", "count": bson.M{"$sum": 1}}}},
			},
		}}},
	}
	cursor, err := r.alerts.Aggregate(ctx, pipeline)
	if err != nil {
		return AlertSummary{}, err
	}
	var rows []struct {
		ByState       []alertCountRow `bson:"byState"`
		OpenBySeverity []alertCountRow `bson:"openBySeverity"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return AlertSummary{}, err
	}

	summary := AlertSummary{
		AlertsByState:  map[string]int64{},
		OpenBySeverity: map[string]int64{},
	}
	if len(rows) > 0 {
		for _, bucket := range rows[0].ByState {
			if bucket.ID != nil {
				summary.AlertsByState[*bucket.ID] = bucket.Count
			}
		}
		for _, bucket := range rows[0].OpenBySeverity {
			if bucket.ID != nil {
				summary.OpenBySeverity[*bucket.ID] = bucket.Count
			}
		}
	}

	totalRules, err := r.rules.CountDocuments(ctx, bson.M{})
	if err != nil {
		return AlertSummary{}, err
	}
	summary.TotalRules = totalRules
	enabledRules, err := r.rules.CountDocuments(ctx, bson.M{"enabled": true})
	if err != nil {
		return AlertSummary{}, err
	}
	summary.EnabledRules = enabledRules
	return summary, nil
}
