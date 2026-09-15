package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// FrozenSubscriberProfileApplyV1 holds the frozen state for a subscriber profile apply.
// Matches Node FrozenSubscriberProfileApplyV1 shape exactly.
type FrozenSubscriberProfileApplyV1 struct {
	Version                    string       `json:"version"`
	Imsi                       string       `json:"imsi"`
	ProfileName                string       `json:"profileName"`
	SubscriberPreconditionHash string       `json:"subscriberPreconditionHash"`
	ProfilePreconditionHash    string       `json:"profilePreconditionHash"`
	Before                     SafeSnapshot `json:"before"`
	AfterPreview               SafeSnapshot `json:"afterPreview"`
	OperationFingerprint       string       `json:"operationFingerprint"`
}

// ProfileApplyAssertion holds the assertion result after re-reading current state.
type ProfileApplyAssertion struct {
	Intent            FrozenSubscriberProfileApplyV1
	CurrentSubscriber bson.M
	Profile           bson.M
	Effective         bson.M
}

// ProfileApplyResult holds the result of a profile apply execution.
type ProfileApplyResult struct {
	Restored        bson.M `json:"restored"`
	Classification  string `json:"classification"`
	Committed       bool   `json:"committed"`
	SecurityChanged bool   `json:"securityChanged"`
}

// ProfileLookupFn is a function that loads a profile document by name.
type ProfileLookupFn func(ctx context.Context, name string) (bson.M, error)

// SubscriberCASFn is a function that replaces a subscriber document using CAS.
type SubscriberCASFn func(ctx context.Context, expected bson.M, replacement bson.M) (bool, error)

// PrepareFrozenSubscriberProfileApply loads subscriber + profile and freezes the profile apply state.
// Matches Node prepareFrozenSubscriberProfileApply() exactly.
func PrepareFrozenSubscriberProfileApply(ctx context.Context, imsi string, profileName string, lookup SubscriberLookupFn, profileLookup ProfileLookupFn) (*FrozenSubscriberProfileApplyV1, error) {
	if profileName == "" {
		return nil, &SubscriberGovernanceError{Code: "INVALID_PROFILE_NAME"}
	}

	subscriber, err := lookup(ctx, imsi)
	if err != nil {
		return nil, err
	}
	if subscriber == nil {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_NOT_FOUND"}
	}

	profile, err := profileLookup(ctx, profileName)
	if err != nil {
		return nil, err
	}
	if profile == nil {
		return nil, &SubscriberGovernanceError{Code: "PROFILE_NOT_FOUND"}
	}

	subHash := computeSubscriberPreconditionHash(subscriber)
	profHash := computeProfilePreconditionHash(profile)
	effective := buildSubscriberAfterProfileApply(subscriber, profile, profileName)

	before := SubscriberSafeSnapshot(subscriber)
	afterPreview := SubscriberSafeSnapshot(effective)

	// No-effect detection
	if !securityMaterialChanged(subscriber, effective) &&
		stableJSON(before) == stableJSON(afterPreview) &&
		getProfileName(subscriber) == profileName {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_PROFILE_APPLY_NO_EFFECT"}
	}

	fingerprint := computeProfileApplyFingerprint(imsi, profileName, subHash, profHash, afterPreview)

	return &FrozenSubscriberProfileApplyV1{
		Version:                    "subscriber-profile-apply-v1",
		Imsi:                       imsi,
		ProfileName:                profileName,
		SubscriberPreconditionHash: subHash,
		ProfilePreconditionHash:    profHash,
		Before:                     before,
		AfterPreview:               afterPreview,
		OperationFingerprint:       fingerprint,
	}, nil
}

// AssertFrozenSubscriberProfileApply re-reads subscriber + profile and verifies preconditions.
// Returns nil if drift detected.
// Matches Node assertFrozenSubscriberProfileApply() exactly.
func AssertFrozenSubscriberProfileApply(ctx context.Context, intent FrozenSubscriberProfileApplyV1, lookup SubscriberLookupFn, profileLookup ProfileLookupFn) (*ProfileApplyAssertion, error) {
	subscriber, err := lookup(ctx, intent.Imsi)
	if err != nil {
		return nil, err
	}
	if subscriber == nil {
		return nil, nil
	}

	profile, err := profileLookup(ctx, intent.ProfileName)
	if err != nil {
		return nil, err
	}
	if profile == nil {
		return nil, nil
	}

	// Verify subscriber precondition
	currentSubHash := computeSubscriberPreconditionHash(subscriber)
	if currentSubHash != intent.SubscriberPreconditionHash {
		return nil, nil
	}

	// Verify profile precondition
	currentProfHash := computeProfilePreconditionHash(profile)
	if currentProfHash != intent.ProfilePreconditionHash {
		return nil, nil
	}

	effective := buildSubscriberAfterProfileApply(subscriber, profile, intent.ProfileName)

	return &ProfileApplyAssertion{
		Intent:            intent,
		CurrentSubscriber: subscriber,
		Profile:           profile,
		Effective:         effective,
	}, nil
}

