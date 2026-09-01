package subscriber

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	defaultListLimit    = 50
	maxListLimit        = 200
	lowTrafficThreshold = 1
	defaultPlanID       = "plan_default_10gb"
)

// Repository provides subscriber data access.
type Repository struct {
	subscribers *mongo.Collection // open5gs.subscribers
	ocsSubs     *mongo.Collection // open5gs.ocs_subscribers
	ocsBalances *mongo.Collection // open5gs.ocs_balances
	tariffPlans *mongo.Collection // open5gs.ocs_tariff_plans
	profiles    *mongo.Collection // xcloud_ops.app_profiles
}

// NewRepository creates a new subscriber Repository.
func NewRepository(
	subscribers *mongo.Collection,
	ocsSubs *mongo.Collection,
	ocsBalances *mongo.Collection,
	tariffPlans *mongo.Collection,
	profiles *mongo.Collection,
) *Repository {
	return &Repository{
		subscribers: subscribers,
		ocsSubs:     ocsSubs,
		ocsBalances: ocsBalances,
		tariffPlans: tariffPlans,
		profiles:    profiles,
	}
}

// --- Helpers ---

func safePage(page int) int {
	if page < 1 {
		return 1
	}
	return page
}

func safeLimit(limit int) int {
	if limit < 1 {
		return defaultListLimit
	}
	if limit > maxListLimit {
		return maxListLimit
	}
	return limit
}

// subscriberFilter builds a BSON filter for IMSI prefix search.
// Returns nil filter if query is invalid (non-digit or too long).
func subscriberFilter(query string) (bson.M, bool) {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return bson.M{}, true
	}
	// Must be digits only, max 15 chars
	if len(trimmed) > 15 {
		return nil, false
	}
	for _, c := range trimmed {
		if c < '0' || c > '9' {
			return nil, false
		}
	}
	return bson.M{"imsi": bson.M{"$regex": "^" + trimmed}}, true
}

// numericInt64 converts various BSON numeric types to int64.
func numericInt64(v any) int64 {
	switch val := v.(type) {
	case int32:
		return int64(val)
	case int64:
		return val
	case float64:
		return int64(val)
	case bson.Decimal128:
		// Use BigInt() to get the significand
		bi, _, err := val.BigInt()
		if err != nil {
			return 0
		}
		return bi.Int64()
	case int:
		return int64(val)
	default:
		return 0
	}
}

// statusFromARD maps access_restriction_data to status string.
func statusFromARD(ard int) string {
	if ard == 255 {
		return "Suspended"
	}
	if ard > 0 && ard != 32 {
		return "Partial Restricted"
	}
	return "Active"
}

// extractARD extracts the ARD value from a subscriber document.
func extractARD(doc bson.M) int {
	if v, ok := doc["access_restriction_data"]; ok {
		return int(numericInt64(v))
	}
	return 32
}

// extractWebuiMeta extracts webui_meta as a map.
func extractWebuiMeta(doc bson.M) map[string]any {
	if v, ok := doc["webui_meta"].(bson.M); ok {
		return map[string]any(v)
	}
	if v, ok := doc["webui_meta"].(map[string]any); ok {
		return v
	}
	return nil
}

// extractProfileName extracts profile_name from webui_meta.
func extractProfileName(doc bson.M) string {
	meta := extractWebuiMeta(doc)
	if meta == nil {
		return ""
	}
	if name, ok := meta["profile_name"].(string); ok {
		return name
	}
	return ""
}

// normalizeTraffic computes traffic totals from balance doc fields.
func normalizeTraffic(dataTotal, dataUsed, dataAvailable any) TrafficSnapshot {
	balance := numericInt64(dataAvailable)
	total := numericInt64(dataTotal)
	used := numericInt64(dataUsed)

	if total == 0 {
		total = balance
	}
	if total < balance {
		total = balance
	}
	if used == 0 {
		used = total - balance
	}
	if used < 0 {
		used = 0
	}

	return TrafficSnapshot{
		Total:   total,
		Used:    used,
		Balance: balance,
	}
}

