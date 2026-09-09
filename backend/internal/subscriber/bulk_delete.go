package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// BulkDeleteRepository defines the interface for bulk delete operations.
// This allows test doubles to be used instead of the concrete Repository.
type BulkDeleteRepository interface {
	FindSubscriberByImsi(ctx context.Context, imsi string) (bson.M, error)
	DeleteSubscriberCAS(ctx context.Context, imsi string, expected bson.M) (bool, error)
}

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
// Uses canonical SafeSnapshot from frozen.go.
type FrozenBulkDeleteTarget struct {
	Imsi             string       `json:"imsi"             bson:"imsi"`
	Before           SafeSnapshot `json:"before"           bson:"before"`
	PreconditionHash string       `json:"preconditionHash" bson:"preconditionHash"`
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
// Uses canonical SubscriberSafeSnapshot from frozen.go.
func PrepareFrozenBulkDelete(ctx context.Context, imsiList []string, repo BulkDeleteRepository) (*FrozenBulkDeleteV2, error) {
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

		// Use canonical SafeSnapshot (excludes security/k/op/opc/amf/sqn)
		before := SubscriberSafeSnapshot(doc)
		preconditionHash := computeBulkDeleteHash(before)

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

	// Enforce snapshot cap at prepare time (Section 26)
	if snapshotBytes > maxBulkDeleteSnapshotBytes {
		return nil, &SubscriberGovernanceError{Code: ErrApprovalSnapshotTooLarge}
	}

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
// Handles bson.A, bson.M, bson.D for BSON-safe decoding (Section 27).
func AssertFrozenBulkDeleteV2(payload map[string]any) (*FrozenBulkDeleteV2, error) {
	// Version check
	version, _ := payload["version"].(string)
	if version != "subscriber-bulk-delete-v2" {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// TargetCount validation
	targetCount, _ := toFloat64(payload["targetCount"])
	if targetCount < 1 || targetCount > float64(maxBulkDeleteTargets) {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
	}

	// Targets validation
	targetsRaw, ok := asAnySlice(payload["targets"])
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
		targetMap, ok := asStringAnyMap(item)
		if !ok || len(targetMap) == 0 {
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

		// Parse before as SafeSnapshot
		beforeRaw, ok := asStringAnyMap(targetMap["before"])
		if !ok || len(beforeRaw) == 0 {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
		}

		// Check no sensitive fields in before
		sensitiveFields := []string{"k", "op", "opc", "amf", "sqn", "security"}
		for _, field := range sensitiveFields {
			if _, exists := beforeRaw[field]; exists {
				return nil, &SubscriberGovernanceError{Code: ErrInvalidFrozenBulkDelete}
			}
		}

		// Parse SafeSnapshot fields
		before := parseSafeSnapshot(beforeRaw)

		// Verify preconditionHash
		preconditionHash, _ := targetMap["preconditionHash"].(string)
		expectedHash := computeBulkDeleteHash(before)
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
	snapshotBytes := toFloat64OrZero(payload["snapshotBytes"])
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
	// Section 16: SUCCESS only when all conditions met
	if deletedCount == requested && conflictCount == 0 && failedCount == 0 && ocsCleanupFailureCount == 0 {
		return "SUCCESS"
	}
	// Section 16: PARTIAL_WRITE when any deletion occurred
	if deletedCount > 0 {
		return "PARTIAL_WRITE"
	}
	// Section 16: FAILED_NO_MUTATION when zero deletions
	return "FAILED_NO_MUTATION"
}

// ExecuteFrozenBulkDelete executes a frozen bulk delete with CAS and OCS cleanup separation.
// Uses canonical SubscriberSafeSnapshot from frozen.go.
func ExecuteFrozenBulkDelete(ctx context.Context, frozen *FrozenBulkDeleteV2, repo BulkDeleteRepository, ocsCleanup OcsCleanupFunc) (*BulkDeleteExecutionResult, error) {
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

		// Verify precondition using canonical SafeSnapshot
		currentSnapshot := SubscriberSafeSnapshot(current)
		currentHash := computeBulkDeleteHash(currentSnapshot)
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
			// Section 15: Storage/driver error → failedImsis
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			classification := ClassifyBulkDeleteResult(result.DeletedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis), len(result.OcsCleanupFailedImsis))
			result.PartialMutation = classification == "PARTIAL_WRITE"
			result.MutationCommitted = result.DeletedCount > 0
			continue
		}
		if current == nil {
			// Section 15: CAS miss (target missing) → conflictImsis
			result.ConflictImsis = append(result.ConflictImsis, target.Imsi)
			classification := ClassifyBulkDeleteResult(result.DeletedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis), len(result.OcsCleanupFailedImsis))
			result.PartialMutation = classification == "PARTIAL_WRITE"
			result.MutationCommitted = result.DeletedCount > 0
			continue
		}

		// Final CAS check using canonical SafeSnapshot
		currentSnapshot := SubscriberSafeSnapshot(current)
		currentHash := computeBulkDeleteHash(currentSnapshot)
		if currentHash != target.PreconditionHash {
			// Section 15: CAS miss (hash changed) → conflictImsis
			result.ConflictImsis = append(result.ConflictImsis, target.Imsi)
			classification := ClassifyBulkDeleteResult(result.DeletedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis), len(result.OcsCleanupFailedImsis))
			result.PartialMutation = classification == "PARTIAL_WRITE"
			result.MutationCommitted = result.DeletedCount > 0
			continue
		}

		// CAS delete - use expected document state
		deleted, err := repo.DeleteSubscriberCAS(ctx, target.Imsi, current)
		if err != nil {
			// Section 15: Storage/driver error → failedImsis
			result.FailedImsis = append(result.FailedImsis, target.Imsi)
			classification := ClassifyBulkDeleteResult(result.DeletedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis), len(result.OcsCleanupFailedImsis))
			result.PartialMutation = classification == "PARTIAL_WRITE"
			result.MutationCommitted = result.DeletedCount > 0
			continue
		}
		if !deleted {
			// Section 15: CAS miss (delete matched 0) → conflictImsis
			result.ConflictImsis = append(result.ConflictImsis, target.Imsi)
			classification := ClassifyBulkDeleteResult(result.DeletedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis), len(result.OcsCleanupFailedImsis))
			result.PartialMutation = classification == "PARTIAL_WRITE"
			result.MutationCommitted = result.DeletedCount > 0
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

	// Section 17: Final classification and partialMutation
	classification := ClassifyBulkDeleteResult(result.DeletedCount, result.Requested, len(result.ConflictImsis), len(result.FailedImsis), len(result.OcsCleanupFailedImsis))
	result.PartialMutation = classification == "PARTIAL_WRITE"

	return result, nil
}

