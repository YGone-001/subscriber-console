package ocs

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides read-only access to OCS data.
type Repository struct {
	balances     *mongo.Collection
	sessions     *mongo.Collection
	reservations *mongo.Collection
	usage        *mongo.Collection
}

// NewRepository creates a new read-only OCS Repository.
func NewRepository(balances, sessions, reservations, usage *mongo.Collection) *Repository {
	return &Repository{
		balances:     balances,
		sessions:     sessions,
		reservations: reservations,
		usage:        usage,
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
		"imsi": "imsi", "data_total": "data_total", "data_used": "data_used",
		"data_available": "data_available", "data_reserved": "data_reserved",
		"updated_at": "updated_at",
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

	// Collect IMSIs to look up subscribers for plan_id and status fallback
	imsiSet := make(map[string]struct{})
	for _, doc := range rawDocs {
		if imsi, ok := doc["imsi"].(string); ok {
			imsiSet[imsi] = struct{}{}
		}
	}

	// Build subscriber lookup map
	subMap := make(map[string]bson.M)
	if len(imsiSet) > 0 {
		imsiList := make(bson.A, 0, len(imsiSet))
		for imsi := range imsiSet {
			imsiList = append(imsiList, imsi)
		}
		subCursor, err := r.balances.Database().Collection("ocs_subscribers").Find(ctx, bson.M{"imsi": bson.M{"$in": imsiList}})
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
		records = append(records, mapBalance(doc, subMap))
	}

	// Apply invariant filter
	if opts.InvariantStatus == "valid" {
		filtered := make([]BalanceRecord, 0)
		for _, r := range records {
			if r.InvariantOk {
				filtered = append(filtered, r)
			}
		}
		records = filtered
	} else if opts.InvariantStatus == "broken" {
		filtered := make([]BalanceRecord, 0)
		for _, r := range records {
			if !r.InvariantOk {
				filtered = append(filtered, r)
			}
		}
		records = filtered
	}

	if records == nil {
		records = []BalanceRecord{}
	}

	// Summary aggregation
	summary, err := r.computeBalanceSummary(ctx)
	if err != nil {
		summary = BalanceSummary{TotalSubscribers: totalCount}
	}

	return BalanceListResponse{
		OK:         true,
		Records:    records,
		Total:      totalCount,
		Page:       page,
		Limit:      limit,
		TotalPages: int(totalCount)/limit + 1,
		Summary:    summary,
	}, nil
}

// ListSessions returns paginated session records with summary.
func (r *Repository) ListSessions(ctx context.Context, opts SessionQueryOptions) (SessionListResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	page := max(1, opts.Page)
	limit := clampLimit(opts.Limit)
	skip := int64((page - 1) * limit)

	filter := bson.M{}
	if opts.IMSI != "" {
		filter["imsi"] = bson.M{"$regex": opts.IMSI, "$options": "i"}
	}
	if opts.SessionID != "" {
		filter["session_id"] = bson.M{"$regex": opts.SessionID, "$options": "i"}
	}
	if opts.APN != "" {
		filter["apn"] = opts.APN
	}
	if opts.State != "" && opts.State != "all" {
		filter["state"] = opts.State
	}
	if opts.InterfaceType != "" && opts.InterfaceType != "all" {
		filter["interface_type"] = opts.InterfaceType
	}

	totalCount, err := r.sessions.CountDocuments(ctx, filter)
	if err != nil {
		return SessionListResponse{}, err
	}

	sortKey := mapSortField(opts.SortField, map[string]string{
		"started_at": "started_at", "last_update_at": "last_update_at",
		"used_total": "used_total", "granted_total": "granted_total",
		"session_id": "session_id", "imsi": "imsi",
	}, "last_update_at")
	sortDir := sortDirection(opts.SortOrder)

	cursor, err := r.sessions.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: sortKey, Value: sortDir}, {Key: "_id", Value: -1}}).
		SetSkip(skip).
		SetLimit(int64(limit)))
	if err != nil {
		return SessionListResponse{}, err
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return SessionListResponse{}, err
	}

	records := make([]SessionRecord, 0, len(rawDocs))
	for _, doc := range rawDocs {
		records = append(records, mapSession(doc))
	}
	if records == nil {
		records = []SessionRecord{}
	}

	// Summary
	activeCount, _ := r.sessions.CountDocuments(ctx, bson.M{"state": "active"})
	closingCount, _ := r.sessions.CountDocuments(ctx, bson.M{"state": "closing"})
	closedCount, _ := r.sessions.CountDocuments(ctx, bson.M{"state": "closed"})

	sums := r.aggregateSum(ctx, r.sessions, "granted_total", "used_total")

	return SessionListResponse{
		OK:         true,
		Records:    records,
		Total:      totalCount,
		Page:       page,
		Limit:      limit,
		TotalPages: int(totalCount)/limit + 1,
		Summary: SessionSummary{
			ActiveSessions:     activeCount,
			ClosingSessions:    closingCount,
			ClosedSessions:     closedCount,
			TotalGrantedOctets: sums[0],
			TotalUsedOctets:    sums[1],
		},
	}, nil
}

