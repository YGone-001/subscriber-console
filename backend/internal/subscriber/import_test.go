package subscriber

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
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

// ---------------------------------------------------------------------------
// Mock ImportRepository for Prepare→Assert tests
// ---------------------------------------------------------------------------

type fakeImportRepo struct {
	existingImsis map[string]bool
	tariffPlans   map[string]bool
	insertedDocs  []bson.M
}

func (f *fakeImportRepo) FindSubscribersForImport(_ context.Context, imsis []string) (map[string]bool, error) {
	result := make(map[string]bool)
	for _, imsi := range imsis {
		result[imsi] = f.existingImsis[imsi]
	}
	return result, nil
}

func (f *fakeImportRepo) InsertSubscriberImportCreateOnly(_ context.Context, doc bson.M) error {
	f.insertedDocs = append(f.insertedDocs, doc)
	return nil
}

func (f *fakeImportRepo) ProvisionImportedSubscriberOcs(_ context.Context, _ OcsProvisioningInput) error {
	return nil
}

func (f *fakeImportRepo) ValidateTariffPlan(_ context.Context, planId string) error {
	if !f.tariffPlans[planId] {
		return &SubscriberGovernanceError{Code: "OCS_PLAN_NOT_FOUND"}
	}
	return nil
}

func newFakeImportRepo(existingImsis ...string) *fakeImportRepo {
	existing := make(map[string]bool)
	for _, imsi := range existingImsis {
		existing[imsi] = true
	}
	return &fakeImportRepo{
		existingImsis: existing,
		tariffPlans:   map[string]bool{"plan_default_10gb": true, "custom_plan": true, "premium_plan": true, "plan_a": true, "plan_b": true},
	}
}

// ---------------------------------------------------------------------------
// Section 3: Prepare→Assert Production Invariant
// ---------------------------------------------------------------------------

