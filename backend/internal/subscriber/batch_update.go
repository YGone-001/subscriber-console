package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	maxSubscriberBatchTargets      = 100
	maxSubscriberBatchSnapshotBytes = 512 * 1024
)

// SubscriberChangeTarget holds a single target for batch update.
type SubscriberChangeTarget struct {
	Imsi            string            `json:"imsi"            bson:"imsi"`
	Before          map[string]any    `json:"before"          bson:"before"`
	After           map[string]any    `json:"after"           bson:"after"`
	PreconditionHash string           `json:"preconditionHash" bson:"preconditionHash"`
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
	Requested          int      `json:"requested"`
	ModifiedImsis      []string `json:"modifiedImsis"`
	ConflictImsis      []string `json:"conflictImsis"`
	FailedImsis        []string `json:"failedImsis"`
	MatchedCount       int64    `json:"matchedCount"`
	ModifiedCount      int64    `json:"modifiedCount"`
	PartialMutation    bool     `json:"partialMutation"`
	MutationCommitted  bool     `json:"mutationCommitted"`
	FieldNames         []string `json:"fieldNames"`
	OperationFingerprint string `json:"operationFingerprint"`
}

// ValidateBatchUpdateRequest validates the raw batch update request.
func ValidateBatchUpdateRequest(payload map[string]any) (imsis []string, patch map[string]any, err error) {
	imsisRaw, ok := payload["imsis"].([]any)
	if !ok || len(imsisRaw) == 0 {
		return nil, nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}
	for _, v := range imsisRaw {
		s, ok := v.(string)
		if !ok || len(s) != 15 {
			return nil, nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
		imsis = append(imsis, s)
	}
	if len(imsis) > maxSubscriberBatchTargets {
		return nil, nil, &SubscriberGovernanceError{Code: "BATCH_SIZE_EXCEEDED"}
	}

	patchRaw, ok := payload["patch"].(map[string]any)
	if !ok || len(patchRaw) == 0 {
		return nil, nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
	}

	// Validate patch fields — only accessRestrictionData, ambr.downlink.{value,unit}, ambr.uplink.{value,unit}
	allowedTopLevel := map[string]bool{"accessRestrictionData": true, "ambr": true}
	for key := range patchRaw {
		if !allowedTopLevel[key] {
			return nil, nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
		}
	}

	if ambrRaw, ok := patchRaw["ambr"].(map[string]any); ok {
		for key := range ambrRaw {
			if key != "downlink" && key != "uplink" {
				return nil, nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
		for _, dir := range []string{"downlink", "uplink"} {
			if dirRaw, ok := ambrRaw[dir].(map[string]any); ok {
				for key := range dirRaw {
					if key != "value" && key != "unit" {
						return nil, nil, &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
					}
				}
			}
		}
	}

	return imsis, patchRaw, nil
}

// ChangedFieldNames extracts the list of top-level field names from the patch.
func ChangedFieldNames(patch map[string]any) []string {
	var fields []string
	for key := range patch {
		if key == "ambr" {
			ambrRaw, ok := patch["ambr"].(map[string]any)
			if !ok {
				continue
			}
			for _, dir := range []string{"downlink", "uplink"} {
				if dirRaw, ok := ambrRaw[dir].(map[string]any); ok {
					for prop := range dirRaw {
						fields = append(fields, fmt.Sprintf("ambr.%s.%s", dir, prop))
					}
				}
			}
		} else {
			fields = append(fields, key)
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
			"imsi":            t.Imsi,
			"preconditionHash": t.PreconditionHash,
			"after":           t.After,
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
func PrepareFrozenBatchUpdate(
	ctx context.Context,
	imsis []string,
	patch map[string]any,
	repo *Repository,
) (*FrozenBatchUpdateV2, error) {
	fieldNames := ChangedFieldNames(patch)
	targets := make([]SubscriberChangeTarget, 0, len(imsis))
	snapshotBytes := 0

	for _, imsi := range imsis {
		sub, err := repo.FindSubscriberByImsi(ctx, imsi)
		if err != nil || sub == nil {
			return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_NOT_FOUND", Details: map[string]any{"imsi": imsi}}
		}

		before := extractUpdateFields(sub, fieldNames)
		after := applyPatch(before, patch)
		beforeHash := fingerprintMap(before)

		target := SubscriberChangeTarget{
			Imsi:            imsi,
			Before:          before,
			After:           after,
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

	// Validate target ordering and uniqueness
	imsis := make([]string, len(frozen.Targets))
	for i, t := range frozen.Targets {
		if len(t.Imsi) != 15 {
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
		// Validate after values
		for key := range t.After {
			if !anyFieldMatches(frozen.FieldNames, key) {
				return &SubscriberGovernanceError{Code: "INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD"}
			}
		}
	}

	// Validate snapshotBytes
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

// ClassifyBatchUpdateResult classifies the execution result.
func ClassifyBatchUpdateResult(modifiedCount int64, requested int, conflictCount, failedCount int) string {
	if modifiedCount == int64(requested) {
		return "SUCCESS"
	}
	if modifiedCount > 0 {
		return "PARTIAL_WRITE"
	}
	return "FAILED_NO_MUTATION"
}

// ExecuteFrozenSubscriberBatchUpdate executes a frozen v2 batch update with per-target CAS.
func ExecuteFrozenSubscriberBatchUpdate(
	ctx context.Context,
	frozen *FrozenBatchUpdateV2,
	repo *Repository,
) (*BatchUpdateExecutionResult, error) {
	if err := AssertFrozenBatchUpdateV2(frozen); err != nil {
		return nil, err
	}

	result := &BatchUpdateExecutionResult{
		Requested:          len(frozen.Targets),
		FieldNames:         frozen.FieldNames,
		OperationFingerprint: frozen.OperationFingerprint,
	}

	for _, target := range frozen.Targets {
		// CAS: filter with {imsi, ...expected_before}, $set after, upsert: false
		filter := bson.M{"imsi": target.Imsi}
		for key, val := range target.Before {
			filter[key] = val
		}

		update := bson.M{"$set": target.After}
		res, err := repo.subscribers.UpdateOne(ctx, filter, update)
		if err != nil {
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			continue
		}

		if res.MatchedCount == 0 {
			// Precondition mismatch — subscriber state changed
			result.ConflictImsis = append(result.ConflictImsis, target.Imsi)
		} else if res.ModifiedCount > 0 {
			result.ModifiedImsis = append(result.ModifiedImsis, target.Imsi)
			result.MatchedCount += res.MatchedCount
			result.ModifiedCount += res.ModifiedCount
		} else {
			// Matched but not modified (values already equal)
			result.ModifiedImsis = append(result.ModifiedImsis, target.Imsi)
			result.MatchedCount += res.MatchedCount
		}
	}

	classification := ClassifyBatchUpdateResult(result.ModifiedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis))
	result.PartialMutation = classification == "PARTIAL_WRITE"
	result.MutationCommitted = result.ModifiedCount > 0

	return result, nil
}

// extractUpdateFields extracts the fields to update from a subscriber document.
func extractUpdateFields(sub map[string]any, fieldNames []string) map[string]any {
	result := make(map[string]any)
	for _, field := range fieldNames {
		if field == "accessRestrictionData" {
			if v, ok := sub["access_restriction_data"]; ok {
				result["access_restriction_data"] = v
			}
		} else {
			// Nested ambr fields like ambr.downlink.value
			parts := splitField(field)
			if len(parts) == 3 && parts[0] == "ambr" {
				if ambr, ok := sub["ambr"].(map[string]any); ok {
					if dir, ok := ambr[parts[1]].(map[string]any); ok {
						if v, ok := dir[parts[2]]; ok {
							if result["ambr"] == nil {
								result["ambr"] = map[string]any{}
							}
							ambrMap := result["ambr"].(map[string]any)
							if ambrMap[parts[1]] == nil {
								ambrMap[parts[1]] = map[string]any{}
							}
							ambrMap[parts[1]].(map[string]any)[parts[2]] = v
						}
					}
				}
			}
		}
	}
	return result
}

// applyPatch applies the patch to the before values, returning the after values.
func applyPatch(before map[string]any, patch map[string]any) map[string]any {
	result := make(map[string]any)
	for k, v := range before {
		result[k] = v
	}
	for key, val := range patch {
		if key == "ambr" {
			patchAmbr, ok := val.(map[string]any)
			if !ok {
				continue
			}
			if result["ambr"] == nil {
				result["ambr"] = map[string]any{}
			}
			resultAmbr := result["ambr"].(map[string]any)
			for dir, dirVal := range patchAmbr {
				patchDir, ok := dirVal.(map[string]any)
				if !ok {
					continue
				}
				if resultAmbr[dir] == nil {
					resultAmbr[dir] = map[string]any{}
				}
				resultDir := resultAmbr[dir].(map[string]any)
				for prop, propVal := range patchDir {
					resultDir[prop] = propVal
				}
			}
		} else if key == "accessRestrictionData" {
			result["access_restriction_data"] = val
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