// ListUsageRecords returns paginated usage records with summary.
func (r *Repository) ListUsageRecords(ctx context.Context, opts UsageQueryOptions) (UsageListResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	page := max(1, opts.Page)
	limit := clampLimit(opts.Limit)
	skip := int64((page - 1) * limit)

	filter := bson.M{}
	if opts.IMSI != "" {
		filter["imsi"] = bson.M{"$regex": opts.IMSI, "$options": "i"}
	}
	if opts.SessionID != "" {
		filter["session_id"] = bson.M{"$regex": opts.SessionID, "$options": "i"}
	}
	if opts.APN != "" {
		filter["apn"] = opts.APN
	}
	if opts.CCRequestType != "" && opts.CCRequestType != "all" {
		filter["cc_request_type"] = opts.CCRequestType
	}
	if opts.Charged != nil {
		filter["charged"] = *opts.Charged
	}

	totalCount, err := r.usage.CountDocuments(ctx, filter)
	if err != nil {
		return UsageListResponse{}, err
	}

	sortKey := mapSortField(opts.SortField, map[string]string{
		"created_at": "created_at", "total_octets": "total_octets",
		"cc_request_number": "cc_request_number",
	}, "created_at")
	sortDir := sortDirection(opts.SortOrder)

	cursor, err := r.usage.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: sortKey, Value: sortDir}, {Key: "_id", Value: -1}}).
		SetSkip(skip).
		SetLimit(int64(limit)))
	if err != nil {
		return UsageListResponse{}, err
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return UsageListResponse{}, err
	}

	records := make([]UsageRecord, 0, len(rawDocs))
	for _, doc := range rawDocs {
		records = append(records, mapUsage(doc))
	}
	if records == nil {
		records = []UsageRecord{}
	}

	// Summary
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":               nil,
			"totalInputOctets":  bson.M{"$sum": "$input_octets"},
			"totalOutputOctets": bson.M{"$sum": "$output_octets"},
			"totalOctets":       bson.M{"$sum": "$total_octets"},
			"chargedCount":      bson.M{"$sum": bson.M{"$cond": bson.A{bson.M{"$eq": bson.A{"$charged", true}}, 1, 0}}},
		}}},
	}
	sumCursor, err := r.usage.Aggregate(ctx, pipeline)
	summary := UsageSummary{TotalRecords: totalCount}
	if err == nil {
		defer sumCursor.Close(ctx)
		if sumCursor.Next(ctx) {
			var agg struct {
				TotalInputOctets  int64 `bson:"totalInputOctets"`
				TotalOutputOctets int64 `bson:"totalOutputOctets"`
				TotalOctets       int64 `bson:"totalOctets"`
				ChargedCount      int64 `bson:"chargedCount"`
			}
			if sumCursor.Decode(&agg) == nil {
				summary.TotalChargedRecords = agg.ChargedCount
				summary.TotalInputOctets = agg.TotalInputOctets
				summary.TotalOutputOctets = agg.TotalOutputOctets
				summary.TotalOctets = agg.TotalOctets
			}
		}
	}

	return UsageListResponse{
		OK:         true,
		Records:    records,
		Total:      totalCount,
		Page:       page,
		Limit:      limit,
		TotalPages: int(totalCount)/limit + 1,
		Summary:    summary,
	}, nil
}

