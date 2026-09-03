package approval

import (
	"net/url"
	"testing"
	"time"
)

func TestBoundedInt(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		fallback int
		maxVal   int
		want     int
	}{
		// Absent vs empty distinction is handled by boundedIntWithAbsent,
		// boundedInt always treats "" as Number("") = 0 → clamp to 1
		{"empty string → 1", "", 20, 100, 1},
		{"valid", "5", 10, 100, 5},
		{"at min", "1", 10, 100, 1},
		{"at max", "100", 10, 100, 100},

		// Clamping
		{"below min", "0", 10, 100, 1},
		{"negative", "-5", 10, 100, 1},
		{"above max", "200", 10, 100, 100},

		// Whitespace (Number(" 2 ") === 2)
		{"leading space", " 5", 10, 100, 5},
		{"trailing space", "5 ", 10, 100, 5},
		{"both spaces", " 5 ", 10, 100, 5},
		{"tab", "\t5\t", 10, 100, 5},
		{"whitespace only → 1", "   ", 20, 100, 1},

		// Leading + (Number("+2") === 2)
		{"leading plus", "+5", 10, 100, 5},
		{"leading plus space", " +5 ", 10, 100, 5},

		// Scientific notation (Number("2e2") === 200)
		{"scientific", "2e2", 10, 1000, 200},
		{"scientific uppercase", "2E2", 10, 1000, 200},
		{"scientific decimal", "1.5e2", 10, 1000, 150},

		// Float (Number("5.0") === 5 → safe integer; Number("5.7") → not safe → fallback)
		{"float exact", "5.0", 10, 100, 5},
		{"float fractional → fallback", "5.7", 10, 100, 10},

		// Hex (Number("0x10") === 16)
		{"hex", "0x10", 10, 100, 16},
		{"hex uppercase", "0X10", 10, 100, 16},
		{"hex large", "0xFF", 10, 300, 255},
		{"hex invalid → fallback", "0xGG", 10, 100, 10},

		// Octal (Number("0o10") === 8)
		{"octal", "0o10", 10, 100, 8},
		{"octal uppercase", "0O10", 10, 100, 8},
		{"octal large", "0o77", 10, 100, 63},
		{"octal invalid → fallback", "0o99", 10, 100, 10},

		// Binary (Number("0b10") === 2)
		{"binary", "0b10", 10, 100, 2},
		{"binary uppercase", "0B10", 10, 100, 2},
		{"binary large", "0b1111", 10, 100, 15},
		{"binary invalid → fallback", "0b22", 10, 100, 10},

		// NaN and Infinity → fallback
		{"NaN", "NaN", 10, 100, 10},
		{"nan lowercase", "nan", 10, 100, 10},
		{"Infinity", "Infinity", 10, 100, 10},
		{"infinity lowercase", "infinity", 10, 100, 10},
		{"+Infinity", "+Infinity", 10, 100, 10},
		{"-Infinity", "-Infinity", 10, 100, 10},

		// Non-numeric → fallback
		{"abc", "abc", 10, 100, 10},
		{"mixed", "5abc", 10, 100, 10},

		// Unsafe integer (Number("9007199254740992") is not safe) → fallback
		{"unsafe large → fallback", "9007199254740992", 10, 100, 10},
		{"unsafe negative → fallback", "-9007199254740992", 10, 100, 10},

		// Zero (Number("0") === 0, safe integer → clamp to 1)
		{"zero → 1", "0", 20, 100, 1},

		// Negative safe integer (Number("-5") === -5 → clamp to 1)
		{"negative safe → 1", "-5", 20, 100, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := boundedInt(tt.value, tt.fallback, tt.maxVal)
			if got != tt.want {
				t.Errorf("boundedInt(%q, %d, %d) = %d, want %d", tt.value, tt.fallback, tt.maxVal, got, tt.want)
			}
		})
	}
}

func TestBoundedIntWithAbsent(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		absent   bool
		fallback int
		maxVal   int
		want     int
	}{
		{"absent → fallback", "", true, 20, 100, 20},
		{"present empty → 1", "", false, 20, 100, 1},
		{"present value", "5", false, 20, 100, 5},
		{"absent with value (edge case)", "5", true, 20, 100, 20},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := boundedIntWithAbsent(tt.value, tt.absent, tt.fallback, tt.maxVal)
			if got != tt.want {
				t.Errorf("boundedIntWithAbsent(%q, %v, %d, %d) = %d, want %d", tt.value, tt.absent, tt.fallback, tt.maxVal, got, tt.want)
			}
		})
	}
}

