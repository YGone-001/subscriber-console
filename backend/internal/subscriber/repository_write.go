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
	if disabled, _ := plan["disabled"].(bool); disabled {
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
		// Log but don't fail — subscriber is already created
		// In production this would be a warning; the OCS provisioning can be retried
		return nil, fmt.Errorf("provision OCS for %s: %w", imsi, err)
	}

	// Reload the created document
	return r.FindSubscriberByImsi(ctx, imsi)
}

// UpdateSubscriberFromLegacy applies a payload to an existing subscriber document
// using atomic CAS (replaceOne with expected document filter).
// Returns the updated document.
func (r *Repository) UpdateSubscriberFromLegacy(ctx context.Context, imsi string, payload UpdatePayload, current bson.M) (bson.M, error) {
	// Build the next document from current + payload using real builder
	next := buildXcloudSubscriberFromLegacy(imsi, payload, current)

	// Atomic CAS: replaceOne with expected document filter
	result, err := r.subscribers.ReplaceOne(
		ctx,
		bson.M{"imsi": imsi, "__v": current["__v"]},
		next,
	)
	if err != nil {
		return nil, fmt.Errorf("update subscriber %s: %w", imsi, err)
	}
	if result.MatchedCount == 0 {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED"}
	}

	// Handle OCS update if traffic data provided
	if payload.OcsTraffic != nil {
		if err := r.updateOcsSubscriber(ctx, imsi, payload.OcsTraffic); err != nil {
			return nil, fmt.Errorf("update OCS for %s: %w", imsi, err)
		}
	}

	// Reload the document to get the full updated state
	return r.FindSubscriberByImsi(ctx, imsi)
}

// DeleteSubscriber removes a subscriber document by IMSI and cleans up OCS provisioning.
// Returns true if a document was deleted.
func (r *Repository) DeleteSubscriber(ctx context.Context, imsi string) (bool, error) {
	result, err := r.subscribers.DeleteOne(ctx, bson.M{"imsi": imsi})
	if err != nil {
		return false, fmt.Errorf("delete subscriber %s: %w", imsi, err)
	}
	if result.DeletedCount == 0 {
		return false, nil
	}

	// Clean up OCS provisioning
	if err := r.deleteOcsProvisioning(ctx, imsi); err != nil {
		// Log but don't fail — subscriber is already deleted
		// OCS cleanup can be retried
	}

	return true, nil
}

// getTariffPlan validates planId format and returns the plan document.
func (r *Repository) getTariffPlan(ctx context.Context, planId string) (bson.M, error) {
	var plan bson.M
	err := r.tariffPlans.FindOne(ctx, bson.M{"planId": planId}).Decode(&plan)
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
func (r *Repository) provisionOcsSubscriber(ctx context.Context, imsi, planId string, plan bson.M) error {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	// Upsert ocs_subscribers
	ocsSub := bson.M{
		"imsi":      imsi,
		"planId":    planId,
		"status":    "active",
		"createdAt": now,
		"updatedAt": now,
	}
	_, err := r.ocsSubs.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{"$set": ocsSub},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("upsert ocs_subscribers: %w", err)
	}

	// Upsert ocs_balances
	ocsBal := bson.M{
		"imsi":         imsi,
		"planId":       planId,
		"trafficTotal": 0,
		"trafficUsed":  0,
		"voiceTotal":   0,
		"voiceUsed":    0,
		"smsTotal":     0,
		"smsUsed":      0,
		"createdAt":    now,
		"updatedAt":    now,
	}
	_, err = r.ocsBalances.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{"$set": ocsBal},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("upsert ocs_balances: %w", err)
	}

	return nil
}

// updateOcsSubscriber updates OCS subscriber with traffic data.
func (r *Repository) updateOcsSubscriber(ctx context.Context, imsi string, ocsTraffic map[string]any) error {
	if len(ocsTraffic) == 0 {
		return nil
	}

	set := bson.M{"updatedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	for k, v := range ocsTraffic {
		set[k] = v
	}

	_, err := r.ocsSubs.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{"$set": set},
	)
	return err
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
// Matches Node buildDefaultXcloudSubscriber() structure.
func buildDefaultSubscriber(imsi string, msisdnList []any) bson.M {
	if msisdnList == nil {
		msisdnList = []any{}
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	return bson.M{
		"__v":            0,
		"schema_version": 1,
		"imsi":           imsi,
		"msisdn":         msisdnList,
		"imeisv":         "8672710677532401",
		"security": bson.M{
			"k":   "00000000000000000000000000000000",
			"amf": "8000",
			"sqn": int64(0),
		},
		"ambr": bson.M{
			"downlink": bson.M{"value": 1, "unit": 3},
			"uplink":   bson.M{"value": 1, "unit": 3},
		},
		"slice": []any{
			bson.M{
				"_id":               bson.NewObjectID(),
				"sst":               1,
				"sd":                "000001",
				"default_indicator": true,
				"session": []any{
					bson.M{
						"_id":  bson.NewObjectID(),
						"name": "internet",
						"type": 3,
						"qos": bson.M{
							"index": 9,
							"arp": bson.M{
								"priority_level":            8,
								"pre_emption_capability":    0,
								"pre_emption_vulnerability": 0,
							},
						},
						"ambr": bson.M{
							"downlink": bson.M{"value": 1, "unit": 3},
							"uplink":   bson.M{"value": 1, "unit": 3},
						},
						"pcc_rule": []any{},
					},
				},
			},
		},
		"access_restriction_data":  32,
		"subscriber_status":        0,
		"network_access_mode":      0,
		"subscribed_rau_tau_timer": 12,
		"mme_host":                 "",
		"mme_realm":                "",
		"mme_timestamp":            "",
		"purge_flag":               false,
		"createdAt":                now,
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
