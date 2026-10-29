package balance

import (
	"context"
	"fmt"
	"math/big"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides read and write access to OCS balance data.
type Repository struct {
	balances    *mongo.Collection
	subscribers *mongo.Collection
	auditLogs   *mongo.Collection
}

// NewRepository creates a new balance Repository.
func NewRepository(balances, subscribers, auditLogs *mongo.Collection) *Repository {
	return &Repository{
		balances:    balances,
		subscribers: subscribers,
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
		/* Escape the needle: the client sends an IMSI, not a pattern. A literal
		 * fragment keeps the historical substring lookup while a metacharacter can
		 * no longer widen the match or fail the query with an invalid regex. */
		filter["imsi"] = bson.M{"$regex": regexp.QuoteMeta(opts.IMSI), "$options": "i"}
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

	records := make([]BalanceRecordView, 0, len(rawDocs))
	for _, doc := range rawDocs {
		records = append(records, mapBalanceView(doc, subMap))
	}

	// Apply invariant filter. A record whose conservation fields are absent is
	// neither valid nor broken, so it belongs to neither subset.
	if opts.InvariantStatus == "valid" {
		filtered := make([]BalanceRecordView, 0)
		for _, rec := range records {
			if rec.InvariantOk != nil && *rec.InvariantOk {
				filtered = append(filtered, rec)
			}
		}
		records = filtered
	} else if opts.InvariantStatus == "broken" {
		filtered := make([]BalanceRecordView, 0)
		for _, rec := range records {
			if rec.InvariantOk != nil && !*rec.InvariantOk {
				filtered = append(filtered, rec)
			}
		}
		records = filtered
	}

	if records == nil {
		records = []BalanceRecordView{}
	}

	summary, err := r.computeBalanceSummary(ctx)
	if err != nil {
		summary = BalanceSummary{}
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

// GetBalanceViewByIMSI returns the nullable read projection for one account.
// It is the authority for reads and for the pre-adjustment completeness check.
func (r *Repository) GetBalanceViewByIMSI(ctx context.Context, imsi string) (*BalanceRecordView, error) {
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

	view := mapBalanceView(doc, subMap)
	return &view, nil
}

// ListAdjustments returns the governed adjustment trail for one balance account.
//
// The trail is the operation log, not a second balance store: every successful
// adjustment writes a BALANCE_ADJUST record whose target is `balance:<imsi>`.
// Reading it back is what makes a governed write reviewable after the fact.
//
// The read is bounded (page/limit) and projects only the fields an operator needs
// to reconstruct the change; the full audit document is never returned.
func (r *Repository) ListAdjustments(ctx context.Context, imsi string, page, limit int) (AdjustmentListResponse, error) {
	response := AdjustmentListResponse{
		OK:      true,
		IMSI:    imsi,
		Page:    max(1, page),
		Limit:   clampLimit(limit),
		Records: []AdjustmentRecord{},
	}

	/* Without an audit collection handle there is no trail to read. That is an
	 * empty result, not a failure: the balance record itself is still valid. */
	if r.auditLogs == nil {
		return response, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := bson.M{
		"module": "ocs",
		"action": "BALANCE_ADJUST",
		"$or": []bson.M{
			{"targetId": "balance:" + imsi},
			{"resource.id": imsi},
		},
	}

	total, err := r.auditLogs.CountDocuments(ctx, filter)
	if err != nil {
		return AdjustmentListResponse{}, err
	}

	cursor, err := r.auditLogs.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "timestamp", Value: -1}, {Key: "_id", Value: -1}}).
		SetSkip(int64((response.Page-1)*response.Limit)).
		SetLimit(int64(response.Limit)))
	if err != nil {
		return AdjustmentListResponse{}, err
	}
	defer cursor.Close(ctx)

	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return AdjustmentListResponse{}, err
	}

	for _, doc := range docs {
		response.Records = append(response.Records, mapAdjustmentDoc(doc))
	}
	response.Total = total
	return response, nil
}

