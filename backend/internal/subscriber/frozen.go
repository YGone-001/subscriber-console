package subscriber

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// SafeSnapshot contains subscriber fields that are safe to include in
// governance snapshots and frozen CHG payloads. NEVER includes security,
// k, op, opc, amf, or sqn.
type SafeSnapshot struct {
	Imsi                  string `json:"imsi" bson:"imsi"`
	Msisdn                []any  `json:"msisdn" bson:"msisdn"`
	AccessRestrictionData int    `json:"accessRestrictionData" bson:"accessRestrictionData"`
	NetworkAccessMode     int    `json:"networkAccessMode" bson:"networkAccessMode"`
	Ambr                  any    `json:"ambr,omitempty" bson:"ambr,omitempty"`
	Slices                any    `json:"slices,omitempty" bson:"slices,omitempty"`
}

// FrozenSubscriberUpdate holds the frozen state for a subscriber update.
// Matches Node FrozenSubscriberUpdate shape.
type FrozenSubscriberUpdate struct {
	Version              string        `json:"version"`
	Imsi                 string        `json:"imsi"`
	Before               SafeSnapshot  `json:"before"`
	After                SafeSnapshot  `json:"after"`
	Payload              UpdatePayload `json:"payload"`
	OperationFingerprint string        `json:"operationFingerprint"`
}

// FrozenSubscriberDelete holds the frozen state for a subscriber delete.
// Matches Node FrozenSubscriberDelete shape.
type FrozenSubscriberDelete struct {
	Version              string       `json:"version"`
	Imsi                 string       `json:"imsi"`
	Before               SafeSnapshot `json:"before"`
	OperationFingerprint string       `json:"operationFingerprint"`
}

// SubscriberGovernanceError is returned when a governance check fails.
type SubscriberGovernanceError struct {
	Code    string
	Details map[string]any
}

func (e *SubscriberGovernanceError) Error() string {
	return e.Code
}

// SubscriberLookupFn is a function that loads a subscriber document by IMSI.
type SubscriberLookupFn func(ctx context.Context, imsi string) (bson.M, error)

// SubscriberWriteFn is a function that writes a subscriber update.
type SubscriberWriteFn func(ctx context.Context, imsi string, payload UpdatePayload, current bson.M) (bson.M, error)

// SubscriberDeleteFn is a function that deletes a subscriber with CAS.
type SubscriberDeleteFn func(ctx context.Context, imsi string, expected bson.M) (bool, error)

// SubscriberSafeSnapshot extracts a safe snapshot from a subscriber document.
// NEVER includes security, k, op, opc, amf, or sqn.
func SubscriberSafeSnapshot(doc bson.M) SafeSnapshot {
	imsi, _ := doc["imsi"].(string)

	var msisdn []any
	if v, ok := doc["msisdn"]; ok && v != nil {
		if arr, ok := v.(bson.A); ok {
			msisdn = make([]any, len(arr))
			copy(msisdn, arr)
		} else if arr, ok := v.([]any); ok {
			msisdn = make([]any, len(arr))
			copy(msisdn, arr)
		}
	}

	ard := 0
	if v, ok := doc["access_restriction_data"]; ok {
		ard = int(toInt64OrZero(v))
	}

	nam := 0
	if v, ok := doc["network_access_mode"]; ok {
		nam = int(toInt64OrZero(v))
	}

	return SafeSnapshot{
		Imsi:                  imsi,
		Msisdn:                msisdn,
		AccessRestrictionData: ard,
		NetworkAccessMode:     nam,
		Ambr:                  doc["ambr"],
		Slices:                doc["slice"],
	}
}

// PrepareFrozenSubscriberUpdate loads a subscriber and freezes the update state.
// Matches Node prepareFrozenSubscriberUpdate() exactly.
func PrepareFrozenSubscriberUpdate(ctx context.Context, imsi string, payload UpdatePayload, lookup SubscriberLookupFn) (*FrozenSubscriberUpdate, error) {
	existing, err := lookup(ctx, imsi)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_NOT_FOUND"}
	}

	// Assert no authentication material change
	if err := assertNoAuthMaterialChange(existing, payload); err != nil {
		return nil, err
	}

	// Clean payload: never store auth material in frozen CHG
	cleaned := cleanPayload(payload)

	// Build the "after" state by applying payload to current
	after := applyPayload(existing, cleaned)

	before := SubscriberSafeSnapshot(existing)
	afterSnap := SubscriberSafeSnapshot(after)

	// Check if the update has any effect
	if stableJSON(before) == stableJSON(afterSnap) {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_NO_EFFECT"}
	}

	return &FrozenSubscriberUpdate{
		Version:              "subscriber-update-v1",
		Imsi:                 imsi,
		Before:               before,
		After:                afterSnap,
		Payload:              cleaned,
		OperationFingerprint: hashOperation("SUBSCRIBER_UPDATE", imsi, before, afterSnap),
	}, nil
}

