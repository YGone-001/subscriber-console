package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	maxSubscriberBatchTargets       = 100
	maxSubscriberBatchSnapshotBytes = 512 * 1024
)

// SubscriberChangeTarget holds a single target for batch update.
type SubscriberChangeTarget struct {
	Imsi             string         `json:"imsi"            bson:"imsi"`
	Before           map[string]any `json:"before"          bson:"before"`
	After            map[string]any `json:"after"           bson:"after"`
	PreconditionHash string         `json:"preconditionHash" bson:"preconditionHash"`
}

// FrozenBatchUpdateV2 is the v2 frozen contract for batch update.
type FrozenBatchUpdateV2 struct {
	Version              string                   `json:"version"`
	Targets              []SubscriberChangeTarget `json:"targets"`
	Patch                map[string]any           `json:"patch"`
	FieldNames           []string                 `json:"fieldNames"`
	TargetCount          int                      `json:"targetCount"`
	SnapshotBytes        int                      `json:"snapshotBytes"`
	OperationFingerprint string                   `json:"operationFingerprint"`
}

// BatchUpdateExecutionResult holds the result of a batch update execution.
type BatchUpdateExecutionResult struct {
	Requested            int      `json:"requested"`
	ModifiedImsis        []string `json:"modifiedImsis"`
	ConflictImsis        []string `json:"conflictImsis"`
	FailedImsis          []string `json:"failedImsis"`
	MatchedCount         int64    `json:"matchedCount"`
	ModifiedCount        int64    `json:"modifiedCount"`
	PartialMutation      bool     `json:"partialMutation"`
	MutationCommitted    bool     `json:"mutationCommitted"`
	FieldNames           []string `json:"fieldNames"`
	OperationFingerprint string   `json:"operationFingerprint"`
}

// BatchUpdateRequest holds the validated batch update request.
type BatchUpdateRequest struct {
	Imsis             []string
	Patch             map[string]any
	Reason            string
	TicketId          string
	MaintenanceWindow *MaintenanceWindow
}

// MaintenanceWindow holds the maintenance window configuration.
type MaintenanceWindow struct {
	Start    string `json:"start"`
	End      string `json:"end"`
	TimeZone string `json:"timeZone,omitempty"`
}

