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
	input := OcsProvisioningInput{
		IMSI:   imsi,
		PlanID: &resolvedPlanId,
	}
	if msisdn != nil && *msisdn != "" {
		input.MSISDN = msisdn
	}
	if err := r.provisionOcsSubscriber(ctx, input); err != nil {
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

// OcsProvisioningInput carries presence-aware OCS balance fields.
// nil = absent (preserve existing); pointer = explicit value.
type OcsProvisioningInput struct {
	IMSI string

	PlanID *string
	MSISDN *string
	Status *string

	DataTotal     *int64
	DataAvailable *int64

	VoiceTotal     *int64
	VoiceAvailable *int64

	SMSTotal     *int64
	SMSAvailable *int64
}

// Default OCS balance constants — matches Node exactly.
const (
	defaultTotalBalance  int64 = 10 * 1024 * 1024 * 1024 // 10GB
	defaultVoiceTotal    int64 = 3600                    // 60 minutes
	defaultSmsTotal      int64 = 100
	defaultQuotaPerGrant int64 = 10 * 1024 * 1024 // 10MB
)

// provisionOcsSubscriber upserts ocs_subscribers and ocs_balances records.
// Matches Node provisionOcsSubscriber() exactly — presence-aware semantics.
func (r *Repository) provisionOcsSubscriber(ctx context.Context, input OcsProvisioningInput) error {
	now := time.Now()
	planId := defaultPlanID
	if input.PlanID != nil && *input.PlanID != "" {
		planId = *input.PlanID
	}

	// Upsert ocs_subscribers — matches Node schema exactly (snake_case, Date)
	ocsSub := bson.M{
		"status":     "active",
		"plan_id":    planId,
		"updated_at": now,
	}
	if input.MSISDN != nil {
		ocsSub["msisdn"] = *input.MSISDN
	} else {
		ocsSub["msisdn"] = ""
	}
	_, err := r.ocsSubs.UpdateOne(
		ctx,
		bson.M{"imsi": input.IMSI},
		bson.M{
			"$set":         ocsSub,
			"$setOnInsert": bson.M{"created_at": now, "imsi": input.IMSI},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("upsert ocs_subscribers: %w", err)
	}

	// Load existing balance for preservation semantics
	var existingBalance bson.M
	_ = r.ocsBalances.FindOne(ctx, bson.M{"imsi": input.IMSI}).Decode(&existingBalance)

	// ── Data balance ──
	// Matches Node: dataTotal = toNumber(input.total, DEFAULT_TOTAL_BALANCE)
	dataTotal := defaultTotalBalance
	if input.DataTotal != nil {
		dataTotal = *input.DataTotal
	}
	if dataTotal < 0 {
		dataTotal = 0
	}

	hasAvailableInput := input.DataAvailable != nil
	requestedAvailable := dataTotal
	if input.DataAvailable != nil {
		requestedAvailable = *input.DataAvailable
	}
	dataAvailable := min64(max64(0, requestedAvailable), dataTotal)

	// Matches Node: derivedReserved = dataAvailable < dataTotal ? min(QUOTA_PER_GRANT, dataTotal - dataAvailable) : 0
	derivedReserved := int64(0)
	if dataAvailable < dataTotal {
		derivedReserved = min64(defaultQuotaPerGrant, dataTotal-dataAvailable)
	}

	// Matches Node: dataReserved = hasAvailableInput ? derivedReserved : existingBalance ? existing.data_reserved : (dataAvailable < dataTotal ? derivedReserved : 0)
	var dataReserved int64
	if hasAvailableInput {
		dataReserved = derivedReserved
	} else if existingBalance != nil {
		dataReserved = numericInt64(existingBalance["data_reserved"])
	} else if dataAvailable < dataTotal {
		dataReserved = derivedReserved
	}

	// Matches Node: dataUsed = hasAvailableInput ? max(0, dataTotal - dataReserved - dataAvailable) : existingBalance ? existing.data_used : max(0, dataTotal - dataReserved - dataAvailable)
	var dataUsed int64
	if hasAvailableInput {
		dataUsed = max64(0, dataTotal-dataReserved-dataAvailable)
	} else if existingBalance != nil {
		dataUsed = numericInt64(existingBalance["data_used"])
	} else {
		dataUsed = max64(0, dataTotal-dataReserved-dataAvailable)
	}

	// Matches Node: nextTotal = max(dataTotal, dataUsed + dataReserved + dataAvailable)
	nextTotal := max64(dataTotal, dataUsed+dataReserved+dataAvailable)

	// ── Voice balance ──
	voiceTotalInput := defaultVoiceTotal
	if input.VoiceTotal != nil {
		voiceTotalInput = *input.VoiceTotal
	} else if existingBalance != nil {
		voiceTotalInput = numericInt64(existingBalance["voice_total"])
	}
	voiceTotal := max64(voiceTotalInput, 0)

	hasVoiceAvailableInput := input.VoiceAvailable != nil
	requestedVoiceAvailable := voiceTotal
	if input.VoiceAvailable != nil {
		requestedVoiceAvailable = *input.VoiceAvailable
	} else if existingBalance != nil {
		requestedVoiceAvailable = numericInt64(existingBalance["voice_available"])
	}
	voiceAvailable := min64(max64(0, requestedVoiceAvailable), voiceTotal)

	var voiceReserved int64
	if hasVoiceAvailableInput {
		voiceReserved = 0
	} else if existingBalance != nil {
		voiceReserved = numericInt64(existingBalance["voice_reserved"])
	}

	var voiceUsed int64
	if hasVoiceAvailableInput {
		voiceUsed = max64(0, voiceTotal-voiceReserved-voiceAvailable)
	} else if existingBalance != nil {
		voiceUsed = numericInt64(existingBalance["voice_used"])
	} else {
		voiceUsed = max64(0, voiceTotal-voiceReserved-voiceAvailable)
	}
	nextVoiceTotal := max64(voiceTotal, voiceUsed+voiceReserved+voiceAvailable)

	// ── SMS balance ──
	smsTotalInput := defaultSmsTotal
	if input.SMSTotal != nil {
		smsTotalInput = *input.SMSTotal
	} else if existingBalance != nil {
		smsTotalInput = numericInt64(existingBalance["sms_total"])
	}
	smsTotal := max64(smsTotalInput, 0)

	hasSmsAvailableInput := input.SMSAvailable != nil
	requestedSmsAvailable := smsTotal
	if input.SMSAvailable != nil {
		requestedSmsAvailable = *input.SMSAvailable
	} else if existingBalance != nil {
		requestedSmsAvailable = numericInt64(existingBalance["sms_available"])
	}
	smsAvailable := min64(max64(0, requestedSmsAvailable), smsTotal)

	var smsUsed int64
	if hasSmsAvailableInput {
		smsUsed = max64(0, smsTotal-smsAvailable)
	} else if existingBalance != nil {
		smsUsed = numericInt64(existingBalance["sms_used"])
	} else {
		smsUsed = max64(0, smsTotal-smsAvailable)
	}
	nextSmsTotal := max64(smsTotal, smsUsed+smsAvailable)

	// ── Version ──
	// Matches Node: version = existingBalance ? existing.version + 1 : 1
	version := int64(1)
	if existingBalance != nil {
		v := numericInt64(existingBalance["version"]) + 1
		if v < 1 {
			v = 1
		}
		version = v
	}

	// ── Upsert ocs_balances ──
	ocsBal := bson.M{
		"imsi":            input.IMSI,
		"data_total":      nextTotal,
		"data_used":       dataUsed,
		"data_reserved":   dataReserved,
		"data_available":  dataAvailable,
		"voice_total":     nextVoiceTotal,
		"voice_used":      voiceUsed,
		"voice_reserved":  voiceReserved,
		"voice_available": voiceAvailable,
		"sms_total":       nextSmsTotal,
		"sms_used":        smsUsed,
		"sms_available":   smsAvailable,
		"money_balance":   int64(0),
		"plan_id":         planId,
		"status":          "active",
		"version":         version,
		"updated_at":      now,
	}
	if existingBalance != nil {
		ocsBal["cycle_start_at"] = existingBalance["cycle_start_at"]
		ocsBal["cycle_reset_at"] = existingBalance["cycle_reset_at"]
	} else {
		ocsBal["cycle_start_at"] = now
		ocsBal["cycle_reset_at"] = now
	}

	_, err = r.ocsBalances.UpdateOne(
		ctx,
		bson.M{"imsi": input.IMSI},
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

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// updateOcsSubscriber updates OCS subscriber and balance with traffic data.
// Maps all ocsTraffic fields to presence-aware provisioning input.
// Matches Node updateSubscriberFromLegacy() → provisionOcsSubscriber() mapping.
func (r *Repository) updateOcsSubscriber(ctx context.Context, imsi string, ocsTraffic map[string]any) error {
	if len(ocsTraffic) == 0 {
		return nil
	}

	input := OcsProvisioningInput{IMSI: imsi}

	// Resolve plan_id — supports both planId and plan_id aliases
	if pid, ok := ocsTraffic["planId"].(string); ok && pid != "" {
		input.PlanID = &pid
	} else if pid, ok := ocsTraffic["plan_id"].(string); ok && pid != "" {
		input.PlanID = &pid
	}

	// Validate tariff plan if provided
	if input.PlanID != nil {
		plan, err := r.getTariffPlan(ctx, *input.PlanID)
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

	// Map all presence-aware traffic fields
	if v, ok := ocsTraffic["traffic_total"]; ok && v != nil {
		n := numericInt64(v)
		input.DataTotal = &n
	}
	if v, ok := ocsTraffic["traffic_balance"]; ok && v != nil {
		n := numericInt64(v)
		input.DataAvailable = &n
	}
	if v, ok := ocsTraffic["voice_total"]; ok && v != nil {
		n := numericInt64(v)
		input.VoiceTotal = &n
	}
	if v, ok := ocsTraffic["voice_balance"]; ok && v != nil {
		n := numericInt64(v)
		input.VoiceAvailable = &n
	}
	if v, ok := ocsTraffic["sms_total"]; ok && v != nil {
		n := numericInt64(v)
		input.SMSTotal = &n
	}
	if v, ok := ocsTraffic["sms_balance"]; ok && v != nil {
		n := numericInt64(v)
		input.SMSAvailable = &n
	}

	return r.provisionOcsSubscriber(ctx, input)
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
			"opc": "00000000000000000000000000000000", // ZERO_128 (not DEFAULT_AUTH_KEY)
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
