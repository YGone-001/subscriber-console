package inspections

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func fixtureDefinition() Definition {
	return Definition{Name: "SYNTHETIC duty inspection", Scope: ScopeSelector{Mode: "all", ResourceIDs: []string{}}, Checks: append([]string{}, CheckKinds...), ConfigMaxAgeSeconds: 86400, Schedule: Schedule{Kind: "daily", Timezone: "Asia/Shanghai", Time: "09:00"}}
}
func instant(s string) time.Time {
	at, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		panic(e)
	}
	return at
}
func TestSchedulesCalendarDSTAndIntervals(t *testing.T) {
	tests := []struct {
		name        string
		s           Schedule
		after, want string
	}{
		{"shanghai", Schedule{Kind: "daily", Timezone: "Asia/Shanghai", Time: "09:00"}, "2026-11-19T01:00:00Z", "2026-11-20T01:00:00Z"},
		{"weekly", Schedule{Kind: "weekly", Timezone: "Asia/Shanghai", Time: "09:00", Weekday: 1}, "2026-11-19T01:00:00Z", "2026-11-23T01:00:00Z"},
		{"spring_gap", Schedule{Kind: "daily", Timezone: "America/New_York", Time: "02:30"}, "2026-03-07T08:00:00Z", "2026-03-09T06:30:00Z"},
		{"fall_first", Schedule{Kind: "daily", Timezone: "America/New_York", Time: "01:30"}, "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z"},
		{"fall_no_second", Schedule{Kind: "daily", Timezone: "America/New_York", Time: "01:30"}, "2026-11-01T05:40:00Z", "2026-11-02T06:30:00Z"},
		{"fixed_elapsed", Schedule{Kind: "interval", Timezone: "America/New_York", IntervalSeconds: 3600}, "2026-11-01T05:40:00Z", "2026-11-01T06:40:00Z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, e := nextScheduled(tt.s, instant(tt.after))
			if e != nil || !got.Equal(instant(tt.want)) {
				t.Fatalf("next=%s error=%v want=%s", got, e, tt.want)
			}
		})
	}
	for _, s := range []Schedule{{Kind: "shell", Timezone: "UTC"}, {Kind: "interval", Timezone: "UTC", IntervalSeconds: 1}, {Kind: "daily", Timezone: "UTC", Time: "25:00"}, {Kind: "weekly", Timezone: "UTC", Time: "09:00", Weekday: 9}, {Kind: "daily", Timezone: "invalid", Time: "09:00"}} {
		if validateSchedule(s) == nil {
			t.Fatalf("accepted invalid schedule %+v", s)
		}
	}
	next, n := advanceSchedule(Schedule{Kind: "interval", Timezone: "UTC", IntervalSeconds: 900}, instant("2026-01-01T00:00:00Z"), instant("2026-11-19T00:00:00Z"))
	if !next.After(instant("2026-11-19T00:00:00Z")) || n < 1000 {
		t.Fatalf("downtime was not bounded arithmetically: %s %d", next, n)
	}
}
func TestDefinitionRejectsAmbiguousAndUnboundedInputs(t *testing.T) {
	for _, alter := range []func(*Definition){func(d *Definition) { d.Scope.Mode = "" }, func(d *Definition) { d.Scope.ResourceIDs = []string{newID()} }, func(d *Definition) { d.Checks = []string{"shell"} }, func(d *Definition) { d.Checks = []string{"agents", "agents"} }, func(d *Definition) { d.ConfigMaxAgeSeconds = 0 }, func(d *Definition) { d.Scope.Filter.IncludeRetired = true }, func(d *Definition) { d.Name = "\n" }} {
		d := fixtureDefinition()
		alter(&d)
		if _, e := normalizeDefinition(d); e == nil {
			t.Fatalf("accepted invalid definition %+v", d)
		}
	}
	d := fixtureDefinition()
	d.Scope.Mode = "resources"
	d.Scope.ResourceIDs = []string{newID(), newID()}
	if _, e := normalizeDefinition(d); e != nil {
		t.Fatal(e)
	}
}
func TestConclusionsNeverConvertMissingEvidenceIntoPass(t *testing.T) {
	for _, tc := range []struct {
		name      string
		items     []Item
		coverage  string
		resources int
		want      string
	}{
		{"all_pass", []Item{{Result: "pass"}}, "complete", 1, "pass"},
		{"no_objects", []Item{}, "complete", 0, "inconclusive"},
		{"unknown", []Item{{Result: "pass"}, {Result: "unknown"}}, "complete", 1, "inconclusive"},
		{"partial", []Item{{Result: "pass"}}, "partial", 1, "inconclusive"},
		{"findings_with_gaps", []Item{{Result: "finding"}, {Result: "unknown"}}, "partial", 1, "findings"},
		{"not_applicable_only", []Item{{Result: "not_applicable"}}, "complete", 1, "inconclusive"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := Run{Items: tc.items, Scope: ResolvedScope{Resources: make([]ResourceFact, tc.resources), Coverage: Coverage{State: "complete"}}, Coverage: map[string]Coverage{"monitoring": {State: tc.coverage}}}
			summarize(&v)
			if v.Conclusion != tc.want {
				t.Fatalf("got=%s want=%s", v.Conclusion, tc.want)
			}
		})
	}
}
func TestComparisonRequiresIdentityAndNewValidEvidence(t *testing.T) {
	d := fixtureDefinition()
	old := &Run{ID: newID(), Version: Version, Definition: d, Items: []Item{{Key: "old", Result: "finding", Compatibility: "g1"}, {Key: "missing", Result: "finding"}, {Key: "changed", Result: "finding", Compatibility: "g1"}}}
	v := &Run{Version: Version, Definition: d, Items: []Item{{Key: "old", Result: "unknown", Compatibility: "g1"}, {Key: "new", Result: "finding"}, {Key: "changed", Result: "pass", Compatibility: "g2"}}}
	compare(v, old)
	if v.Comparison.NotRedetected != 0 || v.Comparison.Removed != 1 || v.Comparison.Added != 1 || v.Comparison.Incomparable != 2 {
		t.Fatalf("invented recovery %+v", v.Comparison)
	}
	v.Items = []Item{{Key: "old", Result: "pass", Compatibility: "g1"}}
	compare(v, old)
	if v.Comparison.NotRedetected != 1 {
		t.Fatal("valid new pass was not compared")
	}
}
func TestCursorBindingAndExportPrivacy(t *testing.T) {
	s := NewService(nil, nil, nil, nil, []byte("synthetic cursor secret"))
	q := Query{PlanID: newID(), Limit: 50}
	cursor := s.encodeCursor("runs", q, newID(), time.Now())
	q.Cursor = cursor
	if _, e := s.decodeCursor("runs", q); e != nil {
		t.Fatal(e)
	}
	q.PlanID = newID()
	if _, e := s.decodeCursor("runs", q); e == nil {
		t.Fatal("cross-scope cursor accepted")
	}
	q.PlanID = ""
	q.Cursor = cursor + "x"
	if _, e := s.decodeCursor("runs", q); e == nil {
		t.Fatal("tampered cursor accepted")
	}
	v := Run{ID: newID(), State: "completed", Definition: fixtureDefinition(), LeaseToken: "DO_NOT_EXPORT", RequestKey: "DO_NOT_EXPORT", Items: []Item{{Name: " \t=HYPERLINK(\"bad\")", Reason: "source_unavailable"}}}
	b, _, e := exportRun(&v, "csv")
	if e != nil || !strings.Contains(string(b), "' \t=HYPERLINK") {
		t.Fatalf("CSV formula not protected: %v", e)
	}
	b, _, e = exportRun(&v, "json")
	if e != nil || strings.Contains(string(b), "DO_NOT_EXPORT") {
		t.Fatal("internal fields leaked")
	}
	var exported map[string]any
	if json.Unmarshal(b, &exported) != nil {
		t.Fatal("invalid JSON")
	}
	v.State = "queued"
	if _, _, e = exportRun(&v, "csv"); e == nil {
		t.Fatal("unfinished report exported")
	}
}
