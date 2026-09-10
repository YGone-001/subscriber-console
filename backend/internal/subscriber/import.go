package subscriber

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const (
	maxImportRows            = 5000
	maxImportSnapshotBytes   = 512 * 1024
	importDefaultTraffic     = 10737418240 // 10 GiB
	importDefaultSms         = 100
	importDefaultAccessRestr = 32
	defaultPlanId            = "plan_default_10gb"
)

// Error codes for import
const (
	ErrInvalidImportRequest        = "INVALID_SUBSCRIBER_IMPORT_REQUEST"
	ErrInvalidFrozenImport         = "INVALID_SUBSCRIBER_IMPORT_PAYLOAD"
	ErrImportPreconditionChanged   = "SUBSCRIBER_IMPORT_PRECONDITION_CHANGED"
	ErrImportPartialWrite          = "SUBSCRIBER_IMPORT_PARTIAL_WRITE"
	ErrImportFailed                = "SUBSCRIBER_IMPORT_FAILED"
	ErrSensitiveChangeNotSupported = "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED"
	ErrImportOverwriteNotSupported = "SUBSCRIBER_IMPORT_OVERWRITE_NOT_SUPPORTED"
)

// ImportRecord holds a single normalized import record.
type ImportRecord struct {
	Imsi                  string  `json:"imsi"`
	AccessRestrictionData int     `json:"access_restriction_data"`
	TrafficTotal          int64   `json:"traffic_total"`
	TrafficBalance        int64   `json:"traffic_balance"`
	SmsTotal              int64   `json:"sms_total"`
	SmsBalance            int64   `json:"sms_balance"`
	PlanId                string  `json:"plan_id"`
	// Omitted fields for fingerprint stability
	_ struct{} `json:"-"`
}

// ImportTarget holds a single target for import.
type ImportTarget struct {
	Imsi             string `json:"imsi"             bson:"imsi"`
	State            string `json:"state"            bson:"state"` // "present" or "absent"
	RecordIntentHash string `json:"recordIntentHash" bson:"recordIntentHash"`
}

// ImportSummary holds the summary of an import operation.
type ImportSummary struct {
	RowCount    int      `json:"rowCount"`
	CreateCount int      `json:"createCount"`
	SkipCount   int      `json:"skipCount"`
	FieldNames  []string `json:"fieldNames"`
	FileHash    string   `json:"fileHash"`
}

// FrozenImportV2 is the v2 frozen contract for import.
type FrozenImportV2 struct {
	Version              string         `json:"version"              bson:"version"`
	Records              []ImportRecord `json:"records"              bson:"records"`
	Targets              []ImportTarget `json:"targets"              bson:"targets"`
	TargetCount          int            `json:"targetCount"          bson:"targetCount"`
	Summary              ImportSummary  `json:"summary"              bson:"summary"`
	Strategy             string         `json:"strategy"             bson:"strategy"`
	SnapshotBytes        int            `json:"snapshotBytes"        bson:"snapshotBytes"`
	OperationFingerprint string         `json:"operationFingerprint" bson:"operationFingerprint"`
}

// ImportExecutionResult holds the result of an import execution.
type ImportExecutionResult struct {
	Requested                  int      `json:"requested"`
	IntendedCreateCount        int      `json:"intendedCreateCount"`
	CreatedImsis               []string `json:"createdImsis"`
	SkippedImsis               []string `json:"skippedImsis"`
	ConflictImsis              []string `json:"conflictImsis"`
	FailedImsis                []string `json:"failedImsis"`
	OcsProvisionedImsis        []string `json:"ocsProvisionedImsis"`
	OcsProvisioningFailedImsis []string `json:"ocsProvisioningFailedImsis"`
	CreatedCount               int      `json:"createdCount"`
	PartialMutation            bool     `json:"partialMutation"`
	MutationCommitted          bool     `json:"mutationCommitted"`
	OperationFingerprint       string   `json:"operationFingerprint"`
}

