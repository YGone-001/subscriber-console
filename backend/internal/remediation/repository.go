package remediation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	defaultOcsPlanID     = "plan_default_10gb"
	defaultTotalBalance  int64 = 10737418240 // 10 * 1024 * 1024 * 1024 (10GB)
	defaultQuotaPerGrant int64 = 10485760    // 10 * 1024 * 1024 (10MB)
	defaultVoiceTotal    int64 = 3600        // 60 minutes
	defaultSmsTotal      int64 = 100
)

// Repository manages controlled remediation operations in MongoDB.
type Repository struct {
	subscribers     *mongo.Collection // xcloud.subscribers
	ocsSubs         *mongo.Collection // xcloud.ocs_subscribers
	ocsBalances     *mongo.Collection // xcloud.ocs_balances
	ocsPlans        *mongo.Collection // xcloud.ocs_tariff_plans
	ocsReservations *mongo.Collection // xcloud.ocs_reservations
	profiles        *mongo.Collection // xcloud_ops.app_profiles
}

// NewRepository creates a new remediation repository.
func NewRepository(xcloudDb, appDb *mongo.Database) *Repository {
	return &Repository{
		subscribers:     xcloudDb.Collection("subscribers"),
		ocsSubs:         xcloudDb.Collection("ocs_subscribers"),
		ocsBalances:     xcloudDb.Collection("ocs_balances"),
		ocsPlans:        xcloudDb.Collection("ocs_tariff_plans"),
		ocsReservations: xcloudDb.Collection("ocs_reservations"),
		profiles:        appDb.Collection("app_profiles"),
	}
}

// HealSubscriberDocument applies targeted remediation for a single subscriber.
// Matches Node healSubscriberDocument() in src/server/repositories/systemAuditRepository.ts exactly.
func (r *Repository) HealSubscriberDocument(ctx context.Context, imsi string, anomalyType string, profileName *string) error {
	var existingSub bson.M
	existingErr := r.subscribers.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&existingSub)
	existing := (existingErr == nil)

	var profile bson.M
	if profileName != nil && *profileName != "" {
		p, err := r.findProfile(ctx, *profileName)
		if err != nil {
			return fmt.Errorf("find profile %s: %w", *profileName, err)
		}
		profile = p
	}

	now := time.Now()

	// Branch 1: orphan_ocs OR missing subscriber
	if anomalyType == "orphan_ocs" || !existing {
		doc := buildDefaultXcloudSubscriber(imsi, profile)
		_, err := r.subscribers.UpdateOne(
			ctx,
			bson.M{"imsi": imsi},
			bson.M{"$setOnInsert": doc},
			options.UpdateOne().SetUpsert(true),
		)
		if err != nil {
			return fmt.Errorf("upsert default subscriber: %w", err)
		}
	}

	// Branch 2: missing_config OR balance_mismatch
	if anomalyType == "missing_config" || anomalyType == "balance_mismatch" {
		total := defaultTotalBalance
		available := total
		smsTotal := defaultSmsTotal
		smsAvailable := smsTotal
		planID := defaultOcsPlanID

		if profile != nil {
			ocsDefs := extractMap(profile, "ocsDefaults")
			if ocsDefs != nil {
				if t := extractInt64(ocsDefs, "trafficTotal", "traffic_total"); t != nil {
					total = *t
					available = total
				}
				if a := extractInt64(ocsDefs, "trafficBalance", "traffic_balance"); a != nil {
					available = *a
				}
				if st := extractInt64(ocsDefs, "smsTotal", "sms_total"); st != nil {
					smsTotal = *st
					smsAvailable = smsTotal
				}
				if sa := extractInt64(ocsDefs, "smsBalance", "sms_balance"); sa != nil {
					smsAvailable = *sa
				}
				if p := extractString(ocsDefs, "planId", "plan_id"); p != nil && *p != "" {
					planID = *p
				}
			}
		}

		err := r.provisionOcsSubscriber(ctx, imsi, planID, total, available, smsTotal, smsAvailable)
		if err != nil {
			return fmt.Errorf("provision ocs subscriber: %w", err)
		}
	}

	// Branch 3: invalid_tariff
	if anomalyType == "invalid_tariff" {
		_, err := r.ocsSubs.UpdateOne(
			ctx,
			bson.M{"imsi": imsi},
			bson.M{"$set": bson.M{"plan_id": defaultOcsPlanID, "updated_at": now}},
		)
		if err != nil {
			return fmt.Errorf("update invalid tariff: %w", err)
		}
	}

	// Branch 4: dangling_profile
	if anomalyType == "dangling_profile" {
		fallbackProfile := "default"
		if profileName != nil && *profileName != "" {
			fallbackProfile = *profileName
		}
		_, err := r.subscribers.UpdateOne(
			ctx,
			bson.M{"imsi": imsi},
			bson.M{
				"$set": bson.M{
					"webui_meta.profile_name": fallbackProfile,
					"profile_name":            fallbackProfile,
					"profile":                 fallbackProfile,
					"updated_at":              now,
				},
			},
		)
		if err != nil {
			return fmt.Errorf("update dangling profile: %w", err)
		}
	}

	// Branch 5: orphan_reservation
	if anomalyType == "orphan_reservation" {
		_, err := r.ocsReservations.UpdateMany(
			ctx,
			bson.M{"imsi": imsi},
			bson.M{
				"$set": bson.M{
					"state":       "released",
					"released_at": now,
				},
			},
		)
		if err != nil {
			return fmt.Errorf("release orphan reservations: %w", err)
		}
	}

	return nil
}