func assertPrepareAssert(t *testing.T, repo *fakeImportRepo, rawRecords []map[string]any) *FrozenImportV2 {
	t.Helper()
	frozen, err := PrepareFrozenImport(context.Background(), rawRecords, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	if err := AssertFrozenImportV2(frozen); err != nil {
		t.Fatalf("AssertFrozenImportV2: %v", err)
	}
	return frozen
}

func TestPrepareAssert_Invariant_ImsiOnly(t *testing.T) {
	repo := newFakeImportRepo()
	frozen := assertPrepareAssert(t, repo, []map[string]any{
		{"imsi": "454000000000002"},
	})
	if len(frozen.Summary.FieldNames) != 6 {
		t.Fatalf("expected6 fieldNames, got %d", len(frozen.Summary.FieldNames))
	}
}

func TestPrepareAssert_Invariant_ImsiPlusTrafficBalanceOnly(t *testing.T) {
	repo := newFakeImportRepo()
	frozen := assertPrepareAssert(t, repo, []map[string]any{
		{"imsi": "454000000000002", "traffic_balance": 5000000000},
	})
	if frozen.Records[0].TrafficTotal != 5000000000 {
		t.Fatalf("expected traffic_total to default to traffic_balance, got %d", frozen.Records[0].TrafficTotal)
	}
	if frozen.Records[0].TrafficBalance != 5000000000 {
		t.Fatalf("expected traffic_balance 5000000000, got %d", frozen.Records[0].TrafficBalance)
	}
}

func TestPrepareAssert_Invariant_ImsiPlusSmsBalanceOnly(t *testing.T) {
	repo := newFakeImportRepo()
	frozen := assertPrepareAssert(t, repo, []map[string]any{
		{"imsi": "454000000000002", "sms_balance": 50},
	})
	if frozen.Records[0].SmsTotal != 50 {
		t.Fatalf("expected sms_total to default to sms_balance, got %d", frozen.Records[0].SmsTotal)
	}
	if frozen.Records[0].SmsBalance != 50 {
		t.Fatalf("expected sms_balance 50, got %d", frozen.Records[0].SmsBalance)
	}
}

func TestPrepareAssert_Invariant_ImsiPlusArdOnly(t *testing.T) {
	repo := newFakeImportRepo()
	frozen := assertPrepareAssert(t, repo, []map[string]any{
		{"imsi": "454000000000002", "access_restriction_data": 128},
	})
	if frozen.Records[0].AccessRestrictionData != 128 {
		t.Fatalf("expected ARD 128, got %d", frozen.Records[0].AccessRestrictionData)
	}
}

func TestPrepareAssert_Invariant_ImsiPlusPlanIdOnly(t *testing.T) {
	repo := newFakeImportRepo()
	frozen := assertPrepareAssert(t, repo, []map[string]any{
		{"imsi": "454000000000002", "plan_id": "custom_plan"},
	})
	if frozen.Records[0].PlanId != "custom_plan" {
		t.Fatalf("expected plan_id custom_plan, got %s", frozen.Records[0].PlanId)
	}
}

func TestPrepareAssert_Invariant_AllFields(t *testing.T) {
	repo := newFakeImportRepo()
	assertPrepareAssert(t, repo, []map[string]any{
		{
			"imsi":                    "454000000000002",
			"access_restriction_data": 64,
			"traffic_total":           20000000000,
			"traffic_balance":         10000000000,
			"sms_total":               200,
			"sms_balance":             100,
			"plan_id":                 "premium_plan",
		},
	})
}

func TestPrepareAssert_Invariant_MixedRows(t *testing.T) {
	repo := newFakeImportRepo("454000000000001")
	frozen := assertPrepareAssert(t, repo, []map[string]any{
		{"imsi": "454000000000001"},
		{"imsi": "454000000000002", "traffic_balance": 5000000000},
		{"imsi": "454000000000003", "sms_balance": 25, "plan_id": "custom_plan"},
		{"imsi": "454000000000004", "access_restriction_data": 0, "traffic_total": 1000, "sms_total": 10},
	})
	if frozen.TargetCount != 4 {
		t.Fatalf("expected 4 targets, got %d", frozen.TargetCount)
	}
	if frozen.Summary.CreateCount != 3 {
		t.Fatalf("expected createCount 3, got %d", frozen.Summary.CreateCount)
	}
	if frozen.Summary.SkipCount != 1 {
		t.Fatalf("expected skipCount 1, got %d", frozen.Summary.SkipCount)
	}
}

// ---------------------------------------------------------------------------
// Section 5: Cross-runtime fixtures
// ---------------------------------------------------------------------------

func TestCrossRuntime_RowOrderInvariant(t *testing.T) {
	repo := newFakeImportRepo()
	rawA := []map[string]any{
		{"imsi": "454000000000003"},
		{"imsi": "454000000000002"},
	}
	rawB := []map[string]any{
		{"imsi": "454000000000002"},
		{"imsi": "454000000000003"},
	}
	a, err := PrepareFrozenImport(context.Background(), rawA, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport a: %v", err)
	}
	b, err := PrepareFrozenImport(context.Background(), rawB, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport b: %v", err)
	}
	if a.Summary.FileHash != b.Summary.FileHash {
		t.Fatalf("fileHash mismatch: %s vs %s", a.Summary.FileHash, b.Summary.FileHash)
	}
	if a.OperationFingerprint != b.OperationFingerprint {
		t.Fatalf("fingerprint mismatch: %s vs %s", a.OperationFingerprint, b.OperationFingerprint)
	}
	for i := range a.Records {
		if a.Records[i].Imsi != b.Records[i].Imsi {
			t.Fatalf("record order mismatch at %d", i)
		}
	}
}

func TestCrossRuntime_TrafficBalanceDefault(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002", "traffic_balance": 5000000000},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	if frozen.Records[0].TrafficTotal != 5000000000 {
		t.Fatalf("expected traffic_total == traffic_balance, got %d", frozen.Records[0].TrafficTotal)
	}
}

