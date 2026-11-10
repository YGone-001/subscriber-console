package opsreports

import (
	"context"
	"encoding/csv"
	"net/url"
	"strings"
	"testing"
	"time"
)

type testRepository struct{ report *Report }

func (r testRepository) Generate(context.Context, Query, string) *Report { return r.report }
func TestQueryWindowAndFilters(t *testing.T) {
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	for period, span := range map[string]time.Duration{"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour} {
		q, e := ParseQuery(url.Values{"period": []string{period}}, now)
		if e != nil || !q.To.Equal(now) || q.To.Sub(q.From) != span {
			t.Fatal("relative window was not server anchored")
		}
	}
	if _, e := ParseQuery(url.Values{"period": []string{"24h"}, "to": []string{now.Format(time.RFC3339)}}, now); e == nil {
		t.Fatal("ambiguous relative and absolute windows accepted")
	}
	for _, query := range []string{"from=2026-11-01T00:00:00Z", "to=2026-11-10T00:00:00Z", "resourceId=not-a-uuid", "severity=major", "limit=0", "limit=1&limit=2", "unknown=x", "domain=anything"} {
		values, _ := url.ParseQuery(query)
		if _, e := ParseQuery(values, now); e == nil {
			t.Fatalf("invalid query accepted: %s", query)
		}
	}
	values, _ := url.ParseQuery("from=2026-11-08T18:00:00%2B08:00&to=2026-11-09T18:00:00%2B08:00")
	q, e := ParseQuery(values, now)
	if e != nil || !q.To.Equal(now) || q.To.Sub(q.From) != 24*time.Hour {
		t.Fatal("timezone window changed")
	}
}
func TestCSVProtectsFormulasAndPreservesNull(t *testing.T) {
	for _, value := range []string{"=2+2", " \t@SUM(A1)", "\n-CMD", "+cmd"} {
		if !strings.HasPrefix(safeCSV(value), "'") {
			t.Fatal("formula prefix unprotected")
		}
	}
	if safeCSV(nil) != "" {
		t.Fatal("null fabricated a zero")
	}
	if safeCSV(float64(-5.25)) != "-5.25" || safeCSV(int64(-2)) != "-2" {
		t.Fatal("numeric measurements were converted to spreadsheet text")
	}
	r := &Report{GeneratedAt: time.Now(), Alerts: Section{Completeness: "complete", Scope: "window_events"}, AlertRows: []map[string]any{{"ruleName": "=2+2", "resourceId": nil, "targetName": "line\n\"quoted\""}}, RowsLimited: map[string]bool{}}
	s := NewService(testRepository{r}, nil)
	data, e := s.Export(context.Background(), Query{From: time.Now().Add(-time.Hour), To: time.Now(), Domain: "5gc", Severity: "critical"}, "alerts")
	if e != nil {
		t.Fatal(e)
	}
	rows, e := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(data), "\ufeff"))).ReadAll()
	if e != nil || len(rows) != 2 || rows[1][10] != "'=2+2" || rows[1][11] != "" || rows[1][13] != "line\n\"quoted\"" || rows[1][8] != "5gc" || rows[1][9] != "critical" {
		t.Fatal("CSV values corrupted")
	}
	r.RowsLimited["alerts"] = true
	if _, e = s.Export(context.Background(), Query{}, "alerts"); e == nil {
		t.Fatal("truncated CSV accepted")
	}
	r.RowsLimited["alerts"] = false
	r.Alerts.Completeness = "unavailable"
	if _, e = s.Export(context.Background(), Query{}, "alerts"); e == nil {
		t.Fatal("failed source exported as empty")
	}
}
func TestReportPageAndCurrentConfigScope(t *testing.T) {
	r := &Report{GeneratedAt: time.Now(), Alerts: Section{Completeness: "complete"}, Config: Section{Completeness: "complete"}, AlertRows: []map[string]any{{"rowId": "a"}, {"rowId": "b"}, {"rowId": "c"}}, RowsLimited: map[string]bool{}}
	s := NewService(testRepository{r}, func() map[string]any { return map[string]any{"catalogState": "not_configured"} })
	p, e := s.Page(context.Background(), Query{Limit: 2}, "alerts")
	if e != nil || !p.HasMore || len(p.Items) != 2 || *p.NextCursor != "b" {
		t.Fatal("cursor page incorrect")
	}
	p, e = s.Page(context.Background(), Query{Limit: 2, Cursor: "b"}, "alerts")
	if e != nil || p.HasMore || len(p.Items) != 1 {
		t.Fatal("cursor continuation incorrect")
	}
	if s.Generate(context.Background(), Query{}, "").Config.Completeness != "unavailable" {
		t.Fatal("unconfigured sources invented a complete zero")
	}
}

func TestCSVEmptyMetadataCancellationAndBudgets(t *testing.T) {
	r := &Report{GeneratedAt: time.Now(), Alerts: Section{Completeness: "complete", Scope: "window_events"}, RowsLimited: map[string]bool{}}
	s := NewService(testRepository{r}, nil)
	q := Query{From: time.Now().Add(-time.Hour), To: time.Now(), Domain: "5gc"}
	data, err := s.Export(context.Background(), q, "alerts")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(data), "\ufeff"))).ReadAll()
	if err != nil || len(rows) != 2 || rows[1][6] != "no_matching_records" || rows[1][8] != q.Domain || rows[1][10] != "" {
		t.Fatal("empty export lost its filter metadata or invented an alert")
	}
	r.AlertRows = []map[string]any{{"ruleName": strings.Repeat("x", 10<<20)}}
	if _, err = s.Export(context.Background(), q, "alerts"); err == nil {
		t.Fatal("oversize export was accepted")
	}
	r.AlertRows = make([]map[string]any, 10001)
	if _, err = s.Export(context.Background(), q, "alerts"); err == nil {
		t.Fatal("row limit was silently truncated")
	}
	r.AlertRows = []map[string]any{{"ruleName": "example"}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = s.Export(ctx, q, "alerts"); err == nil {
		t.Fatal("cancelled export was accepted")
	}
}