// computeBulkDeleteHash computes SHA256 hash of canonical JSON for SafeSnapshot.
func computeBulkDeleteHash(value any) string {
	canonical := stableJSON(value)
	hash := sha256.Sum256([]byte(canonical))
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
	return computeBulkDeleteHash(fp)
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

// parseSafeSnapshot parses a map into a SafeSnapshot struct.
func parseSafeSnapshot(m map[string]any) SafeSnapshot {
	snap := SafeSnapshot{
		Imsi: m["imsi"].(string),
	}
	if v, ok := m["msisdn"]; ok {
		switch arr := v.(type) {
		case []any:
			snap.Msisdn = arr
		case bson.A:
			snap.Msisdn = []any(arr)
		}
	}
	if v, ok := m["accessRestrictionData"]; ok {
		snap.AccessRestrictionData = int(toFloat64OrZero(v))
	}
	if v, ok := m["networkAccessMode"]; ok {
		snap.NetworkAccessMode = int(toFloat64OrZero(v))
	}
	snap.Ambr = m["ambr"]
	snap.Slices = m["slices"]
	return snap
}

// DeleteSubscriberCAS deletes a subscriber with CAS (Compare-And-Swap).
func (r *Repository) DeleteSubscriberCAS(ctx context.Context, imsi string, expected bson.M) (bool, error) {
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
