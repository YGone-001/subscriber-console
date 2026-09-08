package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	maxBulkDeleteTargets       = 5000
	maxBulkDeleteSnapshotBytes = 512 * 1024

	// Error codes for bulk delete
	ErrInvalidBulkDeleteRequest      = "INVALID_BULK_DELETE_REQUEST"
	ErrInvalidFrozenBulkDelete       = "INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD"
	ErrBulkDeletePreconditionChanged = "SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED"
	ErrBulkDeletePartialWrite        = "SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE"
	ErrBulkDeleteFailed              = "SUBSCRIBER_BULK_DELETE_FAILED"
)

// FrozenBulkDeleteTarget holds a single target for bulk delete.
type FrozenBulkDeleteTarget struct {
	Imsi             string         `json:"imsi"             bson:"imsi"`
	Before           map[string]any `json:"before"           bson:"before"`
	PreconditionHash string         `json:"preconditionHash" bson:"preconditionHash"`
}

// FrozenBulkDeleteV2 is the v2 frozen contract for bulk delete.
type FrozenBulkDeleteV2 struct {
	Version              string                   `json:"version"`
	Targets              []FrozenBulkDeleteTarget `json:"targets"`
	TargetCount          int                      `json:"targetCount"`
	SnapshotBytes        int                      `json:"snapshotBytes"`
	Strategy             string                   `json:"strategy"`
	OperationFingerprint string                   `json:"operationFingerprint"`
}

// BulkDeleteExecutionResult holds the result of a bulk delete execution.
type BulkDeleteExecutionResult struct {
	Requested             int      `json:"requested"`
	DeletedImsis          []string `json:"deletedImsis"`
	ConflictImsis         []string `json:"conflictImsis"`
	FailedImsis           []string `json:"failedImsis"`
	OcsCleanedImsis       []string `json:"ocsCleanedImsis"`
	OcsCleanupFailedImsis []string `json:"ocsCleanupFailedImsis"`
	DeletedCount          int      `json:"deletedCount"`
	PartialMutation       bool     `json:"partialMutation"`
	MutationCommitted     bool     `json:"mutationCommitted"`
	OperationFingerprint  string   `json:"operationFingerprint"`
}

// BulkDeleteRequest holds the validated bulk delete request.
type BulkDeleteRequest struct {
	ImsiList []string
}

// ValidateBulkDeleteRequest validates the raw bulk delete request.
func ValidateBulkDeleteRequest(payload map[string]any) (*BulkDeleteRequest, error) {
	// Validate top-level keys
	allowedTopLevel := map[string]bool{"imsiList": true}
	for key := range payload {
		if !allowedTopLevel[key] {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidBulkDeleteRequest}
		}
	}

	// Validate imsiList
	imsiListRaw, ok := payload["imsiList"].([]any)
	if !ok || len(imsiListRaw) == 0 {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidBulkDeleteRequest}
	}

	var imsiList []string
	for _, v := range imsiListRaw {
		s, ok := v.(string)
		if !ok || len(s) != 15 {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidBulkDeleteRequest}
		}
		// Validate each character is ASCII digit
		for _, c := range s {
			if c < '0' || c > '9' {
				return nil, &SubscriberGovernanceError{Code: ErrInvalidBulkDeleteRequest}
			}
		}
		imsiList = append(imsiList, s)
	}

	// Check max targets
	if len(imsiList) > maxBulkDeleteTargets {
		return nil, &SubscriberGovernanceError{Code: ErrBatchSizeExceeded}
	}

	// Check for duplicates
	seen := make(map[string]bool)
	for _, imsi := range imsiList {
		if seen[imsi] {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidBulkDeleteRequest}
		}
		seen[imsi] = true
	}

	return &BulkDeleteRequest{ImsiList: imsiList}, nil
}

// OcsCleanupFunc is the function type for OCS cleanup.
type OcsCleanupFunc func(ctx context.Context, imsi string) error

// PrepareFrozenBulkDelete prepares a frozen v2 bulk delete payload.
func PrepareFrozenBulkDelete(ctx context.Context, imsiList []string, repo *Repository) (*FrozenBulkDeleteV2, error) {
	// Sort IMSIs ascending
	sorted := make([]string, len(imsiList))
	copy(sorted, imsiList)
	sort.Strings(sorted)

	// Load all targets and compute safe snapshots
	targets := make([]FrozenBulkDeleteTarget, 0, len(sorted))
	for _, imsi := range sorted {
		doc, err := repo.FindSubscriberByImsi(ctx, imsi)
		if err != nil {
			return nil, err
		}
		if doc == nil {
			return nil, &SubscriberGovernanceError{
				Code:    "SUBSCRIBER_NOT_FOUND",
				Details: map[string]any{"imsi": imsi},
			}
		}

		// Extract safe snapshot (no sensitive fields)
		before := subscriberSafeSnapshot(doc)
		preconditionHash := computeHash(before)

		targets = append(targets, FrozenBulkDeleteTarget{
			Imsi:             imsi,
			Before:           before,
			PreconditionHash: preconditionHash,
		})
	}

	// Compute operation fingerprint
	fingerprint := computeBulkDeleteFingerprint(targets)

	// Compute snapshot bytes
	snapshotBytes := computeBulkDeleteSnapshotBytes(targets, fingerprint)

	return &FrozenBulkDeleteV2{
		Version:              "subscriber-bulk-delete-v2",
		Targets:              targets,
		TargetCount:          len(targets),
		SnapshotBytes:        snapshotBytes,
		Strategy:             "delete-only",
		OperationFingerprint: fingerprint,
	}, nil
}

