package opsreports

import (
	"context"
	"encoding/csv"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestMetricSourceAndResolutionAreValidated(t *testing.T) {
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	q, e := ParseQuery(url.Values{"source": {"aggregate"}, "resolution": {"1d"}}, now)
	if e != nil || q.Source != "aggregate" || q.Resolution != "1d" {
		t.Fatalf("aggregate daily query rejected: %+v %v", q, e)
	}
	q, e = ParseQuery(url.Values{}, now)
	if e != nil || q.Source != "raw" || q.Resolution != "1h" {
		t.Fatalf("defaults are not the raw partition: %+v %v", q, e)
	}
	for _, bad := range []string{"source=history", "source=raw&resolution=1d", "source=aggregate&resolution=5m", "resolution=1d"} {
		values, _ := url.ParseQuery(bad)
		if _, e := ParseQuery(values, now); e == nil {
			t.Fatalf("invalid metric partition accepted: %s", bad)
		}
	}
}

func exportRecords(t *testing.T, data []byte) [][]string {
	t.Helper()
	records, e := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(data), "\ufeff"))).ReadAll()
	if e != nil || len(records) < 1 {
		t.Fatalf("export unreadable: %v", e)
	}
	return records
}

func TestAggregateExportUsesItsOwnColumnSet(t *testing.T) {
	now := time.Now().UTC()
	row := map[string]any{
		"resourceId": "=cmd|' /C calc'!A0", "targetId": "target", "metric": "process_resident_memory_bytes",
		"unit": "bytes", "resolution": "1h", "algorithmVersion": "rss-hour-v2", "bucketStart": now,
		"identityEpoch": "epoch", "quality": "measured", "sourceComplete": true, "p95State": "complete",
		"sampleCount": int64(3), "min": 1.0, "max": 3.0, "mean": 2.0, "p95": 3.0, "coveredSeconds": 120.0,
	}
	report := &Report{GeneratedAt: now, Query: Query{Source: "aggregate", Resolution: "1h"}, Metrics: Section{Completeness: "complete", Scope: "retained_aggregates"}, MetricRows: []map[string]any{row}, RowsLimited: map[string]bool{}}
	s := NewService(testRepository{report}, nil)
	data, e := s.Export(context.Background(), Query{From: now.Add(-time.Hour), To: now, Source: "aggregate", Resolution: "1h"}, "metrics")
	if e != nil {
		t.Fatal(e)
	}
	records := exportRecords(t, data)
	if len(records) != 2 {
		t.Fatalf("aggregate export row count = %d", len(records))
	}
	header := strings.Join(records[0], ",")
	for _, required := range []string{"p95", "algorithmVersion", "resolution", "identityEpoch", "p95State"} {
		if !strings.Contains(header, required) {
			t.Fatalf("aggregate export is missing %s: %s", required, header)
		}
	}
	for _, rawOnly := range []string{"label_nf", "lastAt", "category"} {
		if strings.Contains(header, rawOnly) {
			t.Fatalf("aggregate export mixed raw column %q: %s", rawOnly, header)
		}
	}
	// The metadata block occupies ten cells, so the first data column is ten.
	if !strings.HasPrefix(records[1][10], "'=") {
		t.Fatalf("aggregate formula cell not neutralised: %q", records[1][10])
	}
	// The raw partition keeps its own columns and never gains an aggregate one.
	report.Query.Source = "raw"
	report.MetricRows = []map[string]any{{"resourceId": "r", "key": "process_resident_memory_bytes", "type": "gauge", "unit": "bytes", "sampleCount": int64(1), "last": 1.0, "min": 1.0, "max": 1.0, "mean": 1.0}}
	raw, e := s.Export(context.Background(), Query{From: now.Add(-time.Hour), To: now}, "metrics")
	if e != nil {
		t.Fatal(e)
	}
	rawHeader := strings.Join(exportRecords(t, raw)[0], ",")
	if strings.Contains(rawHeader, "p95") || strings.Contains(rawHeader, "identityEpoch") {
		t.Fatalf("raw export gained aggregate columns: %s", rawHeader)
	}
	if !strings.Contains(rawHeader, "lastAt") {
		t.Fatalf("raw export lost its own columns: %s", rawHeader)
	}
}