// normalizeSMS computes SMS totals from balance doc fields.
func normalizeSMS(smsTotal, smsUsed, smsAvailable any) SMSSnapshot {
	balance := numericInt64(smsAvailable)
	total := numericInt64(smsTotal)
	used := numericInt64(smsUsed)

	if total == 0 {
		total = balance
	}
	if total < balance {
		total = balance
	}
	if used == 0 {
		used = total - balance
	}
	if used < 0 {
		used = 0
	}

	return SMSSnapshot{
		Total:   total,
		Used:    used,
		Balance: balance,
	}
}

// computeLastActive determines the last active timestamp from multiple sources.
func computeLastActive(open5gsDoc, ocsSubDoc, balanceDoc bson.M) string {
	// Try: ocsSub.updated_at > open5gs.webui_meta.updated_at > open5gs.updated_at
	// > ocsSub.created_at > open5gs.webui_meta.created_at > open5gs.created_at
	// > open5gs._id timestamp > balance.updated_at
	candidates := []any{}

	if ocsSubDoc != nil {
		candidates = append(candidates, ocsSubDoc["updated_at"])
	}
	if meta := extractWebuiMeta(open5gsDoc); meta != nil {
		candidates = append(candidates, meta["updated_at"])
	}
	candidates = append(candidates, open5gsDoc["updated_at"])
	if ocsSubDoc != nil {
		candidates = append(candidates, ocsSubDoc["created_at"])
	}
	if meta := extractWebuiMeta(open5gsDoc); meta != nil {
		candidates = append(candidates, meta["created_at"])
	}
	candidates = append(candidates, open5gsDoc["created_at"])

	// ObjectId timestamp
	if id, ok := open5gsDoc["_id"].(bson.ObjectID); ok {
		candidates = append(candidates, id.Timestamp())
	}

	if balanceDoc != nil {
		candidates = append(candidates, balanceDoc["updated_at"])
	}

	for _, raw := range candidates {
		if raw == nil {
			continue
		}
		var t time.Time
		switch v := raw.(type) {
		case time.Time:
			t = v
		case string:
			parsed, err := time.Parse(time.RFC3339Nano, v)
			if err != nil {
				continue
			}
			t = parsed
		default:
			continue
		}
		if !t.IsZero() {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}

	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// toSubscriberRow converts raw BSON documents to a SubscriberRow.
func toSubscriberRow(
	open5gsDoc bson.M,
	ocsSubDoc bson.M,
	balanceDoc bson.M,
	tariffPlanDoc bson.M,
) SubscriberRow {
	imsi, _ := open5gsDoc["imsi"].(string)
	ard := extractARD(open5gsDoc)
	plmn := imsi
	if len(plmn) > 5 {
		plmn = plmn[:5]
	}

	var planID, planName, planStatus string
	if ocsSubDoc != nil {
		planID, _ = ocsSubDoc["plan_id"].(string)
	}
	if tariffPlanDoc != nil {
		planName, _ = tariffPlanDoc["name"].(string)
		planStatus, _ = tariffPlanDoc["status"].(string)
	}
	if planName == "" {
		planName = planID
	}

	var traffic TrafficSnapshot
	var sms SMSSnapshot
	if balanceDoc != nil {
		traffic = normalizeTraffic(balanceDoc["data_total"], balanceDoc["data_used"], balanceDoc["data_available"])
		sms = normalizeSMS(balanceDoc["sms_total"], balanceDoc["sms_used"], balanceDoc["sms_available"])
	}

	return SubscriberRow{
		IMSI:         imsi,
		Status:       statusFromARD(ard),
		ARD:          ard,
		PLMN:         plmn,
		Profile:      extractProfileName(open5gsDoc),
		Policy:       planID,
		PolicyName:   planName,
		PolicyStatus: planStatus,
		Traffic:      traffic,
		SMS:          sms,
		LastActive:   computeLastActive(open5gsDoc, ocsSubDoc, balanceDoc),
	}
}

// isLowTraffic checks if a row qualifies as low traffic.
func isLowTraffic(row SubscriberRow) bool {
	return row.Traffic.Balance < lowTrafficThreshold
}

// matchesStatusFilter checks if a row matches the given status filter.
func matchesStatusFilter(row SubscriberRow, filter string) bool {
	switch filter {
	case "active":
		return row.Status == "Active"
	case "restricted":
		return row.Status == "Suspended" || row.Status == "Partial Restricted"
	case "lowTraffic":
		return isLowTraffic(row)
	default:
		return true
	}
}

// buildSummary computes aggregate summary from all rows (before filtering).
func buildSummary(rows []SubscriberSummary, allRows []SubscriberRow) SubscriberSummary {
	s := SubscriberSummary{}
	for _, row := range allRows {
		s.Total++
		if row.Status == "Active" {
			s.Active++
		}
		if row.Status == "Suspended" || row.Status == "Partial Restricted" {
			s.Restricted++
		}
		if isLowTraffic(row) {
			s.LowTraffic++
		}
	}
	return s
}

// --- List IMSIs (detail=false) ---

// ListSubscriberImsis returns a paginated list of IMSI strings.
func (r *Repository) ListSubscriberImsis(ctx context.Context, page, limit int, query, sortDirection string) (SubscriberListResult[string], error) {
	filter, valid := subscriberFilter(query)
	page = safePage(page)
	limit = safeLimit(limit)

	if !valid {
		return SubscriberListResult[string]{
			Subscribers: []string{},
			Total:       0,
			Page:        page,
			Limit:       limit,
		}, nil
	}

	sortDir := 1
	if sortDirection == "desc" {
		sortDir = -1
	}

	total, err := r.subscribers.CountDocuments(ctx, filter)
	if err != nil {
		return SubscriberListResult[string]{}, fmt.Errorf("count subscribers: %w", err)
	}

	skip := int64((page - 1) * limit)
	opts := options.Find().
		SetProjection(bson.M{"imsi": 1}).
		SetSort(bson.M{"imsi": sortDir}).
		SetSkip(skip).
		SetLimit(int64(limit))

	cursor, err := r.subscribers.Find(ctx, filter, opts)
	if err != nil {
		return SubscriberListResult[string]{}, fmt.Errorf("find subscribers: %w", err)
	}
	defer cursor.Close(ctx)

	var imsis []string
	for cursor.Next(ctx) {
		var doc struct {
			IMSI string `bson:"imsi"`
		}
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		imsis = append(imsis, doc.IMSI)
	}
	if imsis == nil {
		imsis = []string{}
	}

	return SubscriberListResult[string]{
		Subscribers: imsis,
		Total:       int(total),
		Page:        page,
		Limit:       limit,
	}, nil
}

// --- List Rows (detail=true) ---

// ListSubscriberRows returns enriched subscriber rows with OCS data.
func (r *Repository) ListSubscriberRows(ctx context.Context, page, limit int, query, statusFilter, sortField, sortDirection string) (SubscriberListResult[SubscriberRow], error) {
	filter, valid := subscriberFilter(query)
	page = safePage(page)
	limit = safeLimit(limit)

	if !valid {
		return SubscriberListResult[SubscriberRow]{
			Subscribers: []SubscriberRow{},
			Total:       0,
			Page:        page,
			Limit:       limit,
			Summary:     &SubscriberSummary{},
		}, nil
	}

	// Fetch all matching subscribers (sorted by IMSI)
	cursor, err := r.subscribers.Find(ctx, filter, options.Find().SetSort(bson.M{"imsi": 1}))
	if err != nil {
		return SubscriberListResult[SubscriberRow]{}, fmt.Errorf("find subscribers: %w", err)
	}
	defer cursor.Close(ctx)

	var open5gsDocs []bson.M
	if err := cursor.All(ctx, &open5gsDocs); err != nil {
		return SubscriberListResult[SubscriberRow]{}, fmt.Errorf("decode subscribers: %w", err)
	}

	if len(open5gsDocs) == 0 {
		return SubscriberListResult[SubscriberRow]{
			Subscribers: []SubscriberRow{},
			Total:       0,
			Page:        page,
			Limit:       limit,
			Summary:     &SubscriberSummary{},
		}, nil
	}

	// Collect IMSIs for OCS lookup
	imsis := make([]string, len(open5gsDocs))
	for i, doc := range open5gsDocs {
		imsis[i], _ = doc["imsi"].(string)
	}

	// Fetch OCS data in parallel
	ocsSubMap, balanceMap, tariffPlanMap, err := r.fetchOcsProvisioning(ctx, imsis)
	if err != nil {
		return SubscriberListResult[SubscriberRow]{}, fmt.Errorf("fetch ocs provisioning: %w", err)
	}

	// Build rows
	rows := make([]SubscriberRow, len(open5gsDocs))
	for i, doc := range open5gsDocs {
		imsi := imsis[i]
		rows[i] = toSubscriberRow(
			doc,
			ocsSubMap[imsi],
			balanceMap[imsi],
			tariffPlanMap[getPlanID(ocsSubMap[imsi])],
		)
	}

	// Compute summary before filtering
	summary := buildSummary(nil, rows)

	// Apply status filter
	filtered := make([]SubscriberRow, 0, len(rows))
	for _, row := range rows {
		if matchesStatusFilter(row, statusFilter) {
			filtered = append(filtered, row)
		}
	}

	// Sort
	sortSubscriberRows(filtered, sortField, sortDirection)

	// Paginate
	total := len(filtered)
	start := (page - 1) * limit
	end := start + limit
	if start > total {
		start = total
	}
	if end > total {
		end = total
	}
	paged := filtered[start:end]
	if paged == nil {
		paged = []SubscriberRow{}
	}

	return SubscriberListResult[SubscriberRow]{
		Subscribers: paged,
		Total:       total,
		Page:        page,
		Limit:       limit,
		Summary:     &summary,
	}, nil
}

// getPlanID extracts plan_id from an OCS subscriber doc, defaulting to plan_default_10gb.
func getPlanID(ocsSub bson.M) string {
	if ocsSub == nil {
		return defaultPlanID
	}
	if pid, ok := ocsSub["plan_id"].(string); ok && pid != "" {
		return pid
	}
	return defaultPlanID
}

// fetchOcsProvisioning fetches OCS subscribers, balances, and tariff plans for a set of IMSIs.
func (r *Repository) fetchOcsProvisioning(ctx context.Context, imsis []string) (
	ocsSubMap map[string]bson.M,
	balanceMap map[string]bson.M,
	tariffPlanMap map[string]bson.M,
	err error,
) {
	ocsSubMap = make(map[string]bson.M)
	balanceMap = make(map[string]bson.M)
	tariffPlanMap = make(map[string]bson.M)

	// Fetch OCS subscribers
	ocsCursor, err := r.ocsSubs.Find(ctx, bson.M{"imsi": bson.M{"$in": imsis}})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("find ocs subscribers: %w", err)
	}
	defer ocsCursor.Close(ctx)

	var ocsSubs []bson.M
	if err := ocsCursor.All(ctx, &ocsSubs); err != nil {
		return nil, nil, nil, fmt.Errorf("decode ocs subscribers: %w", err)
	}
	for _, doc := range ocsSubs {
		if imsi, ok := doc["imsi"].(string); ok {
			ocsSubMap[imsi] = doc
		}
	}

	// Fetch balances
	balCursor, err := r.ocsBalances.Find(ctx, bson.M{"imsi": bson.M{"$in": imsis}})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("find ocs balances: %w", err)
	}
	defer balCursor.Close(ctx)

	var balances []bson.M
	if err := balCursor.All(ctx, &balances); err != nil {
		return nil, nil, nil, fmt.Errorf("decode ocs balances: %w", err)
	}
	for _, doc := range balances {
		if imsi, ok := doc["imsi"].(string); ok {
			balanceMap[imsi] = doc
		}
	}

	// Collect plan IDs
	planIDSet := make(map[string]struct{})
	for _, ocsSub := range ocsSubs {
		pid, _ := ocsSub["plan_id"].(string)
		if pid == "" {
			pid = defaultPlanID
		}
		planIDSet[pid] = struct{}{}
	}
	// Always include default plan
	planIDSet[defaultPlanID] = struct{}{}

	planIDs := make([]string, 0, len(planIDSet))
	for pid := range planIDSet {
		planIDs = append(planIDs, pid)
	}

	// Fetch tariff plans
	planCursor, err := r.tariffPlans.Find(ctx, bson.M{"plan_id": bson.M{"$in": planIDs}})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("find tariff plans: %w", err)
	}
	defer planCursor.Close(ctx)

	var plans []bson.M
	if err := planCursor.All(ctx, &plans); err != nil {
		return nil, nil, nil, fmt.Errorf("decode tariff plans: %w", err)
	}
	for _, doc := range plans {
		if pid, ok := doc["plan_id"].(string); ok {
			tariffPlanMap[pid] = doc
		}
	}

	return ocsSubMap, balanceMap, tariffPlanMap, nil
}