// BatchHealSubscriberDocuments applies remediation sequentially for a batch of anomalies.
// Matches Node batchHealSubscriberDocuments() in src/server/repositories/systemAuditRepository.ts exactly.
func (r *Repository) BatchHealSubscriberDocuments(
	ctx context.Context,
	anomalies []any,
	profileName *string,
) (*BatchHealResponse, error) {
	successCount := 0
	failedCount := 0
	errorsList := []string{}

	for _, item := range anomalies {
		// In Node: if item is null, evaluating `${item.imsi}` throws TypeError inside the catch block,
		// escaping the batch loop and causing the route to return HTTP 500.
		if item == nil {
			return nil, errors.New("TypeError: Cannot read properties of null (reading 'imsi')")
		}

		m, isMap := item.(map[string]any)
		if !isMap {
			// Primitive elements (string, number, bool): in JS, .imsi evaluates to undefined.
			failedCount++
			errorsList = append(errorsList, "Failed to heal undefined (undefined): TypeError: Cannot read properties of undefined (reading 'slice')")
			continue
		}

		rawImsi, hasImsi := m["imsi"]
		rawType, hasType := m["type"]

		imsiStr := "undefined"
		if hasImsi && rawImsi != nil {
			imsiStr = fmt.Sprint(rawImsi)
		}
		typeStr := "undefined"
		if hasType && rawType != nil {
			typeStr = fmt.Sprint(rawType)
		}

		if !hasImsi || rawImsi == nil || rawImsi == "" {
			// Missing IMSI: in Node, imsi is undefined. undefined.slice() throws in buildDefaultXcloudSubscriber.
			failedCount++
			errorsList = append(errorsList, fmt.Sprintf("Failed to heal %s (%s): TypeError: Cannot read properties of undefined (reading 'slice')", imsiStr, typeStr))
			continue
		}

		err := r.HealSubscriberDocument(ctx, imsiStr, typeStr, profileName)
		if err != nil {
			failedCount++
			errorsList = append(errorsList, fmt.Sprintf("Failed to heal %s (%s): %s", imsiStr, typeStr, err.Error()))
		} else {
			successCount++
		}
	}

	msg := fmt.Sprintf("Successfully healed %d of %d anomalies", successCount, len(anomalies))
	return &BatchHealResponse{
		Message:      msg,
		SuccessCount: successCount,
		FailedCount:  failedCount,
		Errors:       errorsList,
	}, nil
}

