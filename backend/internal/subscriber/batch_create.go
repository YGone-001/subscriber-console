package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math/big"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Batch default constants — different from single-create defaults.
// Matches Node batch creation: 5 GiB traffic, 100 SMS.
const (
	batchDefaultTrafficTotal   = 5368709120 // 5 GiB
	batchDefaultSmsTotal       = 100
	batchDefaultVoiceTotal     = 3600 // 1 hour in seconds
	batchDefaultAccessRestrict = 32
	batchDefaultNetworkAccess  = 0
)

// BatchCreatePayload holds the validated batch create request.
// Matches Node validateBatchCreatePayload() output.
type BatchCreatePayload struct {
	StartImsi      string  `json:"startImsi"`
	Count          int     `json:"count"`
	TrafficTotal   float64 `json:"trafficTotal,omitempty"`
	TrafficBalance float64 `json:"trafficBalance,omitempty"`
	SmsTotal       float64 `json:"smsTotal,omitempty"`
	SmsBalance     float64 `json:"smsBalance,omitempty"`
	ProfileName    string  `json:"profileName,omitempty"`
	PlanId         string  `json:"planId,omitempty"`
	Strategy       string  `json:"strategy"`
}

// EffectiveOcsConfig holds the resolved OCS configuration for batch creation.
type EffectiveOcsConfig struct {
	PlanId         string `json:"planId"`
	TrafficTotal   int64  `json:"trafficTotal"`
	TrafficBalance int64  `json:"trafficBalance"`
	SmsTotal       int64  `json:"smsTotal"`
	SmsBalance     int64  `json:"smsBalance"`
}

// ProfileState holds the profile precondition state.
type ProfileState struct {
	RequestedName    string `json:"requestedName"`
	State            string `json:"state"` // "present" or "absent"
	PreconditionHash string `json:"preconditionHash"`
}

// FrozenBatchCreateV2 is the v2 frozen contract for batch create.
// Matches the specification exactly.
type FrozenBatchCreateV2 struct {
	Version              string             `json:"version"`
	StartImsi            string             `json:"startImsi"`
	Count                int                `json:"count"`
	ExpectedAbsentImsis  []string           `json:"expectedAbsentImsis"`
	EffectiveOcs         EffectiveOcsConfig `json:"effectiveOcs"`
	Profile              ProfileState       `json:"profile"`
	Strategy             string             `json:"strategy"`
	OperationFingerprint string             `json:"operationFingerprint"`
}

// BatchCreateResult holds the result of a batch create execution.
type BatchCreateResult struct {
	Requested        int          `json:"requested"`
	CreatedImsis     []string     `json:"createdImsis"`
	SubscriberFailed []string     `json:"subscriberFailedImsis"`
	OcsProvisioned   []string     `json:"ocsProvisionedImsis"`
	OcsFailed        []string     `json:"ocsFailedImsis"`
	CreatedCount     int          `json:"createdCount"`
	FailedCount      int          `json:"failedCount"`
	PartialMutation  bool         `json:"partialMutation"`
	Metrics          BatchMetrics `json:"metrics"`
	Fingerprint      string       `json:"operationFingerprint"`
}

// BatchMetrics holds batch execution metrics.
type BatchMetrics struct {
	TotalTraffic int64 `json:"totalTraffic"`
	BatchSize    int   `json:"batchSize"`
}

// GenerateImsiRange generates a range of IMSIs using integer-safe arithmetic.
// Returns error if any generated IMSI exceeds 15 digits.
func GenerateImsiRange(startImsi string, count int) ([]string, error) {
	start := new(big.Int)
	start.SetString(startImsi, 10)

	result := make([]string, count)
	for i := 0; i < count; i++ {
		imsi := new(big.Int).Add(start, big.NewInt(int64(i)))
		s := imsi.String()
		if len(s) != 15 {
			return nil, &SubscriberGovernanceError{Code: "IMSI_RANGE_OVERFLOW"}
		}
		result[i] = s
	}
	return result, nil
}