// ValidateBatchUpdateRequest validates the raw batch update request.
func ValidateBatchUpdateRequest(payload map[string]any) (*BatchUpdateRequest, error) {
	// Validate top-level keys
	allowedTopLevel := map[string]bool{"imsis": true, "patch": true, "reason": true, "ticketId": true, "maintenanceWindow": true}
	for key := range payload {
		if !allowedTopLevel[key] {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	}

	imsisRaw, ok := payload["imsis"].([]any)
	if !ok || len(imsisRaw) == 0 {
		return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}
	var imsis []string
	for _, v := range imsisRaw {
		s, ok := v.(string)
		if !ok || len(s) != 15 {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		// Validate exactly 15 ASCII digits
		for _, c := range s {
			if c < '0' || c > '9' {
				return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
		imsis = append(imsis, s)
	}
	if len(imsis) > maxSubscriberBatchTargets {
		return nil, &SubscriberGovernanceError{Code: "BATCH_SIZE_EXCEEDED"}
	}
	// Reject duplicate IMSIs
	seen := make(map[string]bool, len(imsis))
	for _, imsi := range imsis {
		if seen[imsi] {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		seen[imsi] = true
	}

	patchRaw, ok := payload["patch"].(map[string]any)
	if !ok || len(patchRaw) == 0 {
		return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}

	// Validate patch fields — only accessRestrictionData, ambr.downlink.{value,unit}, ambr.uplink.{value,unit}
	allowedPatch := map[string]bool{"accessRestrictionData": true, "ambr": true}
	for key := range patchRaw {
		if !allowedPatch[key] {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	}

	// Validate accessRestrictionData: integer 0..255
	if ard, ok := patchRaw["accessRestrictionData"]; ok {
		ardNum, ok := ard.(float64)
		if !ok || ardNum < 0 || ardNum > 255 || ardNum != float64(int(ardNum)) {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	}

	// Validate AMBR
	if ambrRaw, ok := patchRaw["ambr"].(map[string]any); ok {
		for key := range ambrRaw {
			if key != "downlink" && key != "uplink" {
				return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
		hasDirection := false
		for _, dir := range []string{"downlink", "uplink"} {
			dirRaw, ok := ambrRaw[dir]
			if !ok {
				continue
			}
			dirMap, ok := dirRaw.(map[string]any)
			if !ok {
				return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
			hasDirection = true
			// Require BOTH value and unit — partial objects rejected
			val, hasVal := dirMap["value"]
			unit, hasUnit := dirMap["unit"]
			if !hasVal || !hasUnit {
				return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
			for key := range dirMap {
				if key != "value" && key != "unit" {
					return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
				}
			}
			valNum, ok := val.(float64)
			if !ok || valNum < 1 || valNum > 10_000_000 || valNum != float64(int(valNum)) {
				return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
			unitNum, ok := unit.(float64)
			if !ok || unitNum < 0 || unitNum > 9 || unitNum != float64(int(unitNum)) {
				return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
		if !hasDirection {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	} else if patchRaw["ambr"] != nil {
		// ambr is present but not a map
		return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}

	// Validate reason: required, trim, 3..1000
	reason, _ := payload["reason"].(string)
	reason = strings.TrimSpace(reason)
	if len(reason) < 3 || len(reason) > 1000 {
		return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}

	// Validate ticketId: optional, trim, max 200
	ticketId, _ := payload["ticketId"].(string)
	ticketId = strings.TrimSpace(ticketId)
	if len(ticketId) > 200 {
		return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}

	// Section K: Validate maintenanceWindow — null/string/array/number all rejected
	var maintenanceWindow *MaintenanceWindow
	if mwPresent, hasMW := payload["maintenanceWindow"]; hasMW {
		if mwPresent == nil {
			return nil, &SubscriberGovernanceError{Code: "INVALID_BATCH_REQUEST"}
		}
		mwRaw, ok := mwPresent.(map[string]any)
		if !ok {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		// Reject unknown keys, $-prefixed keys, and dotted keys
		allowedMW := map[string]bool{"start": true, "end": true, "timeZone": true}
		for key := range mwRaw {
			if !allowedMW[key] || strings.HasPrefix(key, "$") || strings.Contains(key, ".") {
				return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
		start, _ := mwRaw["start"].(string)
		end, _ := mwRaw["end"].(string)
		if start == "" || end == "" {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		startTime, err := time.Parse(time.RFC3339, start)
		if err != nil {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		endTime, err := time.Parse(time.RFC3339, end)
		if err != nil {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		if !startTime.Before(endTime) {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		timeZone, _ := mwRaw["timeZone"].(string)
		timeZone = strings.TrimSpace(timeZone)
		if len(timeZone) > 100 {
			return nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		maintenanceWindow = &MaintenanceWindow{
			Start:    startTime.Format(time.RFC3339),
			End:      endTime.Format(time.RFC3339),
			TimeZone: timeZone,
		}
	}

	return &BatchUpdateRequest{
		Imsis:             imsis,
		Patch:             patchRaw,
		Reason:            reason,
		TicketId:          ticketId,
		MaintenanceWindow: maintenanceWindow,
	}, nil
}

// ChangedFieldNames extracts the list of top-level field names from the patch.
// Returns: access_restriction_data, ambr.downlink, ambr.uplink (matching Node contract).
func ChangedFieldNames(patch map[string]any) []string {
	var fields []string
	if _, ok := patch["accessRestrictionData"]; ok {
		fields = append(fields, "access_restriction_data")
	}
	if ambrRaw, ok := patch["ambr"].(map[string]any); ok {
		if _, ok := ambrRaw["downlink"]; ok {
			fields = append(fields, "ambr.downlink")
		}
		if _, ok := ambrRaw["uplink"]; ok {
			fields = append(fields, "ambr.uplink")
		}
	}
	sort.Strings(fields)
	return fields
}

// ComputeBatchUpdateV2Fingerprint computes the operation fingerprint for batch update v2.
func ComputeBatchUpdateV2Fingerprint(targets []SubscriberChangeTarget, patch map[string]any, fieldNames []string) string {
	targetEntries := make([]any, len(targets))
	for i, t := range targets {
		targetEntries[i] = map[string]any{
			"imsi":             t.Imsi,
			"preconditionHash": t.PreconditionHash,
			"after":            t.After,
		}
	}
	source := map[string]any{
		"operation":  "SUBSCRIBER_BATCH_UPDATE",
		"targets":    targetEntries,
		"patch":      patch,
		"fieldNames": fieldNames,
	}
	h := sha256.Sum256([]byte(stableJSON(source)))
	return fmt.Sprintf("%x", h)
}

// PrepareFrozenBatchUpdate prepares a frozen v2 batch update contract.
// SubscriberFinder is a function that finds a subscriber by IMSI.
type SubscriberFinder func(ctx context.Context, imsi string) (map[string]any, error)

func PrepareFrozenBatchUpdate(
	ctx context.Context,
	imsis []string,
	patch map[string]any,
	find SubscriberFinder,
) (*FrozenBatchUpdateV2, error) {
	fieldNames := ChangedFieldNames(patch)
	targets := make([]SubscriberChangeTarget, 0, len(imsis))
	snapshotBytes := 0

	for _, imsi := range imsis {
		sub, err := find(ctx, imsi)
		if err != nil || sub == nil {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_NOT_FOUND", Details: map[string]any{"imsi": imsi}}
		}

		before := extractUpdateFields(sub, fieldNames)
		after := applyPatch(before, patch)
		beforeHash := fingerprintMap(before)

		// No-effect check: reject if before == after
		if stableJSON(before) == stableJSON(after) {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_BATCH_NO_EFFECT", Details: map[string]any{"imsi": imsi}}
		}

		target := SubscriberChangeTarget{
			Imsi:             imsi,
			Before:           before,
			After:            after,
			PreconditionHash: beforeHash,
		}
		targets = append(targets, target)
		snapshotBytes += len(stableJSON(before)) + len(stableJSON(after))
	}

	if snapshotBytes > maxSubscriberBatchSnapshotBytes {
		return nil, &SubscriberGovernanceError{Code: "APPROVAL_SNAPSHOT_TOO_LARGE"}
	}

	// Sort targets by IMSI for deterministic fingerprint
	sort.Slice(targets, func(i, j int) bool { return targets[i].Imsi < targets[j].Imsi })

	fingerprint := ComputeBatchUpdateV2Fingerprint(targets, patch, fieldNames)

	// Compute snapshotBytes matching Node: stableJSON({ targets, patch, fieldNames, operationFingerprint })
	snapshotBytes = len(stableJSON(map[string]any{
		"targets":              targets,
		"patch":                patch,
		"fieldNames":           fieldNames,
		"operationFingerprint": fingerprint,
	}))

	return &FrozenBatchUpdateV2{
		Version:              "subscriber-batch-update-v2",
		Targets:              targets,
		Patch:                patch,
		FieldNames:           fieldNames,
		TargetCount:          len(targets),
		SnapshotBytes:        snapshotBytes,
		OperationFingerprint: fingerprint,
	}, nil
}

// Section C: expectedTouchedLeafKeys returns the sorted canonical list of leaf keys from the patch.
func expectedTouchedLeafKeys(patch map[string]any) []string {
	var keys []string
	if _, ok := patch["accessRestrictionData"]; ok {
		keys = append(keys, "access_restriction_data")
	}
	if ambrRaw, ok := patch["ambr"].(map[string]any); ok {
		for _, dir := range []string{"downlink", "uplink"} {
			if dirRaw, ok := ambrRaw[dir].(map[string]any); ok {
				if _, ok := dirRaw["value"]; ok {
					keys = append(keys, fmt.Sprintf("ambr.%s.value", dir))
				}
				if _, ok := dirRaw["unit"]; ok {
					keys = append(keys, fmt.Sprintf("ambr.%s.unit", dir))
				}
			}
		}
	}
	sort.Strings(keys)
	return keys
}

// computeExpectedAfterFromPatch computes the expected after values from the patch intent.
func computeExpectedAfterFromPatch(patch map[string]any) map[string]any {
	after := make(map[string]any)
	if ard, ok := patch["accessRestrictionData"]; ok {
		after["access_restriction_data"] = ard
	}
	if ambrRaw, ok := patch["ambr"].(map[string]any); ok {
		for _, dir := range []string{"downlink", "uplink"} {
			if dirRaw, ok := ambrRaw[dir].(map[string]any); ok {
				if val, ok := dirRaw["value"]; ok {
					after[fmt.Sprintf("ambr.%s.value", dir)] = val
				}
				if unit, ok := dirRaw["unit"]; ok {
					after[fmt.Sprintf("ambr.%s.unit", dir)] = unit
				}
			}
		}
	}
	return after
}

// AssertFrozenBatchUpdateV2 validates the frozen batch update contract integrity.
func AssertFrozenBatchUpdateV2(frozen *FrozenBatchUpdateV2) error {
	if frozen == nil {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}
	if frozen.Version != "subscriber-batch-update-v2" {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}
	if frozen.TargetCount < 1 || frozen.TargetCount > maxSubscriberBatchTargets {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}
	if len(frozen.Targets) != frozen.TargetCount {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}

	// Validate patch allowlist
	allowedTopLevel := map[string]bool{"accessRestrictionData": true, "ambr": true}
	for key := range frozen.Patch {
		if !allowedTopLevel[key] {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	}

	// Validate fieldNames derivation
	expectedFields := ChangedFieldNames(frozen.Patch)
	if len(frozen.FieldNames) != len(expectedFields) {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}
	for i, f := range frozen.FieldNames {
		if f != expectedFields[i] {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	}

	// Section F: Frozen IMSI validation — ValidateImsi checks 15 ASCII digits
	imsis := make([]string, len(frozen.Targets))
	for i, t := range frozen.Targets {
		if _, err := ValidateImsi(t.Imsi); err != nil {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		imsis[i] = t.Imsi
	}
	seen := make(map[string]bool, len(imsis))
	for _, imsi := range imsis {
		if seen[imsi] {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		seen[imsi] = true
	}
	sortedImsis := make([]string, len(imsis))
	copy(sortedImsis, imsis)
	sort.Strings(sortedImsis)
	for i, imsi := range imsis {
		if imsi != sortedImsis[i] {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	}

	// Compute expected after values from patch intent
	expectedAfter := computeExpectedAfterFromPatch(frozen.Patch)

	// Validate each target
	for _, t := range frozen.Targets {
		if t.Before == nil || t.After == nil || t.PreconditionHash == "" {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		// Recompute preconditionHash
		expectedHash := fingerprintMap(t.Before)
		if expectedHash != t.PreconditionHash {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		// Section D: Exact leaf-key set equality — before and after must exactly match expected keys
		expectedKeys := expectedTouchedLeafKeys(frozen.Patch)
		beforeKeys := sortedKeys(t.Before)
		afterKeys := sortedKeys(t.After)
		if strings.Join(beforeKeys, ",") != strings.Join(afterKeys, ",") {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		if strings.Join(beforeKeys, ",") != strings.Join(expectedKeys, ",") {
			return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		// Validate after values EXACTLY match patch intent
		for key, val := range expectedAfter {
			if t.After[key] != val {
				return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
		for key := range t.After {
			if _, ok := expectedAfter[key]; !ok {
				return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
	}

	// Recompute snapshotBytes exactly
	expectedSnapshotBytes := len(stableJSON(map[string]any{
		"targets":              frozen.Targets,
		"patch":                frozen.Patch,
		"fieldNames":           frozen.FieldNames,
		"operationFingerprint": frozen.OperationFingerprint,
	}))
	if frozen.SnapshotBytes != expectedSnapshotBytes {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}
	// Section H: Authoritative snapshot cap — enforced after exact recomputation
	if frozen.SnapshotBytes > maxSubscriberBatchSnapshotBytes {
		return &SubscriberGovernanceError{Code: "APPROVAL_SNAPSHOT_TOO_LARGE"}
	}

	// Recompute fingerprint
	expectedFp := ComputeBatchUpdateV2Fingerprint(frozen.Targets, frozen.Patch, frozen.FieldNames)
	if frozen.OperationFingerprint != expectedFp {
		return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}

	return nil
}

// BatchUpdateStore abstracts the data access for batch update execution.
// Enables deterministic testing without Mongo.
type BatchUpdateStore interface {
	// LoadBatchUpdateTarget loads the current state of a subscriber target.
	// Returns nil map if subscriber not found.
	LoadBatchUpdateTarget(ctx context.Context, imsi string) (map[string]any, error)

	// ConditionalUpdateBatchTarget performs a compare-and-swap update.
	// matched=0 means precondition mismatch (CAS conflict).
	ConditionalUpdateBatchTarget(ctx context.Context, imsi string, expected map[string]any, next map[string]any) (matched int64, modified int64, err error)
}

// Ensure Repository implements BatchUpdateStore.
var _ BatchUpdateStore = (*Repository)(nil)

// LoadBatchUpdateTarget loads subscriber fields for CAS.
func (r *Repository) LoadBatchUpdateTarget(ctx context.Context, imsi string) (map[string]any, error) {
	sub, err := r.FindSubscriberByImsi(ctx, imsi)
	if err != nil {
		return nil, err
	}
	if sub == nil {
		return nil, nil
	}
	return sub, nil
}

// ConditionalUpdateBatchTarget performs a CAS update on a subscriber.
func (r *Repository) ConditionalUpdateBatchTarget(ctx context.Context, imsi string, expected map[string]any, next map[string]any) (int64, int64, error) {
	filter := bson.M{"imsi": imsi}
	for key, val := range expected {
		filter[key] = val
	}
	update := bson.M{"$set": next}
	res, err := r.subscribers.UpdateOne(ctx, filter, update)
	if err != nil {
		return 0, 0, err
	}
	return res.MatchedCount, res.ModifiedCount, nil
}

// ClassifyBatchUpdateResult classifies the execution result.
func ClassifyBatchUpdateResult(modifiedCount int64, requested int, conflictCount, failedCount int) string {
	// SUCCESS: modified == requested AND conflicts == 0 AND failures == 0
	if modifiedCount == int64(requested) && conflictCount == 0 && failedCount == 0 {
		return "SUCCESS"
	}
	// PARTIAL_WRITE: modified > 0 AND (conflicts > 0 OR failures > 0)
	if modifiedCount > 0 {
		return "PARTIAL_WRITE"
	}
	// FAILED_NO_MUTATION: modified == 0 AND (conflicts > 0 OR failures > 0)
	return "FAILED_NO_MUTATION"
}

// ExecuteFrozenSubscriberBatchUpdate executes a frozen v2 batch update with per-target CAS.
// Architecture: assert frozen → all-target preflight → final per-target CAS.
// The preflight barrier is independent of the final CAS (race may occur between them).
func ExecuteFrozenSubscriberBatchUpdate(
	ctx context.Context,
	frozen *FrozenBatchUpdateV2,
	store BatchUpdateStore,
) (*BatchUpdateExecutionResult, error) {
	if err := AssertFrozenBatchUpdateV2(frozen); err != nil {
		return nil, err
	}

	// Phase 1: ALL-TARGET PRECONDITION BARRIER
	// Load every target, recompute precondition hash, reject if ANY missing/drifted.
	// Zero writes on visible drift.
	for _, target := range frozen.Targets {
		current, err := store.LoadBatchUpdateTarget(ctx, target.Imsi)
		if err != nil {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_BATCH_UPDATE_FAILED", Details: map[string]any{"imsi": target.Imsi, "error": err.Error()}}
		}
		if current == nil {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_BATCH_PRECONDITION_CHANGED", Details: map[string]any{"imsi": target.Imsi, "reason": "not_found"}}
		}
		// Recompute before hash from live state
		currentBefore := extractUpdateFields(current, frozen.FieldNames)
		currentHash := fingerprintMap(currentBefore)
		if currentHash != target.PreconditionHash {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_BATCH_PRECONDITION_CHANGED", Details: map[string]any{"imsi": target.Imsi, "reason": "drifted"}}
		}
	}

	// Phase 2: FINAL PER-TARGET CAS (independent of preflight — race may occur)
	result := &BatchUpdateExecutionResult{
		Requested:            len(frozen.Targets),
		FieldNames:           frozen.FieldNames,
		OperationFingerprint: frozen.OperationFingerprint,
	}

	for _, target := range frozen.Targets {
		matched, modified, err := store.ConditionalUpdateBatchTarget(ctx, target.Imsi, target.Before, target.After)
		if err != nil {
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			continue
		}

		if matched == 0 {
			// CAS conflict — subscriber state changed between preflight and now
			result.ConflictImsis = append(result.ConflictImsis, target.Imsi)
		} else if modified > 0 {
			result.ModifiedImsis = append(result.ModifiedImsis, target.Imsi)
			result.MatchedCount += matched
			result.ModifiedCount += modified
		} else {
			// Matched but not modified (values already equal)
			result.ModifiedImsis = append(result.ModifiedImsis, target.Imsi)
			result.MatchedCount += matched
		}
	}

	classification := ClassifyBatchUpdateResult(result.ModifiedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis))
	result.PartialMutation = classification == "PARTIAL_WRITE"
	result.MutationCommitted = result.ModifiedCount > 0

	return result, nil
}

// extractUpdateFields extracts the fields to update from a subscriber document.
// Returns flattened values matching Node: access_restriction_data, ambr.downlink.value, etc.
func extractUpdateFields(sub map[string]any, fieldNames []string) map[string]any {
	result := make(map[string]any)
	for _, field := range fieldNames {
		if field == "access_restriction_data" {
			if v, ok := sub["access_restriction_data"]; ok {
				result["access_restriction_data"] = v
			}
		} else if field == "ambr.downlink" || field == "ambr.uplink" {
			// Extract flattened ambr values: ambr.downlink.value, ambr.downlink.unit, etc.
			dir := strings.TrimPrefix(field, "ambr.")
			if ambr, ok := sub["ambr"].(map[string]any); ok {
				if dirMap, ok := ambr[dir].(map[string]any); ok {
					if v, ok := dirMap["value"]; ok {
						result[fmt.Sprintf("ambr.%s.value", dir)] = v
					}
					if v, ok := dirMap["unit"]; ok {
						result[fmt.Sprintf("ambr.%s.unit", dir)] = v
					}
				}
			}
		}
	}
	return result
}

// applyPatch applies the patch to the before values, returning the after values.
// Returns flattened values matching Node: access_restriction_data, ambr.downlink.value, etc.
func applyPatch(before map[string]any, patch map[string]any) map[string]any {
	result := make(map[string]any)
	for k, v := range before {
		result[k] = v
	}
	if ard, ok := patch["accessRestrictionData"]; ok {
		result["access_restriction_data"] = ard
	}
	if ambrRaw, ok := patch["ambr"].(map[string]any); ok {
		for _, dir := range []string{"downlink", "uplink"} {
			if dirRaw, ok := ambrRaw[dir].(map[string]any); ok {
				if val, ok := dirRaw["value"]; ok {
					result[fmt.Sprintf("ambr.%s.value", dir)] = val
				}
				if unit, ok := dirRaw["unit"]; ok {
					result[fmt.Sprintf("ambr.%s.unit", dir)] = unit
				}
			}
		}
	}
	return result
}

// fingerprintMap computes a SHA-256 fingerprint of a map.
func fingerprintMap(m map[string]any) string {
	h := sha256.Sum256([]byte(stableJSON(m)))
	return fmt.Sprintf("%x", h)
}

// splitField splits a dotted field name into parts.
func splitField(field string) []string {
	var parts []string
	current := ""
	for _, c := range field {
		if c == '.' {
			parts = append(parts, current)
			current = ""
		} else {
			current += string(c)
		}
	}
	if current != "" {
		parts = append(parts, current)
	}
	return parts
}

// anyFieldMatches checks if a field name matches any in the list (exact or prefix).
func anyFieldMatches(fields []string, key string) bool {
	for _, f := range fields {
		if key == f || len(key) > len(f) && key[:len(f)+1] == f+"." {
			return true
		}
	}
	return false
}