// sortSubscriberRows sorts rows in-place by the given field and direction.
func sortSubscriberRows(rows []SubscriberRow, sortField, sortDirection string) {
	validFields := map[string]bool{
		"imsi": true, "status": true, "plmn": true,
		"policy": true, "usage": true, "lastActive": true,
	}
	if !validFields[sortField] {
		sortField = "imsi"
	}
	desc := sortDirection == "desc"

	sort.SliceStable(rows, func(i, j int) bool {
		var cmp int
		switch sortField {
		case "usage":
			cmp = int(rows[i].Traffic.Used - rows[j].Traffic.Used)
		case "lastActive":
			cmp = strings.Compare(rows[i].LastActive, rows[j].LastActive)
		case "plmn":
			cmp = strings.Compare(rows[i].PLMN, rows[j].PLMN)
		case "policy":
			cmp = strings.Compare(rows[i].PolicyName, rows[j].PolicyName)
		case "status":
			cmp = strings.Compare(rows[i].Status, rows[j].Status)
		default:
			cmp = strings.Compare(rows[i].IMSI, rows[j].IMSI)
		}
		if cmp == 0 {
			cmp = strings.Compare(rows[i].IMSI, rows[j].IMSI)
		}
		if desc {
			return cmp > 0
		}
		return cmp < 0
	})
}

