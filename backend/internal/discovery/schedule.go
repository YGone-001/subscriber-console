package discovery

import "time"

// EffectiveScanInterval normalizes a stored scan interval. 0 keeps its
// manual-only meaning; any positive value is clamped into the supported
// scheduling bounds so an out-of-range document can never schedule an
// unbounded scan cadence.
func EffectiveScanInterval(seconds int) int {
	if seconds <= 0 {
		return 0
	}
	if seconds < MinScanIntervalSeconds {
		return MinScanIntervalSeconds
	}
	if seconds > MaxScanIntervalSeconds {
		return MaxScanIntervalSeconds
	}
	return seconds
}

// SourceNextScanAt projects the next scheduled scan instant from persisted
// observation metadata. It returns "" when the source is disabled or manual-only
// (no scheduled cadence exists). The projection is response-only and never
// stored; the scheduler derives due-ness from the same last-attempt basis.
func SourceNextScanAt(src *DiscoverySource) string {
	if src == nil || !src.Enabled {
		return ""
	}
	interval := EffectiveScanInterval(src.ScanIntervalSeconds)
	if interval == 0 {
		return ""
	}
	basis := src.LastScanAt
	if basis == "" {
		basis = src.CreatedAt
	}
	if basis == "" {
		return ""
	}
	last, err := time.Parse(time.RFC3339, basis)
	if err != nil {
		return ""
	}
	return last.Add(time.Duration(interval) * time.Second).UTC().Format(time.RFC3339)
}

// IsSourceDue reports whether a scheduled source should be scanned at now.
//
// Persisted lastScanAt is the cadence basis; a never-scanned source uses its
// creation time. lastAttempt is the scanner's in-memory attempt time and only
// strengthens the basis, which keeps a just-attempted source from being picked
// up twice when the persisted metadata write is slow or failed. A disabled or
// manual-only source is never due, and an unparsable basis fails closed.
func IsSourceDue(src *DiscoverySource, now time.Time, lastAttempt time.Time, hasAttempt bool) bool {
	if src == nil || !src.Enabled {
		return false
	}
	interval := EffectiveScanInterval(src.ScanIntervalSeconds)
	if interval == 0 {
		return false
	}

	var basis time.Time
	if src.LastScanAt != "" {
		parsed, err := time.Parse(time.RFC3339, src.LastScanAt)
		if err != nil {
			return false
		}
		basis = parsed
	} else if src.CreatedAt != "" {
		parsed, err := time.Parse(time.RFC3339, src.CreatedAt)
		if err != nil {
			return false
		}
		basis = parsed
	}
	if hasAttempt && lastAttempt.After(basis) {
		basis = lastAttempt
	}
	if basis.IsZero() {
		return true
	}
	return !now.Before(basis.Add(time.Duration(interval) * time.Second))
}
