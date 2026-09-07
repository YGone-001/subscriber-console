package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"

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
// Pointer fields distinguish missing (nil) from explicit zero (ptr to 0).
type BatchCreatePayload struct {
	StartImsi      string   `json:"startImsi"`
	Count          int      `json:"count"`
	TrafficTotal   *float64 `json:"trafficTotal,omitempty"`
	TrafficBalance *float64 `json:"trafficBalance,omitempty"`
	SmsTotal       *float64 `json:"smsTotal,omitempty"`
	SmsBalance     *float64 `json:"smsBalance,omitempty"`
	ProfileName    string   `json:"profileName,omitempty"`
	PlanId         string   `json:"planId,omitempty"`
	Strategy       string   `json:"strategy"`
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
	Requested       int          `json:"requested"`
	CreatedImsis    []string     `json:"createdImsis"`
	FailedImsis     []string     `json:"failedImsis"`
	OcsProvisioned  []string     `json:"ocsProvisionedImsis"`
	OcsFailed       []string     `json:"ocsFailedImsis"`
	CreatedCount    int          `json:"createdCount"`
	FailedCount     int          `json:"failedCount"`
	PartialMutation bool         `json:"partialMutation"`
	Metrics         BatchMetrics `json:"metrics"`
	Fingerprint     string       `json:"operationFingerprint"`
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
// Node contract: explicit zero is a valid value, not absent.
// Absent = nil pointer; present (including zero) = non-nil pointer.
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

	// Resolve traffic total — nil = absent, use fallback chain
	var resolvedTrafficTotal int64
	if trafficTotal != nil {
		resolvedTrafficTotal = int64(*trafficTotal)
	} else if v := extractInt64(profileOcs, "trafficTotal"); v > 0 {
		resolvedTrafficTotal = v
	} else if v := extractInt64(profileOcs, "traffic_total"); v > 0 {
		resolvedTrafficTotal = v
	} else if trafficBalance != nil {
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
	if trafficBalance != nil {
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
	if smsTotal != nil {
		resolvedSmsTotal = int64(*smsTotal)
	} else if v := extractInt64(profileOcs, "smsTotal"); v > 0 {
		resolvedSmsTotal = v
	} else if v := extractInt64(profileOcs, "sms_total"); v > 0 {
		resolvedSmsTotal = v
	} else if smsBalance != nil {
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
	if smsBalance != nil {
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
// ComputeProfilePreconditionHash computes the execution-affecting profile hash.
// Uses ONLY fields that materially affect subscriber creation:
// auth, ambr, sliceList, ocsDefaults.
// This matches the Node profileExecutionHash exactly.
func ComputeProfilePreconditionHash(profileData map[string]any) string {
	if profileData == nil {
		return ""
	}
	// Extract only execution-affecting fields (matching Node canonical projection)
	executionAffecting := map[string]any{
		"auth":        profileData["auth"],
		"ambr":        profileData["ambr"],
		"sliceList":   profileData["sliceList"],
		"ocsDefaults": profileData["ocsDefaults"],
	}
	// Also check ocs_defaults (alternate key)
	if executionAffecting["ocsDefaults"] == nil {
		executionAffecting["ocsDefaults"] = profileData["ocs_defaults"]
	}
	h := sha256.Sum256([]byte(stableJSON(executionAffecting)))
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

	// Resolve effective OCS — pass pointers directly to preserve explicit zero
	effectiveOcs := ResolveEffectiveOcs(profileData, payload.TrafficTotal, payload.TrafficBalance, payload.SmsTotal, payload.SmsBalance, payload.PlanId)

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
		"mme_timestamp":            time.Now().UnixMicro(),
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

// defaultBatchSlices returns the default slice list for batch creation without profile.
// Matches Node normalizeSliceList() default exactly:
// - internet: type=1, 5QI=9, ARP priority=9
// - mobile: type=1, 5QI=9, ARP priority=9
// - ims: type=3, 5QI=5, ARP priority=1, with PCC rule (GBR/MBR 128/unit1, ARP priority=2)
func defaultBatchSlices() bson.A {
	return bson.A{
		bson.M{
			"_id":               bson.NewObjectID(),
			"sst":               1,
			"default_indicator": true,
			"session": bson.A{
				// internet session
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
					"pcc_rule": bson.A{},
				},
				// mobile session
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
					"pcc_rule": bson.A{},
				},
				// ims session with PCC rule
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
					"pcc_rule": bson.A{
						bson.M{
							"flow": bson.A{},
							"qos": bson.M{
								"index": 1,
								"gbr": bson.M{
									"downlink": bson.M{"value": 128, "unit": 1},
									"uplink":   bson.M{"value": 128, "unit": 1},
								},
								"mbr": bson.M{
									"downlink": bson.M{"value": 128, "unit": 1},
									"uplink":   bson.M{"value": 128, "unit": 1},
								},
								"arp": bson.M{
									"priority_level":            2,
									"pre_emption_capability":    2,
									"pre_emption_vulnerability": 2,
								},
							},
						},
					},
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

// buildBatchSession builds an xcloud session document from profile session data.
// Matches Node toXcloudSession() semantics.
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

	// ARP priority: ims=1, internet/mobile=9 (from sessionQosPreset)
	arpPriority := 9
	if isIms {
		arpPriority = 1
	}

	result := bson.M{
		"_id":  bson.NewObjectID(),
		"name": name,
		"type": sessionType,
		"qos": bson.M{
			"index": qosIndex,
			"arp": bson.M{
				"priority_level":            arpPriority,
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

	// IMS sessions get PCC rule with GBR/MBR 128/unit1
	if isIms {
		result["pcc_rule"] = bson.A{
			bson.M{
				"flow": bson.A{},
				"qos": bson.M{
					"index": 1,
					"gbr": bson.M{
						"downlink": bson.M{"value": 128, "unit": 1},
						"uplink":   bson.M{"value": 128, "unit": 1},
					},
					"mbr": bson.M{
						"downlink": bson.M{"value": 128, "unit": 1},
						"uplink":   bson.M{"value": 128, "unit": 1},
					},
					"arp": bson.M{
						"priority_level":            2,
						"pre_emption_capability":    2,
						"pre_emption_vulnerability": 2,
					},
				},
			},
		}
	}

	return result
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

// --- Frozen v2 Integrity Validation (PART L) ---

// AssertFrozenBatchCreateV2 validates the frozen batch create contract integrity.
// Returns INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD if any check fails.
func AssertFrozenBatchCreateV2(frozen *FrozenBatchCreateV2) error {
	if frozen == nil {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	if frozen.Version != "subscriber-batch-create-v2" {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	if frozen.Count < 1 || frozen.Count > 1000 {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	if len(frozen.ExpectedAbsentImsis) != frozen.Count {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	if frozen.Strategy != "create-only" {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	if frozen.StartImsi == "" || len(frozen.StartImsi) != 15 {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	if frozen.Profile.State != "present" && frozen.Profile.State != "absent" {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	if frozen.OperationFingerprint == "" {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}

	// Verify IMSI range regenerates exactly
	targets, err := GenerateImsiRange(frozen.StartImsi, frozen.Count)
	if err != nil {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}
	for i, target := range targets {
		if target != frozen.ExpectedAbsentImsis[i] {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
		}
	}

	// Verify fingerprint recomputes exactly
	expectedFp := ComputeBatchCreateFingerprint(frozen.ExpectedAbsentImsis, frozen.EffectiveOcs, frozen.Profile)
	if expectedFp != frozen.OperationFingerprint {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}

	return nil
}

// --- Profile Drift Enforcement (PART I) ---

// AssertBatchCreateProfilePrecondition validates that the profile state hasn't
// changed since the frozen contract was prepared.
// Returns SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED if drift detected.
func AssertBatchCreateProfilePrecondition(ctx context.Context, frozen *FrozenBatchCreateV2, repo *Repository) error {
	if frozen == nil {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD"}
	}

	currentProfile := repo.loadProfileData(ctx, frozen.Profile.RequestedName)

	switch frozen.Profile.State {
	case "present":
		// Profile was present at prepare time — must still exist with same hash
		if currentProfile == nil {
			return &SubscriberGovernanceError{Code: "SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED"}
		}
		currentHash := ComputeProfilePreconditionHash(currentProfile)
		if currentHash != frozen.Profile.PreconditionHash {
			return &SubscriberGovernanceError{Code: "SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED"}
		}
	case "absent":
		// Profile was absent at prepare time — must still be absent
		if currentProfile != nil {
			return &SubscriberGovernanceError{Code: "SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED"}
		}
	}

	return nil
}

// --- Expected Absence Recheck (PART M) ---

// AssertExpectedAbsence rechecks that no target IMSIs exist before inserts.
// Returns SUBSCRIBER_CREATE_PRECONDITION_CHANGED if any target already exists.
func AssertExpectedAbsence(ctx context.Context, frozen *FrozenBatchCreateV2, repo *Repository) error {
	if frozen == nil || len(frozen.ExpectedAbsentImsis) == 0 {
		return nil
	}

	precheck, err := repo.precheckSubscriberRange(ctx, frozen.StartImsi, frozen.Count)
	if err != nil {
		return err
	}
	if precheck.ConflictCount > 0 {
		return &SubscriberGovernanceError{
			Code: "SUBSCRIBER_CREATE_PRECONDITION_CHANGED",
			Details: map[string]any{
				"conflictCount": precheck.ConflictCount,
				"conflictImsis": precheck.ConflictImsis,
			},
		}
	}
	return nil
}

// --- Typed Batch Executor (PART O) ---

// ExecuteFrozenSubscriberBatchCreate is the reusable business executor for batch create.
// It owns: assert frozen payload → profile precondition → expected-absence precheck →
// create-only insert → OCS provisioning → partial result classification.
// Returns typed errors: INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD,
// SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED, SUBSCRIBER_CREATE_PRECONDITION_CHANGED,
// SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE.
func ExecuteFrozenSubscriberBatchCreate(
	ctx context.Context,
	frozen *FrozenBatchCreateV2,
	repo *Repository,
) (*BatchCreateResult, error) {
	// 1. Assert frozen payload integrity
	if err := AssertFrozenBatchCreateV2(frozen); err != nil {
		return nil, err
	}

	// 2. Profile precondition check
	if err := AssertBatchCreateProfilePrecondition(ctx, frozen, repo); err != nil {
		return nil, err
	}

	// 3. Expected absence precheck
	if err := AssertExpectedAbsence(ctx, frozen, repo); err != nil {
		return nil, err
	}

	// 4. Load profile for document building
	profileData := repo.loadProfileData(ctx, frozen.Profile.RequestedName)

	// 5. Create-only inserts
	result := &BatchCreateResult{
		Requested:   len(frozen.ExpectedAbsentImsis),
		Fingerprint: frozen.OperationFingerprint,
	}

	for _, imsi := range frozen.ExpectedAbsentImsis {
		doc := buildBatchSubscriberDoc(imsi, profileData)

		_, err := repo.subscribers.InsertOne(ctx, doc)
		if err != nil {
			if isMongoDuplicateKey(err) {
				// Duplicate = race condition
				result.FailedImsis = append(result.FailedImsis, imsi)
				continue
			}
			return nil, fmt.Errorf("insert subscriber %s: %w", imsi, err)
		}

		result.CreatedImsis = append(result.CreatedImsis, imsi)
	}

	// 6. OCS provisioning only for successfully inserted subscribers
	for _, imsi := range result.CreatedImsis {
		planId := frozen.EffectiveOcs.PlanId
		input := OcsProvisioningInput{
			IMSI:          imsi,
			PlanID:        &planId,
			DataTotal:     &frozen.EffectiveOcs.TrafficTotal,
			DataAvailable: &frozen.EffectiveOcs.TrafficBalance,
			SMSTotal:      &frozen.EffectiveOcs.SmsTotal,
			SMSAvailable:  &frozen.EffectiveOcs.SmsBalance,
		}

		if err := repo.provisionOcsSubscriber(ctx, input); err != nil {
			result.OcsFailed = append(result.OcsFailed, imsi)
			continue
		}
		result.OcsProvisioned = append(result.OcsProvisioned, imsi)
	}

	// 7. Classify result
	result.CreatedCount = len(result.CreatedImsis)
	result.FailedCount = len(result.FailedImsis) + len(result.OcsFailed)
	result.PartialMutation = result.CreatedCount > 0 && result.FailedCount > 0
	result.Metrics = BatchMetrics{
		TotalTraffic: frozen.EffectiveOcs.TrafficTotal * int64(result.CreatedCount),
		BatchSize:    result.CreatedCount,
	}

	return result, nil
}

// isMongoDuplicateKey checks if an error is a MongoDB duplicate key error.
func isMongoDuplicateKey(err error) bool {
	if err == nil {
		return false
	}
	// Check for MongoDB duplicate key error code (E11000)
	return strings.Contains(err.Error(), "E11000") ||
		strings.Contains(err.Error(), "duplicate key")
}
