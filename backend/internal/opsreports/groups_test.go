package opsreports

import (
	"context"
	"encoding/csv"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"subscriber/internal/operationsview"
)

type reportGroupResolver struct {
	scope operationsview.GroupScope
	fail  bool
}

func (f *reportGroupResolver) ResolveGroupScope(context.Context, operationsview.GroupFilter) (operationsview.GroupScope, error) {
	if f.fail {
		return f.scope, errors.New("down")
	}
	return f.scope, nil
}

type reportScopeSpy struct {
	query Query
	calls int
}

func (s *reportScopeSpy) Generate(_ context.Context, q Query, _ string) *Report {
	s.query = q
	s.calls++
	return &Report{GeneratedAt: time.Now().UTC(), Query: q, Alerts: Section{Completeness: "complete", Scope: "window_events", Data: map[string]any{}}, Config: Section{Completeness: "complete", Data: map[string]any{}}, AlertRows: []map[string]any{{"rowId": strings.Repeat("a", 64), "ruleName": "first"}, {"rowId": strings.Repeat("b", 64), "ruleName": "second"}}, RowsLimited: map[string]bool{}}
}
func completeReportGroup() *reportGroupResolver {
	return &reportGroupResolver{scope: operationsview.GroupScope{IDs: []string{"11111111-1111-4111-8111-111111111111"}, Fingerprint: strings.Repeat("1", 64), Inventory: operationsview.GroupCoverage{Completeness: "complete"}, Topology: operationsview.GroupCoverage{Completeness: "complete"}}}
}
func TestGroupReportNeverFallsBackAndIntersectsResource(t *testing.T) {
	spy := &reportScopeSpy{}
	resolver := completeReportGroup()
	s := NewService(spy, nil)
	s.SetGroups(resolver, nil)
	q := Query{SiteResourceID: "22222222-2222-4222-8222-222222222222", From: time.Now().Add(-time.Hour), To: time.Now(), ResourceID: "33333333-3333-4333-8333-333333333333"}
	r := s.Generate(context.Background(), q, "")
	if spy.query.ScopeIDs == nil || len(spy.query.ScopeIDs) != 0 || r.Query.ScopeFingerprint == "" {
		t.Fatal("empty intersection broadened scope")
	}
	resolver.scope.Topology.Completeness = "partial"
	calls := spy.calls
	r = s.Generate(context.Background(), q, "")
	if r.Alerts.Completeness != "unavailable" || spy.calls != calls {
		t.Fatal("partial graph reached a global report")
	}
	resolver.fail = true
	r = s.Generate(context.Background(), q, "")
	if r.Metrics.Completeness != "unavailable" || spy.calls != calls {
		t.Fatal("resolver failure reached repository")
	}
}
func TestGroupReportCursorBindsWindowSectionAndMembership(t *testing.T) {
	spy := &reportScopeSpy{}
	resolver := completeReportGroup()
	s := NewService(spy, nil)
	s.SetGroups(resolver, nil)
	q := Query{NetworkKey: "a", From: time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC), To: time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC), Limit: 1}
	page, e := s.Page(context.Background(), q, "alerts")
	if e != nil || !page.HasMore || page.NextCursor == nil {
		t.Fatal(e)
	}
	q = page.Query
	q.Cursor = *page.NextCursor
	q.Limit = 1
	continued, e := s.Page(context.Background(), q, "alerts")
	if e != nil || len(continued.Items) != 1 || continued.HasMore {
		t.Fatalf("continuation failed: %#v %v", continued, e)
	}
	if _, e = s.Page(context.Background(), q, "metrics"); e == nil || !strings.Contains(e.Error(), "scope_changed") {
		t.Fatal("cursor crossed report sections")
	}
	changed := q
	changed.From = changed.From.Add(time.Hour)
	if _, e = s.Page(context.Background(), changed, "alerts"); e == nil {
		t.Fatal("cursor crossed windows")
	}
	resolver.scope.Fingerprint = strings.Repeat("2", 64)
	if _, e = s.Page(context.Background(), q, "alerts"); e == nil {
		t.Fatal("cursor survived membership change")
	}
}
func TestGroupReportQueryAndCSVSafelyRetainSelectors(t *testing.T) {
	spy := &reportScopeSpy{}
	s := NewService(spy, nil)
	s.SetGroups(completeReportGroup(), nil)
	q := Query{NetworkKey: "a", OperatorName: "=FORMULA()", PLMN: "001001", From: time.Now().Add(-time.Hour), To: time.Now()}
	data, e := s.Export(context.Background(), q, "alerts")
	if e != nil {
		t.Fatal(e)
	}
	rows, e := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(data), "\ufeff"))).ReadAll()
	if e != nil {
		t.Fatal(e)
	}
	column := func(name string) int {
		for i, k := range rows[0] {
			if k == name {
				return i
			}
		}
		t.Fatalf("missing metadata %s", name)
		return -1
	}
	if rows[1][column("filterPLMN")] != "001001" || rows[1][column("filterOperatorName")] != "'=FORMULA()" || rows[1][column("membershipMeaning")] != "current_assignment" {
		t.Fatal("CSV lost or failed to escape grouping metadata")
	}
	for _, query := range []string{"networkKey=a&plmn=001001", "domain=platform", "includeRetired=1"} {
		v, _ := url.ParseQuery(query)
		if _, e := ParseQuery(v, time.Now()); e != nil {
			t.Fatal(e)
		}
	}
	for _, query := range []string{"networkKey=a&networkKey=b", "siteResourceId=bad", "plmn=1", "networkKey=a&cursor=" + strings.Repeat("a", 64)} {
		v, _ := url.ParseQuery(query)
		if _, e := ParseQuery(v, time.Now()); e == nil {
			t.Fatalf("invalid group report accepted: %s", query)
		}
	}
}
