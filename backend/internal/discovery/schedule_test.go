package discovery

import (
	"testing"
	"time"
)

func TestSourceNextScanAtRequiresScheduledEnabledSource(t *testing.T) {
	base := &DiscoverySource{
		Enabled:             true,
		ScanIntervalSeconds: 300,
		CreatedAt:           "2026-10-31T07:50:00Z",
		LastScanAt:          "2026-10-31T07:55:00Z",
	}

	if got := SourceNextScanAt(base); got != "2026-10-31T08:00:00Z" {
		t.Fatalf("next scan = %q, want lastScanAt + interval", got)
	}

	manual := *base
	manual.ScanIntervalSeconds = 0
	if got := SourceNextScanAt(&manual); got != "" {
		t.Fatalf("manual-only source must not project a next scan, got %q", got)
	}

	disabled := *base
	disabled.Enabled = false
	if got := SourceNextScanAt(&disabled); got != "" {
		t.Fatalf("disabled source must not project a next scan, got %q", got)
	}

	neverScanned := *base
	neverScanned.LastScanAt = ""
	if got := SourceNextScanAt(&neverScanned); got != "2026-10-31T07:55:00Z" {
		t.Fatalf("never-scanned next scan = %q, want createdAt + interval", got)
	}
}

func TestStaleCutoffOnlyAppliesToScheduledSources(t *testing.T) {
	now := time.Date(2026, 10, 31, 8, 0, 0, 0, time.UTC)
	src := &DiscoverySource{Enabled: true, ScanIntervalSeconds: 300}

	cutoff, ok := StaleCutoff(src, now)
	if !ok || cutoff != "2026-10-31T07:45:00Z" {
		t.Fatalf("cutoff = %q ok=%v, want now - 3 intervals", cutoff, ok)
	}

	manual := *src
	manual.ScanIntervalSeconds = 0
	if _, ok := StaleCutoff(&manual, now); ok {
		t.Fatal("manual-only sources must not promise a freshness window")
	}

	disabled := *src
	disabled.Enabled = false
	if _, ok := StaleCutoff(&disabled, now); ok {
		t.Fatal("disabled sources must not age evidence")
	}
}

func TestIsSourceDueUsesLatestAttemptBasis(t *testing.T) {
	now := time.Date(2026, 10, 31, 8, 0, 0, 0, time.UTC)
	src := &DiscoverySource{
		Enabled:             true,
		ScanIntervalSeconds: 300,
		CreatedAt:           "2026-10-31T07:50:00Z",
		LastScanAt:          "2026-10-31T07:55:00Z",
	}

	if !IsSourceDue(src, now, time.Time{}, false) {
		t.Fatal("source must be due at lastScanAt + interval")
	}
	if IsSourceDue(src, now.Add(-time.Minute), time.Time{}, false) {
		t.Fatal("source must not be due before lastScanAt + interval")
	}

	// An in-memory attempt newer than persisted metadata postpones due-ness.
	inFlight := time.Date(2026, 10, 31, 7, 58, 0, 0, time.UTC)
	if IsSourceDue(src, now, inFlight, true) {
		t.Fatal("a more recent attempt must be the cadence basis")
	}

	manual := *src
	manual.ScanIntervalSeconds = 0
	if IsSourceDue(&manual, now, time.Time{}, false) {
		t.Fatal("manual-only source must never be due")
	}

	malformed := *src
	malformed.LastScanAt = "not-a-time"
	if IsSourceDue(&malformed, now, time.Time{}, false) {
		t.Fatal("a malformed cadence basis must fail closed")
	}
}

func TestEffectiveScanIntervalClampsBounds(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{0, 0},
		{-60, 0},
		{1, MinScanIntervalSeconds},
		{MinScanIntervalSeconds, MinScanIntervalSeconds},
		{MaxScanIntervalSeconds, MaxScanIntervalSeconds},
		{MaxScanIntervalSeconds + 1, MaxScanIntervalSeconds},
	}
	for _, tc := range cases {
		if got := EffectiveScanInterval(tc.in); got != tc.want {
			t.Fatalf("EffectiveScanInterval(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
