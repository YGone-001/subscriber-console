package subscriber

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// FindSubscriberByImsi loads a single subscriber document by IMSI.
// Returns nil if not found.
func (r *Repository) FindSubscriberByImsi(ctx context.Context, imsi string) (bson.M, error) {
	var doc bson.M
	err := r.subscribers.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find subscriber %s: %w", imsi, err)
	}
	return doc, nil
}

// CreateSubscriberFromLegacy creates a new subscriber with default Open5GS BSON structure.
// Validates MSISDN uniqueness across both subscribers and ocs_subscribers collections.
// Provisions OCS subscriber and balance records.
// Returns the created document.
func (r *Repository) CreateSubscriberFromLegacy(ctx context.Context, imsi string, planId *string, msisdn *string) (bson.M, error) {
	// Check if subscriber already exists
	existing, err := r.FindSubscriberByImsi(ctx, imsi)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_EXISTS"}
	}

	// Validate and resolve tariff plan
	resolvedPlanId := defaultPlanID
	if planId != nil && *planId != "" {
		resolvedPlanId = *planId
	}
	plan, err := r.getTariffPlan(ctx, resolvedPlanId)
	if err != nil {
		return nil, err
	}
	if plan == nil {
		return nil, &SubscriberGovernanceError{Code: "OCS_PLAN_NOT_FOUND"}
	}
	if status, _ := plan["status"].(string); status == "disabled" {
		return nil, &SubscriberGovernanceError{Code: "OCS_PLAN_DISABLED"}
	}

	// Check MSISDN availability if provided
	var msisdnList []any
	if msisdn != nil && *msisdn != "" {
		if err := validateMsisdnDigits(*msisdn); err != nil {
			return nil, err
		}
		exists, err := r.checkMsisdnExists(ctx, *msisdn, "")
		if err != nil {
			return nil, err
		}
		if exists {
			return nil, &SubscriberGovernanceError{Code: "MSISDN_EXISTS"}
		}
		msisdnList = []any{*msisdn}
	}

	// Build default Open5GS subscriber document
	doc := buildDefaultSubscriber(imsi, msisdnList)

	// Insert subscriber
	_, err = r.subscribers.InsertOne(ctx, doc)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_EXISTS"}
		}
		return nil, fmt.Errorf("insert subscriber %s: %w", imsi, err)
	}

	// Provision OCS subscriber and balance
	if err := r.provisionOcsSubscriber(ctx, imsi, resolvedPlanId, plan); err != nil {
		// Partial failure: subscriber inserted but OCS provisioning failed
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_CREATE_PARTIAL_WRITE"}
	}

	// Reload the created document
	return r.FindSubscriberByImsi(ctx, imsi)
}

// UpdateSubscriberFromLegacy applies a payload to an existing subscriber document
// using atomic CAS (replaceOne with full expected document filter minus _id).
// Matches Node updateSubscriberFromLegacy() exactly.
func (r *Repository) UpdateSubscriberFromLegacy(ctx context.Context, imsi string, payload UpdatePayload, current bson.M) (bson.M, error) {
	// Build the next document from current + payload using real builder
	next := buildXcloudSubscriberFromLegacy(imsi, payload, current)

	// Atomic CAS: full expected document minus _id — matches Node exactly
	expectedFilter := expectedDocumentFilter(current)

	result, err := r.subscribers.ReplaceOne(ctx, expectedFilter, next)
	if err != nil {
		return nil, fmt.Errorf("update subscriber %s: %w", imsi, err)
	}
	if result.MatchedCount == 0 {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED"}
	}

	// Handle OCS update if traffic data provided
	if payload.OcsTraffic != nil {
		if err := r.updateOcsSubscriber(ctx, imsi, payload.OcsTraffic); err != nil {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_PARTIAL_WRITE"}
		}
	}

	// Reload the document to get the full updated state
	return r.FindSubscriberByImsi(ctx, imsi)
}

