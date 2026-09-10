package subscriber

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
)

type ImportFixtureData struct {
	Input                []map[string]any `json:"input"`
	NormalizedRecords    []ImportRecord   `json:"normalizedRecords"`
	Targets              []ImportTarget   `json:"targets"`
	FieldNames           []string         `json:"fieldNames"`
	RecordIntentHashes   []string         `json:"recordIntentHashes"`
	FileHash             string           `json:"fileHash"`
	OperationFingerprint string           `json:"operationFingerprint"`
	SnapshotBytes        int              `json:"snapshotBytes"`
}

func loadImportFixture(t *testing.T, name string) ImportFixtureData {
	t.Helper()
	data, err := os.ReadFile("../../../tests/fixtures/subscriber-import-v2.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixtures map[string]ImportFixtureData
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	f, ok := fixtures[name]
	if !ok {
		t.Fatalf("fixture %q not found", name)
	}
	return f
}

func assertHash(t *testing.T, label, expected, actual string) {
	t.Helper()
	if expected != actual {
		t.Errorf("%s mismatch:\n  Node: %s\n  Go:   %s", label, expected, actual)
	}
}

func TestImportFixture_ImsiOnly(t *testing.T) {
	f := loadImportFixture(t, "imsi_only")
	rec := NormalizeImportRecord(f.Input[0])
	assertHash(t, "recordIntentHash", f.RecordIntentHashes[0], ComputeRecordIntentHash(rec))
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash([]ImportRecord{rec}))
}

func TestImportFixture_TrafficBalanceOnly(t *testing.T) {
	f := loadImportFixture(t, "traffic_balance_only")
	rec := NormalizeImportRecord(f.Input[0])
	assertHash(t, "recordIntentHash", f.RecordIntentHashes[0], ComputeRecordIntentHash(rec))
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash([]ImportRecord{rec}))
}

func TestImportFixture_SmsBalanceOnly(t *testing.T) {
	f := loadImportFixture(t, "sms_balance_only")
	rec := NormalizeImportRecord(f.Input[0])
	assertHash(t, "recordIntentHash", f.RecordIntentHashes[0], ComputeRecordIntentHash(rec))
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash([]ImportRecord{rec}))
}

func TestImportFixture_AllFields(t *testing.T) {
	f := loadImportFixture(t, "all_fields")
	rec := NormalizeImportRecord(f.Input[0])
	assertHash(t, "recordIntentHash", f.RecordIntentHashes[0], ComputeRecordIntentHash(rec))
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash([]ImportRecord{rec}))
}

func TestImportFixture_TwoAbsent(t *testing.T) {
	f := loadImportFixture(t, "two_absent")
	var records []ImportRecord
	for _, raw := range f.Input {
		records = append(records, NormalizeImportRecord(raw))
	}
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash(records))
	for i, rec := range records {
		assertHash(t, "recordIntentHash["+rec.Imsi+"]", f.RecordIntentHashes[i], ComputeRecordIntentHash(rec))
	}
}

func TestImportFixture_PresentAndAbsent(t *testing.T) {
	f := loadImportFixture(t, "present_and_absent")
	var records []ImportRecord
	for _, raw := range f.Input {
		records = append(records, NormalizeImportRecord(raw))
	}
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash(records))
	for i, rec := range records {
		assertHash(t, "recordIntentHash["+rec.Imsi+"]", f.RecordIntentHashes[i], ComputeRecordIntentHash(rec))
	}
}

func TestImportFixture_AllPresent(t *testing.T) {
	f := loadImportFixture(t, "all_present")
	var records []ImportRecord
	for _, raw := range f.Input {
		records = append(records, NormalizeImportRecord(raw))
	}
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash(records))
}

func TestImportFixture_ReversedOrder(t *testing.T) {
	f := loadImportFixture(t, "reversed_order")
	var records []ImportRecord
	for _, raw := range f.Input {
		records = append(records, NormalizeImportRecord(raw))
	}
	// Reversed source should produce same fileHash after sorting
	assertHash(t, "fileHash", f.FileHash, ComputeFileHash(records))
}