func mapAdjustmentDoc(doc bson.M) AdjustmentRecord {
	meta := nestedDoc(doc["metadata"])
	record := AdjustmentRecord{
		ID:            docID(doc),
		CreatedAt:     strWithDefault(doc, "timestamp", ""),
		Action:        strWithDefault(doc, "action", ""),
		Result:        strWithDefault(doc, "result", ""),
		Reason:        strWithDefault(doc, "reason", ""),
		Bucket:        strWithDefault(meta, "bucket", ""),
		Operation:     strWithDefault(meta, "operation", ""),
		TicketID:      strWithDefault(meta, "ticketId", ""),
		Amount:        numericInt64Ptr(meta, "amount"),
		BeforeVersion: numericInt64Ptr(meta, "beforeVersion"),
		AfterVersion:  numericInt64Ptr(meta, "afterVersion"),
	}
	/* The persisted record keeps the actor display name in `actor` (a string) and
	 * the structured identity in `actorContext`. Reading only the string loses the
	 * role; reading only the context loses legacy records that predate it. */
	record.Actor = strWithDefault(doc, "actor", "")
	if actorContext := nestedDoc(doc["actorContext"]); actorContext != nil {
		if record.Actor == "" {
			record.Actor = strWithDefault(actorContext, "username", "")
		}
		record.Role = strWithDefault(actorContext, "role", "")
	} else if nestedActor := nestedDoc(doc["actor"]); nestedActor != nil {
		if record.Actor == "" {
			record.Actor = strWithDefault(nestedActor, "username", "")
		}
		record.Role = strWithDefault(nestedActor, "role", "")
	}
	return record
}

/* nestedDoc accepts the shapes the driver may produce for a subdocument. */
func nestedDoc(value any) bson.M {
	switch typed := value.(type) {
	case bson.M:
		return typed
	case map[string]any:
		return bson.M(typed)
	case bson.D:
		converted := make(bson.M, len(typed))
		for _, element := range typed {
			converted[element.Key] = element.Value
		}
		return converted
	default:
		return nil
	}
}

func numericInt64Ptr(doc bson.M, key string) *int64 {
	if doc == nil {
		return nil
	}
	value, ok := doc[key]
	if !ok || value == nil {
		return nil
	}
	converted := numericInt64(value)
	return &converted
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

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		return BalanceSummary{}, err
	}

	if len(results) == 0 {
		return BalanceSummary{}, nil
	}
	row := results[0]
	return BalanceSummary{
		TotalSubscribers:   numericInt64(row["totalSubscribers"]),
		TotalDataAllocated: numericInt64(row["totalDataAllocated"]),
		TotalDataUsed:      numericInt64(row["totalDataUsed"]),
		TotalDataReserved:  numericInt64(row["totalDataReserved"]),
		TotalDataAvailable: numericInt64(row["totalDataAvailable"]),
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
		switch v := id.(type) {
		case bson.ObjectID:
			return v.Hex()
		case string:
			return v
		default:
			return fmt.Sprintf("%v", id)
		}
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

	createdAt := timeStr(doc, "created_at")
	if createdAt == "" && sub != nil {
		createdAt = timeStr(sub, "created_at")
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
		CreatedAt:      createdAt,
		UpdatedAt:      timeStr(doc, "updated_at"),
		CycleStartAt:   timeStr(doc, "cycle_start_at"),
		CycleResetAt:   timeStr(doc, "cycle_reset_at"),
	}
	if rec.ID == "" {
		rec.ID = imsi
	}
	rec.CheckInvariants()
	return rec
}

