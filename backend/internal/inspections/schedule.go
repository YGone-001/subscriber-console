package inspections

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
	"unicode/utf8"

	"subscriber/internal/operationsview"
)

func normalizeDefinition(d Definition) (Definition, error) {
	d.Name = strings.TrimSpace(d.Name)
	d.Description = strings.TrimSpace(d.Description)
	if !utf8.ValidString(d.Name+d.Description) || len([]rune(d.Name)) < 1 || len([]rune(d.Name)) > 128 || len([]rune(d.Description)) > 1024 || strings.IndexFunc(d.Name, unicode.IsControl) >= 0 {
		return d, fail(400, "INSPECTION_INVALID_DEFINITION", "A bounded name and description are required")
	}
	if len(d.Checks) < 1 || len(d.Checks) > len(CheckKinds) {
		return d, fail(400, "INSPECTION_INVALID_CHECKS", "Select supported checks")
	}
	seen := map[string]bool{}
	for _, k := range d.Checks {
		found := false
		for _, v := range CheckKinds {
			found = found || k == v
		}
		if !found || seen[k] {
			return d, fail(400, "INSPECTION_INVALID_CHECKS", "Unsupported or repeated check")
		}
		seen[k] = true
	}
	sort.Strings(d.Checks)
	if d.ConfigMaxAgeSeconds < 300 || d.ConfigMaxAgeSeconds > 604800 {
		return d, fail(400, "INSPECTION_INVALID_AGE", "Configuration evidence age must be 300 to 604800 seconds")
	}
	f := d.Scope.Filter
	v := url.Values{}
	for k, x := range map[string]string{"networkKey": f.NetworkKey, "siteResourceId": f.SiteResourceID, "hostResourceId": f.HostResourceID, "operatorName": f.OperatorName, "plmn": f.PLMN, "domain": f.Domain} {
		if x != "" {
			v.Set(k, x)
		}
	}
	parsed, e := operationsview.ParseGroupFilter(v)
	if e != nil || f.IncludeRetired {
		return d, fail(400, "INSPECTION_INVALID_SCOPE", "Invalid current-resource scope")
	}
	d.Scope.Filter = parsed
	switch d.Scope.Mode {
	case "all":
		if len(d.Scope.ResourceIDs) > 0 || parsed.HasGroups() || parsed.Domain != "" {
			return d, fail(400, "INSPECTION_INVALID_SCOPE", "An all-resource scope cannot carry selectors")
		}
	case "groups":
		if len(d.Scope.ResourceIDs) > 0 || (!parsed.HasGroups() && parsed.Domain == "") {
			return d, fail(400, "INSPECTION_INVALID_SCOPE", "Select a group or domain")
		}
	case "resources":
		if parsed.HasGroups() || parsed.Domain != "" || len(d.Scope.ResourceIDs) < 1 || len(d.Scope.ResourceIDs) > MaxResources {
			return d, fail(400, "INSPECTION_INVALID_SCOPE", "Select at most 200 explicit resources")
		}
		ids := map[string]bool{}
		for _, id := range d.Scope.ResourceIDs {
			if !validID(id) || ids[id] {
				return d, fail(400, "INSPECTION_INVALID_SCOPE", "Resource UUIDs must be valid and unique")
			}
			ids[id] = true
		}
		sort.Strings(d.Scope.ResourceIDs)
	default:
		return d, fail(400, "INSPECTION_INVALID_SCOPE", "Choose an explicit scope mode")
	}
	if d.Scope.ResourceIDs == nil {
		d.Scope.ResourceIDs = []string{}
	}
	if e = validateSchedule(d.Schedule); e != nil {
		return d, e
	}
	return d, nil
}
func validateSchedule(s Schedule) error {
	if _, e := time.LoadLocation(s.Timezone); e != nil || s.Timezone == "" {
		return fail(400, "INSPECTION_INVALID_TIMEZONE", "Select a valid IANA timezone")
	}
	switch s.Kind {
	case "interval":
		if s.IntervalSeconds != 900 && s.IntervalSeconds != 3600 && s.IntervalSeconds != 14400 {
			return fail(400, "INSPECTION_INVALID_SCHEDULE", "Select a supported interval")
		}
	case "daily", "weekly":
		if len(s.Time) != 5 {
			return fail(400, "INSPECTION_INVALID_SCHEDULE", "Use HH:mm")
		}
		if _, e := time.Parse("15:04", s.Time); e != nil {
			return fail(400, "INSPECTION_INVALID_SCHEDULE", "Use HH:mm")
		}
		if s.Kind == "weekly" && (s.Weekday < 0 || s.Weekday > 6) {
			return fail(400, "INSPECTION_INVALID_SCHEDULE", "Invalid weekday")
		}
	default:
		return fail(400, "INSPECTION_INVALID_SCHEDULE", "Select interval, daily or weekly")
	}
	return nil
}

