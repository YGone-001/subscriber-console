package subscriber

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Subscriber-list documents.
//
// The list reads one row per subscriber, so the projected fields are decoded
// into fixed structs instead of one bson.M per document. At the 10k collection
// size the maps, their key strings and their buckets dominated the read's
// allocation while carrying no schema guarantee. Every field stays deliberately
// loose (any, or RawValue where missing and null must stay distinguishable):
// this package does not own the xCloud schema, so an unexpected value type must
// degrade to the same "absent" projection the map reader produced instead of
// failing the whole list.

type listSubscriberDoc struct {
	ID          bson.RawValue `bson:"_id"`
	IMSI        any           `bson:"imsi"`
	MSISDN      any           `bson:"msisdn"`
	MSISDNList  any           `bson:"msisdnList"`
	ARD         bson.RawValue `bson:"access_restriction_data"`
	WebuiMeta   bson.RawValue `bson:"webui_meta"`
	ProfileName any           `bson:"profile_name"`
	Profile     any           `bson:"profile"`
	UpdatedAt   bson.RawValue `bson:"updated_at"`
	CreatedAt   bson.RawValue `bson:"created_at"`
}

type listContractDoc struct {
	IMSI      any           `bson:"imsi"`
	Status    any           `bson:"status"`
	PlanID    any           `bson:"plan_id"`
	MSISDN    any           `bson:"msisdn"`
	UpdatedAt bson.RawValue `bson:"updated_at"`
	CreatedAt bson.RawValue `bson:"created_at"`
}

type listBalanceDoc struct {
	IMSI          any           `bson:"imsi"`
	DataTotal     any           `bson:"data_total"`
	DataUsed      any           `bson:"data_used"`
	DataAvailable any           `bson:"data_available"`
	SMSTotal      any           `bson:"sms_total"`
	SMSUsed       any           `bson:"sms_used"`
	SMSAvailable  any           `bson:"sms_available"`
	UpdatedAt     bson.RawValue `bson:"updated_at"`
}

type listPlanDoc struct {
	PlanID          any `bson:"plan_id"`
	Name            any `bson:"name"`
	Status          any `bson:"status"`
	VolumeThreshold any `bson:"volume_threshold"`
}

type listOcsProvisioning struct {
	contracts map[string]*listContractDoc
	balances  map[string]*listBalanceDoc
	plans     map[string]*listPlanDoc
}

// subscriberListProjection must stay in lockstep with listSubscriberDoc.
func subscriberListProjection() bson.M {
	return bson.M{
		"imsi":                    1,
		"msisdn":                  1,
		"msisdnList":              1,
		"access_restriction_data": 1,
		"webui_meta":              1,
		"profile_name":            1,
		"profile":                 1,
		"updated_at":              1,
		"created_at":              1,
	}
}

func (r *Repository) fetchSubscriberListDocs(ctx context.Context, filter bson.M) ([]listSubscriberDoc, error) {
	cursor, err := r.subscribers.Find(ctx, filter, options.Find().
		SetProjection(subscriberListProjection()).
		SetSort(bson.M{"imsi": 1}))
	if err != nil {
		return nil, fmt.Errorf("find subscribers: %w", err)
	}
	docs, err := decodeListCursor[listSubscriberDoc](ctx, cursor, 0)
	if err != nil {
		return nil, fmt.Errorf("decode subscribers: %w", err)
	}
	return docs, nil
}