// ImportRepository defines the interface for import operations.
type ImportRepository interface {
	FindSubscribersForImport(ctx context.Context, imsis []string) (map[string]bool, error)
	InsertSubscriberImportCreateOnly(ctx context.Context, doc bson.M) error
	ProvisionImportedSubscriberOcs(ctx context.Context, input OcsProvisioningInput) error
	ValidateTariffPlan(ctx context.Context, planId string) error
}

// sensitiveKeys are the keys that must not be non-empty in import records.
var sensitiveKeys = []string{"k", "op", "opc", "amf", "sqn"}

// unsafeKeys are keys that must not appear in import records.
var unsafeKeys = map[string]bool{
	"_id": true, "security": true, "$set": true, "$unset": true,
	"__proto__": true, "constructor": true, "prototype": true,
}

// allowedTopLevelKeys are the only allowed top-level keys in import request.
var allowedTopLevelKeys = map[string]bool{
	"records": true, "overwrite": true,
}

// ValidateImportRequest validates the raw import request.
func ValidateImportRequest(payload map[string]any) ([]map[string]any, error) {
	// Validate top-level keys
	for key := range payload {
		if !allowedTopLevelKeys[key] {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
		}
	}

	// Check overwrite
	if overwrite, ok := payload["overwrite"]; ok && overwrite == true {
		return nil, &SubscriberGovernanceError{Code: ErrImportOverwriteNotSupported}
	}

	// Validate records
	recordsRaw, ok := payload["records"].([]any)
	if !ok {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
	}
	if len(recordsRaw) == 0 {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
	}
	if len(recordsRaw) > maxImportRows {
		return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
	}

	records := make([]map[string]any, 0, len(recordsRaw))
	seenImsis := make(map[string]bool)

	for _, raw := range recordsRaw {
		rec, ok := raw.(map[string]any)
		if !ok {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
		}

		// Validate IMSI
		imsi, _ := rec["imsi"].(string)
		imsi = strings.TrimSpace(imsi)
		if imsi == "" || len(imsi) != 15 {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
		}
		for _, c := range imsi {
			if c < '0' || c > '9' {
				return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
			}
		}

		// Duplicate IMSI check
		if seenImsis[imsi] {
			return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
		}
		seenImsis[imsi] = true

		// Check sensitive fields
		for _, key := range sensitiveKeys {
			if v, ok := rec[key]; ok {
				s, _ := v.(string)
				if strings.TrimSpace(s) != "" {
					return nil, &SubscriberGovernanceError{Code: ErrSensitiveChangeNotSupported}
				}
			}
		}

		// Check unsafe keys
		for key := range rec {
			if unsafeKeys[key] {
				return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
			}
			if strings.Contains(key, ".") || strings.Contains(key, "$") {
				return nil, &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
			}
		}

		// Validate numeric fields
		if err := validateImportNumericFields(rec); err != nil {
			return nil, err
		}

		// Validate tariff plan ID format
		if planId, ok := rec["plan_id"].(string); ok && planId != "" {
			if err := ValidateTariffPlanId(planId); err != nil {
				return nil, err
			}
		}

		records = append(records, rec)
	}

	return records, nil
}

// validateImportNumericFields validates numeric fields in an import record.
func validateImportNumericFields(rec map[string]any) error {
	// access_restriction_data: 0..255, integer
	if v, ok := rec["access_restriction_data"]; ok {
		n, ok := toFloat64(v)
		if !ok || n < 0 || n > 255 || n != float64(int(n)) {
			return &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
		}
	}

	// traffic_total, traffic_balance: non-negative, integer
	for _, key := range []string{"traffic_total", "traffic_balance"} {
		if v, ok := rec[key]; ok {
			n, ok := toFloat64(v)
			if !ok || n < 0 || n != float64(int64(n)) {
				return &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
			}
		}
	}

	// sms_total, sms_balance: non-negative, integer
	for _, key := range []string{"sms_total", "sms_balance"} {
		if v, ok := rec[key]; ok {
			n, ok := toFloat64(v)
			if !ok || n < 0 || n != float64(int64(n)) {
				return &SubscriberGovernanceError{Code: ErrInvalidImportRequest}
			}
		}
	}

	return nil
}


