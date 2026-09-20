package balance

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides read and write access to OCS balance data.
type Repository struct {
	balances    *mongo.Collection
	subscribers *mongo.Collection
	approvals   *mongo.Collection
	auditLogs   *mongo.Collection
}

// NewRepository creates a new balance Repository.
func NewRepository(balances, subscribers, approvals, auditLogs *mongo.Collection) *Repository {
	return &Repository{
		balances:    balances,
		subscribers: subscribers,
		approvals:   approvals,
		auditLogs:   auditLogs,
	}
}

// ListBalances returns paginated balance records with summary.
func (r *Repository) ListBalances(ctx context.Context, opts BalanceQueryOptions) (BalanceListResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	page := max(1, opts.Page)
	limit := clampLimit(opts.Limit)
	skip := int64((page - 1) * limit)

	filter := bson.M{}
	if opts.IMSI != "" {
		filter["imsi"] = bson.M{"$regex": opts.IMSI, "$options": "i"}
	}
	if opts.PlanID != "" {
		filter["plan_id"] = opts.PlanID
	}
	if opts.Status != "" {
		filter["status"] = opts.Status
	}

	totalCount, err := r.balances.CountDocuments(ctx, filter)
	if err != nil {
		return BalanceListResponse{}, err
	}

	sortKey := mapSortField(opts.SortField, map[string]string{
		"imsi":            "imsi",
		"data_total":      "data_total",
		"data_used":       "data_used",
		"data_available":  "data_available",
		"voice_total":     "voice_total",
		"voice_available": "voice_available",
		"sms_total":       "sms_total",
		"sms_available":   "sms_available",
		"updated_at":      "updated_at",
	}, "updated_at")
	sortDir := sortDirection(opts.SortOrder)

	cursor, err := r.balances.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: sortKey, Value: sortDir}, {Key: "_id", Value: -1}}).
		SetSkip(skip).
		SetLimit(int64(limit)))
	if err != nil {
		return BalanceListResponse{}, err
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return BalanceListResponse{}, err
	}

	// Enrich from ocs_subscribers
	imsiSet := make(map[string]struct{})
	for _, doc := range rawDocs {
		if imsi, ok := doc["imsi"].(string); ok && imsi != "" {
			imsiSet[imsi] = struct{}{}
		}
	}

	subMap := make(map[string]bson.M)
	if len(imsiSet) > 0 && r.subscribers != nil {
		imsiList := make(bson.A, 0, len(imsiSet))
		for imsi := range imsiSet {
			imsiList = append(imsiList, imsi)
		}
		subCursor, err := r.subscribers.Find(ctx, bson.M{"imsi": bson.M{"$in": imsiList}})
		if err == nil {
			defer subCursor.Close(ctx)
			for subCursor.Next(ctx) {
				var sub bson.M
				if subCursor.Decode(&sub) == nil {
					if imsi, ok := sub["imsi"].(string); ok {
						subMap[imsi] = sub
					}
				}
			}
		}
	}

	records := make([]BalanceRecord, 0, len(rawDocs))
	for _, doc := range rawDocs {
		records = append(records, mapBalanceDoc(doc, subMap))
	}

	// Apply invariant filter
	if opts.InvariantStatus == "valid" {
		filtered := make([]BalanceRecord, 0)
		for _, rec := range records {
			if rec.InvariantOk {
				filtered = append(filtered, rec)
			}
		}
		records = filtered
	} else if opts.InvariantStatus == "broken" {
		filtered := make([]BalanceRecord, 0)
		for _, rec := range records {
			if !rec.InvariantOk {
				filtered = append(filtered, rec)
			}
		}
		records = filtered
	}

	if records == nil {
		records = []BalanceRecord{}
	}

	summary, err := r.computeBalanceSummary(ctx)
	if err != nil {
		summary = BalanceSummary{TotalSubscribers: totalCount, ActiveAccounts: totalCount}
	}

	totalPages := int(totalCount) / limit
	if int(totalCount)%limit != 0 || totalPages == 0 {
		totalPages++
	}

	return BalanceListResponse{
		OK:         true,
		Records:    records,
		Total:      totalCount,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
		Summary:    summary,
	}, nil
}

// GetBalanceByIMSI finds a single balance document by IMSI.
func (r *Repository) GetBalanceByIMSI(ctx context.Context, imsi string) (*BalanceRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.balances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}

	subMap := make(map[string]bson.M)
	if r.subscribers != nil {
		var sub bson.M
		if err := r.subscribers.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&sub); err == nil {
			subMap[imsi] = sub
		}
	}

	rec := mapBalanceDoc(doc, subMap)
	return &rec, nil
}

