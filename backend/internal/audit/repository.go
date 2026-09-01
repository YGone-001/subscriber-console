package audit

import (
	"context"
	"fmt"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides read-only access to audit logs.
type Repository struct {
	collection *mongo.Collection
}

// NewRepository creates a Repository for the given collection.
func NewRepository(collection *mongo.Collection) *Repository {
	return &Repository{collection: collection}
}

// ListAuditLogs queries audit logs with pagination, filtering, and summary.
// Matches the Node.js listAuditLogs() aggregation pipeline.
func (r *Repository) ListAuditLogs(ctx context.Context, query AuditQuery, revealSourceIP bool) (*AuditListResponse, error) {
	filter := buildAuditFilter(query)

	// Match the Node.js aggregation pipeline exactly
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: filter}},
		{{Key: "$facet", Value: bson.M{
			"logs": mongo.Pipeline{
				{{Key: "$sort", Value: bson.M{"timestamp": -1}}},
				{{Key: "$skip", Value: (query.Page - 1) * query.PageSize}},
				{{Key: "$limit", Value: query.PageSize}},
				{{Key: "$project", Value: bson.M{
					"_id":           0,
					"id":            1,
					"eventId":       1,
					"timestamp":     1,
					"level":         1,
					"action":        1,
					"targetId":      1,
					"actor":         1,
					"operatorIp":    1,
					"correlationId": 1,
					"approvalId":    1,
					"reason":        1,
					"actorContext":  1,
					"module":        1,
					"resource":      1,
					"riskLevel":     1,
					"result":        1,
					"source.ip":     1,
					"request":       1,
				}}},
			},
			"summary": mongo.Pipeline{
				{{Key: "$group", Value: bson.M{
					"_id":      nil,
					"matched":  bson.M{"$sum": 1},
					"failed":   bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$result", "failed"}}, 1, 0}}},
					"denied":   bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$result", "denied"}}, 1, 0}}},
					"highRisk": bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$in": bson.A{"$riskLevel", bson.A{"high", "critical"}}}, 1, 0}}},
				}}},
			},
		}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("audit aggregate: %w", err)
	}
	defer cursor.Close(ctx)

	var results []struct {
		Logs    []bson.M `bson:"logs"`
		Summary []struct {
			Matched  int `bson:"matched"`
			Failed   int `bson:"failed"`
			Denied   int `bson:"denied"`
			HighRisk int `bson:"highRisk"`
		} `bson:"summary"`
	}
	if err := cursor.All(ctx, &results); err != nil {
		return nil, fmt.Errorf("audit decode: %w", err)
	}

	if len(results) == 0 {
		return &AuditListResponse{
			Logs:       []AuditLogRecord{},
			Pagination: Pagination{Page: query.Page, PageSize: query.PageSize, Total: 0, TotalPages: 1},
			Summary:    Summary{},
		}, nil
	}

	facet := results[0]
	metrics := Summary{}
	if len(facet.Summary) > 0 {
		metrics = Summary{
			Matched:  facet.Summary[0].Matched,
			Failed:   facet.Summary[0].Failed,
			Denied:   facet.Summary[0].Denied,
			HighRisk: facet.Summary[0].HighRisk,
		}
	}

	total := metrics.Matched
	totalPages := total / query.PageSize
	if total%query.PageSize > 0 {
		totalPages++
	}
	if totalPages < 1 {
		totalPages = 1
	}
	page := query.Page
	if page > totalPages {
		page = totalPages
	}

	logs := make([]AuditLogRecord, 0, len(facet.Logs))
	for _, doc := range facet.Logs {
		rec := mapBSONToRecord(doc)
		// Apply source IP access control
		if !revealSourceIP && rec.Source != nil {
			rec.Source = nil
		}
		// Strip large fields from list response (same as Node)
		logs = append(logs, rec)
	}

	return &AuditListResponse{
		Logs: logs,
		Pagination: Pagination{
			Page:       page,
			PageSize:   query.PageSize,
			Total:      total,
			TotalPages: totalPages,
		},
		Summary: metrics,
	}, nil
}

// GetAuditLog retrieves a single audit log by ID.
func (r *Repository) GetAuditLog(ctx context.Context, id string, revealSourceIP bool) (*AuditLogRecord, error) {
	var doc bson.M
	err := r.collection.FindOne(ctx, bson.M{"id": id}, options.FindOne().SetProjection(bson.M{
		"_id": 0,
	})).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("audit find: %w", err)
	}

	rec := mapBSONToRecord(doc)
	if !revealSourceIP && rec.Source != nil {
		rec.Source = nil
	}
	return &rec, nil
}

