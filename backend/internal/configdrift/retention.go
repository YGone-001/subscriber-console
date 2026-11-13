package configdrift

import (
	"context"
	"fmt"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"time"
)

// Prune is bounded and replayable. Open episodes, pending projection journals
// and nonterminal delivery intents are protected. Expiration is marked before
// deletion, so a crash cannot expose a complete-looking empty event history.
func (r *MongoRepository) Prune(ctx context.Context, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	keep := []string{}
	states, e := r.sources.Find(ctx, bson.M{}, options.Find().SetLimit(4097).SetProjection(bson.M{"current._id": 1, "pending.alert._id": 1}))
	if e != nil {
		return e
	}
	var saved []State
	e = states.All(ctx, &saved)
	states.Close(ctx)
	if e != nil {
		return e
	}
	if len(saved) > 4096 {
		return fmt.Errorf("configuration drift retention source bound exceeded")
	}
	for _, s := range saved {
		if s.Current != nil {
			keep = append(keep, s.Current.ID)
		}
		if s.Pending != nil {
			keep = append(keep, s.Pending.Alert.ID)
		}
	}
	deliveries := r.alerts.Database().Collection("app_nf_notification_deliveries")
	cur, e := deliveries.Find(ctx, bson.M{"subjectKind": "config_drift", "status": bson.M{"$nin": bson.A{"sent", "skipped", "dead"}}}, options.Find().SetProjection(bson.M{"subjectId": 1}).SetLimit(10001))
	if e != nil {
		return e
	}
	var pending []struct {
		ID string `bson:"subjectId"`
	}
	e = cur.All(ctx, &pending)
	cur.Close(ctx)
	if e != nil {
		return e
	}
	if len(pending) > 10000 {
		return fmt.Errorf("configuration drift retention intent bound exceeded")
	}
	for _, d := range pending {
		keep = append(keep, d.ID)
	}
	q := bson.M{"state": "resolved", "resolvedAt": bson.M{"$lt": now.AddDate(0, 0, -90)}, "_id": bson.M{"$nin": keep}}
	cur, e = r.alerts.Find(ctx, q, options.Find().SetProjection(bson.M{"_id": 1}).SetSort(bson.D{{Key: "resolvedAt", Value: 1}}).SetLimit(1000))
	if e != nil {
		return e
	}
	var rows []struct {
		ID string `bson:"_id"`
	}
	e = cur.All(ctx, &rows)
	cur.Close(ctx)
	if e != nil {
		return e
	}
	ids := []string{}
	for _, v := range rows {
		ids = append(ids, v.ID)
	}
	if len(ids) == 0 {
		return nil
	}
	q["_id"] = bson.M{"$in": ids}
	if _, e = r.alerts.UpdateMany(ctx, q, bson.M{"$set": bson.M{"expiredAt": now}}); e != nil {
		return e
	}
	if _, e = r.events.DeleteMany(ctx, bson.M{"alertId": bson.M{"$in": ids}}); e != nil {
		return e
	}
	_, e = r.alerts.DeleteMany(ctx, bson.M{"_id": bson.M{"$in": ids}, "expiredAt": bson.M{"$exists": true}})
	return e
}
