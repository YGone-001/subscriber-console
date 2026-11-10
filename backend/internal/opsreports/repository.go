package opsreports

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/nfhealth"
)

type Repository struct{ db *mongo.Database }

func NewRepository(db *mongo.Database) *Repository { return &Repository{db} }
func date(field string) bson.M {
	return bson.M{"$convert": bson.M{"input": "$" + field, "to": "date", "onError": nil, "onNull": nil}}
}
func window(field string, q Query) bson.M { return bson.M{field: bson.M{"$gte": q.From, "$lt": q.To}} }
func (r *Repository) aggregate(ctx context.Context, collection string, pipeline bson.A) (bson.M, error) {
	c, e := r.db.Collection(collection).Aggregate(ctx, pipeline, options.Aggregate().SetAllowDiskUse(false))
	if e != nil {
		return nil, e
	}
	defer c.Close(ctx)
	var v bson.M
	if c.Next(ctx) {
		e = c.Decode(&v)
	} else {
		e = c.Err()
	}
	return v, e
}
func docs(value any) []bson.M {
	a, ok := value.(bson.A)
	if !ok {
		return []bson.M{}
	}
	out := []bson.M{}
	for _, v := range a {
		switch m := v.(type) {
		case bson.M:
			out = append(out, m)
		case bson.D:
			out = append(out, documentMap(m))
		}
	}
	return out
}
func number(value any) int64 {
	switch v := value.(type) {
	case int32:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	}
	return 0
}
func count(v any) int64 {
	a := docs(v)
	if len(a) == 0 {
		return 0
	}
	return number(a[0]["count"])
}
func first(v any) bson.M {
	a := docs(v)
	if len(a) == 0 {
		return bson.M{}
	}
	return a[0]
}
func plain(m bson.M) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}
func (r *Repository) scope(ctx context.Context, q Query) (bson.M, error) {
	filter := bson.M{}
	if q.ResourceID != "" {
		if e := r.db.Collection("app_inventory_resources").FindOne(ctx, bson.M{"_id": q.ResourceID}).Err(); e != nil {
			return nil, fmt.Errorf("resource identity unavailable")
		}
		filter["resourceId"] = q.ResourceID
	}
	if q.Domain == "" {
		return filter, nil
	}
	f := bson.M{"domain": q.Domain}
	if q.ResourceID != "" {
		f["_id"] = q.ResourceID
	}
	c, e := r.db.Collection("app_inventory_resources").Find(ctx, f, options.Find().SetProjection(bson.M{"_id": 1}).SetLimit(1001))
	if e != nil {
		return nil, e
	}
	defer c.Close(ctx)
	ids := []string{}
	for c.Next(ctx) {
		var v struct {
			ID string `bson:"_id"`
		}
		if c.Decode(&v) != nil {
			return nil, fmt.Errorf("resource identity unavailable")
		}
		ids = append(ids, v.ID)
	}
	if c.Err() != nil {
		return nil, c.Err()
	}
	if len(ids) > 1000 {
		return nil, fmt.Errorf("domain scope exceeds 1000 resources; select a resource")
	}
	filter["resourceId"] = bson.M{"$in": ids}
	return filter, nil
}
func (r *Repository) Generate(ctx context.Context, q Query, wanted string) *Report {
	now := time.Now().UTC()
	out := &Report{GeneratedAt: now, Query: q, Consistency: "eventual_across_collections", RowsLimited: map[string]bool{}}
	unavailable := Section{Completeness: "unavailable", Reason: "source_unavailable", Scope: "requested_window"}
	out.Alerts = unavailable
	out.Metrics = unavailable
	out.Config = unavailable
	out.Agents = unavailable
	filter, e := r.scope(ctx, q)
	if e != nil {
		out.Alerts.Reason = "scope_unavailable"
		out.Metrics.Reason = "scope_unavailable"
		out.Config.Reason = "scope_unavailable"
		return out
	}
	if wanted == "" || wanted == "alerts" {
		out.Alerts, out.AlertRows, out.RowsLimited["alerts"] = r.alerts(ctx, q, filter, now)
	}
	if q.Severity != "" {
		out.Metrics = Section{Completeness: "unavailable", Scope: "unsupported_filter", Reason: "severity_is_alert_only"}
		out.Config = out.Metrics
		out.Agents = out.Metrics
		return out
	}
	if wanted == "" || wanted == "metrics" {
		out.Metrics, out.MetricRows, out.RowsLimited["metrics"] = r.metrics(ctx, q, filter, now)
	}
	if wanted == "" || wanted == "config" {
		out.Config, out.ConfigRows, out.RowsLimited["config"] = r.config(ctx, q, filter)
	}
	if wanted == "" {
		if q.ResourceID != "" || q.Domain != "" {
			out.Agents = Section{Completeness: "unavailable", Scope: "unsupported_filter", Reason: "agent_resource_history_unavailable"}
		} else {
			out.Agents = r.agents(ctx, now)
		}
	}
	return out
}
func (r *Repository) alerts(ctx context.Context, q Query, scope bson.M, now time.Time) (Section, []map[string]any, bool) {
	filter := bson.M{}
	for k, v := range scope {
		filter[k] = v
	}
	if q.Severity != "" {
		filter["severity"] = q.Severity
	}
	cohort := func(field string) bson.A {
		return bson.A{bson.M{"$match": window(field, q)}, bson.M{"$count": "count"}}
	}
	duration := func(field string) bson.A {
		var grouping any
		if field == "closed" {
			grouping = "$resolvedReason"
		}
		return bson.A{bson.M{"$match": window(field, q)}, bson.M{"$match": bson.M{"first": bson.M{"$ne": nil}, "$expr": bson.M{"$gte": bson.A{"$" + field, "$first"}}}}, bson.M{"$group": bson.M{"_id": grouping, "count": bson.M{"$sum": 1}, "seconds": bson.M{"$avg": bson.M{"$divide": bson.A{bson.M{"$subtract": bson.A{"$" + field, "$first"}}, 1000}}}}}}
	}
	v, e := r.aggregate(ctx, "app_nf_alerts", bson.A{bson.M{"$match": filter}, bson.M{"$set": bson.M{"first": date("firstTriggeredAt"), "ack": date("acknowledgedAt"), "closed": date("resolvedAt")}}, bson.M{"$facet": bson.M{
		"new": cohort("first"), "acknowledged": cohort("ack"), "closed": cohort("closed"), "ackDuration": duration("ack"), "closeDuration": duration("closed"),
		"currentOpen":         bson.A{bson.M{"$match": bson.M{"state": bson.M{"$in": bson.A{"active", "acknowledged", "assigned", "recovering"}}, "first": bson.M{"$lte": now}}}, bson.M{"$count": "count"}},
		"newBySeverity":       bson.A{bson.M{"$match": window("first", q)}, bson.M{"$group": bson.M{"_id": "$severity", "count": bson.M{"$sum": 1}}}},
		"closedByReason":      bson.A{bson.M{"$match": window("closed", q)}, bson.M{"$group": bson.M{"_id": "$resolvedReason", "count": bson.M{"$sum": 1}}}},
		"invalidTimesInScope": bson.A{bson.M{"$match": bson.M{"$or": bson.A{bson.M{"first": nil}, bson.M{"ack": nil, "acknowledgedAt": bson.M{"$nin": bson.A{nil, ""}}}, bson.M{"closed": nil, "resolvedAt": bson.M{"$nin": bson.A{nil, ""}}}}}}, bson.M{"$count": "count"}},
		"rows":                bson.A{bson.M{"$match": bson.M{"$or": bson.A{window("first", q), window("ack", q), window("closed", q)}}}, bson.M{"$sort": bson.M{"_id": 1}}, bson.M{"$limit": 10001}, bson.M{"$project": bson.M{"ruleName": 1, "resourceId": 1, "targetId": 1, "targetName": 1, "severity": 1, "state": 1, "firstTriggeredAt": 1, "acknowledgedAt": 1, "resolvedAt": 1, "resolvedReason": 1}}},
	}}})
	if e != nil {
		return Section{Completeness: "unavailable", Scope: "requested_window", Reason: "source_unavailable"}, nil, false
	}
	data := map[string]any{"new": count(v["new"]), "acknowledged": count(v["acknowledged"]), "closed": count(v["closed"]), "currentOpen": count(v["currentOpen"]), "currentOpenAsOf": now, "ackDuration": first(v["ackDuration"]), "closeDurationsByReason": docs(v["closeDuration"]), "newBySeverity": docs(v["newBySeverity"]), "closedByReason": docs(v["closedByReason"]), "invalidTimesInScope": count(v["invalidTimesInScope"]), "durationMeaning": "alert_processing_not_network_repair", "domainBasis": "current_inventory"}
	if len(first(v["ackDuration"])) == 0 {
		data["ackDuration"] = bson.M{"count": int64(0), "seconds": nil}
	}
	rows := []map[string]any{}
	for _, m := range docs(v["rows"]) {
		row := plain(m)
		row["rowId"] = rowID(fmt.Sprint(m["_id"]))
		delete(row, "_id")
		rows = append(rows, row)
	}
	sortRows(rows)
	completeness, reason := "complete", ""
	if count(v["invalidTimesInScope"]) > 0 {
		completeness = "partial"
		reason = "invalid_timestamps_in_scope"
	}
	return Section{Completeness: completeness, Scope: "window_events_and_current_queue", Reason: reason, Data: data}, rows, len(rows) > 10000
}
func (r *Repository) metrics(ctx context.Context, q Query, scope bson.M, now time.Time) (Section, []map[string]any, bool) {
	group := bson.M{"targetId": "$targetId", "resourceId": "$resourceId", "key": "$metrics.key", "type": "$metrics.type", "unit": "$metrics.unit", "category": bson.M{"$ifNull": bson.A{"$metrics.category", "resource"}}}
	labelKeys := bson.M{"$map": bson.M{"input": bson.M{"$objectToArray": bson.M{"$ifNull": bson.A{"$metrics.labels", bson.M{}}}}, "as": "label", "in": "$$label.k"}}
	validLabels := bson.M{"$expr": bson.M{"$setIsSubset": bson.A{labelKeys, bson.A{"nf", "nftype", "nf_type", "function", "instance"}}}}
	for _, label := range []string{"nf", "nftype", "nf_type", "function", "instance"} {
		group["label_"+label] = "$metrics.labels." + label
	}
	v, e := r.aggregate(ctx, "app_nf_health_samples", bson.A{bson.M{"$match": scope}, bson.M{"$set": bson.M{"at": date("collectedAt")}}, bson.M{"$facet": bson.M{
		"coverage":            bson.A{bson.M{"$match": window("at", q)}, bson.M{"$group": bson.M{"_id": nil, "samples": bson.M{"$sum": 1}, "metricObservations": bson.M{"$sum": bson.M{"$size": bson.M{"$ifNull": bson.A{"$metrics", bson.A{}}}}}, "first": bson.M{"$min": "$at"}, "last": bson.M{"$max": "$at"}}}},
		"invalidTimesInScope": bson.A{bson.M{"$match": bson.M{"at": nil}}, bson.M{"$count": "count"}},
		"rows":                bson.A{bson.M{"$match": window("at", q)}, bson.M{"$sort": bson.M{"at": 1}}, bson.M{"$unwind": "$metrics"}, bson.M{"$match": validLabels}, bson.M{"$match": bson.M{"metrics.type": bson.M{"$in": bson.A{"gauge", "counter"}}, "metrics.value": bson.M{"$gte": -math.MaxFloat64, "$lte": math.MaxFloat64}}}, bson.M{"$group": bson.M{"_id": group, "sampleCount": bson.M{"$sum": 1}, "first": bson.M{"$min": "$at"}, "lastAt": bson.M{"$max": "$at"}, "last": bson.M{"$last": "$metrics.value"}, "min": bson.M{"$min": "$metrics.value"}, "max": bson.M{"$max": "$metrics.value"}, "mean": bson.M{"$avg": "$metrics.value"}}}, bson.M{"$limit": 10001}},
	}}})
	if e != nil {
		return Section{Completeness: "unavailable", Scope: "requested_window", Reason: "source_unavailable"}, nil, false
	}
	coverage := plain(first(v["coverage"]))
	if coverage["samples"] == nil {
		coverage["samples"] = int64(0)
	}
	coverage["retentionDays"] = nfhealth.DefaultRetentionDays
	coverage["continuousCoverage"] = "unknown"
	coverage["invalidTimesInScope"] = count(v["invalidTimesInScope"])
	coverage["domainBasis"] = "current_inventory"
	rows := []map[string]any{}
	invalidAggregates := 0
	for _, m := range docs(v["rows"]) {
		key := firstKey(m["_id"])
		encoded, _ := json.Marshal(key)
		row := plain(m)
		delete(row, "_id")
		row["rowId"] = rowID(string(encoded))
		for k, value := range key {
			row[k] = value
		}
		if row["type"] != "gauge" {
			row["mean"] = nil
		}
		for _, field := range []string{"last", "min", "max", "mean"} {
			if value, ok := row[field].(float64); ok && (math.IsNaN(value) || math.IsInf(value, 0)) {
				row[field] = nil
				invalidAggregates++
			}
		}
		rows = append(rows, row)
	}
	sortRows(rows)
	completeness := "complete"
	reason := "continuous_coverage_unknown"
	var usable int64
	for _, row := range rows {
		usable += number(row["sampleCount"])
	}
	coverage["excludedMetricObservations"] = nil
	coverage["invalidAggregateValues"] = invalidAggregates
	if len(rows) <= 10000 {
		excluded := number(coverage["metricObservations"]) - usable
		coverage["excludedMetricObservations"] = excluded
		if excluded > 0 {
			completeness = "partial"
			reason = "unsupported_metric_evidence"
		}
	}
	if count(v["invalidTimesInScope"]) > 0 {
		completeness = "partial"
		reason = "invalid_timestamps_in_scope"
	}
	if invalidAggregates > 0 {
		completeness = "partial"
		reason = "non_finite_metric_aggregate"
	}
	if q.From.Before(now.AddDate(0, 0, -nfhealth.DefaultRetentionDays)) {
		completeness = "partial"
		reason = "requested_window_exceeds_sample_retention"
	}
	if len(rows) > 10000 {
		coverage["series"] = nil
		completeness = "partial"
		reason = "series_budget_exceeded"
	} else {
		coverage["series"] = len(rows)
	}
	return Section{Completeness: completeness, Scope: "retained_samples", Reason: reason, Data: coverage}, rows, len(rows) > 10000
}
func firstKey(v any) bson.M {
	switch m := v.(type) {
	case bson.M:
		return m
	case bson.D:
		return documentMap(m)
	}
	return bson.M{}
}