// NormalizeImportRecord normalizes a raw import record to canonical form.
func NormalizeImportRecord(rec map[string]any) ImportRecord {
	imsi, _ := rec["imsi"].(string)
	imsi = strings.TrimSpace(imsi)

	ard := importDefaultAccessRestr
	if v, ok := rec["access_restriction_data"]; ok {
		if n, ok := toFloat64(v); ok {
			ard = int(n)
		}
	}

	trafficTotal := int64(importDefaultTraffic)
	if v, ok := rec["traffic_total"]; ok {
		if n, ok := toFloat64(v); ok {
			trafficTotal = int64(n)
		}
	}

	trafficBalance := int64(importDefaultTraffic)
	if v, ok := rec["traffic_balance"]; ok {
		if n, ok := toFloat64(v); ok {
			trafficBalance = int64(n)
		}
	}

	smsTotal := int64(importDefaultSms)
	if v, ok := rec["sms_total"]; ok {
		if n, ok := toFloat64(v); ok {
			smsTotal = int64(n)
		}
	}

	smsBalance := int64(importDefaultSms)
	if v, ok := rec["sms_balance"]; ok {
		if n, ok := toFloat64(v); ok {
			smsBalance = int64(n)
		}
	}

	planId := defaultPlanId
	if v, ok := rec["plan_id"].(string); ok && strings.TrimSpace(v) != "" {
		planId = strings.TrimSpace(v)
	}

	return ImportRecord{
		Imsi:                  imsi,
		AccessRestrictionData: ard,
		TrafficTotal:          trafficTotal,
		TrafficBalance:        trafficBalance,
		SmsTotal:              smsTotal,
		SmsBalance:            smsBalance,
		PlanId:                planId,
	}
}

// ComputeRecordIntentHash computes the SHA256 hash of a normalized record.
func ComputeRecordIntentHash(rec ImportRecord) string {
	h := sha256.Sum256([]byte(stableJSON(rec)))
	return fmt.Sprintf("%x", h)
}

// ComputeFileHash computes the SHA256 hash of normalized records sorted by IMSI.
func ComputeFileHash(records []ImportRecord) string {
	sorted := make([]ImportRecord, len(records))
	copy(sorted, records)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Imsi < sorted[j].Imsi })
	h := sha256.Sum256([]byte(stableJSON(sorted)))
	return fmt.Sprintf("%x", h)
}

// ComputeImportFingerprint computes the operation fingerprint for import.
func ComputeImportFingerprint(targets []ImportTarget, strategy string, fileHash string) string {
	source := map[string]any{
		"operation": "SUBSCRIBER_IMPORT",
		"targets":   targets,
		"strategy":  strategy,
		"fileHash":  fileHash,
	}
	h := sha256.Sum256([]byte(stableJSON(source)))
	return fmt.Sprintf("%x", h)
}

