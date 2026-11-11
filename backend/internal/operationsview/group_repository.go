package operationsview

import (
	"context"
	"regexp"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/agents"
	"subscriber/internal/inventory"
	"subscriber/internal/nfalert"
	"subscriber/internal/topology"
)

type GroupStore interface {
	Resource(context.Context, string) (*inventory.Resource, error)
	Resources(context.Context, GroupFilter, []string, int) ([]inventory.Resource, bool, error)
	Edges(context.Context, []string, string, int) ([]topology.Edge, bool, error)
	Directory(context.Context, GroupQuery) ([]GroupEntry, bool, error)
	Agents(context.Context, GroupFilter, int) ([]agents.Record, bool, error)
	Alerts(context.Context, []string, GroupQuery, string) ([]nfalert.Alert, int, error)
}
type GroupRepository struct{ db *mongo.Database }

type GroupAgentReferenceStore interface {
	AgentsForHosts(context.Context, []string, int) ([]agents.Record, bool, error)
}

func NewGroupRepository(db *mongo.Database) *GroupRepository { return &GroupRepository{db: db} }

func groupRead[T any](ctx context.Context, c *mongo.Collection, filter any, limit int, projection bson.M) ([]T, bool, error) {
	opts := options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).SetLimit(int64(limit + 1))
	if projection != nil {
		opts.SetProjection(projection)
	}
	cur, e := c.Find(ctx, filter, opts)
	if e != nil {
		return nil, false, e
	}
	defer cur.Close(ctx)
	rows := []T{}
	for cur.Next(ctx) {
		var v T
		if e = cur.Decode(&v); e != nil {
			return nil, false, e
		}
		rows = append(rows, v)
	}
	if e = cur.Err(); e != nil {
		return nil, false, e
	}
	more := len(rows) > limit
	if more {
		rows = rows[:limit]
	}
	return rows, more, nil
}
func (r *GroupRepository) Resource(ctx context.Context, id string) (*inventory.Resource, error) {
	var v inventory.Resource
	e := r.db.Collection("app_inventory_resources").FindOne(ctx, bson.M{"_id": id}).Decode(&v)
	if e == mongo.ErrNoDocuments {
		return nil, inventory.ErrNotFound
	}
	return &v, e
}
func groupResourceMatch(f GroupFilter) bson.M {
	m := bson.M{}
	if !f.IncludeRetired {
		m["lifecycleState"] = bson.M{"$ne": "retired"}
	}
	if f.Domain != "" {
		m["domain"] = f.Domain
	}
	s := bson.M{}
	if f.NetworkKey != "" {
		s["networkKey"] = f.NetworkKey
	}
	if f.OperatorName != "" {
		s["operatorName"] = f.OperatorName
	}
	if f.PLMN != "" {
		s["plmns"] = f.PLMN
	}
	if len(s) > 0 {
		m["attributes."+inventory.OperationalScopesAttribute] = bson.M{"$elemMatch": s}
		m["kind"] = bson.M{"$in": []string{inventory.KindSite, inventory.KindHost, inventory.KindNetworkFunction, inventory.KindNetworkFunctionInstance}}
	}
	return m
}
func (r *GroupRepository) Resources(ctx context.Context, f GroupFilter, ids []string, limit int) ([]inventory.Resource, bool, error) {
	m := groupResourceMatch(f)
	if ids != nil {
		m["_id"] = bson.M{"$in": ids}
	}
	return groupRead[inventory.Resource](ctx, r.db.Collection("app_inventory_resources"), m, limit, nil)
}
func (r *GroupRepository) Edges(ctx context.Context, ids []string, direction string, limit int) ([]topology.Edge, bool, error) {
	if len(ids) == 0 {
		return []topology.Edge{}, false, nil
	}
	key := "fromResourceId"
	if direction == "inbound" {
		key = "toResourceId"
	}
	return groupRead[topology.Edge](ctx, r.db.Collection("app_topology_edges"), bson.M{key: bson.M{"$in": ids}, "relationshipType": "contains", "lifecycleState": "active"}, limit, nil)
}
func (r *GroupRepository) Agents(ctx context.Context, f GroupFilter, limit int) ([]agents.Record, bool, error) {
	m := bson.M{}
	for k, v := range map[string]string{"networkKey": f.NetworkKey, "operatorName": f.OperatorName, "siteResourceId": f.SiteResourceID, "hostResourceId": f.HostResourceID, "plmns": f.PLMN} {
		if v != "" {
			m["scope."+k] = v
		}
	}
	return groupRead[agents.Record](ctx, r.db.Collection("app_agents"), m, limit, bson.M{"keyHash": 0, "sessionHash": 0, "reportHash": 0, "sessionExpiresAt": 0, "sequence": 0, "observation.components": 0})
}