// ListReservations returns paginated reservation records with summary.
func (r *Repository) ListReservations(ctx context.Context, opts ReservationQueryOptions) (ReservationListResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	page := max(1, opts.Page)
	limit := clampLimit(opts.Limit)
	skip := int64((page - 1) * limit)

	filter := bson.M{}
	if opts.IMSI != "" {
		filter["imsi"] = bson.M{"$regex": opts.IMSI, "$options": "i"}
	}
	if opts.SessionID != "" {
		filter["session_id"] = bson.M{"$regex": opts.SessionID, "$options": "i"}
	}
	if opts.State != "" && opts.State != "all" {
		filter["state"] = opts.State
	}
	if opts.ChargingType != "" && opts.ChargingType != "all" {
		filter["charging_type"] = opts.ChargingType
	}

	totalCount, err := r.reservations.CountDocuments(ctx, filter)
	if err != nil {
		return ReservationListResponse{}, err
	}

	sortKey := mapSortField(opts.SortField, map[string]string{
		"created_at": "created_at", "updated_at": "updated_at",
		"reserved_octets": "reserved_octets", "used_octets": "used_octets",
	}, "created_at")
	sortDir := sortDirection(opts.SortOrder)

	cursor, err := r.reservations.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: sortKey, Value: sortDir}, {Key: "_id", Value: -1}}).
		SetSkip(skip).
		SetLimit(int64(limit)))
	if err != nil {
		return ReservationListResponse{}, err
	}
	defer cursor.Close(ctx)

	var rawDocs []bson.M
	if err := cursor.All(ctx, &rawDocs); err != nil {
		return ReservationListResponse{}, err
	}

	records := make([]ReservationRecord, 0, len(rawDocs))
	for _, doc := range rawDocs {
		records = append(records, mapReservation(doc))
	}
	if records == nil {
		records = []ReservationRecord{}
	}

	// Summary
	activeCount, _ := r.reservations.CountDocuments(ctx, bson.M{"state": "active"})
	settledCount, _ := r.reservations.CountDocuments(ctx, bson.M{"state": "settled"})
	orphanedCount, _ := r.reservations.CountDocuments(ctx, bson.M{"state": "orphaned"})

	sums := r.aggregateSum(ctx, r.reservations, "reserved_octets", "released_octets")

	return ReservationListResponse{
		OK:         true,
		Records:    records,
		Total:      totalCount,
		Page:       page,
		Limit:      limit,
		TotalPages: int(totalCount)/limit + 1,
		Summary: ReservationSummary{
			ActiveReservations:   activeCount,
			SettledReservations:  settledCount,
			OrphanedReservations: orphanedCount,
			TotalReservedOctets:  sums[0],
			TotalReleasedOctets:  sums[1],
		},
	}, nil
}

// ── Query option types ──────────────────────────────────────────────────────

// BalanceQueryOptions holds query parameters for balance listing.
type BalanceQueryOptions struct {
	Page            int
	Limit           int
	IMSI            string
	PlanID          string
	Status          string
	InvariantStatus string
	SortField       string
	SortOrder       string
}

// SessionQueryOptions holds query parameters for session listing.
type SessionQueryOptions struct {
	Page          int
	Limit         int
	IMSI          string
	SessionID     string
	APN           string
	State         string
	InterfaceType string
	SortField     string
	SortOrder     string
}

// UsageQueryOptions holds query parameters for usage listing.
type UsageQueryOptions struct {
	Page          int
	Limit         int
	IMSI          string
	SessionID     string
	APN           string
	CCRequestType string
	Charged       *bool
	SortField     string
	SortOrder     string
}