// Calendar traversal uses local dates. Repeated DST minutes use the first
// occurrence; missing minutes are skipped rather than shifted to another time.
func nextScheduled(s Schedule, after time.Time) (time.Time, error) {
	if e := validateSchedule(s); e != nil {
		return time.Time{}, e
	}
	if s.Kind == "interval" {
		return after.UTC().Add(time.Duration(s.IntervalSeconds) * time.Second), nil
	}
	loc, _ := time.LoadLocation(s.Timezone)
	clock, _ := time.Parse("15:04", s.Time)
	day := after.In(loc)
	y, m, d := day.Date()
	for offset := 0; offset < 15; offset++ {
		noon := time.Date(y, m, d+offset, 12, 0, 0, 0, loc)
		if s.Kind == "weekly" && int(noon.Weekday()) != s.Weekday {
			continue
		}
		yy, mm, dd := noon.Date()
		candidate := time.Date(yy, mm, dd, clock.Hour(), clock.Minute(), 0, 0, loc)
		cy, cm, cd := candidate.In(loc).Date()
		if cy != yy || cm != mm || cd != dd || candidate.In(loc).Format("15:04") != s.Time {
			continue
		}
		// Some zones roll back by thirty minutes or two hours, not one hour.
		for delta := time.Minute; delta <= 3*time.Hour; delta += time.Minute {
			earlier := candidate.Add(-delta)
			if earlier.In(loc).Format("2006-01-02 15:04") == candidate.In(loc).Format("2006-01-02 15:04") {
				candidate = earlier
				break
			}
		}
		if candidate.After(after) {
			return candidate.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("no scheduled occurrence in the supported calendar horizon")
}
func nextOccurrences(s Schedule, after time.Time, n int) ([]time.Time, error) {
	out := []time.Time{}
	for range n {
		t, e := nextScheduled(s, after)
		if e != nil {
			return nil, e
		}
		out = append(out, t)
		after = t
	}
	return out, nil
}

// calendarGap identifies today's nonexistent wall-clock occurrence. Its record
// is stamped at the first real local minute after the gap; no check is run.
func calendarGap(s Schedule, now time.Time) (time.Time, string, bool) {
	if s.Kind != "daily" && s.Kind != "weekly" {
		return time.Time{}, "", false
	}
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return time.Time{}, "", false
	}
	local := now.In(loc)
	if s.Kind == "weekly" && int(local.Weekday()) != s.Weekday {
		return time.Time{}, "", false
	}
	clock, err := time.Parse("15:04", s.Time)
	if err != nil {
		return time.Time{}, "", false
	}
	y, m, d := local.Date()
	candidate := time.Date(y, m, d, clock.Hour(), clock.Minute(), 0, 0, loc)
	if candidate.In(loc).Format("2006-01-02 15:04") == local.Format("2006-01-02")+" "+s.Time {
		return time.Time{}, "", false
	}
	start := time.Date(y, m, d, 0, 0, 0, 0, loc)
	for n := 0; n < 26*60; n++ {
		at := start.Add(time.Duration(n) * time.Minute)
		wall := at.In(loc)
		yy, mm, dd := wall.Date()
		if yy == y && mm == m && dd == d && wall.Format("15:04") > s.Time {
			return at.UTC(), wall.Format("2006-01-02") + " " + s.Time, !at.After(now)
		}
	}
	return time.Time{}, "", false
}

// advanceSchedule bounds downtime processing. An interval count is arithmetic;
// calendar records cap the count and retain the complete skipped time range.
func advanceSchedule(s Schedule, first, now time.Time) (time.Time, int) {
	if s.Kind == "interval" {
		step := time.Duration(s.IntervalSeconds) * time.Second
		n := int(now.Sub(first)/step) + 1
		if n < 1 {
			n = 1
		}
		return first.Add(time.Duration(n) * step), n
	}
	n := 0
	at := first
	for !at.After(now) && n < 366 {
		n++
		next, e := nextScheduled(s, at)
		if e != nil {
			return time.Time{}, n
		}
		at = next
	}
	if !at.After(now) {
		next, _ := nextScheduled(s, now)
		return next, -1
	}
	return at, n
}
func parseQuery(v url.Values, allowed ...string) (Query, error) {
	q := Query{Limit: 50}
	set := map[string]bool{}
	for _, k := range allowed {
		set[k] = true
	}
	for k, values := range v {
		if !set[k] || len(values) != 1 {
			return q, fail(400, "INSPECTION_INVALID_QUERY", "Unsupported or repeated query")
		}
	}
	q.Q = strings.TrimSpace(v.Get("q"))
	q.PlanID = v.Get("planId")
	q.State = v.Get("state")
	q.Conclusion = v.Get("conclusion")
	q.Kind = v.Get("kind")
	q.Result = v.Get("result")
	q.Cursor = v.Get("cursor")
	q.Archived = v.Get("archived") == "1"
	if len(q.Q) > 128 || (q.PlanID != "" && !validID(q.PlanID)) || (v.Has("archived") && v.Get("archived") != "0" && v.Get("archived") != "1") {
		return q, fail(400, "INSPECTION_INVALID_QUERY", "Invalid bounded query")
	}
	if v.Has("limit") {
		n, e := strconv.Atoi(v.Get("limit"))
		if e != nil || n < 1 || n > 200 {
			return q, fail(400, "INSPECTION_INVALID_QUERY", "Limit must be 1 to 200")
		}
		q.Limit = n
	}
	for key, pair := range map[string]struct {
		v       string
		choices string
	}{"state": {q.State, "queued running completed failed interrupted missed skipped"}, "conclusion": {q.Conclusion, "pass findings inconclusive"}, "kind": {q.Kind, strings.Join(CheckKinds, " ")}, "result": {q.Result, "pass finding unknown not_applicable"}} {
		if pair.v != "" && !strings.Contains(" "+pair.choices+" ", " "+pair.v+" ") {
			return q, fail(400, "INSPECTION_INVALID_QUERY", "Invalid "+key)
		}
	}
	f, e := operationsview.ParseGroupFilter(v)
	if e != nil {
		return q, fail(400, "INSPECTION_INVALID_QUERY", "Invalid group filter")
	}
	q.Scope = f
	return q, nil
}