// ResolveEffectiveOcs resolves the effective OCS configuration from request,
// profile defaults, and hardcoded defaults.
// Matches Node batch create resolution logic exactly.
func ResolveEffectiveOcs(
	profileData map[string]any,
	trafficTotal, trafficBalance, smsTotal, smsBalance *float64,
	planId string,
) EffectiveOcsConfig {
	// Profile OCS defaults
	profileOcs := extractProfileOcs(profileData)

	// Resolve plan
	resolvedPlan := planId
	if resolvedPlan == "" {
		resolvedPlan = extractString(profileOcs, "planId")
		if resolvedPlan == "" {
			resolvedPlan = extractString(profileOcs, "plan_id")
		}
	}
	if resolvedPlan == "" {
		resolvedPlan = defaultPlanID
	}

	// Resolve traffic total
	var resolvedTrafficTotal int64
	if trafficTotal != nil && *trafficTotal > 0 {
		resolvedTrafficTotal = int64(*trafficTotal)
	} else if v := extractInt64(profileOcs, "trafficTotal"); v > 0 {
		resolvedTrafficTotal = v
	} else if v := extractInt64(profileOcs, "traffic_total"); v > 0 {
		resolvedTrafficTotal = v
	} else if trafficBalance != nil && *trafficBalance > 0 {
		resolvedTrafficTotal = int64(*trafficBalance)
	} else if v := extractInt64(profileOcs, "trafficBalance"); v > 0 {
		resolvedTrafficTotal = v
	} else if v := extractInt64(profileOcs, "traffic_balance"); v > 0 {
		resolvedTrafficTotal = v
	} else {
		resolvedTrafficTotal = batchDefaultTrafficTotal
	}

	// Resolve traffic balance
	var resolvedTrafficBalance int64
	if trafficBalance != nil && *trafficBalance > 0 {
		resolvedTrafficBalance = int64(*trafficBalance)
	} else if v := extractInt64(profileOcs, "trafficBalance"); v > 0 {
		resolvedTrafficBalance = v
	} else if v := extractInt64(profileOcs, "traffic_balance"); v > 0 {
		resolvedTrafficBalance = v
	} else {
		resolvedTrafficBalance = resolvedTrafficTotal
	}

	// Resolve SMS total
	var resolvedSmsTotal int64
	if smsTotal != nil && *smsTotal > 0 {
		resolvedSmsTotal = int64(*smsTotal)
	} else if v := extractInt64(profileOcs, "smsTotal"); v > 0 {
		resolvedSmsTotal = v
	} else if v := extractInt64(profileOcs, "sms_total"); v > 0 {
		resolvedSmsTotal = v
	} else if smsBalance != nil && *smsBalance > 0 {
		resolvedSmsTotal = int64(*smsBalance)
	} else if v := extractInt64(profileOcs, "smsBalance"); v > 0 {
		resolvedSmsTotal = v
	} else if v := extractInt64(profileOcs, "sms_balance"); v > 0 {
		resolvedSmsTotal = v
	} else {
		resolvedSmsTotal = batchDefaultSmsTotal
	}

	// Resolve SMS balance
	var resolvedSmsBalance int64
	if smsBalance != nil && *smsBalance > 0 {
		resolvedSmsBalance = int64(*smsBalance)
	} else if v := extractInt64(profileOcs, "smsBalance"); v > 0 {
		resolvedSmsBalance = v
	} else if v := extractInt64(profileOcs, "sms_balance"); v > 0 {
		resolvedSmsBalance = v
	} else {
		resolvedSmsBalance = resolvedSmsTotal
	}

	return EffectiveOcsConfig{
		PlanId:         resolvedPlan,
		TrafficTotal:   resolvedTrafficTotal,
		TrafficBalance: resolvedTrafficBalance,
		SmsTotal:       resolvedSmsTotal,
		SmsBalance:     resolvedSmsBalance,
	}
}

// ComputeProfilePreconditionHash computes a SHA-256 hash over ALL profile data
// that materially affects batch creation. Includes security material internally
// but only the hash leaves the executor boundary.
func ComputeProfilePreconditionHash(profileData map[string]any) string {
	if profileData == nil {
		return ""
	}
	// Use stable JSON for deterministic hashing
	h := sha256.Sum256([]byte(stableJSON(profileData)))
	return fmt.Sprintf("%x", h)
}