// PrepareFrozenImport prepares a frozen v2 import payload.
func PrepareFrozenImport(
	ctx context.Context,
	rawRecords []map[string]any,
	repo ImportRepository,
) (*FrozenImportV2, error) {
	// Normalize records
	records := make([]ImportRecord, 0, len(rawRecords))
	for _, raw := range rawRecords {
		records = append(records, NormalizeImportRecord(raw))
	}

	// Sort records by IMSI for deterministic ordering
	sort.Slice(records, func(i, j int) bool { return records[i].Imsi < records[j].Imsi })

	// Extract IMSIs
	imsis := make([]string, len(records))
	for i, rec := range records {
		imsis[i] = rec.Imsi
	}

	// Load existence states
	existsMap, err := repo.FindSubscribersForImport(ctx, imsis)
	if err != nil {
		return nil, fmt.Errorf("check subscriber existence: %w", err)
	}

	// Validate tariff plans
	planIds := make(map[string]bool)
	for _, rec := range records {
		planIds[rec.PlanId] = true
	}
	for planId := range planIds {
		if err := repo.ValidateTariffPlan(ctx, planId); err != nil {
			return nil, err
		}
	}

	// Build targets with state and recordIntentHash
	targets := make([]ImportTarget, 0, len(records))
	createCount := 0
	skipCount := 0

	for _, rec := range records {
		state := "absent"
		if existsMap[rec.Imsi] {
			state = "present"
			skipCount++
		} else {
			createCount++
		}

		targets = append(targets, ImportTarget{
			Imsi:             rec.Imsi,
			State:            state,
			RecordIntentHash: ComputeRecordIntentHash(rec),
		})
	}

	// Compute field names (sorted, unique)
	fieldNameSet := make(map[string]bool)
	for _, raw := range rawRecords {
		for key := range raw {
			if key != "imsi" {
				fieldNameSet[key] = true
			}
		}
	}
	fieldNames := make([]string, 0, len(fieldNameSet))
	for name := range fieldNameSet {
		fieldNames = append(fieldNames, name)
	}
	sort.Strings(fieldNames)

	// Compute hashes
	fileHash := ComputeFileHash(records)
	fingerprint := ComputeImportFingerprint(targets, "skip-existing-create-only", fileHash)

	// Compute snapshotBytes
	snapshotBytes := len(stableJSON(map[string]any{
		"version":              "subscriber-import-v2",
		"records":              records,
		"targets":              targets,
		"targetCount":          len(targets),
		"summary": map[string]any{
			"rowCount":    len(records),
			"createCount": createCount,
			"skipCount":   skipCount,
			"fieldNames":  fieldNames,
			"fileHash":    fileHash,
		},
		"strategy":             "skip-existing-create-only",
		"operationFingerprint": fingerprint,
	}))

	// Snapshot cap check
	if snapshotBytes > maxImportSnapshotBytes {
		return nil, &SubscriberGovernanceError{Code: ErrApprovalSnapshotTooLarge}
	}

	return &FrozenImportV2{
		Version: "subscriber-import-v2",
		Records: records,
		Targets: targets,
		TargetCount: len(targets),
		Summary: ImportSummary{
			RowCount:    len(records),
			CreateCount: createCount,
			SkipCount:   skipCount,
			FieldNames:  fieldNames,
			FileHash:    fileHash,
		},
		Strategy:             "skip-existing-create-only",
		SnapshotBytes:        snapshotBytes,
		OperationFingerprint: fingerprint,
	}, nil
}

// AssertFrozenImportV2 validates a frozen import payload.
func AssertFrozenImportV2(frozen *FrozenImportV2) error {
	if frozen == nil {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}
	if frozen.Version != "subscriber-import-v2" {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}
	if len(frozen.Records) == 0 || len(frozen.Targets) == 0 {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}
	if len(frozen.Records) != len(frozen.Targets) {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}
	if frozen.TargetCount != len(frozen.Targets) {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}
	if frozen.Strategy != "skip-existing-create-only" {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}

	// Verify sorted by IMSI
	for i := 1; i < len(frozen.Records); i++ {
		if frozen.Records[i].Imsi <= frozen.Records[i-1].Imsi {
			return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
		}
	}
	for i := 1; i < len(frozen.Targets); i++ {
		if frozen.Targets[i].Imsi <= frozen.Targets[i-1].Imsi {
			return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
		}
	}

	// Verify 1:1 correlation
	for i, rec := range frozen.Records {
		if rec.Imsi != frozen.Targets[i].Imsi {
			return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
		}
	}

	// Verify unique IMSIs
	seen := make(map[string]bool)
	for _, rec := range frozen.Records {
		if seen[rec.Imsi] {
			return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
		}
		seen[rec.Imsi] = true
	}

	// Verify target states
	for _, t := range frozen.Targets {
		if t.State != "present" && t.State != "absent" {
			return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
		}
	}

	// Verify recordIntentHash
	for i, t := range frozen.Targets {
		expected := ComputeRecordIntentHash(frozen.Records[i])
		if t.RecordIntentHash != expected {
			return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
		}
	}

	// Verify summary
	if frozen.Summary.RowCount != len(frozen.Records) {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}
	if frozen.Summary.CreateCount+frozen.Summary.SkipCount != len(frozen.Records) {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}

	// Verify fileHash
	expectedFileHash := ComputeFileHash(frozen.Records)
	if frozen.Summary.FileHash != expectedFileHash {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}

	// Verify fingerprint
	expectedFingerprint := ComputeImportFingerprint(frozen.Targets, frozen.Strategy, frozen.Summary.FileHash)
	if frozen.OperationFingerprint != expectedFingerprint {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}

	// Verify snapshotBytes
	expectedSnapshot := len(stableJSON(map[string]any{
		"version":              frozen.Version,
		"records":              frozen.Records,
		"targets":              frozen.Targets,
		"targetCount":          frozen.TargetCount,
		"summary":              frozen.Summary,
		"strategy":             frozen.Strategy,
		"operationFingerprint": frozen.OperationFingerprint,
	}))
	if frozen.SnapshotBytes != expectedSnapshot {
		return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
	}

	// Verify no sensitive fields in records
	for _, rec := range frozen.Records {
		recMap := map[string]any{
			"imsi":                   rec.Imsi,
			"access_restriction_data": rec.AccessRestrictionData,
			"traffic_total":          rec.TrafficTotal,
			"traffic_balance":        rec.TrafficBalance,
			"sms_total":              rec.SmsTotal,
			"sms_balance":            rec.SmsBalance,
			"plan_id":                rec.PlanId,
		}
		for _, key := range sensitiveKeys {
			if _, ok := recMap[key]; ok {
				return &SubscriberGovernanceError{Code: ErrInvalidFrozenImport}
			}
		}
	}

	return nil
}