// ExecuteFrozenSubscriberUpdate validates the precondition and applies the update.
// Matches Node executeFrozenSubscriberUpdate() exactly.
func ExecuteFrozenSubscriberUpdate(ctx context.Context, frozen *FrozenSubscriberUpdate, lookup SubscriberLookupFn, write SubscriberWriteFn) (*ExecuteResult, error) {
	if frozen == nil || frozen.Version != "subscriber-update-v1" || frozen.Imsi == "" {
		return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_UPDATE_PAYLOAD"}
	}

	current, err := lookup(ctx, frozen.Imsi)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED"}
	}

	currentSnap := SubscriberSafeSnapshot(current)
	if stableJSON(currentSnap) != stableJSON(frozen.Before) {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED"}
	}

	updated, err := write(ctx, frozen.Imsi, frozen.Payload, current)
	if err != nil {
		return nil, err
	}

	return &ExecuteResult{
		Imsi:                 frozen.Imsi,
		Before:               frozen.Before,
		After:                SubscriberSafeSnapshot(updated),
		OperationFingerprint: frozen.OperationFingerprint,
	}, nil
}

// PrepareFrozenSubscriberDelete loads a subscriber and freezes the delete state.
// Matches Node prepareFrozenSubscriberDelete() exactly.
func PrepareFrozenSubscriberDelete(ctx context.Context, imsi string, lookup SubscriberLookupFn) (*FrozenSubscriberDelete, error) {
	existing, err := lookup(ctx, imsi)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_NOT_FOUND"}
	}

	before := SubscriberSafeSnapshot(existing)
	return &FrozenSubscriberDelete{
		Version:              "subscriber-delete-v1",
		Imsi:                 imsi,
		Before:               before,
		OperationFingerprint: hashOperation("SUBSCRIBER_DELETE", imsi, before, nil),
	}, nil
}

// ExecuteFrozenSubscriberDelete validates the precondition and deletes the subscriber.
// Matches Node executeFrozenSubscriberDelete() exactly.
func ExecuteFrozenSubscriberDelete(ctx context.Context, frozen *FrozenSubscriberDelete, lookup SubscriberLookupFn, deleteFn SubscriberDeleteFn) (*ExecuteResult, error) {
	if frozen == nil || frozen.Version != "subscriber-delete-v1" || frozen.Imsi == "" {
		return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_DELETE_PAYLOAD"}
	}

	current, err := lookup(ctx, frozen.Imsi)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_DELETE_PRECONDITION_CHANGED"}
	}

	currentSnap := SubscriberSafeSnapshot(current)
	if stableJSON(currentSnap) != stableJSON(frozen.Before) {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_DELETE_PRECONDITION_CHANGED"}
	}

	deleted, err := deleteFn(ctx, frozen.Imsi, current)
	if err != nil {
		return nil, err
	}
	if !deleted {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_DELETE_PRECONDITION_CHANGED"}
	}

	return &ExecuteResult{
		Imsi:                 frozen.Imsi,
		Before:               frozen.Before,
		Deleted:              true,
		OperationFingerprint: frozen.OperationFingerprint,
	}, nil
}

// ExecuteResult is the result of executing a frozen subscriber mutation.
type ExecuteResult struct {
	Imsi                 string       `json:"imsi"`
	Before               SafeSnapshot `json:"before"`
	After                SafeSnapshot `json:"after,omitempty"`
	Deleted              bool         `json:"deleted,omitempty"`
	OperationFingerprint string       `json:"operationFingerprint"`
}

// --- internal helpers ---

func assertNoAuthMaterialChange(existing bson.M, payload UpdatePayload) error {
	if payload.Auth4G == nil {
		return nil
	}
	sec, _ := existing["security"].(bson.M)
	if sec == nil {
		sec = bson.M{}
	}
	fields := []string{"k", "op", "opc", "amf", "sqn"}
	for _, field := range fields {
		authVal, ok := payload.Auth4G[field]
		if !ok || authVal == nil {
			continue
		}
		authStr := strings.TrimSpace(fmt.Sprintf("%v", authVal))
		if authStr == "" {
			continue
		}
		currentStr := fmt.Sprintf("%v", sec[field])
		if authStr != currentStr {
			return &SubscriberGovernanceError{Code: "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED"}
		}
	}
	return nil
}