// --- MSISDN Lookup ---

// FindSubscriberByMsisdn looks up a subscriber by MSISDN in both open5gs.subscribers and open5gs.ocs_subscribers.
func (r *Repository) FindSubscriberByMsisdn(ctx context.Context, msisdn, excludeImsi string) (*MsisdnLookupResult, error) {
	normalized := strings.TrimSpace(msisdn)
	if normalized == "" {
		return &MsisdnLookupResult{Exists: false, IMSI: nil, Source: nil}, nil
	}
	// Validate digits only
	for _, c := range normalized {
		if c < '0' || c > '9' {
			return &MsisdnLookupResult{Exists: false, IMSI: nil, Source: nil}, nil
		}
	}

	// Query both collections in parallel
	type lookupResult struct {
		imsi   string
		source string
	}

	ch := make(chan lookupResult, 2)

	// Check open5gs.subscribers
	go func() {
		var doc struct {
			IMSI string `bson:"imsi"`
		}
		err := r.subscribers.FindOne(ctx, bson.M{"msisdn": normalized}, options.FindOne().SetProjection(bson.M{"imsi": 1})).Decode(&doc)
		if err == nil && doc.IMSI != "" {
			ch <- lookupResult{imsi: doc.IMSI, source: "open5gs"}
		} else {
			ch <- lookupResult{}
		}
	}()

	// Check open5gs.ocs_subscribers
	go func() {
		var doc struct {
			IMSI string `bson:"imsi"`
		}
		err := r.ocsSubs.FindOne(ctx, bson.M{"msisdn": normalized}, options.FindOne().SetProjection(bson.M{"imsi": 1})).Decode(&doc)
		if err == nil && doc.IMSI != "" {
			ch <- lookupResult{imsi: doc.IMSI, source: "ocs"}
		} else {
			ch <- lookupResult{}
		}
	}()

	r1 := <-ch
	r2 := <-ch

	// Prefer open5gs source
	var match *lookupResult
	if r1.imsi != "" {
		match = &r1
	} else if r2.imsi != "" {
		match = &r2
	}

	if match == nil {
		return &MsisdnLookupResult{Exists: false, IMSI: nil, Source: nil}, nil
	}

	// Apply exclude filter
	if excludeImsi != "" && match.imsi == excludeImsi {
		return &MsisdnLookupResult{Exists: false, IMSI: nil, Source: nil}, nil
	}

	return &MsisdnLookupResult{
		Exists: true,
		IMSI:   &match.imsi,
		Source: &match.source,
	}, nil
}