func TestImportFixture_ReversedKeys(t *testing.T) {
	f := loadImportFixture(t, "reversed_keys")
	rec := NormalizeImportRecord(f.Input[0])
	assertHash(t, "recordIntentHash", f.RecordIntentHashes[0], ComputeRecordIntentHash(rec))
}

func TestImportFixture_PlanChanged(t *testing.T) {
	f := loadImportFixture(t, "plan_changed")
	rec := NormalizeImportRecord(f.Input[0])
	assertHash(t, "recordIntentHash", f.RecordIntentHashes[0], ComputeRecordIntentHash(rec))
}

func TestImportFixture_ArdChanged(t *testing.T) {
	f := loadImportFixture(t, "ard_changed")
	rec := NormalizeImportRecord(f.Input[0])
	assertHash(t, "recordIntentHash", f.RecordIntentHashes[0], ComputeRecordIntentHash(rec))
}

func TestImportFixture_CrossRuntimeParity(t *testing.T) {
	data, err := os.ReadFile("../../../tests/fixtures/subscriber-import-v2.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixtures map[string]ImportFixtureData
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}

	for name, f := range fixtures {
		t.Run(name, func(t *testing.T) {
			// Normalize records and sort by IMSI (matching Node fixture producer)
			var records []ImportRecord
			for _, raw := range f.Input {
				records = append(records, NormalizeImportRecord(raw))
			}
			sort.Slice(records, func(i, j int) bool { return records[i].Imsi < records[j].Imsi })

			// Verify recordIntentHashes
			for i, rec := range records {
				actual := ComputeRecordIntentHash(rec)
				if f.RecordIntentHashes[i] != actual {
					t.Errorf("recordIntentHash[%d] mismatch:\n  Node: %s\n  Go:   %s", i, f.RecordIntentHashes[i], actual)
				}
			}

			// Verify fileHash
			actualFileHash := ComputeFileHash(records)
			if f.FileHash != actualFileHash {
				t.Errorf("fileHash mismatch:\n  Node: %s\n  Go:   %s", f.FileHash, actualFileHash)
			}

			// Build targets using fixture's states and verify fingerprint
			targets := make([]ImportTarget, len(records))
			for i, rec := range records {
				targets[i] = ImportTarget{
					Imsi:             rec.Imsi,
					State:            f.Targets[i].State,
					RecordIntentHash: ComputeRecordIntentHash(rec),
				}
			}
			actualFingerprint := ComputeImportFingerprint(targets, "skip-existing-create-only", actualFileHash)
			if f.OperationFingerprint != actualFingerprint {
				t.Errorf("operationFingerprint mismatch:\n  Node: %s\n  Go:   %s", f.OperationFingerprint, actualFingerprint)
			}

			// Verify snapshotBytes
			fieldNames := make([]string, len(canonicalImportFieldNames))
			copy(fieldNames, canonicalImportFieldNames)
			createCount := 0
			skipCount := 0
			for _, t := range targets {
				if t.State == "absent" {
					createCount++
				} else {
					skipCount++
				}
			}
			snapshotSource := map[string]any{
				"version":     "subscriber-import-v2",
				"records":     records,
				"targets":     targets,
				"targetCount": len(targets),
				"summary": map[string]any{
					"rowCount":    len(records),
					"createCount": createCount,
					"skipCount":   skipCount,
					"fieldNames":  fieldNames,
					"fileHash":    actualFileHash,
				},
				"strategy":             "skip-existing-create-only",
				"operationFingerprint": actualFingerprint,
			}
			actualSnapshotBytes := len(stableJSON(snapshotSource))
			if f.SnapshotBytes != actualSnapshotBytes {
				t.Errorf("snapshotBytes mismatch:\n  Node: %d\n  Go:   %d", f.SnapshotBytes, actualSnapshotBytes)
			}
		})
	}
}