// AssertFrozenBulkDeleteV2 validates a frozen v2 bulk delete payload.
func AssertFrozenBulkDeleteV2(payload map[string]any) (*FrozenBulkDeleteV2, error) {
	// Version check
	version, _ := payload["version"].(string)
	if version != "subscriber-bulk-delete-v2" {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// TargetCount validation
	targetCount, _ := payload["targetCount"].(float64)
	if targetCount < 1 || targetCount > float64(maxBulkDeleteTargets) {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// Targets validation
	targetsRaw, ok := payload["targets"].([]any)
	if !ok || len(targetsRaw) == 0 {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// TargetCount must match targets length
	if int(targetCount) != len(targetsRaw) {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// Strategy check
	strategy, _ := payload["strategy"].(string)
	if strategy != "delete-only" {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// Parse targets
	targets := make([]FrozenBulkDeleteTarget, 0, len(targetsRaw))
	imsiSet := make(map[string]bool)
	var prevImsi string
	for _, item := range targetsRaw {
		targetMap, ok := item.(map[string]any)
		if !ok {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
		}

		imsi, _ := targetMap["imsi"].(string)
		if len(imsi) != 15 {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
		}
		for _, c := range imsi {
			if c < '0' || c > '9' {
				return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
			}
		}

		// Check sorted ascending
		if prevImsi != "" && imsi <= prevImsi {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
		}
		prevImsi = imsi

		// Check unique
		if imsiSet[imsi] {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
		}
		imsiSet[imsi] = true

		// Before must exist
		before, ok := targetMap["before"].(map[string]any)
		if !ok || len(before) == 0 {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
		}

		// Check no sensitive fields in before
		sensitiveFields := []string{"k", "op", "opc", "amf", "sqn", "security"}
		for _, field := range sensitiveFields {
			if _, exists := before[field]; exists {
				return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
			}
		}

		// Verify preconditionHash
		preconditionHash, _ := targetMap["preconditionHash"].(string)
		expectedHash := computeHash(before)
		if preconditionHash != expectedHash {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
		}

		targets = append(targets, FrozenBulkDeleteTarget{
			Imsi:             imsi,
			Before:           before,
			PreconditionHash: preconditionHash,
		})
	}

	// Verify operationFingerprint
	fingerprint, _ := payload["operationFingerprint"].(string)
	expectedFingerprint := computeBulkDeleteFingerprint(targets)
	if fingerprint != expectedFingerprint {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// Verify snapshotBytes
	snapshotBytes, _ := payload["snapshotBytes"].(float64)
	expectedSnapshotBytes := computeBulkDeleteSnapshotBytes(targets, fingerprint)
	if int(snapshotBytes) != expectedSnapshotBytes {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// Check snapshot size limit
	if int(snapshotBytes) > maxBulkDeleteSnapshotBytes {
		return nil, &SubscriberGovernanceError{Code: ErrApprovalSnapshotTooLarge}
	}

	return &FrozenBulkDeleteV2{
		Version:              version,
		Targets:              targets,
		TargetCount:          int(targetCount),
		SnapshotBytes:        int(snapshotBytes),
		Strategy:             strategy,
		OperationFingerprint: fingerprint,
	}, nil
}

// ClassifyBulkDeleteResult classifies the execution result.
func ClassifyBulkDeleteResult(deletedCount, requested, conflictCount, failedCount, ocsCleanupFailureCount int) string {
	if deletedCount == requested && conflictCount == 0 && failedCount == 0 && ocsCleanupFailureCount == 0 {
		return "SUCCESS"
	}
	if deletedCount > 0 {
		return "PARTIAL_WRITE"
	}
	return "FAILED_NO_MUTATION"
}

// ExecuteFrozenBulkDelete executes a frozen bulk delete with CAS and OCS cleanup separation.
func ExecuteFrozenBulkDelete(ctx context.Context, frozen *FrozenBulkDeleteV2, repo *Repository, ocsCleanup OcsCleanupFunc) (*BulkDeleteExecutionResult, error) {
	result := &BulkDeleteExecutionResult{
		Requested:             frozen.TargetCount,
		OperationFingerprint:  frozen.OperationFingerprint,
		DeletedImsis:          []string{},
		ConflictImsis:         []string{},
		FailedImsis:           []string{},
		OcsCleanedImsis:       []string{},
		OcsCleanupFailedImsis: []string{},
	}

	// All-target precondition barrier
	for _, target := range frozen.Targets {
		current, err := repo.FindSubscriberByImsi(ctx, target.Imsi)
		if err != nil {
			return result, &SubscriberGovernanceError{
				Code:    ErrBulkDeleteFailed,
				Details: map[string]any{"error": err.Error()},
			}
		}
		if current == nil {
			result.ConflictImsis = append(result.ConflictImsis, target.Imsi)
			continue
		}

		// Verify precondition
		currentSnapshot := SubscriberSafeSnapshot(current)
		currentHash := computeHash(currentSnapshot)
		if currentHash != target.PreconditionHash {
			result.ConflictImsis = append(result.ConflictImsis, target.Imsi)
		}
	}

	// If any conflicts detected, fail before any deletion
	if len(result.ConflictImsis) > 0 {
		return result, &SubscriberGovernanceError{
			Code: ErrBulkDeletePreconditionChanged,
			Details: map[string]any{
				"conflictImsis": result.ConflictImsis,
				"committed":     false,
			},
		}
	}

	// Execute per-target CAS deletion
	for _, target := range frozen.Targets {
		// Re-read current state for final CAS
		current, err := repo.FindSubscriberByImsi(ctx, target.Imsi)
		if err != nil {
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			result.PartialMutation = len(result.DeletedImsis) > 0
			result.MutationCommitted = len(result.DeletedImsis) > 0
			continue
		}
		if current == nil {
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			result.PartialMutation = len(result.DeletedImsis) > 0
			result.MutationCommitted = len(result.DeletedImsis) > 0
			continue
		}

		// Final CAS check
		currentSnapshot := SubscriberSafeSnapshot(current)
		currentHash := computeHash(currentSnapshot)
		if currentHash != target.PreconditionHash {
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			result.PartialMutation = len(result.DeletedImsis) > 0
			result.MutationCommitted = len(result.DeletedImsis) > 0
			continue
		}

		// CAS delete - use expected document state
		deleted, err := repo.DeleteSubscriberCAS(ctx, target.Imsi, current)
		if err != nil {
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			result.PartialMutation = len(result.DeletedImsis) > 0
			result.MutationCommitted = len(result.DeletedImsis) > 0
			continue
		}
		if !deleted {
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			result.PartialMutation = len(result.DeletedImsis) > 0
			result.MutationCommitted = len(result.DeletedImsis) > 0
			continue
		}

		// Subscriber deleted successfully
		result.DeletedImsis = append(result.DeletedImsis, target.Imsi)
		result.DeletedCount++
		result.MutationCommitted = true

		// OCS cleanup - separate from subscriber deletion
		if ocsCleanup != nil {
			if err := ocsCleanup(ctx, target.Imsi); err != nil {
				result.OcsCleanupFailedImsis = append(result.OcsCleanupFailedImsis, target.Imsi)
			} else {
				result.OcsCleanedImsis = append(result.OcsCleanedImsis, target.Imsi)
			}
		}
	}

	// Final classification
	result.PartialMutation = result.DeletedCount > 0 && result.DeletedCount < result.Requested

	return result, nil
}

// computeHash computes SHA256 hash of stable JSON.
func computeHash(value any) string {
	stable := stableJSON(value)
	hash := sha256.Sum256([]byte(stable))
	return fmt.Sprintf("%x", hash)
}

// computeBulkDeleteFingerprint computes the operation fingerprint.
func computeBulkDeleteFingerprint(targets []FrozenBulkDeleteTarget) string {
	fp := map[string]any{
		"operation": "SUBSCRIBER_BULK_DELETE",
		"targets":   make([]map[string]any, len(targets)),
		"strategy":  "delete-only",
	}
	targetList := fp["targets"].([]map[string]any)
	for i, t := range targets {
		targetList[i] = map[string]any{
			"imsi":             t.Imsi,
			"preconditionHash": t.PreconditionHash,
		}
	}
	return computeHash(fp)
}

// computeBulkDeleteSnapshotBytes computes the snapshot size.
func computeBulkDeleteSnapshotBytes(targets []FrozenBulkDeleteTarget, fingerprint string) int {
	snapshot := map[string]any{
		"targets":              targets,
		"strategy":             "delete-only",
		"operationFingerprint": fingerprint,
	}
	return len(stableJSON(snapshot))
}

// subscriberSafeSnapshot extracts safe snapshot from subscriber document (bulk_delete version).
func subscriberSafeSnapshot(doc map[string]any) map[string]any {
	snapshot := make(map[string]any)
	sensitiveFields := map[string]bool{
		"k": true, "op": true, "opc": true, "amf": true, "sqn": true,
		"security": true, "_id": true, "password": true,
	}
	for k, v := range doc {
		if !sensitiveFields[k] {
			snapshot[k] = v
		}
	}
	return snapshot
}

// DeleteSubscriberCAS deletes a subscriber with CAS (Compare-And-Swap).
func (r *Repository) DeleteSubscriberCAS(ctx context.Context, imsi string, expected map[string]any) (bool, error) {
	collection := r.subscribers

	// Build filter from expected state (excluding _id)
	filter := bson.M{"imsi": imsi}
	for k, v := range expected {
		if k != "_id" && k != "imsi" {
			filter[k] = v
		}
	}

	result, err := collection.DeleteOne(ctx, filter)
	if err != nil {
		return false, err
	}
	return result.DeletedCount > 0, nil
}