// decodeListCursor decodes a whole cursor into a slice with a known upper bound.
// The driver's cursor.All grows its result through reflection, which reallocates
// the full slice repeatedly at the 10k document scale.
func decodeListCursor[T any](ctx context.Context, cursor *mongo.Cursor, capacity int) ([]T, error) {
	defer cursor.Close(ctx)
	if capacity < 0 {
		capacity = 0
	}
	docs := make([]T, 0, capacity)
	for cursor.Next(ctx) {
		var doc T
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		docs = append(docs, doc)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return docs, nil
}

// fetchSubscriberListOcs loads the bounded OCS fields the rows and filters
// read. Contracts, balances and plans are three batched $in queries; nothing
// here is issued per subscriber.
func (r *Repository) fetchSubscriberListOcs(ctx context.Context, imsis []string) (*listOcsProvisioning, error) {
	result := &listOcsProvisioning{
		contracts: make(map[string]*listContractDoc, len(imsis)),
		balances:  make(map[string]*listBalanceDoc, len(imsis)),
		plans:     make(map[string]*listPlanDoc),
	}

	contractCursor, err := r.ocsSubs.Find(ctx, bson.M{"imsi": bson.M{"$in": imsis}}, options.Find().SetProjection(bson.M{
		"imsi": 1, "status": 1, "plan_id": 1, "msisdn": 1, "updated_at": 1, "created_at": 1,
	}))
	if err != nil {
		return nil, fmt.Errorf("find ocs subscribers: %w", err)
	}
	contractDocs, err := decodeListCursor[listContractDoc](ctx, contractCursor, len(imsis))
	if err != nil {
		return nil, fmt.Errorf("decode ocs subscribers: %w", err)
	}
	for index := range contractDocs {
		if imsi, ok := contractDocs[index].IMSI.(string); ok {
			result.contracts[imsi] = &contractDocs[index]
		}
	}

	balanceCursor, err := r.ocsBalances.Find(ctx, bson.M{"imsi": bson.M{"$in": imsis}}, options.Find().SetProjection(bson.M{
		"imsi": 1, "data_total": 1, "data_used": 1, "data_available": 1,
		"sms_total": 1, "sms_used": 1, "sms_available": 1, "updated_at": 1,
	}))
	if err != nil {
		return nil, fmt.Errorf("find ocs balances: %w", err)
	}
	balanceDocs, err := decodeListCursor[listBalanceDoc](ctx, balanceCursor, len(imsis))
	if err != nil {
		return nil, fmt.Errorf("decode ocs balances: %w", err)
	}
	for index := range balanceDocs {
		if imsi, ok := balanceDocs[index].IMSI.(string); ok {
			result.balances[imsi] = &balanceDocs[index]
		}
	}

	planIDs := make(map[string]struct{})
	for index := range contractDocs {
		planIDs[listContractPlanID(&contractDocs[index])] = struct{}{}
	}
	planIDs[defaultPlanID] = struct{}{}
	ids := make([]string, 0, len(planIDs))
	for planID := range planIDs {
		ids = append(ids, planID)
	}

	planCursor, err := r.tariffPlans.Find(ctx, bson.M{"plan_id": bson.M{"$in": ids}}, options.Find().SetProjection(bson.M{
		"plan_id": 1, "name": 1, "status": 1, "volume_threshold": 1,
	}))
	if err != nil {
		return nil, fmt.Errorf("find tariff plans: %w", err)
	}
	planDocs, err := decodeListCursor[listPlanDoc](ctx, planCursor, len(ids))
	if err != nil {
		return nil, fmt.Errorf("decode tariff plans: %w", err)
	}
	for index := range planDocs {
		if planID, ok := planDocs[index].PlanID.(string); ok {
			result.plans[planID] = &planDocs[index]
		}
	}

	return result, nil
}

// listContractPlanID resolves the plan a contract references. A contract
// without a stored plan id is read through the default plan, matching the
// projection used before the list was typed.
func listContractPlanID(contract *listContractDoc) string {
	if contract == nil {
		return defaultPlanID
	}
	if planID, ok := contract.PlanID.(string); ok && planID != "" {
		return planID
	}
	return defaultPlanID
}

// toSubscriberRow converts one subscriber and its OCS records into a row. It is
// the single row authority for the list: every field is derived here, and the
// access status, balance state, binding and provisioning rules are shared with
// the filters through the same helpers.
func toSubscriberRow(
	subscriber listSubscriberDoc,
	contract *listContractDoc,
	balance *listBalanceDoc,
	plan *listPlanDoc,
) SubscriberRow {
	imsi, _ := subscriber.IMSI.(string)
	ard := listARD(subscriber.ARD)
	plmn := imsi
	if len(plmn) > 5 {
		plmn = plmn[:5]
	}

	var planID, planName, planStatus string
	if contract != nil {
		planID, _ = contract.PlanID.(string)
	}
	if plan != nil {
		planName, _ = plan.Name.(string)
		planStatus, _ = plan.Status.(string)
	}
	if planName == "" {
		planName = planID
	}

	var traffic TrafficSnapshot
	var sms SMSSnapshot
	if balance != nil {
		traffic = normalizeTraffic(balance.DataTotal, balance.DataUsed, balance.DataAvailable)
		sms = normalizeSMS(balance.SMSTotal, balance.SMSUsed, balance.SMSAvailable)
	}

	var balanceThreshold int64
	if contract != nil && plan != nil {
		balanceThreshold = numericInt64(plan.VolumeThreshold)
	}

	return SubscriberRow{
		IMSI:             imsi,
		MSISDN:           listMSISDN(subscriber, contract),
		Status:           statusFromARD(ard),
		ContractStatus:   listContractStatus(contract),
		BalanceState:     classifyBalance(balance != nil, traffic.Balance, balanceThreshold),
		BalanceThreshold: balanceThreshold,
		ARD:              ard,
		PLMN:             plmn,
		Profile:          listProfileName(subscriber),
		Policy:           planID,
		PolicyName:       planName,
		PolicyStatus:     planStatus,
		Provisioning: SubscriberProvisioning{
			Contract:   contract != nil,
			Balance:    balance != nil,
			TariffPlan: contract != nil && plan != nil,
		},
		Traffic:    traffic,
		SMS:        sms,
		LastActive: listLastActive(subscriber, contract, balance),
	}
}

// listARD distinguishes an absent access_restriction_data (the legacy 32
// default) from an explicit null, which projects as 0 like any other
// non-numeric value. The raw accessors are read directly so the row does not
// build a decoder per subscriber.
func listARD(raw bson.RawValue) int {
	if raw.IsZero() {
		return 32
	}
	switch raw.Type {
	case bson.TypeInt32:
		value, ok := raw.Int32OK()
		if !ok {
			return 0
		}
		return int(value)
	case bson.TypeInt64:
		value, ok := raw.Int64OK()
		if !ok {
			return 0
		}
		return int(value)
	case bson.TypeDouble:
		value, ok := raw.DoubleOK()
		if !ok {
			return 0
		}
		return int(value)
	case bson.TypeDecimal128:
		value, ok := raw.Decimal128OK()
		if !ok {
			return 0
		}
		return int(numericInt64(value))
	default:
		return 0
	}
}

func listContractStatus(contract *listContractDoc) string {
	if contract == nil {
		return ""
	}
	status, _ := contract.Status.(string)
	return status
}

// listMSISDN mirrors the legacy precedence: the xCloud list field, then the
// scalar field, then the contract.
func listMSISDN(subscriber listSubscriberDoc, contract *listContractDoc) string {
	if value, ok := firstMSISDNValue(subscriber.MSISDNList); ok {
		return value
	}
	if value, ok := firstMSISDNValue(subscriber.MSISDN); ok {
		return value
	}
	if contract != nil {
		if value, ok := contract.MSISDN.(string); ok {
			return value
		}
	}
	return ""
}

func listProfileName(subscriber listSubscriberDoc) string {
	return profileNameFromBindingValues(
		listWebuiMetaString(subscriber.WebuiMeta, "profile_name"),
		listWebuiMetaString(subscriber.WebuiMeta, "profile"),
		listStringValue(subscriber.ProfileName),
		listStringValue(subscriber.Profile),
	)
}

// listLastActive reports the newest stored activity evidence. Precedence is
// irrelevant because the value is a maximum, but the candidate set is the
// contract: contract, template metadata and subscriber timestamps, then the
// balance account, then the document identifier's own creation instant.
func listLastActive(subscriber listSubscriberDoc, contract *listContractDoc, balance *listBalanceDoc) string {
	var latest time.Time
	found := false
	if contract != nil {
		latest, found = listNewerTimestamp(latest, found, contract.UpdatedAt)
	}
	latest, found = listNewerTimestamp(latest, found, listWebuiMetaValue(subscriber.WebuiMeta, "updated_at"))
	latest, found = listNewerTimestamp(latest, found, subscriber.UpdatedAt)
	if contract != nil {
		latest, found = listNewerTimestamp(latest, found, contract.CreatedAt)
	}
	latest, found = listNewerTimestamp(latest, found, listWebuiMetaValue(subscriber.WebuiMeta, "created_at"))
	latest, found = listNewerTimestamp(latest, found, subscriber.CreatedAt)
	if balance != nil {
		latest, found = listNewerTimestamp(latest, found, balance.UpdatedAt)
	}
	if id, ok := subscriber.ID.ObjectIDOK(); ok {
		if candidate := id.Timestamp(); !candidate.IsZero() && (!found || candidate.After(latest)) {
			latest, found = candidate, true
		}
	}
	if !found {
		return ""
	}
	return latest.UTC().Format("2006-01-02T15:04:05.000Z")
}

func listNewerTimestamp(latest time.Time, found bool, raw bson.RawValue) (time.Time, bool) {
	candidate, ok := listTimestamp(raw)
	if !ok || (found && !candidate.After(latest)) {
		return latest, found
	}
	return candidate, true
}

// listTimestamp reads a stored timestamp. xCloud records these both as BSON
// dates and as RFC 3339 strings, and this driver decodes a date into int64
// milliseconds, so only the raw value can tell a date from an unrelated number.
// Anything else is not activity evidence and stays absent rather than becoming
// an epoch-zero timestamp.
func listTimestamp(raw bson.RawValue) (time.Time, bool) {
	if raw.IsZero() {
		return time.Time{}, false
	}
	if value, ok := raw.TimeOK(); ok && !value.IsZero() {
		return value, true
	}
	if text, ok := raw.StringValueOK(); ok {
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil || parsed.IsZero() {
			return time.Time{}, false
		}
		return parsed, true
	}
	return time.Time{}, false
}

func listStringValue(value any) string {
	text, _ := value.(string)
	return text
}

// listWebuiMetaValue reads one webui_meta field straight off the raw document.
// The metadata block is decoded here rather than into a map so that its own
// timestamps keep their BSON type.
func listWebuiMetaValue(meta bson.RawValue, key string) bson.RawValue {
	document, ok := meta.DocumentOK()
	if !ok {
		return bson.RawValue{}
	}
	return document.Lookup(key)
}

func listWebuiMetaString(meta bson.RawValue, key string) string {
	text, ok := listWebuiMetaValue(meta, key).StringValueOK()
	if !ok {
		return ""
	}
	return text
}