// findProfile loads a profile document by name from app_profiles.
func (r *Repository) findProfile(ctx context.Context, name string) (bson.M, error) {
	var doc bson.M
	err := r.profiles.FindOne(ctx, bson.M{"name": name}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	return doc, nil
}

// provisionOcsSubscriber upserts ocs_subscribers and ocs_balances records.
// Matches Node provisionOcsSubscriber() in src/server/repositories/ocsBillingRepository.ts exactly.
func (r *Repository) provisionOcsSubscriber(
	ctx context.Context,
	imsi string,
	planID string,
	dataTotal int64,
	dataAvailable int64,
	smsTotal int64,
	smsAvailable int64,
) error {
	now := time.Now()

	// Check if tariff plan exists
	var plan bson.M
	err := r.ocsPlans.FindOne(ctx, bson.M{"plan_id": planID}).Decode(&plan)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return errors.New("OCS_PLAN_NOT_FOUND")
		}
		return err
	}

	// Load existing OCS subscriber to preserve msisdn
	var existingOcsSub bson.M
	_ = r.ocsSubs.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&existingOcsSub)
	msisdn := ""
	if existingOcsSub != nil {
		if m, ok := existingOcsSub["msisdn"].(string); ok {
			msisdn = m
		}
	}

	// Upsert ocs_subscribers
	_, err = r.ocsSubs.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{
			"$set": bson.M{
				"msisdn":     msisdn,
				"status":     "active",
				"plan_id":    planID,
				"updated_at": now,
			},
			"$setOnInsert": bson.M{
				"created_at": now,
				"imsi":       imsi,
			},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("upsert ocs_subscribers: %w", err)
	}

	// Load existing balance
	var existingBalance bson.M
	_ = r.ocsBalances.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&existingBalance)

	// Data calculations
	clampedAvailable := min64(max64(0, dataAvailable), dataTotal)
	derivedReserved := int64(0)
	if clampedAvailable < dataTotal {
		derivedReserved = min64(defaultQuotaPerGrant, dataTotal-clampedAvailable)
	}
	dataReserved := derivedReserved
	dataUsed := max64(0, dataTotal-dataReserved-clampedAvailable)
	nextTotal := max64(dataTotal, dataUsed+dataReserved+clampedAvailable)

	// Voice calculations
	voiceTotal := defaultVoiceTotal
	if existingBalance != nil && existingBalance["voice_total"] != nil {
		voiceTotal = toInt64(existingBalance["voice_total"], defaultVoiceTotal)
	}
	voiceAvailable := voiceTotal
	if existingBalance != nil && existingBalance["voice_available"] != nil {
		voiceAvailable = toInt64(existingBalance["voice_available"], voiceTotal)
	}
	voiceAvailable = min64(max64(0, voiceAvailable), voiceTotal)

	voiceReserved := int64(0)
	if existingBalance != nil && existingBalance["voice_reserved"] != nil {
		voiceReserved = toInt64(existingBalance["voice_reserved"], 0)
	}
	voiceUsed := int64(0)
	if existingBalance != nil && existingBalance["voice_used"] != nil {
		voiceUsed = toInt64(existingBalance["voice_used"], 0)
	} else {
		voiceUsed = max64(0, voiceTotal-voiceReserved-voiceAvailable)
	}
	nextVoiceTotal := max64(voiceTotal, voiceUsed+voiceReserved+voiceAvailable)

	// SMS calculations
	clampedSmsAvailable := min64(max64(0, smsAvailable), smsTotal)
	smsUsed := max64(0, smsTotal-clampedSmsAvailable)
	nextSmsTotal := max64(smsTotal, smsUsed+clampedSmsAvailable)

	// Version calculation
	version := int64(1)
	if existingBalance != nil && existingBalance["version"] != nil {
		version = toInt64(existingBalance["version"], 0) + 1
	}

	cycleStartAt := now
	cycleResetAt := now
	if existingBalance != nil {
		if cs, ok := existingBalance["cycle_start_at"]; ok && cs != nil {
			if t, ok := cs.(time.Time); ok {
				cycleStartAt = t
			}
		}
		if cr, ok := existingBalance["cycle_reset_at"]; ok && cr != nil {
			if t, ok := cr.(time.Time); ok {
				cycleResetAt = t
			}
		}
	}

	// Upsert ocs_balances
	_, err = r.ocsBalances.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{
			"$set": bson.M{
				"data_total":      nextTotal,
				"data_used":       dataUsed,
				"data_reserved":   dataReserved,
				"data_available":  clampedAvailable,
				"voice_total":     nextVoiceTotal,
				"voice_used":      voiceUsed,
				"voice_reserved":  voiceReserved,
				"voice_available": voiceAvailable,
				"sms_total":       nextSmsTotal,
				"sms_used":        smsUsed,
				"sms_available":   clampedSmsAvailable,
				"money_balance":   int64(0),
				"plan_id":         planID,
				"status":          "active",
				"version":         version,
				"updated_at":      now,
				"cycle_start_at":  cycleStartAt,
				"cycle_reset_at":  cycleResetAt,
			},
			"$setOnInsert": bson.M{
				"created_at": now,
			},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("upsert ocs_balances: %w", err)
	}

	return nil
}