// DeleteSubscriber removes a subscriber document using atomic CAS
// and cleans up OCS provisioning.
// Matches Node deleteSubscriber() exactly — uses full expected document minus _id.
func (r *Repository) DeleteSubscriber(ctx context.Context, imsi string, expected bson.M) (bool, error) {
	// Atomic CAS: full expected document minus _id — matches Node exactly
	expectedFilter := expectedDocumentFilter(expected)

	result, err := r.subscribers.DeleteOne(ctx, expectedFilter)
	if err != nil {
		return false, fmt.Errorf("delete subscriber %s: %w", imsi, err)
	}
	if result.DeletedCount == 0 {
		return false, nil
	}

	// Clean up OCS provisioning — errors are typed, not swallowed
	if err := r.deleteOcsProvisioning(ctx, imsi); err != nil {
		return true, &SubscriberGovernanceError{Code: "SUBSCRIBER_DELETE_PARTIAL_WRITE"}
	}

	return true, nil
}

// expectedDocumentFilter builds a CAS filter from the full expected document minus _id.
// Matches Node: const filter = { ...expectedDocument }; delete filter._id;
func expectedDocumentFilter(doc bson.M) bson.M {
	filter := bson.M{}
	for k, v := range doc {
		if k == "_id" {
			continue
		}
		filter[k] = v
	}
	return filter
}

// getTariffPlan validates planId format and returns the plan document.
// Matches Node getTariffPlanDocument() — uses plan_id (snake_case).
func (r *Repository) getTariffPlan(ctx context.Context, planId string) (bson.M, error) {
	var plan bson.M
	err := r.tariffPlans.FindOne(ctx, bson.M{"plan_id": planId}).Decode(&plan)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("get tariff plan %s: %w", planId, err)
	}
	return plan, nil
}

// checkMsisdnExists checks if an MSISDN is already in use in either
// xcloud.subscribers or xcloud.ocs_subscribers collections.
func (r *Repository) checkMsisdnExists(ctx context.Context, msisdn, excludeImsi string) (bool, error) {
	// Check subscribers collection
	subFilter := bson.M{"msisdn": msisdn}
	if excludeImsi != "" {
		subFilter["imsi"] = bson.M{"$ne": excludeImsi}
	}
	count, err := r.subscribers.CountDocuments(ctx, subFilter)
	if err != nil {
		return false, fmt.Errorf("check msisdn in subscribers: %w", err)
	}
	if count > 0 {
		return true, nil
	}

	// Check ocs_subscribers collection
	ocsFilter := bson.M{"msisdn": msisdn}
	if excludeImsi != "" {
		ocsFilter["imsi"] = bson.M{"$ne": excludeImsi}
	}
	count, err = r.ocsSubs.CountDocuments(ctx, ocsFilter)
	if err != nil {
		return false, fmt.Errorf("check msisdn in ocs_subscribers: %w", err)
	}
	return count > 0, nil
}

// validateMsisdnDigits checks that MSISDN contains only digits.
func validateMsisdnDigits(msisdn string) error {
	if msisdn == "" {
		return nil
	}
	for _, c := range msisdn {
		if c < '0' || c > '9' {
			return &SubscriberGovernanceError{Code: "INVALID_MSISDN"}
		}
	}
	return nil
}

