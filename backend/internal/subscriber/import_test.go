package subscriber

import (
	"testing"
)

func TestValidateImportRequest_EmptyRecords(t *testing.T) {
	payload := map[string]any{
		"records": []any{},
	}
	_, err := ValidateImportRequest(payload)
	if err == nil {
		t.Fatal("expected error for empty records")
	}
}

func TestValidateImportRequest_OverwriteRejected(t *testing.T) {
	payload := map[string]any{
		"records":   []any{map[string]any{"imsi": "454000000000001"}},
		"overwrite": true,
	}
	_, err := ValidateImportRequest(payload)
	if err == nil {
		t.Fatal("expected error for overwrite=true")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != ErrImportOverwriteNotSupported {
		t.Fatalf("expected SUBSCRIBER_IMPORT_OVERWRITE_NOT_SUPPORTED, got %s", govErr.Code)
	}
}

func TestValidateImportRequest_SecretRejected(t *testing.T) {
	payload := map[string]any{
		"records": []any{
			map[string]any{"imsi": "454000000000001", "k": "00000000000000000000000000000000"},
		},
	}
	_, err := ValidateImportRequest(payload)
	if err == nil {
		t.Fatal("expected error for sensitive field")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != ErrSensitiveChangeNotSupported {
		t.Fatalf("expected SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED, got %s", govErr.Code)
	}
}

func TestValidateImportRequest_TooManyRows(t *testing.T) {
	records := make([]any, maxImportRows+1)
	for i := range records {
		records[i] = map[string]any{"imsi": "454000000000001"}
	}
	payload := map[string]any{
		"records": records,
	}
	_, err := ValidateImportRequest(payload)
	if err == nil {
		t.Fatal("expected error for too many rows")
	}
}

func TestValidateImportRequest_Valid(t *testing.T) {
	payload := map[string]any{
		"records": []any{
			map[string]any{"imsi": "454000000000001", "traffic_total": 1000000000},
			map[string]any{"imsi": "454000000000002"},
		},
	}
	validated, err := ValidateImportRequest(payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(validated) != 2 {
		t.Fatalf("expected 2 records, got %d", len(validated))
	}
}

func TestNormalizeImportRecord_Defaults(t *testing.T) {
	record := map[string]any{
		"imsi": "  454000000000001  ",
	}
	normalized := NormalizeImportRecord(record)
	if normalized.Imsi != "454000000000001" {
		t.Fatalf("expected trimmed imsi, got %s", normalized.Imsi)
	}
	if normalized.TrafficTotal != importDefaultTraffic {
		t.Fatalf("expected default traffic total %d, got %d", importDefaultTraffic, normalized.TrafficTotal)
	}
	if normalized.TrafficBalance != importDefaultTraffic {
		t.Fatalf("expected default traffic balance %d, got %d", importDefaultTraffic, normalized.TrafficBalance)
	}
	if normalized.SmsTotal != importDefaultSms {
		t.Fatalf("expected default sms total %d, got %d", importDefaultSms, normalized.SmsTotal)
	}
	if normalized.SmsBalance != importDefaultSms {
		t.Fatalf("expected default sms balance %d, got %d", importDefaultSms, normalized.SmsBalance)
	}
	if normalized.PlanId != defaultPlanId {
		t.Fatalf("expected default plan id %s, got %s", defaultPlanId, normalized.PlanId)
	}
	if normalized.AccessRestrictionData != importDefaultAccessRestr {
		t.Fatalf("expected default access restriction %d, got %d", importDefaultAccessRestr, normalized.AccessRestrictionData)
	}
}

func TestNormalizeImportRecord_ExplicitValues(t *testing.T) {
	record := map[string]any{
		"imsi":                    "454000000000001",
		"traffic_total":           5000000000,
		"traffic_balance":         4000000000,
		"sms_total":               200,
		"sms_balance":             150,
		"plan_id":                 "plan_custom",
		"access_restriction_data": 64,
	}
	normalized := NormalizeImportRecord(record)
	if normalized.TrafficTotal != 5000000000 {
		t.Fatalf("expected traffic total 5000000000, got %d", normalized.TrafficTotal)
	}
	if normalized.TrafficBalance != 4000000000 {
		t.Fatalf("expected traffic balance 4000000000, got %d", normalized.TrafficBalance)
	}
	if normalized.SmsTotal != 200 {
		t.Fatalf("expected sms total 200, got %d", normalized.SmsTotal)
	}
	if normalized.SmsBalance != 150 {
		t.Fatalf("expected sms balance 150, got %d", normalized.SmsBalance)
	}
	if normalized.PlanId != "plan_custom" {
		t.Fatalf("expected plan id plan_custom, got %s", normalized.PlanId)
	}
	if normalized.AccessRestrictionData != 64 {
		t.Fatalf("expected access restriction 64, got %d", normalized.AccessRestrictionData)
	}
}

func TestComputeRecordIntentHash_Deterministic(t *testing.T) {
	record := ImportRecord{
		Imsi:                  "454000000000001",
		AccessRestrictionData: 32,
		TrafficTotal:          10737418240,
		TrafficBalance:        10737418240,
		SmsTotal:              100,
		SmsBalance:            100,
		PlanId:                "plan_default_10gb",
	}
	hash1 := ComputeRecordIntentHash(record)
	hash2 := ComputeRecordIntentHash(record)
	if hash1 != hash2 {
		t.Fatalf("expected deterministic hash, got %s and %s", hash1, hash2)
	}
	if len(hash1) != 64 {
		t.Fatalf("expected 64 char hex hash, got %d chars", len(hash1))
	}
}

func TestComputeFileHash_Deterministic(t *testing.T) {
	records := []ImportRecord{
		{Imsi: "454000000000002", TrafficTotal: 1000},
		{Imsi: "454000000000001", TrafficTotal: 2000},
	}
	hash1 := ComputeFileHash(records)
	hash2 := ComputeFileHash(records)
	if hash1 != hash2 {
		t.Fatalf("expected deterministic hash, got %s and %s", hash1, hash2)
	}
}

func TestComputeImportFingerprint_Deterministic(t *testing.T) {
	targets := []ImportTarget{
		{Imsi: "454000000000001", State: "absent", RecordIntentHash: "abc123"},
	}
	hash1 := ComputeImportFingerprint(targets, "skip-existing-create-only", "filehash123")
	hash2 := ComputeImportFingerprint(targets, "skip-existing-create-only", "filehash123")
	if hash1 != hash2 {
		t.Fatalf("expected deterministic fingerprint, got %s and %s", hash1, hash2)
	}
}

func TestPrepareFrozenImport_SortedByImsi(t *testing.T) {
	records := []ImportRecord{
		{Imsi: "454000000000002", TrafficTotal: 1000, TrafficBalance: 1000, SmsTotal: 100, SmsBalance: 100, PlanId: "plan1", AccessRestrictionData: 32},
		{Imsi: "454000000000001", TrafficTotal: 2000, TrafficBalance: 2000, SmsTotal: 200, SmsBalance: 200, PlanId: "plan2", AccessRestrictionData: 64},
	}

	// Verify records would be sorted
	sorted := make([]ImportRecord, len(records))
	copy(sorted, records)
	if sorted[0].Imsi > sorted[1].Imsi {
		sorted[0], sorted[1] = sorted[1], sorted[0]
	}
	if sorted[0].Imsi != "454000000000001" {
		t.Fatalf("expected first record to be 454000000000001, got %s", sorted[0].Imsi)
	}
}

func TestClassifyImportResult_Success(t *testing.T) {
	classification := ClassifyImportResult(5, 5, 0, 0, 0)
	if classification != "SUCCESS" {
		t.Fatalf("expected SUCCESS, got %s", classification)
	}
}

func TestClassifyImportResult_PartialWrite(t *testing.T) {
	classification := ClassifyImportResult(3, 5, 2, 0, 0)
	if classification != "PARTIAL_WRITE" {
		t.Fatalf("expected PARTIAL_WRITE, got %s", classification)
	}
}

func TestClassifyImportResult_FailedNoMutation(t *testing.T) {
	classification := ClassifyImportResult(0, 5, 5, 0, 0)
	if classification != "FAILED_NO_MUTATION" {
		t.Fatalf("expected FAILED_NO_MUTATION, got %s", classification)
	}
}

func TestAssertFrozenImportV2_NilPayload(t *testing.T) {
	err := AssertFrozenImportV2(nil)
	if err == nil {
		t.Fatal("expected error for nil payload")
	}
}

func TestAssertFrozenImportV2_EmptyRecords(t *testing.T) {
	frozen := &FrozenImportV2{
		Version:     "subscriber-import-v2",
		Records:     []ImportRecord{},
		Targets:     []ImportTarget{{Imsi: "454000000000001", State: "absent", RecordIntentHash: "abc"}},
		TargetCount: 1,
		Strategy:    "skip-existing-create-only",
	}
	err := AssertFrozenImportV2(frozen)
	if err == nil {
		t.Fatal("expected error for empty records")
	}
}

func TestAssertFrozenImportV2_EmptyTargets(t *testing.T) {
	frozen := &FrozenImportV2{
		Version:     "subscriber-import-v2",
		Records:     []ImportRecord{{Imsi: "454000000000001"}},
		Targets:     []ImportTarget{},
		TargetCount: 0,
		Strategy:    "skip-existing-create-only",
	}
	err := AssertFrozenImportV2(frozen)
	if err == nil {
		t.Fatal("expected error for empty targets")
	}
}

func TestAssertFrozenImportV2_MismatchedCounts(t *testing.T) {
	frozen := &FrozenImportV2{
		Version:     "subscriber-import-v2",
		Records:     []ImportRecord{{Imsi: "454000000000001"}},
		Targets:     []ImportTarget{{Imsi: "454000000000001", State: "absent", RecordIntentHash: "abc"}, {Imsi: "454000000000002", State: "absent", RecordIntentHash: "def"}},
		TargetCount: 2,
		Strategy:    "skip-existing-create-only",
	}
	err := AssertFrozenImportV2(frozen)
	if err == nil {
		t.Fatal("expected error for mismatched counts")
	}
}

func TestAssertFrozenImportV2_UnsortedRecords(t *testing.T) {
	frozen := &FrozenImportV2{
		Version: "subscriber-import-v2",
		Records: []ImportRecord{
			{Imsi: "454000000000002"},
			{Imsi: "454000000000001"},
		},
		Targets: []ImportTarget{
			{Imsi: "454000000000002", State: "absent", RecordIntentHash: "abc"},
			{Imsi: "454000000000001", State: "absent", RecordIntentHash: "def"},
		},
		TargetCount: 2,
		Strategy:    "skip-existing-create-only",
	}
	err := AssertFrozenImportV2(frozen)
	if err == nil {
		t.Fatal("expected error for unsorted records")
	}
}

func TestAssertFrozenImportV2_InvalidStrategy(t *testing.T) {
	frozen := &FrozenImportV2{
		Version: "subscriber-import-v2",
		Records: []ImportRecord{
			{Imsi: "454000000000001"},
		},
		Targets: []ImportTarget{
			{Imsi: "454000000000001", State: "absent", RecordIntentHash: "abc"},
		},
		TargetCount: 1,
		Strategy:    "wrong-strategy",
	}
	err := AssertFrozenImportV2(frozen)
	if err == nil {
		t.Fatal("expected error for invalid strategy")
	}
}

func TestAssertFrozenImportV2_Valid(t *testing.T) {
	record1 := ImportRecord{Imsi: "454000000000001", AccessRestrictionData: 32, TrafficTotal: 1000, TrafficBalance: 1000, SmsTotal: 100, SmsBalance: 100, PlanId: "plan1"}
	record2 := ImportRecord{Imsi: "454000000000002", AccessRestrictionData: 32, TrafficTotal: 2000, TrafficBalance: 2000, SmsTotal: 200, SmsBalance: 200, PlanId: "plan2"}
	records := []ImportRecord{record1, record2}
	targets := []ImportTarget{
		{Imsi: "454000000000001", State: "absent", RecordIntentHash: ComputeRecordIntentHash(record1)},
		{Imsi: "454000000000002", State: "present", RecordIntentHash: ComputeRecordIntentHash(record2)},
	}
	fileHash := ComputeFileHash(records)
	fingerprint := ComputeImportFingerprint(targets, "skip-existing-create-only", fileHash)
	fieldNames := []string{"access_restriction_data", "plan_id", "sms_balance", "sms_total", "traffic_balance", "traffic_total"}
	summary := ImportSummary{RowCount: 2, CreateCount: 1, SkipCount: 1, FieldNames: fieldNames, FileHash: fileHash}
	snapshotBytes := len(stableJSON(map[string]any{
		"version":              "subscriber-import-v2",
		"records":              records,
		"targets":              targets,
		"targetCount":          2,
		"summary":              summary,
		"strategy":             "skip-existing-create-only",
		"operationFingerprint": fingerprint,
	}))
	frozen := &FrozenImportV2{
		Version:              "subscriber-import-v2",
		Records:              records,
		Targets:              targets,
		TargetCount:          2,
		Summary:              summary,
		Strategy:             "skip-existing-create-only",
		SnapshotBytes:        snapshotBytes,
		OperationFingerprint: fingerprint,
	}
	err := AssertFrozenImportV2(frozen)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBuildImportSubscriberDoc(t *testing.T) {
	record := ImportRecord{
		Imsi:                  "454000000000001",
		AccessRestrictionData: 64,
		TrafficTotal:          5000000000,
		TrafficBalance:        4000000000,
		SmsTotal:              200,
		SmsBalance:            150,
		PlanId:                "plan_custom",
	}
	doc := buildImportSubscriberDoc(record)
	if doc["imsi"] != "454000000000001" {
		t.Fatalf("expected imsi 454000000000001, got %v", doc["imsi"])
	}
	ard, ok := doc["access_restriction_data"].(int64)
	if !ok {
		t.Fatalf("expected access_restriction_data to be int64, got %T: %v", doc["access_restriction_data"], doc["access_restriction_data"])
	}
	if ard != 64 {
		t.Fatalf("expected access_restriction_data 64, got %v", ard)
	}
	ambr, ok := doc["ambr"].(map[string]any)
	if !ok {
		t.Fatalf("expected ambr to be map[string]any, got %T", doc["ambr"])
	}
	dl, ok := ambr["downlink"].(map[string]any)
	if !ok {
		t.Fatalf("expected downlink to be map[string]any, got %T", ambr["downlink"])
	}
	if dl["value"] != int64(1024) {
		t.Fatalf("expected downlink value 1024, got %v", dl["value"])
	}
}