// ClassifyImportResult classifies the import result.
func ClassifyImportResult(createdCount, intendedCreateCount, conflictCount, failedCount, ocsFailureCount int) string {
	// SUCCESS: all intended creates succeeded + all skips + no conflicts/failures
	if createdCount == intendedCreateCount && conflictCount == 0 && failedCount == 0 && ocsFailureCount == 0 {
		return "SUCCESS"
	}
	// PARTIAL_WRITE: some creates succeeded
	if createdCount > 0 {
		return "PARTIAL_WRITE"
	}
	// FAILED_NO_MUTATION: no creates
	return "FAILED_NO_MUTATION"
}

// ExecuteFrozenImport executes a frozen v2 import.
func ExecuteFrozenImport(
	ctx context.Context,
	frozen *FrozenImportV2,
	repo ImportRepository,
) (*ImportExecutionResult, error) {
	if err := AssertFrozenImportV2(frozen); err != nil {
		return nil, err
	}

	// Phase 1: ALL-TARGET STATE BARRIER
	// Load ALL target IMSI existence states and compare to frozen.
	imsis := make([]string, len(frozen.Targets))
	for i, t := range frozen.Targets {
		imsis[i] = t.Imsi
	}

	existsMap, err := repo.FindSubscribersForImport(ctx, imsis)
	if err != nil {
		return nil, &SubscriberGovernanceError{Code: ErrImportFailed, Details: map[string]any{"error": err.Error()}}
	}

	// Compare to frozen states — zero writes on ANY state change
	for _, t := range frozen.Targets {
		actualExists := existsMap[t.Imsi]
		if t.State == "present" && !actualExists {
			return &ImportExecutionResult{
				Requested:            frozen.TargetCount,
				IntendedCreateCount:  frozen.Summary.CreateCount,
				OperationFingerprint: frozen.OperationFingerprint,
				CreatedImsis:         []string{},
				SkippedImsis:         []string{},
				ConflictImsis:        []string{},
				FailedImsis:          []string{},
				OcsProvisionedImsis:  []string{},
				OcsProvisioningFailedImsis: []string{},
			}, &SubscriberGovernanceError{Code: ErrImportPreconditionChanged}
		}
		if t.State == "absent" && actualExists {
			return &ImportExecutionResult{
				Requested:            frozen.TargetCount,
				IntendedCreateCount:  frozen.Summary.CreateCount,
				OperationFingerprint: frozen.OperationFingerprint,
				CreatedImsis:         []string{},
				SkippedImsis:         []string{},
				ConflictImsis:        []string{},
				FailedImsis:          []string{},
				OcsProvisionedImsis:  []string{},
				OcsProvisioningFailedImsis: []string{},
			}, &SubscriberGovernanceError{Code: ErrImportPreconditionChanged}
		}
	}

	// Phase 2: Execute — skip present, insert absent
	result := &ImportExecutionResult{
		Requested:            frozen.TargetCount,
		IntendedCreateCount:  frozen.Summary.CreateCount,
		OperationFingerprint: frozen.OperationFingerprint,
		CreatedImsis:         []string{},
		SkippedImsis:         []string{},
		ConflictImsis:        []string{},
		FailedImsis:          []string{},
		OcsProvisionedImsis:  []string{},
		OcsProvisioningFailedImsis: []string{},
	}

	// Build record map for OCS provisioning
	recordByImsi := make(map[string]ImportRecord)
	for _, rec := range frozen.Records {
		recordByImsi[rec.Imsi] = rec
	}

	for _, t := range frozen.Targets {
		if t.State == "present" {
			// Skip existing
			result.SkippedImsis = append(result.SkippedImsis, t.Imsi)
			continue
		}

		// Insert new subscriber
		rec := recordByImsi[t.Imsi]
		doc := buildImportSubscriberDoc(rec)
		if err := repo.InsertSubscriberImportCreateOnly(ctx, doc); err != nil {
			if mongo.IsDuplicateKeyError(err) {
				// Duplicate-key race after successful preflight
				result.ConflictImsis = append(result.ConflictImsis, t.Imsi)
				continue
			}
			result.FailedImsis = append(result.FailedImsis, t.Imsi)
			continue
		}

		result.CreatedImsis = append(result.CreatedImsis, t.Imsi)
	}

	// Phase 3: OCS provisioning only for successfully created subscribers
	for _, imsi := range result.CreatedImsis {
		rec := recordByImsi[imsi]
		input := OcsProvisioningInput{
			IMSI:          imsi,
			PlanID:        &rec.PlanId,
			DataTotal:     &rec.TrafficTotal,
			DataAvailable: &rec.TrafficBalance,
			SMSTotal:      &rec.SmsTotal,
			SMSAvailable:  &rec.SmsBalance,
		}
		if err := repo.ProvisionImportedSubscriberOcs(ctx, input); err != nil {
			result.OcsProvisioningFailedImsis = append(result.OcsProvisioningFailedImsis, imsi)
			continue
		}
		result.OcsProvisionedImsis = append(result.OcsProvisionedImsis, imsi)
	}

	// Classify
	result.CreatedCount = len(result.CreatedImsis)
	classification := ClassifyImportResult(
		result.CreatedCount,
		result.IntendedCreateCount,
		len(result.ConflictImsis),
		len(result.FailedImsis),
		len(result.OcsProvisioningFailedImsis),
	)
	result.PartialMutation = classification == "PARTIAL_WRITE"
	result.MutationCommitted = result.CreatedCount > 0

	return result, nil
}