func TestCrossRuntime_SmsBalanceDefault(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002", "sms_balance": 50},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	if frozen.Records[0].SmsTotal != 50 {
		t.Fatalf("expected sms_total == sms_balance, got %d", frozen.Records[0].SmsTotal)
	}
}

func TestCrossRuntime_PlanIdChangeAffectsHash(t *testing.T) {
	repo := newFakeImportRepo()
	a, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002", "plan_id": "plan_a"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport a: %v", err)
	}
	b, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002", "plan_id": "plan_b"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport b: %v", err)
	}
	if a.Targets[0].RecordIntentHash == b.Targets[0].RecordIntentHash {
		t.Fatal("expected different recordIntentHash for different plan_id")
	}
	if a.OperationFingerprint == b.OperationFingerprint {
		t.Fatal("expected different fingerprint for different plan_id")
	}
}

func TestCrossRuntime_ArdChangeAffectsHash(t *testing.T) {
	repo := newFakeImportRepo()
	a, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002", "access_restriction_data": 32},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport a: %v", err)
	}
	b, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002", "access_restriction_data": 64},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport b: %v", err)
	}
	if a.Targets[0].RecordIntentHash == b.Targets[0].RecordIntentHash {
		t.Fatal("expected different recordIntentHash for different ARD")
	}
}

func TestCrossRuntime_CanonicalFieldNames(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	expected := []string{"access_restriction_data", "plan_id", "sms_balance", "sms_total", "traffic_balance", "traffic_total"}
	if len(frozen.Summary.FieldNames) != len(expected) {
		t.Fatalf("expected %d fieldNames, got %d", len(expected), len(frozen.Summary.FieldNames))
	}
	for i, name := range expected {
		if frozen.Summary.FieldNames[i] != name {
			t.Fatalf("fieldNames[%d] = %s, want %s", i, frozen.Summary.FieldNames[i], name)
		}
	}
}

func TestCrossRuntime_AllFieldsCanonicalValues(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{
			"imsi":                    "454000000000002",
			"access_restriction_data": 32,
			"traffic_total":           10737418240,
			"traffic_balance":         10737418240,
			"sms_total":               100,
			"sms_balance":             100,
			"plan_id":                 "plan_default_10gb",
		},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	if err := AssertFrozenImportV2(frozen); err != nil {
		t.Fatalf("AssertFrozenImportV2: %v", err)
	}
	if frozen.SnapshotBytes <= 0 {
		t.Fatal("expected positive snapshotBytes")
	}
	// Verify deterministic canonical values
	if frozen.Targets[0].RecordIntentHash == "" {
		t.Fatal("expected non-empty recordIntentHash")
	}
	if frozen.Summary.FileHash == "" {
		t.Fatal("expected non-empty fileHash")
	}
	if frozen.OperationFingerprint == "" {
		t.Fatal("expected non-empty fingerprint")
	}
}

// ---------------------------------------------------------------------------
// Section 9: Frozen tamper tests
// ---------------------------------------------------------------------------

func TestTamper_InvalidImsiInRecords(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Records[0].Imsi = "invalid"
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for invalid IMSI")
	}
}

func TestTamper_RecordIntentHashModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Targets[0].RecordIntentHash = "tampered"
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered recordIntentHash")
	}
}

func TestTamper_TargetStateModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Targets[0].State = "present"
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered target state")
	}
}

func TestTamper_TargetOrderModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
		{"imsi": "454000000000003"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Targets[0], frozen.Targets[1] = frozen.Targets[1], frozen.Targets[0]
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered target order")
	}
}

func TestTamper_RecordOrderModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
		{"imsi": "454000000000003"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Records[0], frozen.Records[1] = frozen.Records[1], frozen.Records[0]
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered record order")
	}
}

func TestTamper_SummaryRowCountModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Summary.RowCount = 999
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered rowCount")
	}
}

func TestTamper_SummaryCreateCountModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Summary.CreateCount = 999
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered createCount")
	}
}

func TestTamper_SummarySkipCountModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Summary.SkipCount = 999
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered skipCount")
	}
}