func documentMap(d bson.D) bson.M {
	m := bson.M{}
	for _, e := range d {
		m[e.Key] = e.Value
	}
	return m
}
func sortRows(rows []map[string]any) {
	sort.Slice(rows, func(i, j int) bool { return fmt.Sprint(rows[i]["rowId"]) < fmt.Sprint(rows[j]["rowId"]) })
}
func (r *Repository) config(ctx context.Context, q Query, scope bson.M) (Section, []map[string]any, bool) {
	filter := bson.M{"collectedAt": bson.M{"$gte": q.From, "$lt": q.To}, "published": true}
	for k, v := range scope {
		filter[k] = v
	}
	v, e := r.aggregate(ctx, "app_config_observations", bson.A{bson.M{"$match": filter}, bson.M{"$facet": bson.M{"counts": bson.A{bson.M{"$group": bson.M{"_id": "$status", "count": bson.M{"$sum": 1}}}}, "changed": bson.A{bson.M{"$match": bson.M{"changed": true}}, bson.M{"$count": "count"}}, "rows": bson.A{bson.M{"$sort": bson.M{"_id": 1}}, bson.M{"$limit": 10001}, bson.M{"$project": bson.M{"sourceId": 1, "resourceId": 1, "collectedAt": 1, "status": 1, "reason": 1, "changed": 1, "snapshotId": 1}}}}}})
	if e != nil {
		return Section{Completeness: "unavailable", Scope: "requested_window", Reason: "source_unavailable"}, nil, false
	}
	rows := []map[string]any{}
	for _, m := range docs(v["rows"]) {
		row := plain(m)
		row["rowId"] = rowID(fmt.Sprint(m["_id"]))
		delete(row, "_id")
		rows = append(rows, row)
	}
	sortRows(rows)
	return Section{Completeness: "complete", Scope: "observation_times", Data: map[string]any{"byStatus": docs(v["counts"]), "changed": count(v["changed"]), "timeMeaning": "observed_not_actual_modification"}}, rows, len(rows) > 10000
}
func (r *Repository) agents(ctx context.Context, now time.Time) Section {
	v, e := r.aggregate(ctx, "app_agents", bson.A{bson.M{"$group": bson.M{"_id": bson.M{"$switch": bson.M{"branches": bson.A{bson.M{"case": bson.M{"$eq": bson.A{"$enabled", false}}, "then": "disabled"}, bson.M{"case": bson.M{"$eq": bson.A{bson.M{"$ifNull": bson.A{"$lastReceivedAt", nil}}, nil}}, "then": "pending"}, bson.M{"case": bson.M{"$gte": bson.A{"$lastReceivedAt", now.Add(-45 * time.Second)}}, "then": "online"}, bson.M{"case": bson.M{"$gte": bson.A{"$lastReceivedAt", now.Add(-120 * time.Second)}}, "then": "stale"}}, "default": "offline"}}, "count": bson.M{"$sum": 1}}}, bson.M{"$group": bson.M{"_id": nil, "states": bson.M{"$push": bson.M{"state": "$_id", "count": "$count"}}}}})
	if e != nil {
		return Section{Completeness: "unavailable", Scope: "current_remote_collectors", Reason: "source_unavailable"}
	}
	states := map[string]int64{"online": 0, "stale": 0, "offline": 0, "pending": 0, "disabled": 0}
	for _, m := range docs(v["states"]) {
		states[fmt.Sprint(m["state"])] = number(m["count"])
	}
	return Section{Completeness: "complete", Scope: "current_remote_collectors", Data: map[string]any{"states": states, "asOf": now, "controllerIncluded": false, "historyAvailable": false}}
}