// ExecuteFrozenSubscriberProfileApply executes the profile apply with CAS.
// Matches Node executeFrozenSubscriberProfileApply() exactly.
func ExecuteFrozenSubscriberProfileApply(ctx context.Context, assertion *ProfileApplyAssertion, actor string, casFn SubscriberCASFn) (*ProfileApplyResult, error) {
	// Update webui_meta with actor
	effective := assertion.Effective
	meta := toMap(effective["webui_meta"])
	if meta == nil {
		meta = map[string]interface{}{}
	}
	meta["updated_at"] = bson.NewDateTimeFromTime(time.Now())
	effective["webui_meta"] = meta

	replaced, err := casFn(ctx, assertion.CurrentSubscriber, effective)
	if err != nil {
		return nil, err
	}
	if !replaced {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED"}
	}

	secChanged := securityMaterialChanged(assertion.CurrentSubscriber, effective)

	return &ProfileApplyResult{
		Restored:        effective,
		Classification:  "SUCCESS",
		Committed:       true,
		SecurityChanged: secChanged,
	}, nil
}

// BuildSubscriberAfterProfileApply applies profile fields to a subscriber document.
// Preserves SQN, applies auth (k, op/opc normalization, amf), ambr, slices, access_restriction_data.
// No OCS mutation.
func BuildSubscriberAfterProfileApply(current bson.M, profile bson.M, profileName string) bson.M {
	// Deep copy current subscriber
	next := deepCopyBsonM(current)

	// Apply profile auth fields
	profileAuth := toMap(profile["auth"])
	if profileAuth != nil {
		currentSecurity := toMap(next["security"])
		if currentSecurity == nil {
			currentSecurity = map[string]interface{}{}
		}

		// K
		if k, ok := profileAuth["k"]; ok && k != nil {
			currentSecurity["k"] = fmt.Sprintf("%v", k)
		}

		// OP/OPc normalization: profile auth mode is authoritative
		if opc, ok := profileAuth["opc"]; ok && opc != nil {
			currentSecurity["opc"] = fmt.Sprintf("%v", opc)
			currentSecurity["op"] = nil
		} else if op, ok := profileAuth["op"]; ok && op != nil {
			currentSecurity["op"] = fmt.Sprintf("%v", op)
			currentSecurity["opc"] = nil
		}

		// AMF
		if amf, ok := profileAuth["amf"]; ok && amf != nil {
			currentSecurity["amf"] = fmt.Sprintf("%v", amf)
		}

		// SQN is NEVER overwritten — preserve existing

		next["security"] = currentSecurity
	}

	// Apply profile AMBR
	if ambr := profile["ambr"]; ambr != nil {
		next["ambr"] = ambr
	}

	// Apply profile slices — convert legacy sliceList to Xcloud format
	if sliceList := profile["sliceList"]; sliceList != nil {
		next["slice"] = convertSlices(sliceList)
	}

	// Apply access_restriction_data
	if ard, ok := profile["access_restriction_data"]; ok {
		next["access_restriction_data"] = ard
	}

	// Set profile binding metadata
	meta := toMap(next["webui_meta"])
	if meta == nil {
		meta = map[string]interface{}{}
	}
	meta["profile_name"] = profileName
	meta["updated_at"] = bson.NewDateTimeFromTime(time.Now())
	next["webui_meta"] = meta

	return next
}

// toMap converts bson.M, bson.D, or map[string]interface{} to map[string]interface{}.
// bson.D appears after JSON round-trip of nested objects in mongo-driver v2.
// Recursively converts nested bson.D values so callers can use type assertions safely.
func toMap(v interface{}) map[string]interface{} {
	switch m := v.(type) {
	case bson.M:
		return convertBsonMM(m)
	case map[string]interface{}:
		return convertMapString(m)
	case bson.D:
		return convertBsonD(m)
	default:
		return nil
	}
}

func convertBsonD(d bson.D) map[string]interface{} {
	result := make(map[string]interface{}, len(d))
	for _, elem := range d {
		result[elem.Key] = convertValue(elem.Value)
	}
	return result
}