// PrepareFrozenBatchCreate prepares a frozen v2 batch create contract.
func PrepareFrozenBatchCreate(
	ctx context.Context,
	payload BatchCreatePayload,
	profileData map[string]any,
	profilePresent bool,
) (*FrozenBatchCreateV2, error) {
	// Generate target IMSIs
	targets, err := GenerateImsiRange(payload.StartImsi, payload.Count)
	if err != nil {
		return nil, err
	}

	// Resolve effective OCS
	var tt, tb, st, sb *float64
	if payload.TrafficTotal > 0 {
		tt = &payload.TrafficTotal
	}
	if payload.TrafficBalance > 0 {
		tb = &payload.TrafficBalance
	}
	if payload.SmsTotal > 0 {
		st = &payload.SmsTotal
	}
	if payload.SmsBalance > 0 {
		sb = &payload.SmsBalance
	}
	effectiveOcs := ResolveEffectiveOcs(profileData, tt, tb, st, sb, payload.PlanId)

	// Profile state
	profileState := ProfileState{
		RequestedName: payload.ProfileName,
	}
	if profilePresent {
		profileState.State = "present"
		profileState.PreconditionHash = ComputeProfilePreconditionHash(profileData)
	} else {
		profileState.State = "absent"
	}

	// Compute fingerprint
	fingerprint := ComputeBatchCreateFingerprint(targets, effectiveOcs, profileState)

	return &FrozenBatchCreateV2{
		Version:              "subscriber-batch-create-v2",
		StartImsi:            payload.StartImsi,
		Count:                payload.Count,
		ExpectedAbsentImsis:  targets,
		EffectiveOcs:         effectiveOcs,
		Profile:              profileState,
		Strategy:             "create-only",
		OperationFingerprint: fingerprint,
	}, nil
}

// ComputeBatchCreateFingerprint computes the operation fingerprint.
// Uses canonical stable serialization.
func ComputeBatchCreateFingerprint(
	targets []string,
	ocs EffectiveOcsConfig,
	profile ProfileState,
) string {
	source := map[string]any{
		"operation": "SUBSCRIBER_BATCH_CREATE",
		"targets":   targets,
		"effectiveOcs": map[string]any{
			"planId":         ocs.PlanId,
			"trafficTotal":   ocs.TrafficTotal,
			"trafficBalance": ocs.TrafficBalance,
			"smsTotal":       ocs.SmsTotal,
			"smsBalance":     ocs.SmsBalance,
		},
		"profile": map[string]any{
			"requestedName":    profile.RequestedName,
			"state":            profile.State,
			"preconditionHash": profile.PreconditionHash,
		},
		"strategy": "create-only",
	}
	h := sha256.Sum256([]byte(stableJSON(source)))
	return fmt.Sprintf("%x", h)
}

// buildBatchSubscriberDoc builds a subscriber document for batch creation.
// Uses profile auth/material or zero-key batch defaults.
// Access restriction = 32, network access mode = 0.
func buildBatchSubscriberDoc(imsi string, profileData map[string]any) bson.M {
	// Build auth from profile or zero-key defaults
	auth := buildBatchAuth(profileData)
	ambr := buildBatchAmbr(profileData)
	slices := buildBatchSlices(profileData)
	realm := epcRealmFromImsi(imsi)

	return bson.M{
		"__v":                      0,
		"schema_version":           1,
		"imsi":                     imsi,
		"msisdn":                   bson.A{},
		"imeisv":                   "8672710677532401",
		"security":                 auth,
		"ambr":                     ambr,
		"slice":                    slices,
		"access_restriction_data":  batchDefaultAccessRestrict,
		"subscriber_status":        0,
		"network_access_mode":      batchDefaultNetworkAccess,
		"subscribed_rau_tau_timer": 12,
		"mme_host":                 realm["mme_host"],
		"mme_realm":                realm["mme_realm"],
		"mme_timestamp":            0, // will be set by DB
		"purge_flag":               false,
	}
}

func buildBatchAuth(profileData map[string]any) bson.M {
	if profileData == nil {
		return bson.M{
			"k":   "00000000000000000000000000000000",
			"op":  nil,
			"opc": "00000000000000000000000000000000",
			"amf": "8000",
			"sqn": 1,
		}
	}

	authRaw, _ := profileData["auth"].(map[string]any)
	if authRaw == nil {
		return bson.M{
			"k":   "00000000000000000000000000000000",
			"op":  nil,
			"opc": "00000000000000000000000000000000",
			"amf": "8000",
			"sqn": 1,
		}
	}

	return bson.M{
		"k":   extractString(authRaw, "k"),
		"op":  authRaw["op"],
		"opc": extractString(authRaw, "opc"),
		"amf": extractStringWithDefault(authRaw, "amf", "8000"),
		"sqn": 1,
	}
}

func buildBatchAmbr(profileData map[string]any) bson.M {
	defaultAmbr := bson.M{
		"downlink": bson.M{"value": 1, "unit": 3},
		"uplink":   bson.M{"value": 1, "unit": 3},
	}

	if profileData == nil {
		return defaultAmbr
	}

	ambrRaw, _ := profileData["ambr"].(map[string]any)
	if ambrRaw == nil {
		return defaultAmbr
	}

	dl, _ := ambrRaw["downlink"].(map[string]any)
	ul, _ := ambrRaw["uplink"].(map[string]any)
	if dl == nil || ul == nil {
		return defaultAmbr
	}

	return bson.M{
		"downlink": bson.M{
			"value": extractInt(dl, "value", 1),
			"unit":  extractInt(dl, "unit", 3),
		},
		"uplink": bson.M{
			"value": extractInt(ul, "value", 1),
			"unit":  extractInt(ul, "unit", 3),
		},
	}
}