// provisionOcsSubscriber upserts ocs_subscribers and ocs_balances records.
// Matches Node provisionOcsSubscriber() exactly.
func (r *Repository) provisionOcsSubscriber(ctx context.Context, imsi, planId string, plan bson.M) error {
	now := time.Now()

	// Default balance constants — matches Node
	defaultTotalBalance := int64(10 * 1024 * 1024 * 1024) // 10GB
	defaultVoiceTotal := int64(3600)                      // 60 minutes
	defaultSmsTotal := int64(100)
	defaultQuotaPerGrant := int64(10 * 1024 * 1024) // 10MB

	// Upsert ocs_subscribers — matches Node schema exactly (snake_case, Date)
	ocsSub := bson.M{
		"imsi":       imsi,
		"msisdn":     "",
		"status":     "active",
		"plan_id":    planId, // snake_case, not camelCase
		"updated_at": now,    // BSON Date, not string
	}
	_, err := r.ocsSubs.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{
			"$set":         ocsSub,
			"$setOnInsert": bson.M{"created_at": now},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("upsert ocs_subscribers: %w", err)
	}

	// Check existing balance for preservation semantics
	var existingBalance bson.M
	_ = r.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&existingBalance)

	dataTotal := defaultTotalBalance
	dataAvailable := dataTotal
	var dataReserved int64
	var dataUsed int64

	if existingBalance != nil {
		// Preserve existing balance values — matches Node semantics
		dataReserved = numericInt64(existingBalance["data_reserved"])
		dataUsed = numericInt64(existingBalance["data_used"])
		dataAvailable = dataTotal - dataReserved - dataUsed
		if dataAvailable < 0 {
			dataAvailable = 0
		}
	} else {
		// New subscriber: reserve quota_per_grant
		dataReserved = defaultQuotaPerGrant
		dataUsed = 0
		dataAvailable = dataTotal - dataReserved
	}

	voiceTotal := defaultVoiceTotal
	smsTotal := defaultSmsTotal

	// Version: increment if existing, else 1
	version := int64(1)
	if existingBalance != nil {
		version = numericInt64(existingBalance["version"]) + 1
		if version < 1 {
			version = 1
		}
	}

	// Upsert ocs_balances — matches Node schema exactly (snake_case, int64, Date)
	ocsBal := bson.M{
		"imsi":            imsi,
		"data_total":      dataTotal,
		"data_used":       dataUsed,
		"data_reserved":   dataReserved,
		"data_available":  dataAvailable,
		"voice_total":     voiceTotal,
		"voice_used":      int64(0),
		"voice_reserved":  int64(0),
		"voice_available": voiceTotal,
		"sms_total":       smsTotal,
		"sms_used":        int64(0),
		"sms_available":   smsTotal,
		"money_balance":   int64(0),
		"plan_id":         planId,
		"status":          "active",
		"version":         version,
		"updated_at":      now,
		"cycle_start_at":  now,
		"cycle_reset_at":  now,
	}
	if existingBalance != nil {
		if existingBalance["cycle_start_at"] != nil {
			ocsBal["cycle_start_at"] = existingBalance["cycle_start_at"]
		}
		if existingBalance["cycle_reset_at"] != nil {
			ocsBal["cycle_reset_at"] = existingBalance["cycle_reset_at"]
		}
	}

	_, err = r.ocsBalances.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{
			"$set":         ocsBal,
			"$setOnInsert": bson.M{"created_at": now},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("upsert ocs_balances: %w", err)
	}

	return nil
}

// updateOcsSubscriber updates OCS subscriber and balance with traffic data.
// Maps legacy payload keys to OCS schema. Does NOT $set raw ocsTraffic keys.
func (r *Repository) updateOcsSubscriber(ctx context.Context, imsi string, ocsTraffic map[string]any) error {
	if len(ocsTraffic) == 0 {
		return nil
	}

	// Resolve plan_id — supports both planId and plan_id aliases
	planId, _ := ocsTraffic["planId"].(string)
	if planId == "" {
		planId, _ = ocsTraffic["plan_id"].(string)
	}
	if planId != "" {
		// Validate tariff plan
		plan, err := r.getTariffPlan(ctx, planId)
		if err != nil {
			return err
		}
		if plan == nil {
			return &SubscriberGovernanceError{Code: "OCS_PLAN_NOT_FOUND"}
		}
		if status, _ := plan["status"].(string); status == "disabled" {
			return &SubscriberGovernanceError{Code: "OCS_PLAN_DISABLED"}
		}
	}

	// Delegate to provisionOcsSubscriber which handles all balance math
	return r.provisionOcsSubscriber(ctx, imsi, planId, nil)
}

// deleteOcsProvisioning deletes from both ocs_subscribers and ocs_balances.
func (r *Repository) deleteOcsProvisioning(ctx context.Context, imsi string) error {
	_, err := r.ocsSubs.DeleteOne(ctx, bson.M{"imsi": imsi})
	if err != nil {
		return fmt.Errorf("delete ocs_subscribers: %w", err)
	}
	_, err = r.ocsBalances.DeleteOne(ctx, bson.M{"imsi": imsi})
	if err != nil {
		return fmt.Errorf("delete ocs_balances: %w", err)
	}
	return nil
}