// --- Subscriber Detail ---

// FindSubscriberLegacyState returns the full legacy state for a subscriber.
func (r *Repository) FindSubscriberLegacyState(ctx context.Context, imsi string) (*LegacySubscriberState, error) {
	// Fetch subscriber document
	var doc bson.M
	err := r.subscribers.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find subscriber: %w", err)
	}

	// Map to legacy state (matching open5gsToLegacyState)
	state := open5gsToLegacyState(doc)

	// Fetch OCS provisioning
	ocsSub, balance, tariffPlan, err := r.fetchSingleOcsProvisioning(ctx, imsi)
	if err != nil {
		return nil, fmt.Errorf("fetch ocs provisioning: %w", err)
	}

	// Build ocsTraffic
	var ocsTraffic map[string]any
	if balance != nil {
		ocsTraffic = map[string]any{
			"traffic_total":   numericInt64(balance["data_total"]),
			"traffic_balance": numericInt64(balance["data_available"]),
			"data_used":       numericInt64(balance["data_used"]),
			"data_reserved":   numericInt64(balance["data_reserved"]),
			"voice_total":     numericInt64Default(balance["voice_total"], 3600),
			"voice_balance":   numericInt64Default(balance["voice_available"], 3600),
			"voice_used":      numericInt64(balance["voice_used"]),
			"voice_reserved":  numericInt64(balance["voice_reserved"]),
			"sms_total":       numericInt64Default(balance["sms_total"], 100),
			"sms_balance":     numericInt64Default(balance["sms_available"], 100),
			"sms_used":        numericInt64(balance["sms_used"]),
			"imsi":            imsi,
			"plmn":            imsi[:5],
		}
	}

	// Build ocsImsi
	var ocsImsi map[string]any
	if ocsSub != nil {
		ocsImsi = map[string]any{
			"account_id": imsi,
			"imsi":       imsi,
			"msisdn":     ocsSub["msisdn"],
			"status":     ocsSub["status"],
			"plan_id":    ocsSub["plan_id"],
		}
	}

	state.OcsTraffic = ocsTraffic
	state.OcsImsi = ocsImsi
	if tariffPlan != nil {
		state.OcsTariffPlan = tariffPlan
	}

	return state, nil
}