// buildImportSubscriberDoc builds a subscriber document for import creation.
func buildImportSubscriberDoc(rec ImportRecord) bson.M {
	// Build auth with zero-key defaults (import never carries secrets)
	auth := map[string]any{
		"k":   "00000000000000000000000000000000",
		"opc": "00000000000000000000000000000000",
		"amf": "8000",
		"sqn": int64(1),
	}

	ambr := map[string]any{
		"downlink": map[string]any{"value": int64(1024), "unit": int64(0)},
		"uplink":   map[string]any{"value": int64(1024), "unit": int64(0)},
	}

	realm := epcRealmFromImsi(rec.Imsi)

	return bson.M{
		"__v":                      0,
		"schema_version":           1,
		"imsi":                     rec.Imsi,
		"msisdn":                   bson.A{},
		"access_restriction_data":  int64(rec.AccessRestrictionData),
		"network_access_mode":      int64(0),
		"subscriber_status":        int64(0),
		"operator_select_access":   int64(0),
		"slice":                    bson.A{},
		"ambr":                     ambr,
		"security":                 auth,
		"schema_version_of_pdu":    1,
		"pdu_session":              bson.A{},
		"session":                  bson.A{},
		"flows":                    bson.A{},
		"webui_meta":               bson.M{"profile_name": ""},
		"name":                     "",
		"epc": bson.M{
			"realm":     realm,
			"ue_realm":  realm,
			"ue_ipv4":   "",
			"visited_id": "",
		},
	}
}