func buildBatchSlices(profileData map[string]any) bson.A {
	if profileData == nil {
		return defaultBatchSlices()
	}

	sliceListRaw, _ := profileData["sliceList"]
	if sliceListRaw == nil {
		return defaultBatchSlices()
	}

	sliceList, ok := sliceListRaw.([]any)
	if !ok || len(sliceList) == 0 {
		return defaultBatchSlices()
	}

	result := bson.A{}
	for _, sliceRaw := range sliceList {
		slice, ok := sliceRaw.(map[string]any)
		if !ok {
			continue
		}
		result = append(result, buildBatchSlice(slice))
	}
	return result
}

func defaultBatchSlices() bson.A {
	return bson.A{
		bson.M{
			"_id":               bson.NewObjectID(),
			"sst":               1,
			"default_indicator": true,
			"session": bson.A{
				bson.M{
					"_id":  bson.NewObjectID(),
					"name": "internet",
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
					"pcc_rule": bson.A{},
				},
			},
		},
	}
}

func buildBatchSlice(sliceData map[string]any) bson.M {
	sst := extractInt(sliceData, "sst", 1)
	sd := extractString(sliceData, "sd")

	sessions := bson.A{}
	sessionListRaw, _ := sliceData["session_list"]
	if sessionListRaw != nil {
		if sessionList, ok := sessionListRaw.([]any); ok {
			for _, s := range sessionList {
				if session, ok := s.(map[string]any); ok {
					sessions = append(sessions, buildBatchSession(session))
				}
			}
		}
	}
	if len(sessions) == 0 {
		sessions = bson.A{
			buildBatchSession(map[string]any{"name": "internet", "type": 1}),
		}
	}

	result := bson.M{
		"_id":               bson.NewObjectID(),
		"sst":               sst,
		"default_indicator": true,
		"session":           sessions,
	}
	if sd != "" && sd != "000001" {
		result["sd"] = sd
	}
	return result
}

func buildBatchSession(sessionData map[string]any) bson.M {
	name := extractStringWithDefault(sessionData, "name", "internet")
	isIms := name == "ims"
	qosIndex := 9
	if isIms {
		qosIndex = 5
	}
	sessionType := 1
	if isIms {
		sessionType = 3
	}
	if v, ok := sessionData["type"].(float64); ok && v > 0 {
		sessionType = int(v)
	}

	return bson.M{
		"_id":  bson.NewObjectID(),
		"name": name,
		"type": sessionType,
		"qos": bson.M{
			"index": qosIndex,
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
		"pcc_rule": bson.A{},
	}
}

func epcRealmFromImsi(imsi string) map[string]string {
	mcc := imsi[:3]
	mnc := imsi[3:5]
	if len(mnc) < 3 {
		mnc = strings.Repeat("0", 3-len(mnc)) + mnc
	}
	return map[string]string{
		"mme_host":  fmt.Sprintf("mme.epc.mnc%s.mcc%s.3gppnetwork.org", mnc, mcc),
		"mme_realm": fmt.Sprintf("epc.mnc%s.mcc%s.3gppnetwork.org", mnc, mcc),
	}
}

// extractProfileOcs extracts OCS defaults from profile data.
func extractProfileOcs(profileData map[string]any) map[string]any {
	if profileData == nil {
		return nil
	}
	if ocs, ok := profileData["ocsDefaults"].(map[string]any); ok {
		return ocs
	}
	if ocs, ok := profileData["ocs_defaults"].(map[string]any); ok {
		return ocs
	}
	return nil
}

func extractString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf("%v", v))
}

func extractStringWithDefault(m map[string]any, key, def string) string {
	s := extractString(m, key)
	if s == "" {
		return def
	}
	return s
}

func extractInt(m map[string]any, key string, def int) int {
	if m == nil {
		return def
	}
	v, ok := m[key]
	if !ok || v == nil {
		return def
	}
	if n, ok := v.(float64); ok {
		return int(n)
	}
	if n, ok := v.(int); ok {
		return n
	}
	return def
}

func extractInt64(m map[string]any, key string) int64 {
	if m == nil {
		return 0
	}
	v, ok := m[key]
	if !ok || v == nil {
		return 0
	}
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	}
	return 0
}

// sortedKeys returns sorted keys for stable serialization.
func sortedKeysForBatch(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
