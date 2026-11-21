package nfalert

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The rule CAS atomically records this intent. A failed post-CAS closure is
// retried by the worker, including for disabled rules, before new evaluation.
type metricPolicyClosure struct {
	Revision int64  `bson:"revision"`
	At       string `bson:"at"`
	Reason   string `bson:"reason"`
}

func (r *Repository) drainMetricPolicyClosure(ctx context.Context, rule *AlertRule) error {
	p := rule.MetricClosure
	if p == nil {
		return nil
	}
	// One single-target metric rule has at most one open alert. Also read the
	// already-closed incident to repair a crash before notification emission.
	q := bson.M{"ruleId": rule.RuleID, "$and": bson.A{
		bson.M{"$or": bson.A{bson.M{"ruleRevision": bson.M{"$lt": p.Revision}}, bson.M{"ruleRevision": bson.M{"$exists": false}}}},
		bson.M{"$or": bson.A{bson.M{"state": bson.M{"$in": AlertOpenStates}}, bson.M{"resolvedAt": p.At, "resolvedReason": p.Reason}}},
	}}
	cursor, err := r.alerts.Find(ctx, q, options.Find().SetLimit(2))
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	var alerts []Alert
	if err := cursor.All(ctx, &alerts); err != nil {
		return err
	}
	for _, alert := range alerts {
		if alert.State != AlertStateResolved {
			res, err := r.alerts.UpdateOne(ctx, bson.M{"_id": alert.AlertID, "state": bson.M{"$in": AlertOpenStates}}, bson.M{"$set": bson.M{
				"state": AlertStateResolved, "resolvedAt": p.At, "resolvedReason": p.Reason, "updatedAt": p.At,
			}})
			if err != nil {
				return err
			}
			if res.MatchedCount == 0 {
				continue
			}
			alert.State, alert.ResolvedAt, alert.ResolvedReason = AlertStateResolved, p.At, p.Reason
		}
		r.emitAlertEvent(ctx, buildAlertEvent(AlertEventResolved, &alert, p.At))
	}
	_, err = r.rules.UpdateOne(ctx, bson.M{"_id": rule.RuleID, "revision": p.Revision, "metricClosure.revision": p.Revision}, bson.M{"$unset": bson.M{"metricClosure": ""}})
	if err == nil {
		rule.MetricClosure = nil
	}
	return err
}

func (r *Repository) storeMetricLatest(ctx context.Context, alertID string, status MetricEvaluationStatus, evidence *MetricEvidence) error {
	_, err := r.alerts.UpdateOne(ctx, bson.M{"_id": alertID, "state": bson.M{"$in": AlertOpenStates}}, bson.M{"$set": bson.M{
		"metricLatest": &MetricObservation{Status: status, Evidence: evidence},
	}})
	return err
}