func TestParamOrElse(t *testing.T) {
	tests := []struct {
		name      string
		params    map[string][]string
		primary   string
		secondary string
		wantVal   string
		wantOK    bool
	}{
		{
			name:      "both absent",
			params:    map[string][]string{},
			primary:   "pageSize",
			secondary: "limit",
			wantVal:   "",
			wantOK:    false,
		},
		{
			name:      "primary present non-empty",
			params:    map[string][]string{"pageSize": {"50"}},
			primary:   "pageSize",
			secondary: "limit",
			wantVal:   "50",
			wantOK:    true,
		},
		{
			name:      "secondary present, primary absent",
			params:    map[string][]string{"limit": {"30"}},
			primary:   "pageSize",
			secondary: "limit",
			wantVal:   "30",
			wantOK:    true,
		},
		{
			// Node: params.get('pageSize') || params.get('limit')
			// "" is falsy in JS ||, so falls through to limit
			name:      "primary empty falls through to secondary",
			params:    map[string][]string{"pageSize": {""}, "limit": {"50"}},
			primary:   "pageSize",
			secondary: "limit",
			wantVal:   "50",
			wantOK:    true,
		},
		{
			// Both empty: "" || "" → "" (falsy) → ("", false)
			name:      "both empty",
			params:    map[string][]string{"pageSize": {""}, "limit": {""}},
			primary:   "pageSize",
			secondary: "limit",
			wantVal:   "",
			wantOK:    false,
		},
		{
			// Primary empty, secondary absent → ("", false)
			name:      "primary empty, secondary absent",
			params:    map[string][]string{"pageSize": {""}},
			primary:   "pageSize",
			secondary: "limit",
			wantVal:   "",
			wantOK:    false,
		},
		{
			// Primary absent, secondary empty → ("", false)
			name:      "primary absent, secondary empty",
			params:    map[string][]string{"limit": {""}},
			primary:   "pageSize",
			secondary: "limit",
			wantVal:   "",
			wantOK:    false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotVal, gotOK := paramOrElse(tt.params, tt.primary, tt.secondary)
			if gotVal != tt.wantVal || gotOK != tt.wantOK {
				t.Errorf("paramOrElse(%v, %q, %q) = (%q, %v), want (%q, %v)",
					tt.params, tt.primary, tt.secondary, gotVal, gotOK, tt.wantVal, tt.wantOK)
			}
		})
	}
}

// TestPageSizeLimitQueryCompat verifies the full query parameter resolution
// for pageSize || limit and page, matching Node behavior exactly.
func TestPageSizeLimitQueryCompat(t *testing.T) {
	tests := []struct {
		name      string
		query     string
		wantPage  int
		wantPSize int
	}{
		// Mandatory spec tests
		{"?pageSize=25", "pageSize=25", 1, 25},
		{"?pageSize=&limit=50", "pageSize=&limit=50", 1, 50},
		{"?pageSize=&limit=", "pageSize=&limit=", 1, 20},
		{"?limit=30", "limit=30", 1, 30},
		// pageSize=1.5 selected by || (non-empty), then boundedInt rejects → fallback 20
		{"?pageSize=1.5&limit=50", "pageSize=1.5&limit=50", 1, 20},
		// page empty → Number("") = 0 → clamp 1
		{"?page=", "page=", 1, 20},

		// Additional cases
		{"no params", "", 1, 20},
		{"?pageSize=20&limit=50", "pageSize=20&limit=50", 1, 20},
		{"?page=3&pageSize=10", "page=3&pageSize=10", 3, 10},
		{"?page=0", "page=0", 1, 20},
		{"?page=-1", "page=-1", 1, 20},
		{"?pageSize=0x10", "pageSize=0x10", 1, 16},
		{"?pageSize=2e1", "pageSize=2e1", 1, 20},
		{"?pageSize=abc&limit=50", "pageSize=abc&limit=50", 1, 20},
		{"?pageSize=101", "pageSize=101", 1, 100},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params, _ := url.ParseQuery(tt.query)

			pageSizeVal, pageSizePresent := paramOrElse(params, "pageSize", "limit")
			gotPage := boundedIntWithAbsent(params.Get("page"), !params.Has("page"), 1, 100000)
			gotPSize := boundedIntWithAbsent(pageSizeVal, !pageSizePresent, 20, 100)

			if gotPage != tt.wantPage {
				t.Errorf("page = %d, want %d (query: %s)", gotPage, tt.wantPage, tt.query)
			}
			if gotPSize != tt.wantPSize {
				t.Errorf("pageSize = %d, want %d (query: %s)", gotPSize, tt.wantPSize, tt.query)
			}
		})
	}
}