// buildDefaultXcloudSubscriber constructs a default xCloud subscriber document.
// Matches Node buildDefaultXcloudSubscriber() in src/lib/xcloudSubscriber.ts exactly.
func buildDefaultXcloudSubscriber(imsi string, profile bson.M) bson.M {
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
	mmeTimestamp := time.Now().UnixMilli() * 1000

	ambr := bson.M{
		"downlink": bson.M{"value": 1, "unit": 3},
		"uplink":   bson.M{"value": 1, "unit": 3},
	}
	if profile != nil {
		if pAmbr := extractMap(profile, "ambr"); pAmbr != nil {
			if dl := extractMap(pAmbr, "downlink"); dl != nil {
				ambr["downlink"] = bson.M{
					"value": toInt(dl["value"], 1),
					"unit":  toInt(dl["unit"], 3),
				}
			}
			if ul := extractMap(pAmbr, "uplink"); ul != nil {
				ambr["uplink"] = bson.M{
					"value": toInt(ul["value"], 1),
					"unit":  toInt(ul["unit"], 3),
				}
			}
		}
	}

	slice := buildDefaultSlice()

	return bson.M{
		"__v":            0,
		"schema_version": 1,
		"imsi":           imsi,
		"msisdn":         []any{},
		"imeisv":         "8672710677532401",
		"security": bson.M{
			"k":   "000102030405060708090A0B0C0D0E0F",
			"op":  nil,
			"opc": "00000000000000000000000000000000",
			"amf": "8000",
			"sqn": int64(1719756),
		},
		"ambr":                     ambr,
		"slice":                    slice,
		"access_restriction_data":  32,
		"subscriber_status":        0,
		"network_access_mode":      0,
		"subscribed_rau_tau_timer": 12,
		"mme_host":                 mmeHost,
		"mme_realm":                mmeRealm,
		"mme_timestamp":            mmeTimestamp,
		"purge_flag":               false,
	}
}

// buildDefaultSlice constructs default slice array.
func buildDefaultSlice() []any {
	return []any{
		bson.M{
			"_id":               bson.NewObjectID(),
			"sst":               1,
			"default_indicator": true,
			"session": []any{
				bson.M{
					"_id":  bson.NewObjectID(),
					"name": "internet",
					"type": 1,
					"qos": bson.M{
						"index": 9,
						"arp": bson.M{
							"priority_level":            9,
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
				bson.M{
					"_id":  bson.NewObjectID(),
					"name": "mobile",
					"type": 1,
					"qos": bson.M{
						"index": 9,
						"arp": bson.M{
							"priority_level":            9,
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
				bson.M{
					"_id":  bson.NewObjectID(),
					"name": "ims",
					"type": 3,
					"qos": bson.M{
						"index": 5,
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
									"pre_emption_capability":    2,
									"pre_emption_vulnerability": 2,
								},
								"gbr": bson.M{"value": 128, "unit": 1},
								"mbr": bson.M{"value": 128, "unit": 1},
							},
						},
					},
				},
			},
		},
	}
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

func toInt(v any, fallback int) int {
	if v == nil {
		return fallback
	}
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return fallback
	}
}

func toInt64(v any, fallback int64) int64 {
	if v == nil {
		return fallback
	}
	switch n := v.(type) {
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	default:
		return fallback
	}
}

func extractMap(m bson.M, key string) bson.M {
	if v, ok := m[key]; ok && v != nil {
		if sub, ok := v.(bson.M); ok {
			return sub
		}
		if subD, ok := v.(bson.D); ok {
			res := make(bson.M, len(subD))
			for _, elem := range subD {
				res[elem.Key] = elem.Value
			}
			return res
		}
		if subMap, ok := v.(map[string]any); ok {
			res := make(bson.M, len(subMap))
			for k, val := range subMap {
				res[k] = val
			}
			return res
		}
	}
	return nil
}

func extractInt64(m bson.M, keys ...string) *int64 {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			n := toInt64(v, -1)
			if n >= 0 {
				return &n
			}
		}
	}
	return nil
}

func extractString(m bson.M, keys ...string) *string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			if s, ok := v.(string); ok && s != "" {
				return &s
			}
		}
	}
	return nil
}