func (r *GroupRepository) AgentsForHosts(ctx context.Context, ids []string, limit int) ([]agents.Record, bool, error) {
	return groupRead[agents.Record](ctx, r.db.Collection("app_agents"), bson.M{"scope.hostResourceId": bson.M{"$in": ids}}, limit, bson.M{"keyHash": 0, "sessionHash": 0, "reportHash": 0, "sessionExpiresAt": 0, "sequence": 0, "observation.components": 0})
}
func (r *GroupRepository) Alerts(ctx context.Context, ids []string, q GroupQuery, after string) ([]nfalert.Alert, int, error) {
	m := bson.M{"resourceId": bson.M{"$in": ids}, "state": bson.M{"$in": []string{"active", "acknowledged", "assigned", "recovering"}}}
	if q.Severity != "" {
		m["severity"] = q.Severity
	}
	if q.Q != "" {
		re := bson.M{"$regex": regexp.QuoteMeta(q.Q), "$options": "i"}
		m["$or"] = bson.A{bson.M{"ruleName": re}, bson.M{"targetName": re}}
	}
	n, e := r.db.Collection("app_nf_alerts").CountDocuments(ctx, m)
	if e != nil {
		return nil, 0, e
	}
	if after != "" {
		m["_id"] = bson.M{"$gt": after}
	}
	rows, more, e := groupRead[nfalert.Alert](ctx, r.db.Collection("app_nf_alerts"), m, q.Limit, bson.M{"evidence": 0})
	if more {
		rows = append(rows, nfalert.Alert{})
	}
	return rows, int(n), e
}
func (r *GroupRepository) Directory(ctx context.Context, q GroupQuery) ([]GroupEntry, bool, error) {
	if q.GroupBy == "site" {
		m := bson.M{"kind": "site"}
		if !q.IncludeRetired {
			m["lifecycleState"] = bson.M{"$ne": "retired"}
		}
		if q.Q != "" {
			re := bson.M{"$regex": regexp.QuoteMeta(q.Q), "$options": "i"}
			m["$or"] = bson.A{bson.M{"name": re}, bson.M{"displayName": re}}
		}
		rows, more, e := groupRead[inventory.Resource](ctx, r.db.Collection("app_inventory_resources"), m, GroupMaxResources, bson.M{"name": 1, "displayName": 1, "kind": 1})
		out := []GroupEntry{}
		for _, v := range rows {
			name := v.DisplayName
			if name == "" {
				name = v.Name
			}
			out = append(out, GroupEntry{Key: v.ResourceID, Name: name, Kind: "site"})
		}
		return out, more, e
	}
	path := "$attributes." + inventory.OperationalScopesAttribute
	match := bson.M{}
	match["kind"] = bson.M{"$in": []string{inventory.KindSite, inventory.KindHost, inventory.KindNetworkFunction, inventory.KindNetworkFunctionInstance}}
	if !q.IncludeRetired {
		match["lifecycleState"] = bson.M{"$ne": "retired"}
	}
	pipeline := bson.A{
		bson.M{"$match": match},
		bson.M{"$project": bson.M{"scopes": bson.M{"$cond": bson.A{bson.M{"$isArray": path}, path, bson.A{}}}}},
		bson.M{"$match": bson.M{"$expr": validGroupDeclarations()}},
		bson.M{"$unwind": "$scopes"}, bson.M{"$project": bson.M{"key": "$scopes.networkKey"}},
		bson.M{"$unionWith": bson.M{"coll": "app_agents", "pipeline": bson.A{bson.M{"$project": bson.M{"key": "$scope.networkKey"}}}}},
		bson.M{"$match": bson.M{"key": bson.M{"$type": "string", "$regex": inventory.NetworkKeyPattern.String()}}},
	}
	if q.Q != "" {
		pipeline = append(pipeline, bson.M{"$match": bson.M{"key": bson.M{"$regex": regexp.QuoteMeta(q.Q), "$options": "i"}}})
	}
	pipeline = append(pipeline, bson.M{"$group": bson.M{"_id": "$key"}}, bson.M{"$sort": bson.M{"_id": 1}}, bson.M{"$limit": GroupMaxResources + 1})
	cur, e := r.db.Collection("app_inventory_resources").Aggregate(ctx, pipeline, options.Aggregate().SetAllowDiskUse(false))
	if e != nil {
		return nil, false, e
	}
	defer cur.Close(ctx)
	rows := []GroupEntry{}
	for cur.Next(ctx) {
		var v GroupEntry
		if e = cur.Decode(&v); e != nil {
			return nil, false, e
		}
		v.Name = v.Key
		v.Kind = "network"
		rows = append(rows, v)
	}
	more := len(rows) > GroupMaxResources
	if more {
		rows = rows[:GroupMaxResources]
	}
	return rows, more, cur.Err()
}