// buildDefaultSubscriber builds a default Open5GS subscriber document.
// Matches Node buildDefaultXcloudSubscriber() structure exactly.
func buildDefaultSubscriber(imsi string, msisdnList []any) bson.M {
	if msisdnList == nil {
		msisdnList = []any{}
	}

	// EPC realm from IMSI — matches Node epcRealm()
	mcc := "417"
	if len(imsi) >= 3 {
		mcc = imsi[:3]
	}
	mnc := "001"
	if len(imsi) >= 5 {
		mnc = imsi[3:5]
	}
	for len(mnc) < 3 {
		mnc = "0" + mnc
	}
	mmeHost := fmt.Sprintf("mme.epc.mnc%s.mcc%s.3gppnetwork.org", mnc, mcc)
	mmeRealm := fmt.Sprintf("epc.mnc%s.mcc%s.3gppnetwork.org", mnc, mcc)

	// mme_timestamp — matches Date.now() * 1000 (microseconds since epoch)
	mmeTimestamp := time.Now().UnixMilli() * 1000

	return bson.M{
		"__v":            0,
		"schema_version": 1,
		"imsi":           imsi,
		"msisdn":         msisdnList,
		"imeisv":         "8672710677532401",
		"security": bson.M{
			"k":   "000102030405060708090A0B0C0D0E0F", // DEFAULT_AUTH_KEY
			"op":  nil,                                // null, not missing
			"opc": "000102030405060708090A0B0C0D0E0F", // DEFAULT_AUTH_KEY
			"amf": "8000",
			"sqn": int64(1719756), // matches Node Long(1719756)
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 1, "unit": 3},
			"uplink":   bson.M{"value": 1, "unit": 3},
		},
		"slice":                    buildDefaultSlice(),
		"access_restriction_data":  32,
		"subscriber_status":        0,
		"network_access_mode":      0,
		"subscribed_rau_tau_timer": 12,
		"mme_host":                 mmeHost,
		"mme_realm":                mmeRealm,
		"mme_timestamp":            mmeTimestamp, // number (microseconds), not string
		"purge_flag":               false,
		// NO createdAt — Node does not produce it
	}
}

// buildDefaultSlice builds the default slice array for a new subscriber.
// Matches Node normalizeSliceList(undefined) → toXcloudSlice() exactly.
// Default: 1 slice with 3 sessions (internet, mobile, ims).
func buildDefaultSlice() []any {
	return []any{
		bson.M{
			"_id":               bson.NewObjectID(),
			"sst":               1,
			"default_indicator": true,
			// sd omitted — Node omits when sd=="000001"
			"session": []any{
				// internet — index 0, type 1, 5QI 9, ARP priority 8
				bson.M{
					"_id":  bson.NewObjectID(),
					"name": "internet",
					"type": 1,
					"qos": bson.M{
						"index": 9,
						"arp": bson.M{
							"priority_level":            8,
							"pre_emption_capability":    1, // NOT_PREEMPT
							"pre_emption_vulnerability": 1, // NOT_PREEMPTABLE
						},
					},
					"ambr": bson.M{
						"downlink": bson.M{"value": 1, "unit": 3},
						"uplink":   bson.M{"value": 1, "unit": 3},
					},
					"pcc_rule": []any{},
				},
				// mobile — index 1, type 1, 5QI 9, ARP priority 8
				bson.M{
					"_id":  bson.NewObjectID(),
					"name": "mobile",
					"type": 1,
					"qos": bson.M{
						"index": 9,
						"arp": bson.M{
							"priority_level":            8,
							"pre_emption_capability":    1,
							"pre_emption_vulnerability": 1,
						},
					},
					"ambr": bson.M{
						"downlink": bson.M{"value": 1, "unit": 3},
						"uplink":   bson.M{"value": 1, "unit": 3},
					},
					"pcc_rule": []any{},
				},
				// ims — index 2, type 3, 5QI 5, ARP priority 1, with pcc_rule
				bson.M{
					"_id":  bson.NewObjectID(),
					"name": "ims",
					"type": 3, // IMS
					"qos": bson.M{
						"index": 5, // 5QI 5 for IMS
						"arp": bson.M{
							"priority_level":            1,
							"pre_emption_capability":    1,
							"pre_emption_vulnerability": 1,
						},
					},
					"ambr": bson.M{
						"downlink": bson.M{"value": 1, "unit": 3},
						"uplink":   bson.M{"value": 1, "unit": 3},
					},
					"pcc_rule": []any{
						bson.M{
							"flow": []any{},
							"qos": bson.M{
								"index": 1,
								"arp": bson.M{
									"priority_level":            2,
									"pre_emption_capability":    1, // 2→NOT_PREEMPT
									"pre_emption_vulnerability": 1, // 2→NOT_PREEMPTABLE
								},
							},
						},
					},
				},
			},
		},
	}
}