// CountPendingAdjustments counts pending balance adjustment approvals.
func (r *Repository) CountPendingAdjustments(ctx context.Context) (int64, error) {
	if r.approvals == nil {
		return 0, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	filter := bson.M{
		"status": "pending",
		"action": bson.M{"$in": bson.A{"TRAFFIC_ADJUSTMENT", "BALANCE_ADJUST", "OCS_BALANCE_ADJUST"}},
	}
	return r.approvals.CountDocuments(ctx, filter)
}

func (r *Repository) computeBalanceSummary(ctx context.Context) (BalanceSummary, error) {
	totalSubscribers, err := r.balances.CountDocuments(ctx, bson.M{})
	if err != nil {
		return BalanceSummary{}, err
	}

	activeCount, err := r.balances.CountDocuments(ctx, bson.M{
		"$or": bson.A{
			bson.M{"status": "active"},
			bson.M{"status": bson.M{"$exists": false}},
			bson.M{"status": ""},
		},
	})
	if err != nil {
		activeCount = totalSubscribers
	}

	pendingCount, _ := r.CountPendingAdjustments(ctx)

	return BalanceSummary{
		TotalSubscribers:   totalSubscribers,
		ActiveAccounts:     activeCount,
		PendingAdjustments: pendingCount,
	}, nil
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func clampLimit(limit int) int {
	if limit <= 0 {
		return 20
	}
	if limit > 100 {
		return 100
	}
	return limit
}

func mapSortField(field string, allowed map[string]string, fallback string) string {
	if mapped, ok := allowed[field]; ok {
		return mapped
	}
	return fallback
}

func sortDirection(order string) int {
	if order == "asc" || order == "ascending" {
		return 1
	}
	return -1
}

var bigInt10 = big.NewInt(10)

func numericInt64(v any) int64 {
	switch val := v.(type) {
	case int64:
		return val
	case int32:
		return int64(val)
	case int:
		return int64(val)
	case float64:
		return int64(val)
	case bson.Decimal128:
		bi, exp, err := val.BigInt()
		if err != nil {
			return 0
		}
		if exp > 0 {
			for i := 0; i < exp; i++ {
				bi = bi.Mul(bi, bigInt10)
			}
		}
		return bi.Int64()
	default:
		return 0
	}
}

func numericInt64WithDefault(doc bson.M, key string, fallback int64) int64 {
	v, ok := doc[key]
	if !ok || v == nil {
		return fallback
	}
	return numericInt64(v)
}

func numericFloat64(v any) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case int32:
		return float64(val)
	case int64:
		return float64(val)
	default:
		return 0
	}
}

func strWithDefault(doc bson.M, key, fallback string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return fallback
	}
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

func docID(doc bson.M) string {
	if id, ok := doc["_id"]; ok {
		return fmt.Sprintf("%v", id)
	}
	return ""
}

func timeStr(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.DateTime:
		return t.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	case string:
		return t
	default:
		return ""
	}
}

func mapBalanceDoc(doc bson.M, subMap map[string]bson.M) BalanceRecord {
	imsi := strWithDefault(doc, "imsi", "")
	sub := subMap[imsi]

	dataTotal := numericInt64(doc["data_total"])
	dataUsed := numericInt64(doc["data_used"])
	dataReserved := numericInt64(doc["data_reserved"])
	dataAvailable := numericInt64(doc["data_available"])

	voiceTotal := numericInt64WithDefault(doc, "voice_total", 3600)
	voiceUsed := numericInt64WithDefault(doc, "voice_used", 0)
	voiceReserved := numericInt64WithDefault(doc, "voice_reserved", 0)
	voiceAvailable := numericInt64WithDefault(doc, "voice_available", 3600)

	smsTotal := numericInt64WithDefault(doc, "sms_total", 100)
	smsUsed := numericInt64WithDefault(doc, "sms_used", 0)
	smsAvailable := numericInt64WithDefault(doc, "sms_available", 100)

	planID := strWithDefault(doc, "plan_id", "")
	if planID == "" && sub != nil {
		planID = strWithDefault(sub, "plan_id", "plan_default_10gb")
	}
	if planID == "" {
		planID = "plan_default_10gb"
	}

	status := strWithDefault(doc, "status", "")
	if status == "" && sub != nil {
		status = strWithDefault(sub, "status", "active")
	}
	if status == "" {
		status = "active"
	}

	rec := BalanceRecord{
		ID:             docID(doc),
		IMSI:           imsi,
		PlanID:         planID,
		Status:         status,
		DataTotal:      dataTotal,
		DataUsed:       dataUsed,
		DataReserved:   dataReserved,
		DataAvailable:  dataAvailable,
		VoiceTotal:     voiceTotal,
		VoiceUsed:      voiceUsed,
		VoiceReserved:  voiceReserved,
		VoiceAvailable: voiceAvailable,
		SmsTotal:       smsTotal,
		SmsUsed:        smsUsed,
		SmsAvailable:   smsAvailable,
		MoneyBalance:   numericFloat64(doc["money_balance"]),
		Version:        numericInt64WithDefault(doc, "version", 1),
		CreatedAt:      timeStr(doc, "created_at"),
		UpdatedAt:      timeStr(doc, "updated_at"),
	}
	rec.CheckInvariants()
	return rec
}