// fetchSingleOcsProvisioning fetches OCS data for a single IMSI.
func (r *Repository) fetchSingleOcsProvisioning(ctx context.Context, imsi string) (
	ocsSub bson.M, balance bson.M, tariffPlan bson.M, err error,
) {
	// Fetch OCS subscriber
	err = r.ocsSubs.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&ocsSub)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, nil, nil, fmt.Errorf("find ocs subscriber: %w", err)
	}
	if err == mongo.ErrNoDocuments {
		ocsSub = nil
	}

	// Fetch balance
	err = r.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&balance)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, nil, nil, fmt.Errorf("find ocs balance: %w", err)
	}
	if err == mongo.ErrNoDocuments {
		balance = nil
	}

	// Determine plan ID
	planID := defaultPlanID
	if ocsSub != nil {
		if pid, ok := ocsSub["plan_id"].(string); ok && pid != "" {
			planID = pid
		}
	}

	// Fetch tariff plan
	err = r.tariffPlans.FindOne(ctx, bson.M{"plan_id": planID}).Decode(&tariffPlan)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, nil, nil, fmt.Errorf("find tariff plan: %w", err)
	}
	if err == mongo.ErrNoDocuments {
		tariffPlan = nil
	}

	return ocsSub, balance, tariffPlan, nil
}