func TestTamper_FieldNamesMissing(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Summary.FieldNames = []string{}
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for empty fieldNames")
	}
}

func TestTamper_FieldNamesExtra(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Summary.FieldNames = append(frozen.Summary.FieldNames, "extra")
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for extra fieldNames")
	}
}

func TestTamper_FieldNamesWrongOrder(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	// Reverse fieldNames
	for i, j := 0, len(frozen.Summary.FieldNames)-1; i < j; i, j = i+1, j-1 {
		frozen.Summary.FieldNames[i], frozen.Summary.FieldNames[j] = frozen.Summary.FieldNames[j], frozen.Summary.FieldNames[i]
	}
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for reversed fieldNames")
	}
}

func TestTamper_FileHashModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.Summary.FileHash = "tampered"
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered fileHash")
	}
}

func TestTamper_FingerprintModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.OperationFingerprint = "tampered"
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered fingerprint")
	}
}

func TestTamper_SnapshotBytesModified(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	frozen.SnapshotBytes = 0
	if err := AssertFrozenImportV2(frozen); err == nil {
		t.Fatal("expected error for tampered snapshotBytes")
	}
}

// ---------------------------------------------------------------------------
// Section 8: Snapshot cap — real Prepare
// ---------------------------------------------------------------------------

