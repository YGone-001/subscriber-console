package analytics

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBuildUsageTrendExpandsSparseBuckets(t *testing.T) {
	start := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	buckets := map[string]usageBucket{
		"2026-10-21T10:00:00Z": {Octets: 100, Records: 1},
		"2026-10-21T12:00:00Z": {Octets: 250, Records: 2},
	}

	trend, records, total := buildUsageTrend(start, 4, buckets)
	if len(trend) != 4 {
		t.Fatalf("expected 4 buckets, got %d", len(trend))
	}
	wantHours := []string{
		"2026-10-21T10:00:00Z",
		"2026-10-21T11:00:00Z",
		"2026-10-21T12:00:00Z",
		"2026-10-21T13:00:00Z",
	}
	wantOctets := []int64{100, 0, 250, 0}
	for index, point := range trend {
		if point.Hour != wantHours[index] {
			t.Errorf("bucket %d hour = %s, want %s", index, point.Hour, wantHours[index])
		}
		if point.Octets != wantOctets[index] {
			t.Errorf("bucket %d octets = %d, want %d", index, point.Octets, wantOctets[index])
		}
	}
	if records != 3 {
		t.Errorf("records = %d, want 3", records)
	}
	if total != 350 {
		t.Errorf("total = %d, want 350", total)
	}
}

func TestBuildUsageTrendRejectsEmptyWindow(t *testing.T) {
	trend, records, total := buildUsageTrend(time.Now(), 0, nil)
	if len(trend) != 0 || records != 0 || total != 0 {
		t.Fatalf("zero-hour window must stay empty, got %d points, %d records, %d total", len(trend), records, total)
	}
}

func TestTopUsageEntriesComputesShareAndSkipsEmptyIdentity(t *testing.T) {
	rows := []imsiUsageRow{
		{IMSI: "460020000000001", Used: 600},
		{IMSI: "", Used: 10},
		{IMSI: "460020000000002", Used: 400},
	}
	top := topUsageEntries(rows, 1000)
	if len(top) != 2 {
		t.Fatalf("expected 2 non-empty entries, got %d", len(top))
	}
	if top[0].Share != 60 || top[1].Share != 40 {
		t.Fatalf("unexpected shares: %+v", top)
	}
	if empty := topUsageEntries(rows, 0); len(empty) != 0 {
		t.Fatalf("zero total must yield an empty list, got %+v", empty)
	}
}

func TestAnalyticsMetricsSerializesBusinessFields(t *testing.T) {
	payload := AnalyticsMetrics{
		UsageWindowHours:       24,
		UsageWindowRecords:     3,
		UsageWindowTotalOctets: 1024,
		UsageTrend: []UsageTrendPoint{{
			Hour:   "2026-10-21T10:00:00Z",
			Octets: 1024,
		}},
		TopUsage: []TopUsageEntry{{
			IMSI:       "460020000000001",
			UsedOctets: 512,
			Share:      50,
		}},
		LatestUsageAt: "2026-10-21T10:30:00Z",
		OcsBalances: OcsBalanceMetrics{
			InvariantChecked:         10,
			InvariantSampleLimit:     500,
			InvariantScope:           "data_balance",
			VoiceAllocationDefaulted: 8,
			SmsAllocationDefaulted:   3,
		},
		OcsSessions: OcsSessionMetrics{
			ActiveUsedOctets: 2048,
			ActiveUsageTop: []TopUsageEntry{{
				IMSI:       "460020000000001",
				UsedOctets: 1024,
				Share:      50,
			}},
		},
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal analytics metrics: %v", err)
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(encoded, &raw); err != nil {
		t.Fatalf("unmarshal analytics metrics: %v", err)
	}

	if raw["usageWindowHours"] != float64(24) {
		t.Errorf("usageWindowHours = %v", raw["usageWindowHours"])
	}
	if raw["usageWindowRecords"] != float64(3) {
		t.Errorf("usageWindowRecords = %v", raw["usageWindowRecords"])
	}
	trend, ok := raw["usageTrend"].([]interface{})
	if !ok || len(trend) != 1 {
		t.Fatalf("usageTrend missing or empty: %v", raw["usageTrend"])
	}
	top, ok := raw["topUsage"].([]interface{})
	if !ok || len(top) != 1 {
		t.Fatalf("topUsage missing or empty: %v", raw["topUsage"])
	}
	balances, ok := raw["ocsBalances"].(map[string]interface{})
	if !ok {
		t.Fatalf("ocsBalances missing")
	}
	if balances["invariantChecked"] != float64(10) {
		t.Errorf("invariantChecked = %v", balances["invariantChecked"])
	}
	if balances["invariantSampleLimit"] != float64(500) {
		t.Errorf("invariantSampleLimit = %v", balances["invariantSampleLimit"])
	}
	sessions, ok := raw["ocsSessions"].(map[string]interface{})
	if !ok {
		t.Fatalf("ocsSessions missing")
	}
	if sessions["activeUsedOctets"] != float64(2048) {
		t.Errorf("activeUsedOctets = %v", sessions["activeUsedOctets"])
	}
	if topActive, ok := sessions["activeUsageTop"].([]interface{}); !ok || len(topActive) != 1 {
		t.Errorf("activeUsageTop missing or empty: %v", sessions["activeUsageTop"])
	}
}