func TestExtractNullish(t *testing.T) {
	tests := []struct {
		name      string
		body      map[string]interface{}
		primary   string
		secondary string
		want      interface{}
	}{
		// comment ?? note
		{
			name:      "comment present",
			body:      map[string]interface{}{"comment": "hello"},
			primary:   "comment",
			secondary: "note",
			want:      "hello",
		},
		{
			name:      "comment null → note",
			body:      map[string]interface{}{"comment": nil, "note": "fallback"},
			primary:   "comment",
			secondary: "note",
			want:      "fallback",
		},
		{
			name:      "comment missing → note",
			body:      map[string]interface{}{"note": "fallback"},
			primary:   "comment",
			secondary: "note",
			want:      "fallback",
		},
		{
			name:      "comment empty string → empty (NOT nullish)",
			body:      map[string]interface{}{"comment": "", "note": "fallback"},
			primary:   "comment",
			secondary: "note",
			want:      "",
		},
		{
			name:      "comment 0 → 0 (NOT nullish)",
			body:      map[string]interface{}{"comment": 0, "note": "fallback"},
			primary:   "comment",
			secondary: "note",
			want:      0,
		},
		{
			name:      "comment false → false (NOT nullish)",
			body:      map[string]interface{}{"comment": false, "note": "fallback"},
			primary:   "comment",
			secondary: "note",
			want:      false,
		},
		{
			name:      "both missing → nil",
			body:      map[string]interface{}{},
			primary:   "comment",
			secondary: "note",
			want:      nil,
		},
		{
			name:      "nil body → nil",
			body:      nil,
			primary:   "comment",
			secondary: "note",
			want:      nil,
		},
		// reason ?? note
		{
			name:      "reason present",
			body:      map[string]interface{}{"reason": "bad"},
			primary:   "reason",
			secondary: "note",
			want:      "bad",
		},
		{
			name:      "reason null → note",
			body:      map[string]interface{}{"reason": nil, "note": "fallback"},
			primary:   "reason",
			secondary: "note",
			want:      "fallback",
		},
		{
			name:      "reason missing → note",
			body:      map[string]interface{}{"note": "fallback"},
			primary:   "reason",
			secondary: "note",
			want:      "fallback",
		},
		{
			name:      "reason empty string → empty (NOT nullish)",
			body:      map[string]interface{}{"reason": "", "note": "fallback"},
			primary:   "reason",
			secondary: "note",
			want:      "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractNullish(tt.body, tt.primary, tt.secondary)
			if got != tt.want {
				t.Errorf("extractNullish(%v, %q, %q) = %v, want %v", tt.body, tt.primary, tt.secondary, got, tt.want)
			}
		})
	}
}

func TestToOptionalString(t *testing.T) {
	tests := []struct {
		name string
		val  interface{}
		want string
	}{
		{"nil", nil, ""},
		{"string", "hello", "hello"},
		{"empty string", "", ""},
		{"int", 42, ""},
		{"bool", true, ""},
		{"float", 3.14, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := toOptionalString(tt.val)
			if got != tt.want {
				t.Errorf("toOptionalString(%v) = %q, want %q", tt.val, got, tt.want)
			}
		})
	}
}