func cleanPayload(payload UpdatePayload) UpdatePayload {
	// Never store auth material in frozen CHG
	return UpdatePayload{
		Sub4G:      payload.Sub4G,
		OcsTraffic: payload.OcsTraffic,
	}
}

func applyPayload(current bson.M, payload UpdatePayload) bson.M {
	// Deep copy the current document
	result := deepCopyBsonM(current)

	if payload.Sub4G != nil {
		for k, v := range payload.Sub4G {
			if k == "ambr" || k == "slice" || k == "sliceList" || k == "msisdnList" {
				continue // Complex fields need special handling
			}
			result[k] = v
		}
		// Handle ambr
		if ambr, ok := payload.Sub4G["ambr"]; ok && ambr != nil {
			result["ambr"] = ambr
		}
		// Handle slices
		if slices, ok := payload.Sub4G["sliceList"]; ok && slices != nil {
			result["slice"] = slices
		}
		// Handle msisdn
		if msisdn, ok := payload.Sub4G["msisdnList"]; ok && msisdn != nil {
			result["msisdn"] = msisdn
		}
	}

	if payload.OcsTraffic != nil {
		ocs, _ := result["ocs_sub"].(bson.M)
		if ocs == nil {
			ocs = bson.M{}
		}
		for k, v := range payload.OcsTraffic {
			ocs[k] = v
		}
		result["ocs_sub"] = ocs
	}

	return result
}

func deepCopyBsonM(m bson.M) bson.M {
	if m == nil {
		return bson.M{}
	}
	data, _ := bson.Marshal(m)
	var out bson.M
	_ = bson.Unmarshal(data, &out)
	return out
}

// stableJSON produces a canonical JSON string with recursively sorted object keys.
// Matches Node stable() + JSON.stringify() exactly.
func stableJSON(v any) string {
	data, _ := json.Marshal(stable(v))
	return string(data)
}

// stable recursively sorts object keys to produce a canonical representation.
// Matches Node stable() function exactly: objects sorted by keys, arrays in order,
// primitives via standard JSON serialization.
// Handles map types, slices, and structs (via reflection with json tags).
func stable(value any) any {
	if value == nil {
		return nil
	}
	// Check for map types (bson.M, map[string]any, etc.)
	switch m := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		result := make(map[string]any, len(m))
		for _, k := range keys {
			result[k] = stable(m[k])
		}
		return result
	case bson.M:
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		result := make(map[string]any, len(m))
		for _, k := range keys {
			result[k] = stable(m[k])
		}
		return result
	case []any:
		result := make([]any, len(m))
		for i, item := range m {
			result[i] = stable(item)
		}
		return result
	case bson.A:
		result := make([]any, len(m))
		for i, item := range m {
			result[i] = stable(item)
		}
		return result
	default:
		// Handle structs via reflection: convert to map using json tags
		rv := reflect.ValueOf(value)
		if rv.Kind() == reflect.Ptr {
			rv = rv.Elem()
		}
		if rv.Kind() == reflect.Struct {
			result := make(map[string]any, rv.NumField())
			rt := rv.Type()
			for i := 0; i < rv.NumField(); i++ {
				field := rt.Field(i)
				if !field.IsExported() {
					continue
				}
				key := field.Tag.Get("json")
				if key == "" || key == "-" {
					key = field.Name
				}
				// Strip omitempty and other options
				if comma := strings.IndexByte(key, ','); comma >= 0 {
					key = key[:comma]
				}
				val := rv.Field(i).Interface()
				// Skip zero values for omitempty fields
				if strings.Contains(field.Tag.Get("json"), "omitempty") && rv.Field(i).IsZero() {
					continue
				}
				result[key] = stable(val)
			}
			return result
		}
		return value
	}
}

// hashOperation computes SHA256(stable({operation, imsi, before, after})).
// Matches Node hash({ operation, imsi, before, after }) exactly.
func hashOperation(operation, imsi string, before, after any) string {
	obj := map[string]any{
		"operation": operation,
		"imsi":      imsi,
		"before":    before,
	}
	if after != nil {
		obj["after"] = after
	}
	h := sha256.Sum256([]byte(stableJSON(obj)))
	return fmt.Sprintf("%x", h)
}

func toInt64OrZero(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case float32:
		return int64(n)
	default:
		return 0
	}
}

// sortedKeys returns the keys of a map in sorted order for stable serialization.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