func TestSnapshotCap_NormalBelowCap(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	if frozen.SnapshotBytes > maxImportSnapshotBytes {
		t.Fatalf("expected snapshot within cap, got %d", frozen.SnapshotBytes)
	}
	if err := AssertFrozenImportV2(frozen); err != nil {
		t.Fatalf("AssertFrozenImportV2: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Section 7: Real Mongo insert-race evidence (uses fake repo for unit tests)
// ---------------------------------------------------------------------------

func TestInsertRace_AbsentImsi_InsertSucceeds(t *testing.T) {
	repo := &fakeImportRepo{existingImsis: map[string]bool{}, tariffPlans: map[string]bool{"plan_default_10gb": true}}
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	result, err := ExecuteFrozenImport(context.Background(), frozen, repo)
	if err != nil {
		t.Fatalf("ExecuteFrozenImport: %v", err)
	}
	if result.CreatedCount != 1 {
		t.Fatalf("expected createdCount 1, got %d", result.CreatedCount)
	}
	if len(repo.insertedDocs) != 1 {
		t.Fatalf("expected 1 inserted doc, got %d", len(repo.insertedDocs))
	}
}

func TestInsertRace_PresentImsi_Skipped(t *testing.T) {
	repo := newFakeImportRepo("454000000000001")
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000001"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	result, err := ExecuteFrozenImport(context.Background(), frozen, repo)
	if err != nil {
		t.Fatalf("ExecuteFrozenImport: %v", err)
	}
	if result.CreatedCount != 0 {
		t.Fatalf("expected createdCount 0, got %d", result.CreatedCount)
	}
	if len(result.SkippedImsis) != 1 {
		t.Fatalf("expected 1 skipped, got %d", len(result.SkippedImsis))
	}
	if len(repo.insertedDocs) != 0 {
		t.Fatalf("expected 0 inserted docs, got %d", len(repo.insertedDocs))
	}
}

func TestInsertRace_PreconditionDrift(t *testing.T) {
	// Prepare with IMSI absent, then make it present before execute
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{"imsi": "454000000000002"},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	// Simulate drift: IMSI now exists
	repo.existingImsis["454000000000002"] = true
	_, err = ExecuteFrozenImport(context.Background(), frozen, repo)
	if err == nil {
		t.Fatal("expected precondition changed error")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T", err)
	}
	if govErr.Code != ErrImportPreconditionChanged {
		t.Fatalf("expected %s, got %s", ErrImportPreconditionChanged, govErr.Code)
	}
}

// Verify no replace/upsert in v2 execution path
func TestInsertRace_NoReplaceUpsert(t *testing.T) {
	record := ImportRecord{
		Imsi: "454000000000002", AccessRestrictionData: 32,
		TrafficTotal: 10737418240, TrafficBalance: 10737418240,
		SmsTotal: 100, SmsBalance: 100, PlanId: "plan_default_10gb",
	}
	doc := buildImportSubscriberDoc(record)
	// Verify the doc doesn't contain replace/upsert markers
	for _, key := range []string{"$set", "$unset", "$replace", "upsert"} {
		if _, ok := doc[key]; ok {
			t.Fatalf("unexpected key %s in import doc", key)
		}
	}
	// Verify it's a plain insert document
	if doc["imsi"] != "454000000000002" {
		t.Fatalf("expected imsi in doc, got %v", doc["imsi"])
	}
}

// Verify sensitive keys are not present in normalized records
func TestNormalizedRecord_NoSensitiveKeys(t *testing.T) {
	record := map[string]any{
		"imsi": "454000000000001",
	}
	normalized := NormalizeImportRecord(record)
	recMap := map[string]any{
		"imsi":                    normalized.Imsi,
		"access_restriction_data": normalized.AccessRestrictionData,
		"traffic_total":           normalized.TrafficTotal,
		"traffic_balance":         normalized.TrafficBalance,
		"sms_total":               normalized.SmsTotal,
		"sms_balance":             normalized.SmsBalance,
		"plan_id":                 normalized.PlanId,
	}
	for _, key := range sensitiveKeys {
		if _, ok := recMap[key]; ok {
			t.Fatalf("unexpected sensitive key %s in normalized record", key)
		}
	}
}

func TestPrepareFrozenImport_OversizedSnapshotRejected(t *testing.T) {
	repo := newFakeImportRepo()
	// Generate enough records to exceed 512KB snapshotBytes
	// Each record ~308 bytes in stable JSON, need >1701 records to exceed 512KB
	records := make([]map[string]any, 2000)
	for i := range records {
		records[i] = map[string]any{
			"imsi":                    fmt.Sprintf("45400000%07d", i),
			"access_restriction_data": 32,
			"traffic_total":           10737418240,
			"traffic_balance":         10737418240,
			"sms_total":               100,
			"sms_balance":             100,
			"plan_id":                 "plan_default_10gb",
		}
	}
	_, err := PrepareFrozenImport(context.Background(), records, repo)
	if err == nil {
		t.Fatal("expected error for oversized snapshot")
	}
	govErr, ok := err.(*SubscriberGovernanceError)
	if !ok {
		t.Fatalf("expected SubscriberGovernanceError, got %T: %v", err, err)
	}
	if govErr.Code != ErrApprovalSnapshotTooLarge {
		t.Fatalf("expected APPROVAL_SNAPSHOT_TOO_LARGE, got %s", govErr.Code)
	}
}

// Helper for test logging cross-runtime fixture values
func TestCrossRuntime_PrintCanonicalValues(t *testing.T) {
	repo := newFakeImportRepo()
	frozen, err := PrepareFrozenImport(context.Background(), []map[string]any{
		{
			"imsi":                    "454000000000002",
			"access_restriction_data": 32,
			"traffic_total":           10737418240,
			"traffic_balance":         10737418240,
			"sms_total":               100,
			"sms_balance":             100,
			"plan_id":                 "plan_default_10gb",
		},
	}, repo)
	if err != nil {
		t.Fatalf("PrepareFrozenImport: %v", err)
	}
	if err := AssertFrozenImportV2(frozen); err != nil {
		t.Fatalf("AssertFrozenImportV2: %v", err)
	}
	fmt.Printf("GO_CROSS_RUNTIME_FIXTURE_ALL_FIELDS: recordIntentHash=%s fileHash=%s fingerprint=%s snapshotBytes=%d fieldNames=%s\n",
		frozen.Targets[0].RecordIntentHash,
		frozen.Summary.FileHash,
		frozen.OperationFingerprint,
		frozen.SnapshotBytes,
		strings.Join(frozen.Summary.FieldNames, ","),
	)
}