// mapBalanceView projects the stored document without manufacturing values.
// Missing measurements stay nil, and a conservation check is nil (unknown)
// whenever one of its operands is absent.
func mapBalanceView(doc bson.M, subMap map[string]bson.M) BalanceRecordView {
	imsi := strWithDefault(doc, "imsi", "")
	sub := subMap[imsi]

	dataTotal := numericInt64ValuePtr(doc, "data_total")
	dataUsed := numericInt64ValuePtr(doc, "data_used")
	dataReserved := numericInt64ValuePtr(doc, "data_reserved")
	dataAvailable := numericInt64ValuePtr(doc, "data_available")

	voiceTotal := numericInt64ValuePtr(doc, "voice_total")
	voiceUsed := numericInt64ValuePtr(doc, "voice_used")
	voiceReserved := numericInt64ValuePtr(doc, "voice_reserved")
	voiceAvailable := numericInt64ValuePtr(doc, "voice_available")

	smsTotal := numericInt64ValuePtr(doc, "sms_total")
	smsUsed := numericInt64ValuePtr(doc, "sms_used")
	smsAvailable := numericInt64ValuePtr(doc, "sms_available")

	planID := stringValuePtr(doc, "plan_id")
	if planID == nil && sub != nil {
		planID = stringValuePtr(sub, "plan_id")
	}

	status := stringValuePtr(doc, "status")
	if status == nil && sub != nil {
		status = stringValuePtr(sub, "status")
	}

	createdAt := timeStr(doc, "created_at")
	if createdAt == "" && sub != nil {
		createdAt = timeStr(sub, "created_at")
	}

	dataInvariant := invariant4(dataTotal, dataUsed, dataReserved, dataAvailable)
	voiceInvariant := invariant4(voiceTotal, voiceUsed, voiceReserved, voiceAvailable)
	smsInvariant := invariant3(smsTotal, smsUsed, smsAvailable)

	var overallInvariant *bool
	if dataInvariant != nil && voiceInvariant != nil && smsInvariant != nil {
		overall := *dataInvariant && *voiceInvariant && *smsInvariant
		overallInvariant = &overall
	}

	view := BalanceRecordView{
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
		MoneyBalance:     numericFloat64ValuePtr(doc, "money_balance"),
		Version:          numericInt64ValuePtr(doc, "version"),
		DataInvariantOk:  dataInvariant,
		VoiceInvariantOk: voiceInvariant,
		SmsInvariantOk:   smsInvariant,
		InvariantOk:      overallInvariant,
		CreatedAt:        createdAt,
		UpdatedAt:        timeStr(doc, "updated_at"),
		CycleStartAt:     timeStr(doc, "cycle_start_at"),
		CycleResetAt:     timeStr(doc, "cycle_reset_at"),
	}
	if view.ID == "" {
		view.ID = imsi
	}
	return view
}

func stringValuePtr(doc bson.M, key string) *string {
	if doc == nil {
		return nil
	}
	value, ok := doc[key]
	if !ok || value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	return &text
}

func numericInt64ValuePtr(doc bson.M, key string) *int64 {
	if doc == nil {
		return nil
	}
	value, ok := doc[key]
	if !ok || value == nil {
		return nil
	}
	switch value.(type) {
	case int32, int64, float64, bson.Decimal128:
		converted := numericInt64(value)
		return &converted
	default:
		return nil
	}
}

func numericFloat64ValuePtr(doc bson.M, key string) *float64 {
	if doc == nil {
		return nil
	}
	value, ok := doc[key]
	if !ok || value == nil {
		return nil
	}
	switch value.(type) {
	case int32, int64, float64:
		converted := numericFloat64(value)
		return &converted
	default:
		return nil
	}
}

func invariant4(total, used, reserved, available *int64) *bool {
	if total == nil || used == nil || reserved == nil || available == nil {
		return nil
	}
	ok := *total == *used+*reserved+*available
	return &ok
}

func invariant3(total, used, available *int64) *bool {
	if total == nil || used == nil || available == nil {
		return nil
	}
	ok := *total == *used+*available
	return &ok
}

// balanceBucketFieldsPresent reports whether every stored field needed to
// adjust one bucket is actually present. Missing fields must block a write
// instead of being read as zeroes.
func balanceBucketFieldsPresent(doc bson.M, bucket string) bool {
	keys := []string{}
	switch bucket {
	case "data":
		keys = []string{"data_total", "data_used", "data_reserved", "data_available"}
	case "voice":
		keys = []string{"voice_total", "voice_used", "voice_reserved", "voice_available"}
	case "sms":
		keys = []string{"sms_total", "sms_used", "sms_available"}
	default:
		return false
	}
	for _, key := range keys {
		if numericInt64ValuePtr(doc, key) == nil {
			return false
		}
	}
	return numericInt64ValuePtr(doc, "version") != nil
}