func convertBsonMM(m bson.M) map[string]interface{} {
	result := make(map[string]interface{}, len(m))
	for k, v := range m {
		result[k] = convertValue(v)
	}
	return result
}

func convertMapString(m map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{}, len(m))
	for k, v := range m {
		result[k] = convertValue(v)
	}
	return result
}

func convertValue(v interface{}) interface{} {
	switch val := v.(type) {
	case bson.D:
		return convertBsonD(val)
	case bson.M:
		return convertBsonMM(val)
	case map[string]interface{}:
		return convertMapString(val)
	case bson.A:
		result := make(bson.A, len(val))
		for i, item := range val {
			result[i] = convertValue(item)
		}
		return result
	default:
		return v
	}
}

// buildSubscriberAfterProfileApply is the internal version used by prepare/assert.
func buildSubscriberAfterProfileApply(current bson.M, profile bson.M, profileName string) bson.M {
	return BuildSubscriberAfterProfileApply(current, profile, profileName)
}

// --- Helpers ---

// computeSubscriberPreconditionHash computes the full execution-relevant state hash.
// Includes security fields as INPUT (unlike profile hash).
// Canonical fields: imsi, msisdn, security, ambr, slice, access_restriction_data,
// network_access_mode, webui_meta.profile_name.
func computeSubscriberPreconditionHash(doc bson.M) string {
	data := map[string]any{
		"imsi":                    doc["imsi"],
		"msisdn":                  doc["msisdn"],
		"security":                doc["security"],
		"ambr":                    doc["ambr"],
		"slice":                   doc["slice"],
		"access_restriction_data": doc["access_restriction_data"],
		"network_access_mode":     doc["network_access_mode"],
		"webui_meta":              map[string]any{"profile_name": getProfileName(doc)},
	}
	return sha256Hex(stableJSON(data))
}

// computeProfilePreconditionHash computes the profile-relevant hash.
// Only includes auth, ambr, sliceList, access_restriction_data.
func computeProfilePreconditionHash(profile bson.M) string {
	data := map[string]any{
		"auth":                    profile["auth"],
		"ambr":                    profile["ambr"],
		"sliceList":               profile["sliceList"],
		"access_restriction_data": profile["access_restriction_data"],
	}
	return sha256Hex(stableJSON(data))
}

// computeProfileApplyFingerprint computes the operation fingerprint.
// Must include operation field for Node/Go parity.
func computeProfileApplyFingerprint(imsi, profileName, subHash, profHash string, after SafeSnapshot) string {
	data := map[string]any{
		"operation":                  "SUBSCRIBER_PROFILE_APPLY",
		"imsi":                       imsi,
		"profileName":                profileName,
		"subscriberPreconditionHash": subHash,
		"profilePreconditionHash":    profHash,
		"afterPreview":               after,
	}
	return sha256Hex(stableJSON(data))
}

// securityMaterialChanged checks if security material differs between current and effective.
func securityMaterialChanged(current, effective bson.M) bool {
	currentSec := toMap(current["security"])
	effectiveSec := toMap(effective["security"])

	if currentSec == nil && effectiveSec == nil {
		return false
	}
	if currentSec == nil || effectiveSec == nil {
		return true
	}

	// Compare k, op, opc, amf (NOT sqn — sqn is runtime state)
	fields := []string{"k", "op", "opc", "amf"}
	for _, f := range fields {
		if fmt.Sprintf("%v", currentSec[f]) != fmt.Sprintf("%v", effectiveSec[f]) {
			return true
		}
	}
	return false
}

// getProfileName extracts profile_name from webui_meta.
func getProfileName(doc bson.M) string {
	meta := toMap(doc["webui_meta"])
	if meta == nil {
		return ""
	}
	name, _ := meta["profile_name"].(string)
	return name
}

// sha256Hex computes the SHA-256 hex digest.
func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", h)
}

// IsProfileApplyNoEffect checks if a profile apply would have no effect.
// Exported for testing.
func IsProfileApplyNoEffect(current bson.M, profile bson.M, profileName string) bool {
	effective := buildSubscriberAfterProfileApply(current, profile, profileName)
	if securityMaterialChanged(current, effective) {
		return false
	}
	before := SubscriberSafeSnapshot(current)
	after := SubscriberSafeSnapshot(effective)
	return stableJSON(before) == stableJSON(after) && getProfileName(current) == profileName
}

// SecurityMaterialChanged checks if security material differs.
// Exported for testing.
func SecurityMaterialChanged(current, effective bson.M) bool {
	return securityMaterialChanged(current, effective)
}