// ReservationQueryOptions holds query parameters for reservation listing.
type ReservationQueryOptions struct {
	Page         int
	Limit        int
	IMSI         string
	SessionID    string
	State        string
	ChargingType string
	SortField    string
	SortOrder    string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func clampLimit(v int) int {
	if v <= 0 {
		return 20
	}
	if v > 100 {
		return 100
	}
	return v
}

func mapSortField(requested string, allowed map[string]string, defaultField string) string {
	if requested == "" {
		return defaultField
	}
	if field, ok := allowed[requested]; ok {
		return field
	}
	return defaultField
}

func sortDirection(order string) int {
	if order == "asc" {
		return 1
	}
	return -1
}

// numericInt64 converts various BSON numeric types to int64.
// Handles: int32, int64, float64, bson.Decimal128.
func numericInt64(v any) int64 {
	switch val := v.(type) {
	case int32:
		return int64(val)
	case int64:
		return val
	case float64:
		return int64(val)
	case bson.Decimal128:
		if val.IsNaN() || val.IsInf() != 0 {
			return 0
		}
		bi, exp, err := val.BigInt()
		if err != nil {
			return 0
		}
		// For positive exponents, multiply significand by 10^exp
		if exp > 0 {
			for i := 0; i < exp; i++ {
				bi = bi.Mul(bi, bigInt10)
			}
		}
		// For negative exponents, truncate fractional part (matches Node toNumber())
		return bi.Int64()
	default:
		return 0
	}
}

var bigInt10 = big.NewInt(10)

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

func stringPtr(doc bson.M, key string) *string {
	v, ok := doc[key]
	if !ok || v == nil {
		return nil
	}
	if s, ok := v.(string); ok && s != "" {
		return &s
	}
	return nil
}

func int64Ptr(doc bson.M, key string) *int64 {
	v, ok := doc[key]
	if !ok || v == nil {
		return nil
	}
	n := numericInt64(v)
	return &n
}

func timePtr(doc bson.M, key string) *string {
	v, ok := doc[key]
	if !ok || v == nil {
		return nil
	}
	switch t := v.(type) {
	case time.Time:
		s := t.UTC().Format("2006-01-02T15:04:05.000Z")
		return &s
	case bson.DateTime:
		s := t.Time().UTC().Format("2006-01-02T15:04:05.000Z")
		return &s
	default:
		return nil
	}
}

func timeStr(doc bson.M, key string) string {
	if p := timePtr(doc, key); p != nil {
		return *p
	}
	return ""
}

func strWithDefault(doc bson.M, key, fallback string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return fallback
	}
	if s, ok := v.(string); ok {
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

func mapBalance(doc bson.M, subMap map[string]bson.M) BalanceRecord {
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

	return BalanceRecord{
		ID:               docID(doc),
		IMSI:             imsi,
		PlanID:           planID,
		Status:           status,
		DataTotal:        dataTotal,
		DataUsed:         dataUsed,
		DataReserved:     dataReserved,
		DataAvailable:    dataAvailable,
		VoiceTotal:       voiceTotal,
		VoiceUsed:        voiceUsed,
		VoiceReserved:    voiceReserved,
		VoiceAvailable:   voiceAvailable,
		SmsTotal:         smsTotal,
		SmsUsed:          smsUsed,
		SmsAvailable:     smsAvailable,
		MoneyBalance:     numericFloat64(doc["money_balance"]),
		Version:          numericInt64WithDefault(doc, "version", 1),
		DataInvariantOk:  dataTotal == (dataUsed + dataReserved + dataAvailable),
		VoiceInvariantOk: voiceTotal == (voiceUsed + voiceReserved + voiceAvailable),
		SmsInvariantOk:   smsTotal == (smsUsed + smsAvailable),
		InvariantOk: (dataTotal == (dataUsed + dataReserved + dataAvailable)) &&
			(voiceTotal == (voiceUsed + voiceReserved + voiceAvailable)) &&
			(smsTotal == (smsUsed + smsAvailable)),
		CreatedAt:    timeStr(doc, "created_at"),
		UpdatedAt:    timeStr(doc, "updated_at"),
		CycleStartAt: timeStr(doc, "cycle_start_at"),
		CycleResetAt: timeStr(doc, "cycle_reset_at"),
	}
}

func mapSession(doc bson.M) SessionRecord {
	return SessionRecord{
		ID:                docID(doc),
		SessionID:         strWithDefault(doc, "session_id", ""),
		IMSI:              strWithDefault(doc, "imsi", ""),
		APN:               strWithDefault(doc, "apn", "internet"),
		State:             strWithDefault(doc, "state", "active"),
		InterfaceType:     strWithDefault(doc, "interface_type", "gy"),
		CCRequestNumber:   numericInt64WithDefault(doc, "cc_request_number", 0),
		GrantedTotal:      numericInt64WithDefault(doc, "granted_total", 0),
		UsedTotal:         numericInt64WithDefault(doc, "used_total", 0),
		RatingGroup:       int64Ptr(doc, "rating_group"),
		ServiceIdentifier: int64Ptr(doc, "service_identifier"),
		TariffRuleID:      stringPtr(doc, "tariff_rule_id"),
		ChargingType:      stringPtr(doc, "charging_type"),
		CallingParty:      stringPtr(doc, "calling_party"),
		CalledParty:       stringPtr(doc, "called_party"),
		ServiceContextID:  stringPtr(doc, "service_context_id"),
		GrantedSeconds:    int64Ptr(doc, "granted_seconds"),
		UsedSeconds:       int64Ptr(doc, "used_seconds"),
		CleanupToken:      stringPtr(doc, "cleanup_token"),
		CleanupStage:      stringPtr(doc, "cleanup_stage"),
		CleanupUpdatedAt:  timePtr(doc, "cleanup_updated_at"),
		CloseReason:       stringPtr(doc, "close_reason"),
		StartedAt:         timePtr(doc, "started_at"),
		LastUpdateAt:      timePtr(doc, "last_update_at"),
		ClosedAt:          timePtr(doc, "closed_at"),
	}
}

func mapUsage(doc bson.M) UsageRecord {
	return UsageRecord{
		ID:                docID(doc),
		SessionID:         strWithDefault(doc, "session_id", ""),
		IMSI:              strWithDefault(doc, "imsi", ""),
		APN:               strWithDefault(doc, "apn", "internet"),
		CCRequestType:     strWithDefault(doc, "cc_request_type", "UPDATE"),
		CCRequestNumber:   numericInt64WithDefault(doc, "cc_request_number", 0),
		InputOctets:       numericInt64WithDefault(doc, "input_octets", 0),
		OutputOctets:      numericInt64WithDefault(doc, "output_octets", 0),
		TotalOctets:       numericInt64WithDefault(doc, "total_octets", 0),
		ChargingType:      stringPtr(doc, "charging_type"),
		InterfaceType:     stringPtr(doc, "interface_type"),
		Charged:           boolField(doc, "charged"),
		ResultCode:        int64Ptr(doc, "result_code"),
		GrantedOctets:     int64Ptr(doc, "granted_octets"),
		GrantedSeconds:    int64Ptr(doc, "granted_seconds"),
		UsedSeconds:       int64Ptr(doc, "used_seconds"),
		GrantedEvents:     int64Ptr(doc, "granted_events"),
		UsedEvents:        int64Ptr(doc, "used_events"),
		ServiceContextID:  stringPtr(doc, "service_context_id"),
		RatingGroup:       int64Ptr(doc, "rating_group"),
		ServiceIdentifier: int64Ptr(doc, "service_identifier"),
		TariffRuleID:      stringPtr(doc, "tariff_rule_id"),
		CreatedAt:         timePtr(doc, "created_at"),
	}
}

func mapReservation(doc bson.M) ReservationRecord {
	return ReservationRecord{
		ID:                   docID(doc),
		SessionID:            strWithDefault(doc, "session_id", ""),
		IMSI:                 strWithDefault(doc, "imsi", ""),
		APN:                  strWithDefault(doc, "apn", "internet"),
		ChargingType:         strWithDefault(doc, "charging_type", "data_volume"),
		InterfaceType:        stringPtr(doc, "interface_type"),
		GrantCCRequestType:   strWithDefault(doc, "grant_cc_request_type", "INITIAL"),
		GrantCCRequestNumber: numericInt64WithDefault(doc, "grant_cc_request_number", 0),
		ReservedOctets:       numericInt64WithDefault(doc, "reserved_octets", 0),
		UsedOctets:           numericInt64WithDefault(doc, "used_octets", 0),
		ReleasedOctets:       numericInt64WithDefault(doc, "released_octets", 0),
		OveruseOctets:        numericInt64WithDefault(doc, "overuse_octets", 0),
		GrantedOctets:        numericInt64WithDefault(doc, "granted_octets", 0),
		GrantedSeconds:       int64Ptr(doc, "granted_seconds"),
		UsedSeconds:          int64Ptr(doc, "used_seconds"),
		ResultCode:           numericInt64WithDefault(doc, "result_code", 2001),
		State:                strWithDefault(doc, "state", "active"),
		RatingGroup:          int64Ptr(doc, "rating_group"),
		ServiceIdentifier:    int64Ptr(doc, "service_identifier"),
		TariffRuleID:         stringPtr(doc, "tariff_rule_id"),
		OrphanReason:         stringPtr(doc, "orphan_reason"),
		CleanupToken:         stringPtr(doc, "cleanup_token"),
		CreatedAt:            timePtr(doc, "created_at"),
		UpdatedAt:            timePtr(doc, "updated_at"),
		SettledAt:            timePtr(doc, "settled_at"),
		ClosedAt:             timePtr(doc, "closed_at"),
		OrphanedAt:           timePtr(doc, "orphaned_at"),
	}
}

func numericInt64WithDefault(doc bson.M, key string, fallback int64) int64 {
	v, ok := doc[key]
	if !ok || v == nil {
		return fallback
	}
	n := numericInt64(v)
	if n == 0 && fallback != 0 {
		return fallback
	}
	return n
}

func boolField(doc bson.M, key string) bool {
	v, ok := doc[key]
	if !ok || v == nil {
		return false
	}
	if b, ok := v.(bool); ok {
		return b
	}
	return false
}

func (r *Repository) computeBalanceSummary(ctx context.Context) (BalanceSummary, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":                nil,
			"totalDataAllocated": bson.M{"$sum": "$data_total"},
			"totalDataUsed":      bson.M{"$sum": "$data_used"},
			"totalDataReserved":  bson.M{"$sum": "$data_reserved"},
			"totalDataAvailable": bson.M{"$sum": "$data_available"},
			"totalSubscribers":   bson.M{"$sum": 1},
		}}},
	}

	cursor, err := r.balances.Aggregate(ctx, pipeline)
	if err != nil {
		return BalanceSummary{}, err
	}
	defer cursor.Close(ctx)

	if cursor.Next(ctx) {
		var agg struct {
			TotalDataAllocated int64 `bson:"totalDataAllocated"`
			TotalDataUsed      int64 `bson:"totalDataUsed"`
			TotalDataReserved  int64 `bson:"totalDataReserved"`
			TotalDataAvailable int64 `bson:"totalDataAvailable"`
			TotalSubscribers   int64 `bson:"totalSubscribers"`
		}
		if err := cursor.Decode(&agg); err == nil {
			return BalanceSummary{
				TotalSubscribers:   agg.TotalSubscribers,
				TotalDataAllocated: agg.TotalDataAllocated,
				TotalDataUsed:      agg.TotalDataUsed,
				TotalDataReserved:  agg.TotalDataReserved,
				TotalDataAvailable: agg.TotalDataAvailable,
			}, nil
		}
	}

	return BalanceSummary{}, nil
}

func (r *Repository) aggregateSum(ctx context.Context, coll *mongo.Collection, field1, field2 string) [2]int64 {
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id": nil,
			"f1":  bson.M{"$sum": "$" + field1},
			"f2":  bson.M{"$sum": "$" + field2},
		}}},
	}
	cursor, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		return [2]int64{0, 0}
	}
	defer cursor.Close(ctx)

	if cursor.Next(ctx) {
		var agg struct {
			F1 int64 `bson:"f1"`
			F2 int64 `bson:"f2"`
		}
		if cursor.Decode(&agg) == nil {
			return [2]int64{agg.F1, agg.F2}
		}
	}
	return [2]int64{0, 0}
}