// open5gsToLegacyState maps an Open5GS subscriber document to legacy state format.
// This matches the Node open5gsToLegacyState function exactly.
func open5gsToLegacyState(doc bson.M) *LegacySubscriberState {
	if doc == nil {
		return nil
	}

	// Build sub4G
	sub4G := map[string]any{
		"access_restriction_data": doc["access_restriction_data"],
		"network_access_mode":     doc["network_access_mode"],
	}

	// Extract msisdnList from doc
	if msisdn, ok := doc["msisdn"]; ok {
		sub4G["msisdnList"] = msisdn
	}
	if ambr, ok := doc["ambr"]; ok {
		sub4G["ambr"] = ambr
	}
	if sliceList, ok := doc["slice_list"]; ok {
		sub4G["sliceList"] = sliceList
	}
	if allowedPlmns, ok := doc["allowed_visited_plmns"]; ok {
		sub4G["allowedVisitedPlmns"] = allowedPlmns
	}

	// Build pcrf4G
	pcrf4G := map[string]any{
		"name":                    doc["imsi"],
		"access_restriction_data": doc["access_restriction_data"],
		"subscriber_status":       doc["subscriber_status"],
	}
	if subStatus, ok := doc["subscriber_status"]; ok {
		pcrf4G["subscriber_status"] = subStatus
	}

	// Build auth4G
	auth4G := map[string]any{
		"sqn": doc["sequence_number"],
	}
	// K and OPc are sensitive — expose only if present in the raw doc.
	// The Node version reads from the document directly.
	if k, ok := doc["security_key"]; ok {
		auth4G["k"] = k
	}
	if opc, ok := doc["opc"]; ok {
		auth4G["opc"] = opc
	}
	if amf, ok := doc["authentication_management_field"]; ok {
		auth4G["amf"] = amf
	}

	return &LegacySubscriberState{
		Sub4G:  sub4G,
		Pcrf4G: pcrf4G,
		Auth4G: auth4G,
	}
}

// numericInt64Default converts a value to int64, returning defaultVal if zero/nil.
func numericInt64Default(v any, defaultVal int64) int64 {
	val := numericInt64(v)
	if val == 0 {
		return defaultVal
	}
	return val
}

// --- Batch Precheck ---

// PrecheckSubscriberRange checks for conflicts in an IMSI range.
func (r *Repository) PrecheckSubscriberRange(ctx context.Context, startImsi string, count int) (*BatchPrecheckResult, error) {
	imsis := generateImsiRange(startImsi, count)
	if err := ensureImsiRange(imsis); err != nil {
		return nil, err
	}

	// Find existing IMSIs in range
	cursor, err := r.subscribers.Find(ctx, bson.M{"imsi": bson.M{"$in": imsis}}, options.Find().SetProjection(bson.M{"imsi": 1}))
	if err != nil {
		return nil, fmt.Errorf("find existing imsis: %w", err)
	}
	defer cursor.Close(ctx)

	existingSet := make(map[string]struct{})
	for cursor.Next(ctx) {
		var doc struct {
			IMSI string `bson:"imsi"`
		}
		if err := cursor.Decode(&doc); err == nil {
			existingSet[doc.IMSI] = struct{}{}
		}
	}

	conflictImsis := make([]string, 0)
	for _, imsi := range imsis {
		if _, exists := existingSet[imsi]; exists {
			conflictImsis = append(conflictImsis, imsi)
		}
	}

	return &BatchPrecheckResult{
		ConflictCount: len(conflictImsis),
		ConflictImsis: conflictImsis,
		TotalCount:    count,
	}, nil
}