// This positive directory projection mirrors the reserved declaration grammar.
// Invalid legacy arrays cannot manufacture otherwise valid network keys.
func validGroupDeclarations() bson.M {
	str := func(field string) bson.M {
		return bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{bson.M{"$type": field}, "string"}}, field, ""}}
	}
	array := bson.M{"$cond": bson.A{bson.M{"$isArray": "$$s.plmns"}, "$$s.plmns", bson.A{}}}
	op := bson.M{"$ifNull": bson.A{"$$s.operatorName", ""}}
	opString := bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{bson.M{"$type": op}, "string"}}, op, ""}}
	object := bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{bson.M{"$type": "$$s"}, "object"}}, "$$s", bson.M{}}}
	entry := bson.M{"$and": bson.A{
		bson.M{"$eq": bson.A{bson.M{"$type": "$$s"}, "object"}},
		bson.M{"$regexMatch": bson.M{"input": str("$$s.networkKey"), "regex": inventory.NetworkKeyPattern.String()}},
		bson.M{"$eq": bson.A{bson.M{"$type": op}, "string"}},
		bson.M{"$lte": bson.A{bson.M{"$strLenCP": bson.M{"$trim": bson.M{"input": opString}}}, 128}},
		bson.M{"$not": bson.A{bson.M{"$regexMatch": bson.M{"input": opString, "regex": `[\x00-\x1f\x7f-\x9f]`}}}},
		bson.M{"$in": bson.A{bson.M{"$type": "$$s.plmns"}, bson.A{"array", "missing", "null"}}},
		bson.M{"$lte": bson.A{bson.M{"$size": array}, 16}},
		bson.M{"$eq": bson.A{bson.M{"$size": array}, bson.M{"$size": bson.M{"$setUnion": bson.A{array, bson.A{}}}}}},
		bson.M{"$allElementsTrue": bson.A{bson.M{"$map": bson.M{"input": array, "as": "p", "in": bson.M{"$regexMatch": bson.M{"input": str("$$p"), "regex": inventory.PLMNPattern.String()}}}}}},
		bson.M{"$setIsSubset": bson.A{bson.M{"$map": bson.M{"input": bson.M{"$objectToArray": object}, "as": "entry", "in": "$$entry.k"}}, bson.A{"networkKey", "operatorName", "plmns"}}},
	}}
	keys := bson.M{"$map": bson.M{"input": "$scopes", "as": "s", "in": "$$s.networkKey"}}
	return bson.M{"$and": bson.A{
		bson.M{"$lte": bson.A{bson.M{"$size": "$scopes"}, 8}},
		bson.M{"$eq": bson.A{bson.M{"$size": "$scopes"}, bson.M{"$size": bson.M{"$setUnion": bson.A{keys, bson.A{}}}}}},
		bson.M{"$allElementsTrue": bson.A{bson.M{"$map": bson.M{"input": "$scopes", "as": "s", "in": entry}}}},
	}}
}
