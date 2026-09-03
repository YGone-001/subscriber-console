package approval

import (
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
		// Basic
		{"empty", "", 10, 100, 10},
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

		// Leading + (Number("+2") === 2)
		{"leading plus", "+5", 10, 100, 5},
		{"leading plus space", " +5 ", 10, 100, 5},

		// Scientific notation (Number("2e2") === 200)
		{"scientific", "2e2", 10, 1000, 200},
		{"scientific uppercase", "2E2", 10, 1000, 200},
		{"scientific decimal", "1.5e2", 10, 1000, 150},

		// Float (Number("5.0") === 5; Number.isSafeInteger(5.7) is false → maxVal)
		{"float exact", "5.0", 10, 100, 5},
		{"float rounded", "5.7", 10, 100, 100},

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
		{"empty after trim", "   ", 10, 100, 10},

		// Hex (Number("0x10") === 16) — Go ParseFloat doesn't handle hex, returns fallback
		{"hex", "0x10", 10, 100, 10},

		// Unsafe integer (Number("99999999999999999999") is not safe)
		{"unsafe large", "99999999999999999999", 10, 100, 100},
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