// --- IMSI Range Generation ---

// generateImsiRange generates a range of IMSIs starting from startImsi.
func generateImsiRange(startImsi string, count int) []string {
	start := new(big.Int)
	start.SetString(startImsi, 10)

	result := make([]string, count)
	for i := 0; i < count; i++ {
		imsi := new(big.Int).Add(start, big.NewInt(int64(i)))
		result[i] = fmt.Sprintf("%015s", imsi.String())
	}
	return result
}

// ensureImsiRange validates all IMSIs in the range are exactly 15 digits.
func ensureImsiRange(imsis []string) error {
	for _, imsi := range imsis {
		if len(imsi) != 15 {
			return fmt.Errorf("IMSI_RANGE_OVERFLOW")
		}
		for _, c := range imsi {
			if c < '0' || c > '9' {
				return fmt.Errorf("IMSI_RANGE_OVERFLOW")
			}
		}
	}
	return nil
}

// --- Search ---

// SearchSubscribers finds matching subscriber IMSIs by prefix.
func (r *Repository) SearchSubscribers(ctx context.Context, query string, limit int) []SearchResult {
	// Only digits-only queries match subscribers
	for _, c := range query {
		if c < '0' || c > '9' {
			return nil
		}
	}
	if limit <= 0 {
		return nil
	}

	cursor, err := r.subscribers.Find(ctx, bson.M{"imsi": bson.M{"$regex": "^" + query}}, options.Find().
		SetProjection(bson.M{"imsi": 1}).
		SetLimit(int64(limit)))
	if err != nil {
		return nil
	}
	defer cursor.Close(ctx)

	var results []SearchResult
	for cursor.Next(ctx) {
		var doc struct {
			IMSI string `bson:"imsi"`
		}
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		results = append(results, SearchResult{
			ID:    "imsi-" + doc.IMSI,
			Label: doc.IMSI,
			Desc:  "Open subscriber",
			Type:  "imsi",
			Path:  "/subscribers",
		})
	}
	return results
}

// SearchProfiles finds matching profiles by name/title.
func (r *Repository) SearchProfiles(ctx context.Context, query string, limit int) []SearchResult {
	if limit <= 0 {
		return nil
	}
	needle := strings.ToLower(query)

	cursor, err := r.profiles.Find(ctx, bson.M{})
	if err != nil {
		return nil
	}
	defer cursor.Close(ctx)

	var results []SearchResult
	for cursor.Next(ctx) {
		var doc profileDoc
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		name := strings.ToLower(doc.Name)
		title := strings.ToLower(doc.Title)
		if !strings.Contains(name, needle) && !strings.Contains(title, needle) {
			continue
		}

		desc := doc.Title
		if doc.Title == doc.Name {
			desc = "Open profile template"
		}

		results = append(results, SearchResult{
			ID:    "profile-" + doc.Name,
			Label: doc.Name,
			Desc:  desc,
			Type:  "profile",
			Path:  "/profile",
		})

		if len(results) >= limit {
			break
		}
	}
	return results
}

// validateImsi validates an IMSI string (exactly 15 digits).
func validateImsi(value, field string) (string, error) {
	if value == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	if len(value) != 15 {
		return "", fmt.Errorf("%s must be exactly 15 digits", field)
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return "", fmt.Errorf("%s must be exactly 15 digits", field)
		}
	}
	return value, nil
}

// validateBatchCount validates a batch count value.
func validateBatchCount(value int) (int, error) {
	if value < 1 || value > 1000 {
		return 0, fmt.Errorf("Count must be an integer between 1 and 1000")
	}
	return value, nil
}

// BigInt converts a bson.Decimal128 to big.Int (significand only, matching Node BigInt()).
// Used for Decimal128 fields that store integer values.
func decimal128ToBigInt(v bson.Decimal128) *big.Int {
	bi, _, err := v.BigInt()
	if err != nil {
		return big.NewInt(0)
	}
	return bi
}