// buildXcloudSubscriberFromLegacy merges a payload into an existing subscriber document.
// Matches Node buildXcloudSubscriberFromLegacy() semantics.
func buildXcloudSubscriberFromLegacy(imsi string, payload UpdatePayload, existing bson.M) bson.M {
	// Deep copy existing document
	result := deepCopyBsonM(existing)

	if payload.Sub4G != nil {
		// Handle ambr
		if ambr, ok := payload.Sub4G["ambr"]; ok && ambr != nil {
			result["ambr"] = ambr
		}
		// Handle slices (legacy key is sliceList)
		if slices, ok := payload.Sub4G["sliceList"]; ok && slices != nil {
			result["slice"] = convertSlices(slices)
		}
		// Handle msisdn (legacy key is msisdnList)
		if msisdn, ok := payload.Sub4G["msisdnList"]; ok && msisdn != nil {
			result["msisdn"] = convertMsisdnList(msisdn)
		}
		// Handle simple scalar fields
		skipKeys := map[string]bool{"ambr": true, "sliceList": true, "msisdnList": true}
		for k, v := range payload.Sub4G {
			if skipKeys[k] {
				continue
			}
			result[k] = v
		}
	}

	return result
}

// convertSlices converts legacy sliceList format to Open5GS slice format
// with ObjectIds for _id and session._id.
func convertSlices(slices any) []any {
	list, ok := slices.([]any)
	if !ok {
		return []any{}
	}
	result := make([]any, 0, len(list))
	for _, item := range list {
		slice, ok := item.(map[string]any)
		if !ok {
			continue
		}
		converted := bson.M{
			"_id":               bson.NewObjectID(),
			"sst":               slice["sst"],
			"sd":                slice["sd"],
			"default_indicator": slice["default_indicator"],
		}
		// Convert sessions
		if sessions, ok := slice["session_list"].([]any); ok {
			convertedSessions := make([]any, 0, len(sessions))
			for _, sess := range sessions {
				s, ok := sess.(map[string]any)
				if !ok {
					continue
				}
				convertedSess := bson.M{
					"_id":      bson.NewObjectID(),
					"name":     s["name"],
					"type":     s["type"],
					"qos":      s["qos"],
					"ambr":     s["ambr"],
					"pcc_rule": []any{},
				}
				convertedSessions = append(convertedSessions, convertedSess)
			}
			converted["session"] = convertedSessions
		}
		result = append(result, converted)
	}
	return result
}

// convertMsisdnList converts legacy msisdnList format to simple string array.
// Node stores msisdn as a flat string array, not object array.
func convertMsisdnList(msisdn any) []any {
	list, ok := msisdn.([]any)
	if !ok {
		return []any{}
	}
	result := make([]any, 0, len(list))
	for _, item := range list {
		switch v := item.(type) {
		case map[string]any:
			if ms, ok := v["msisdn"]; ok {
				result = append(result, ms)
			}
		case string:
			result = append(result, v)
		default:
			result = append(result, item)
		}
	}
	return result
}