func TestDateParam(t *testing.T) {
	tests := []struct {
		name      string
		value     string
		endOfDay  bool
		wantNil   bool
		wantOK    bool
		checkTime func(t *testing.T, tm time.Time)
	}{
		// Empty → nil, ok
		{"empty", "", false, true, true, nil},

		// YYYY-MM-DD
		{"date start", "2024-01-15", false, false, true, func(t *testing.T, tm time.Time) {
			if tm.Hour() != 0 || tm.Minute() != 0 || tm.Second() != 0 {
				t.Errorf("expected 00:00:00, got %v", tm)
			}
		}},
		{"date end", "2024-01-15", true, false, true, func(t *testing.T, tm time.Time) {
			if tm.Hour() != 23 || tm.Minute() != 59 || tm.Second() != 59 {
				t.Errorf("expected 23:59:59, got %v", tm)
			}
		}},

		// .000Z format (canonical storage format)
		{"millis UTC", "2024-01-15T10:30:00.000Z", false, false, true, func(t *testing.T, tm time.Time) {
			if tm.Hour() != 10 || tm.Minute() != 30 {
				t.Errorf("expected 10:30, got %v", tm)
			}
		}},

		// RFC3339
		{"rfc3339", "2024-01-15T10:30:00Z", false, false, true, func(t *testing.T, tm time.Time) {
			if tm.Hour() != 10 || tm.Minute() != 30 {
				t.Errorf("expected 10:30, got %v", tm)
			}
		}},
		{"rfc3339 offset", "2024-01-15T10:30:00+05:00", false, false, true, func(t *testing.T, tm time.Time) {
			// UTC equivalent: 05:30
			if tm.UTC().Hour() != 5 || tm.UTC().Minute() != 30 {
				t.Errorf("expected UTC 05:30, got %v", tm.UTC())
			}
		}},

		// No timezone (millis without Z)
		{"millis no tz", "2024-01-15T10:30:00.000", false, false, true, func(t *testing.T, tm time.Time) {
			if tm.Hour() != 10 || tm.Minute() != 30 {
				t.Errorf("expected 10:30, got %v", tm)
			}
		}},

		// Plain datetime
		{"plain datetime", "2024-01-15T10:30:00", false, false, true, func(t *testing.T, tm time.Time) {
			if tm.Hour() != 10 || tm.Minute() != 30 {
				t.Errorf("expected 10:30, got %v", tm)
			}
		}},

		// Invalid → nil, false
		{"invalid", "not-a-date", false, true, false, nil},
		{"garbage", "xyz123", false, true, false, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tm, ok := dateParam(tt.value, tt.endOfDay)
			if ok != tt.wantOK {
				t.Errorf("dateParam(%q, %v) ok = %v, want %v", tt.value, tt.endOfDay, ok, tt.wantOK)
			}
			if tt.wantNil {
				if tm != nil {
					t.Errorf("expected nil time, got %v", tm)
				}
				return
			}
			if tm == nil {
				t.Fatal("expected non-nil time, got nil")
			}
			if tt.checkTime != nil {
				tt.checkTime(t, *tm)
			}
		})
	}
}

// TestFormatISO8601Millis verifies that Mongo comparison boundaries use
// millisecond format (YYYY-MM-DDTHH:mm:ss.SSSZ), not RFC3339 without millis.
// This is critical for lexicographic string comparison against stored ISO dates.
func TestFormatISO8601Millis(t *testing.T) {
	tests := []struct {
		name string
		hour int
		min  int
		sec  int
		nsec int
		want string
	}{
		{"midnight", 0, 0, 0, 0, "2024-01-15T00:00:00.000Z"},
		{"with millis", 10, 30, 45, 123000000, "2024-01-15T10:30:45.123Z"},
		{"end of day", 23, 59, 59, 999000000, "2024-01-15T23:59:59.999Z"},
		{"zero millis", 12, 0, 0, 0, "2024-01-15T12:00:00.000Z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tm := time.Date(2024, 1, 15, tt.hour, tt.min, tt.sec, tt.nsec, time.UTC)
			got := formatISO8601Millis(tm)
			if got != tt.want {
				t.Errorf("formatISO8601Millis() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestFormatISO8601Millis_FromDateParam verifies that dateParam output,
// when formatted via formatISO8601Millis, produces millisecond boundaries
// matching the actual BSON query values used in the repository.
func TestFormatISO8601Millis_FromDateParam(t *testing.T) {
	// from=2024-01-15 → 2024-01-15T00:00:00.000Z
	fromTime, ok := dateParam("2024-01-15", false)
	if !ok || fromTime == nil {
		t.Fatal("dateParam failed for from")
	}
	fromISO := formatISO8601Millis(*fromTime)
	if fromISO != "2024-01-15T00:00:00.000Z" {
		t.Errorf("from boundary = %q, want %q", fromISO, "2024-01-15T00:00:00.000Z")
	}

	// to=2024-01-15 → 2024-01-15T23:59:59.999Z
	toTime, ok := dateParam("2024-01-15", true)
	if !ok || toTime == nil {
		t.Fatal("dateParam failed for to")
	}
	toISO := formatISO8601Millis(*toTime)
	if toISO != "2024-01-15T23:59:59.999Z" {
		t.Errorf("to boundary = %q, want %q", toISO, "2024-01-15T23:59:59.999Z")
	}

	// today boundary: must contain .000Z
	today := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	todayISO := formatISO8601Millis(today)
	if todayISO != "2024-01-15T00:00:00.000Z" {
		t.Errorf("todayISO = %q, want %q", todayISO, "2024-01-15T00:00:00.000Z")
	}

	// Verify NOT RFC3339 without millis
	if todayISO == "2024-01-15T00:00:00Z" {
		t.Error("todayISO should NOT be RFC3339 without milliseconds")
	}
}
