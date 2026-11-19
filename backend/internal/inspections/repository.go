package inspections

import (
	"context"
	"errors"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type Repository struct{ plans, runs *mongo.Collection }

func NewRepository(db *mongo.Database) *Repository {
	return &Repository{db.Collection("app_inspection_plans"), db.Collection("app_inspection_runs")}
}
func missing(err error) error {
	if errors.Is(err, mongo.ErrNoDocuments) {
		return ErrNotFound
	}
	return err
}
func changed(n int64, err error) error {
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return nil
}
func (r *Repository) Plan(ctx context.Context, id string) (*Plan, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var p Plan
	e := r.plans.FindOne(ctx, bson.M{"_id": id}).Decode(&p)
	return &p, missing(e)
}
func (r *Repository) Run(ctx context.Context, id string) (*Run, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var v Run
	e := r.runs.FindOne(ctx, bson.M{"_id": id}).Decode(&v)
	return &v, missing(e)
}
func (r *Repository) Plans(ctx context.Context) ([]Plan, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	rows, more, e := scopedRead[Plan](ctx, r.plans, bson.M{"archived": false}, nil, MaxPlans)
	if more {
		return nil, fail(503, "INSPECTION_PLAN_LIMIT", "Inspection plan count exceeds the supported limit")
	}
	return rows, e
}
func (r *Repository) Create(ctx context.Context, p *Plan) (*Plan, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if old, e := r.Plan(ctx, p.ID); e == nil {
		if old.RequestKey != p.RequestKey || old.RequestDigest != p.RequestDigest {
			return nil, ErrConflict
		}
		return old, nil
	} else if !errors.Is(e, ErrNotFound) {
		return nil, e
	}
	n, e := r.plans.CountDocuments(ctx, bson.M{"archived": false})
	if e != nil {
		return nil, e
	}
	if n >= MaxPlans {
		return nil, fail(409, "INSPECTION_PLAN_LIMIT", "Archive an unused plan before creating another")
	}
	_, e = r.plans.InsertOne(ctx, p)
	if mongo.IsDuplicateKeyError(e) {
		old, readErr := r.Plan(ctx, p.ID)
		if readErr == nil && old.RequestKey == p.RequestKey && old.RequestDigest == p.RequestDigest {
			return old, nil
		}
		return nil, ErrConflict
	}
	return p, e
}
func definitionSet(d Definition) bson.M {
	return bson.M{"name": d.Name, "description": d.Description, "scope": d.Scope, "checks": d.Checks, "configMaxAgeSeconds": d.ConfigMaxAgeSeconds, "schedule": d.Schedule}
}
func (r *Repository) Update(ctx context.Context, p *Plan, expected int64) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	set := definitionSet(p.Definition)
	runtimeFields := bson.M{"revision": p.Revision, "scheduleRevision": p.ScheduleRevision, "enabled": p.Enabled, "archived": p.Archived, "authorizedBy": p.AuthorizedBy, "updatedAt": p.UpdatedAt, "nextAt": p.NextAt, "scheduleReason": p.ScheduleReason}
	for k, v := range runtimeFields {
		set[k] = v
	}
	m := bson.M{"_id": p.ID, "revision": expected, "archived": false}
	if p.Archived {
		m["activeRunId"] = ""
	}
	res, e := r.plans.UpdateOne(ctx, m, bson.M{"$set": set})
	if e != nil {
		return e
	}
	return changed(res.MatchedCount, nil)
}
func (r *Repository) Admit(ctx context.Context, p *Plan, v *Run, next *time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	set := bson.M{"activeRunId": v.ID, "pending": v}
	m := bson.M{"_id": p.ID, "revision": p.Revision, "archived": false, "activeRunId": ""}
	if v.Mode == "scheduled" {
		m["enabled"] = true
		m["nextAt"] = p.NextAt
		set["nextAt"] = next
		set["scheduleReason"] = ""
	}
	res, e := r.plans.UpdateOne(ctx, m, bson.M{"$set": set})
	if e != nil {
		return e
	}
	return changed(res.MatchedCount, nil)
}
func (r *Repository) Record(ctx context.Context, v *Run) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, e := r.runs.UpdateOne(ctx, bson.M{"_id": v.ID}, bson.M{"$setOnInsert": v}, options.UpdateOne().SetUpsert(true))
	return e
}
func (r *Repository) Reconcile(ctx context.Context, p *Plan) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if p.Pending == nil {
		return nil
	}
	if p.Pending.ID != p.ActiveRunID {
		return fail(503, "INSPECTION_JOURNAL_INVALID", "Inspection journal identity is inconsistent")
	}
	if e := r.Record(ctx, p.Pending); e != nil {
		return e
	}
	_, e := r.plans.UpdateOne(ctx, bson.M{"_id": p.ID, "activeRunId": p.ActiveRunID, "pending._id": p.Pending.ID}, bson.M{"$unset": bson.M{"pending": ""}})
	return e
}
func (r *Repository) ScheduleNext(ctx context.Context, p *Plan, next *time.Time, reason string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	res, e := r.plans.UpdateOne(ctx, bson.M{"_id": p.ID, "revision": p.Revision, "nextAt": p.NextAt, "enabled": true}, bson.M{"$set": bson.M{"nextAt": next, "scheduleReason": reason}})
	if e != nil {
		return e
	}
	return changed(res.MatchedCount, nil)
}
func (r *Repository) Claim(ctx context.Context, id string, now time.Time) (*Run, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var v Run
	token := newID()
	e := r.runs.FindOneAndUpdate(ctx, bson.M{"_id": id, "state": "queued"}, bson.M{"$set": bson.M{"state": "running", "startedAt": now, "leaseToken": token, "leaseUntil": now.Add(time.Minute)}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&v)
	return &v, missing(e)
}
func (r *Repository) Finish(ctx context.Context, v *Run, token string, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	v.FinishedAt = &now
	expires := now.AddDate(0, 0, RetentionDays)
	v.ExpiresAt = &expires
	v.LeaseToken = ""
	v.LeaseUntil = time.Time{}
	b, e := bson.Marshal(v)
	if e != nil {
		return e
	}
	if len(b) > MaxRunBytes {
		return fail(503, "INSPECTION_REPORT_LIMIT", "The fixed report exceeds its storage bound")
	}
	res, e := r.runs.ReplaceOne(ctx, bson.M{"_id": v.ID, "state": "running", "leaseToken": token, "leaseUntil": bson.M{"$gt": now}}, v)
	if e != nil {
		return e
	}
	return changed(res.MatchedCount, nil)
}
func (r *Repository) Release(ctx context.Context, p *Plan, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, e := r.plans.UpdateOne(ctx, bson.M{"_id": p.ID, "activeRunId": id, "pending": bson.M{"$exists": false}}, bson.M{"$set": bson.M{"activeRunId": "", "lastRunId": id}})
	return e
}
func terminal(state string) bool { return state != "queued" && state != "running" }
func (r *Repository) Recover(ctx context.Context, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// One atomic state transition fences any expired worker before releasing its
	// plan. Read handlers never perform this recovery.
	expires := now.AddDate(0, 0, RetentionDays)
	_, e := r.runs.UpdateMany(ctx, bson.M{"state": "running", "leaseUntil": bson.M{"$lte": now}}, bson.M{"$set": bson.M{"state": "interrupted", "reason": "worker_interrupted", "conclusion": "inconclusive", "finishedAt": now, "expiresAt": expires, "leaseToken": ""}})
	if e != nil {
		return e
	}
	plans, e := r.Plans(ctx)
	if e != nil {
		return e
	}
	for i := range plans {
		p := &plans[i]
		if e = r.Reconcile(ctx, p); e != nil {
			return e
		}
		if p.ActiveRunID != "" {
			v, err := r.Run(ctx, p.ActiveRunID)
			if err != nil {
				return err
			}
			if terminal(v.State) {
				if e = r.Release(ctx, p, v.ID); e != nil {
					return e
				}
			}
		}
	}
	return nil
}
func (r *Repository) Capacity(ctx context.Context) (int, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// A reserved run occupies its maximum 2 MiB, including queued reports. The
	// conservative reservation bounds retained BSON without an unbounded scan.
	specs, e := r.runs.Indexes().ListSpecifications(ctx)
	if e != nil {
		var command mongo.CommandError
		if errors.As(e, &command) && command.Code == 26 {
			return 0, 0, fail(503, "INSPECTION_INDEXES_REQUIRED", "Apply the inspection indexes before enabling execution")
		}
		return 0, 0, e
	}
	found := map[string]bool{}
	for _, s := range specs {
		found[s.Name] = true
	}
	for _, name := range []string{"inspection_occurrence", "inspection_request", "inspection_expiry", "inspection_directory"} {
		if !found[name] {
			return 0, 0, fail(503, "INSPECTION_INDEXES_REQUIRED", "Apply the inspection indexes before enabling execution")
		}
	}
	n, e := r.runs.CountDocuments(ctx, bson.M{})
	if e != nil {
		return 0, 0, e
	}
	queued, e := r.runs.CountDocuments(ctx, bson.M{"state": "queued"})
	if e != nil {
		return 0, 0, e
	}
	plans, e := r.Plans(ctx)
	if e != nil {
		return 0, 0, e
	}
	for _, p := range plans {
		if p.Pending != nil {
			if _, err := r.Run(ctx, p.Pending.ID); errors.Is(err, ErrNotFound) {
				n++
				queued++
			} else if err != nil {
				return 0, 0, err
			}
		}
	}
	return int(n), int(queued), nil
}
func selectorMatch(prefix string, q Query, m bson.M) {
	for k, v := range map[string]string{"networkKey": q.Scope.NetworkKey, "siteResourceId": q.Scope.SiteResourceID, "hostResourceId": q.Scope.HostResourceID, "operatorName": q.Scope.OperatorName, "plmn": q.Scope.PLMN, "domain": q.Scope.Domain} {
		if v != "" {
			m[prefix+"scope.filter."+k] = v
		}
	}
}
func (r *Repository) ListPlans(ctx context.Context, q Query) ([]Plan, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	m := bson.M{"archived": q.Archived}
	if q.Q != "" {
		m["name"] = bson.M{"$regex": regexp.QuoteMeta(q.Q), "$options": "i"}
	}
	selectorMatch("", q, m)
	if q.Cursor != "" {
		m["_id"] = bson.M{"$gt": q.Cursor}
	}
	return scopedRead[Plan](ctx, r.plans, m, bson.M{"pending": 0, "requestKey": 0, "requestDigest": 0}, q.Limit)
}
func (r *Repository) Runs(ctx context.Context, q Query) ([]Run, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	m := bson.M{}
	for k, v := range map[string]string{"planId": q.PlanID, "state": q.State, "conclusion": q.Conclusion} {
		if v != "" {
			m[k] = v
		}
	}
	if q.Q != "" {
		m["definition.name"] = bson.M{"$regex": regexp.QuoteMeta(q.Q), "$options": "i"}
	}
	selectorMatch("definition.", q, m)
	if q.Cursor != "" {
		m["$or"] = bson.A{bson.M{"queuedAt": bson.M{"$lt": q.AfterAt}}, bson.M{"queuedAt": q.AfterAt, "_id": bson.M{"$lt": q.Cursor}}}
	}
	cur, e := r.runs.Find(ctx, m, options.Find().SetProjection(bson.M{"items": 0, "scope.resources": 0, "scope.agents": 0, "scope.agentIds": 0}).SetSort(bson.D{{Key: "queuedAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(int64(q.Limit+1)))
	if e != nil {
		return nil, false, e
	}
	defer cur.Close(ctx)
	out := []Run{}
	if e = cur.All(ctx, &out); e != nil {
		return nil, false, e
	}
	more := len(out) > q.Limit
	if more {
		out = out[:q.Limit]
	}
	return out, more, nil
}
func (r *Repository) Previous(ctx context.Context, v *Run) (*Run, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var out Run
	e := r.runs.FindOne(ctx, bson.M{"planId": v.PlanID, "state": "completed", "queuedAt": bson.M{"$lt": v.QueuedAt}}, options.FindOne().SetSort(bson.D{{Key: "queuedAt", Value: -1}, {Key: "_id", Value: -1}})).Decode(&out)
	return &out, missing(e)
}

func PlanIndexes() []mongo.IndexModel {
	return []mongo.IndexModel{
		{Keys: bson.D{{Key: "archived", Value: 1}, {Key: "_id", Value: 1}}, Options: options.Index().SetName("inspection_plans_directory")},
		{Keys: bson.D{{Key: "enabled", Value: 1}, {Key: "nextAt", Value: 1}}, Options: options.Index().SetName("inspection_plans_due")},
		{Keys: bson.D{{Key: "requestKey", Value: 1}}, Options: options.Index().SetName("inspection_plan_request").SetUnique(true)},
	}
}
func RunIndexes() []mongo.IndexModel {
	return []mongo.IndexModel{
		{Keys: bson.D{{Key: "occurrenceKey", Value: 1}}, Options: options.Index().SetName("inspection_occurrence").SetUnique(true).SetPartialFilterExpression(bson.M{"occurrenceKey": bson.M{"$type": "string"}})},
		{Keys: bson.D{{Key: "requestKey", Value: 1}}, Options: options.Index().SetName("inspection_request").SetUnique(true).SetPartialFilterExpression(bson.M{"requestKey": bson.M{"$type": "string"}})},
		{Keys: bson.D{{Key: "expiresAt", Value: 1}}, Options: options.Index().SetName("inspection_expiry").SetExpireAfterSeconds(0)},
		{Keys: bson.D{{Key: "planId", Value: 1}, {Key: "state", Value: 1}, {Key: "queuedAt", Value: -1}, {Key: "_id", Value: -1}}, Options: options.Index().SetName("inspection_directory")},
		{Keys: bson.D{{Key: "state", Value: 1}, {Key: "leaseUntil", Value: 1}}, Options: options.Index().SetName("inspection_leases")},
	}
}
