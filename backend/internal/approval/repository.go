package approval

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides read-only access to approvals.
type Repository struct {
	approvals *mongo.Collection
	auditLogs *mongo.Collection
}

// NewRepository creates a Repository for the given collections.
func NewRepository(approvals, auditLogs *mongo.Collection) *Repository {
	return &Repository{approvals: approvals, auditLogs: auditLogs}
}

// ListQuery represents query parameters for listing approvals.
type ListQuery struct {
	Page         int
	PageSize     int
	Q            string
	Status       string // "all" or a valid ApprovalStatus
	Risk         string
	Action       string
	ResourceType string
	ResourceID   string
	Requester    string
	Reviewer     string
	FromTime     *time.Time
	ToTime       *time.Time
	ActorUser    string
	ActorRole    string
	CanApprove   bool
}

// ListResult is the response from listing approvals.
type ListResult struct {
	Approvals  []ApprovalWithActions `json:"approvals"`
	Pagination Pagination            `json:"pagination"`
	Summary    ListSummary           `json:"summary"`
	Total      int                   `json:"total"`
	Pending    int                   `json:"pending"`
	SLA        SLAInfo               `json:"sla"`
}

// Pagination represents page metadata.
type Pagination struct {
	Page       int `json:"page"`
	PageSize   int `json:"pageSize"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// ListSummary is the summary section of the approval list.
type ListSummary struct {
	CanReview       int `json:"canReview"`
	Awaiting        int `json:"awaiting"`
	TodayApproved   int `json:"todayApproved"`
	HighRiskPending int `json:"highRiskPending"`
}

// SLAInfo represents SLA tone for pending approvals.
type SLAInfo struct {
	OK          int `json:"ok"`
	Warning     int `json:"warning"`
	Danger      int `json:"danger"`
	OldestHours int `json:"oldestHours"`
}

// ListApprovals queries approvals with filtering, pagination, and summary.
// Matches Node listApprovals() exactly.
func (r *Repository) ListApprovals(ctx context.Context, q ListQuery) (*ListResult, error) {
	// Clamp pagination
	maxLimit := 100
	pageSize := clampInt(q.PageSize, 1, maxLimit)
	if pageSize <= 0 {
		pageSize = 20
	}
	requestedPage := q.Page
	if requestedPage < 1 {
		requestedPage = 1
	}

	// Build filter
	filter := bson.M{}

	if q.Status != "" && q.Status != "all" {
		if q.Status == "completed" {
			filter["status"] = bson.M{"$in": bson.A{"completed", "executed"}}
		} else {
			filter["status"] = q.Status
		}
	}
	if q.Risk != "" {
		filter["riskLevel"] = q.Risk
	}
	if q.Action != "" {
		filter["action"] = q.Action
	}
	if q.Requester != "" {
		filter["requester"] = q.Requester
	}
	if q.Reviewer != "" {
		filter["reviewer"] = q.Reviewer
	}
	if q.ResourceType != "" {
		filter["operation.resourceType"] = q.ResourceType
	}
	if q.ResourceID != "" {
		filter["operation.resourceId"] = q.ResourceID
	}
	if q.Q != "" {
		escaped := escapeRegex(strings.TrimSpace(q.Q)[:min(len(strings.TrimSpace(q.Q)), 200)])
		pattern := bson.M{"$regex": escaped, "$options": "i"}
		filter["$or"] = []bson.M{
			{"changeId": pattern},
			{"id": pattern},
			{"title": pattern},
			{"summary": pattern},
			{"targetId": pattern},
			{"requester": pattern},
			{"reviewer": pattern},
			{"action": pattern},
		}
	}
	if q.FromTime != nil || q.ToTime != nil {
		createdAt := bson.M{}
		if q.FromTime != nil {
			createdAt["$gte"] = q.FromTime.UTC().Format(time.RFC3339)
		}
		if q.ToTime != nil {
			createdAt["$lte"] = q.ToTime.UTC().Format(time.RFC3339)
		}
		filter["createdAt"] = createdAt
	}

	// Count total
	total, err := r.approvals.CountDocuments(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("approval count: %w", err)
	}

	totalPages := int(math.Max(1, math.Ceil(float64(total)/float64(pageSize))))
	page := int(math.Min(float64(requestedPage), float64(totalPages)))

	// Query approvals with pagination
	opts := options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetSkip(int64((page - 1) * pageSize)).
		SetLimit(int64(pageSize)).
		SetProjection(bson.M{"_id": 0})

	cursor, err := r.approvals.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("approval find: %w", err)
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return nil, fmt.Errorf("approval decode: %w", err)
	}

	// Pending filter for SLA/pending count
	pendingFilter := bson.M{"status": "pending"}
	if q.Requester != "" {
		pendingFilter["requester"] = q.Requester
	}

	// With-filter helper for summary queries
	withFilter := func(extra bson.M) bson.M {
		if len(filter) == 0 {
			return extra
		}
		return bson.M{"$and": bson.A{filter, extra}}
	}

	// Summary queries
	today := time.Now().UTC()
	today = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	todayISO := today.Format(time.RFC3339)

	canReviewFilter := withFilter(bson.M{
		"status": "pending",
		"$or": []bson.M{
			{"riskLevel": bson.M{"$in": bson.A{"low", "medium"}}},
			{"riskLevel": bson.M{"$in": bson.A{"high", "critical"}}, "requester": bson.M{"$ne": q.ActorUser}},
			{"riskLevel": bson.M{"$exists": false}, "requester": bson.M{"$ne": q.ActorUser}},
		},
	})

	// Execute summary queries in parallel
	type summaryResult struct {
		awaiting         int64
		todayApproved    int64
		highRiskPending  int64
		canReview        int64
		pendingApprovals []bson.M
	}

	sr := summaryResult{}
	errCh := make(chan error, 5)

	go func() {
		n, err := r.approvals.CountDocuments(ctx, withFilter(bson.M{"status": "pending"}))
		sr.awaiting = n
		errCh <- err
	}()
	go func() {
		n, err := r.approvals.CountDocuments(ctx, withFilter(bson.M{
			"decision.outcome":   "approved",
			"decision.decidedAt": bson.M{"$gte": todayISO},
		}))
		sr.todayApproved = n
		errCh <- err
	}()
	go func() {
		n, err := r.approvals.CountDocuments(ctx, withFilter(bson.M{
			"status":    "pending",
			"riskLevel": bson.M{"$in": bson.A{"high", "critical"}},
		}))
		sr.highRiskPending = n
		errCh <- err
	}()
	go func() {
		if q.CanApprove {
			n, err := r.approvals.CountDocuments(ctx, canReviewFilter)
			sr.canReview = n
			errCh <- err
		} else {
			errCh <- nil
		}
	}()
	go func() {
		// Pending approvals for SLA calculation
		opts := options.Find().
			SetProjection(bson.M{"createdAt": 1, "_id": 0})
		cursor, err := r.approvals.Find(ctx, pendingFilter, opts)
		if err != nil {
			errCh <- err
			return
		}
		defer cursor.Close(ctx)
		err = cursor.All(ctx, &sr.pendingApprovals)
		errCh <- err
	}()

	for i := 0; i < 5; i++ {
		if e := <-errCh; e != nil {
			return nil, fmt.Errorf("approval summary: %w", e)
		}
	}

	// Calculate SLA
	now := time.Now().UTC().UnixMilli()
	sla := SLAInfo{}
	for _, doc := range sr.pendingApprovals {
		createdAt := bsonString(doc, "createdAt")
		hours := approvalAgeHours(createdAt, now)
		tone := approvalSlaTone(createdAt, now)
		switch tone {
		case "ok":
			sla.OK++
		case "warning":
			sla.Warning++
		case "danger":
			sla.Danger++
		}
		if hours > sla.OldestHours {
			sla.OldestHours = hours
		}
	}

	// Normalize approvals and append actions
	approvals := make([]ApprovalWithActions, 0, len(rawDocs))
	for _, doc := range rawDocs {
		normalized := normalizeApproval(doc)
		if normalized == nil {
			continue
		}
		actions := ComputeActionEligibility(*normalized, q.ActorUser, q.ActorRole)
		approvals = append(approvals, ApprovalWithActions{
			ApprovalDocument: *normalized,
			Actions:          actions,
		})
	}

	return &ListResult{
		Approvals: approvals,
		Pagination: Pagination{
			Page:       page,
			PageSize:   pageSize,
			Total:      int(total),
			TotalPages: totalPages,
		},
		Summary: ListSummary{
			CanReview:       int(sr.canReview),
			Awaiting:        int(sr.awaiting),
			TodayApproved:   int(sr.todayApproved),
			HighRiskPending: int(sr.highRiskPending),
		},
		Total:   int(total),
		Pending: len(sr.pendingApprovals),
		SLA:     sla,
	}, nil
}

// GetApproval retrieves a single approval by ID.
func (r *Repository) GetApproval(ctx context.Context, id string) (*ApprovalDocument, error) {
	var doc bson.M
	err := r.approvals.FindOne(ctx, bson.M{"id": id}, options.FindOne().SetProjection(bson.M{"_id": 0})).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("approval find: %w", err)
	}
	return normalizeApproval(doc), nil
}

// ListAuditLogsForApproval retrieves audit logs related to an approval.
// Uses the unified audit presenter for full record presentation including
// oldData/newData/metadata/error. Matches Node listAuditLogsForApproval() exactly.
func (r *Repository) ListAuditLogsForApproval(ctx context.Context, approvalID string, revealSourceIP bool) ([]audit.AuditLogRecord, error) {
	filter := bson.M{
		"$or": []bson.M{
			{"targetId": "approval:" + approvalID},
			{"approvalId": approvalID},
			{"oldData.approvalId": approvalID},
			{"newData.approvalId": approvalID},
		},
	}

	opts := options.Find().
		SetSort(bson.D{{Key: "timestamp", Value: 1}}).
		SetLimit(100).
		SetProjection(bson.M{"_id": 0})

	cursor, err := r.auditLogs.Find(ctx, filter, opts)
	if err != nil {
		return nil, fmt.Errorf("audit logs for approval: %w", err)
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return nil, fmt.Errorf("audit logs decode: %w", err)
	}

	logs := make([]audit.AuditLogRecord, 0, len(rawDocs))
	for _, doc := range rawDocs {
		logs = append(logs, audit.PresentRecord(doc, revealSourceIP))
	}

	return logs, nil
}

// approvalAgeHours returns the age of an approval in hours.
func approvalAgeHours(createdAt string, nowMillis int64) int {
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		return 0
	}
	createdMillis := t.UnixMilli()
	if createdMillis >= nowMillis {
		return 0
	}
	return int((nowMillis - createdMillis) / 3600000)
}

// approvalSlaTone returns the SLA tone for a pending approval.
func approvalSlaTone(createdAt string, nowMillis int64) string {
	hours := approvalAgeHours(createdAt, nowMillis)
	if hours >= 48 {
		return "danger"
	}
	if hours >= 24 {
		return "warning"
	}
	return "ok"
}

// clampInt clamps a value to [min, max].
func clampInt(value, minVal, maxVal int) int {
	if value < minVal {
		return minVal
	}
	if value > maxVal {
		return maxVal
	}
	return value
}

// escapeRegex escapes special regex characters in a string.
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