func mapBSONToRecord(doc bson.M) AuditLogRecord {
	rec := AuditLogRecord{}
	if v, ok := doc["id"].(string); ok {
		rec.ID = v
	}
	if v, ok := doc["eventId"].(string); ok {
		rec.EventID = v
	}
	if v, ok := doc["timestamp"].(string); ok {
		rec.Timestamp = v
	} else if v, ok := doc["timestamp"].(bson.DateTime); ok {
		rec.Timestamp = v.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if v, ok := doc["level"].(string); ok {
		rec.Level = v
	}
	if v, ok := doc["action"].(string); ok {
		rec.Action = v
	}
	if v, ok := doc["targetId"].(string); ok {
		rec.TargetID = v
	}
	rec.Actor = doc["actor"]
	if v, ok := doc["operatorIp"].(string); ok {
		rec.OperatorIP = v
	}
	if v, ok := doc["correlationId"].(string); ok {
		rec.CorrelationID = v
	}
	if v, ok := doc["approvalId"].(string); ok {
		rec.ApprovalID = v
	}
	if v, ok := doc["reason"].(string); ok {
		rec.Reason = v
	}
	rec.ActorContext = doc["actorContext"]
	if v, ok := doc["module"].(string); ok {
		rec.Module = v
	}
	rec.Resource = doc["resource"]
	if v, ok := doc["riskLevel"].(string); ok {
		rec.RiskLevel = v
	}
	if v, ok := doc["result"].(string); ok {
		rec.Result = v
	}
	if src, ok := doc["source"].(bson.M); ok {
		if ip, ok := src["ip"].(string); ok {
			rec.Source = &struct {
				IP string `json:"ip,omitempty"`
			}{IP: ip}
		}
	}
	rec.Request = doc["request"]
	return rec
}

func buildAuditFilter(query AuditQuery) bson.M {
	clauses := []bson.M{}

	if query.Action != "" {
		clauses = append(clauses, bson.M{"action": query.Action})
	}
	if query.Module != "" {
		clauses = append(clauses, bson.M{"module": query.Module})
	}
	if query.Result != "" {
		clauses = append(clauses, bson.M{"result": query.Result})
	}
	if query.Risk != "" {
		clauses = append(clauses, bson.M{"riskLevel": query.Risk})
	}
	if query.Level != "" {
		clauses = append(clauses, bson.M{"level": query.Level})
	}
	if query.Actor != "" {
		match := containsRegex(query.Actor)
		clauses = append(clauses, bson.M{"$or": []bson.M{
			{"actor": match},
			{"actorContext.username": match},
			{"actorContext.displayName": match},
			{"actorContext.userId": query.Actor},
		}})
	}
	if query.ResourceType != "" {
		clauses = append(clauses, bson.M{"resource.type": query.ResourceType})
	}
	if query.ResourceID != "" {
		match := containsRegex(query.ResourceID)
		clauses = append(clauses, bson.M{"$or": []bson.M{
			{"targetId": match},
			{"resource.id": match},
			{"resource.name": match},
		}})
	}
	if query.RequestID != "" {
		clauses = append(clauses, bson.M{"request.requestId": query.RequestID})
	}
	if query.CorrelationID != "" {
		clauses = append(clauses, bson.M{"$or": []bson.M{
			{"correlationId": query.CorrelationID},
			{"request.correlationId": query.CorrelationID},
		}})
	}
	if query.ApprovalID != "" {
		clauses = append(clauses, bson.M{"approvalId": query.ApprovalID})
	}
	if query.SourceIP != "" {
		clauses = append(clauses, bson.M{"$or": []bson.M{
			{"operatorIp": query.SourceIP},
			{"source.ip": query.SourceIP},
		}})
	}
	if query.From != "" || query.To != "" {
		ts := bson.M{}
		if query.From != "" {
			ts["$gte"] = query.From
		}
		if query.To != "" {
			ts["$lte"] = query.To
		}
		clauses = append(clauses, bson.M{"timestamp": ts})
	}
	if query.Q != "" {
		match := containsRegex(query.Q)
		clauses = append(clauses, bson.M{"$or": []bson.M{
			{"id": match},
			{"eventId": match},
			{"action": match},
			{"actor": match},
			{"targetId": match},
			{"resource.id": match},
			{"request.requestId": match},
			{"request.correlationId": match},
			{"correlationId": match},
			{"approvalId": match},
		}})
	}

	if len(clauses) == 0 {
		return bson.M{}
	}
	if len(clauses) == 1 {
		return clauses[0]
	}
	return bson.M{"$and": clauses}
}

func containsRegex(value string) bson.M {
	escaped := escapeRegex(value)
	return bson.M{"$regex": escaped, "$options": "i"}
}

func escapeRegex(s string) string {
	replacer := strings.NewReplacer(
		"\\", "\\\\",
		".", "\\.",
		"*", "\\*",
		"+", "\\+",
		"?", "\\?",
		"^", "\\^",
		"$", "\\$",
		"{", "\\{",
		"}", "\\}",
		"(", "\\(",
		")", "\\)",
		"[", "\\[",
		"]", "\\]",
		"|", "\\|",
	)
	return replacer.Replace(s)
}
