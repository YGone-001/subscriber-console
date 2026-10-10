package nfhealth

import "time"

// Clock is an injectable time source so scheduling and freshness can be tested
// without long real-time sleeps.
type Clock interface {
	Now() time.Time
}

// SystemClock is the production clock.
type SystemClock struct{}

// Now returns the current UTC instant.
func (SystemClock) Now() time.Time { return time.Now().UTC() }

// FixedClock is a deterministic test clock.
type FixedClock struct {
	T time.Time
}

// Now returns the configured instant.
func (c *FixedClock) Now() time.Time { return c.T.UTC() }

// Advance moves the test clock forward.
func (c *FixedClock) Advance(d time.Duration) { c.T = c.T.Add(d) }

// FreshnessPolicySeconds returns the configured staleness window for a target.
//
// Scheduled targets: interval + configured grace.
// Manual targets: an explicit age-based window so manual monitoring is never
// presented as continuously current.
func FreshnessPolicySeconds(target *HealthTarget) int {
	if target == nil {
		return ManualFreshnessWindowSeconds
	}
	if target.CollectionMode == CollectionScheduled {
		interval := target.IntervalSeconds
		if interval < MinIntervalSeconds {
			interval = MinIntervalSeconds
		}
		if interval > MaxIntervalSeconds {
			interval = MaxIntervalSeconds
		}
		return interval + StalenessGraceSeconds
	}
	return ManualFreshnessWindowSeconds
}

// EvaluateFreshness projects measurement freshness from authoritative fields.
//
// lastAttemptAt  = time of the last completed collection attempt
// lastSuccessAt  = time of the last fully successful collection
// lastMeasuredAt = time of the last accepted valid measurement
// sample.collectedAt = the actual observation timestamp
//
// A failed collection never advances lastMeasuredAt, so a historical sample
// ages out instead of being presented as current evidence forever. Future-dated
// measurements are treated as invalid and therefore unknown.
func EvaluateFreshness(target *HealthTarget, now time.Time) FreshnessProjection {
	evaluatedAt := now.UTC().Format(time.RFC3339Nano)
	if target == nil {
		return FreshnessProjection{
			State:       FreshnessUnknown,
			Basis:       "none",
			EvaluatedAt: evaluatedAt,
			Reason:      "target_missing",
		}
	}
	if !target.Enabled {
		return FreshnessProjection{
			State:         FreshnessNotMonitored,
			PolicySeconds: FreshnessPolicySeconds(target),
			Basis:         "none",
			EvaluatedAt:   evaluatedAt,
			Reason:        "target_disabled",
		}
	}

	raw := target.LastMeasuredAt
	if raw == "" {
		return FreshnessProjection{
			State:         FreshnessUnknown,
			PolicySeconds: FreshnessPolicySeconds(target),
			Basis:         "none",
			EvaluatedAt:   evaluatedAt,
			Reason:        "no_accepted_measurement",
		}
	}
	measured, err := ParseBSONTime(raw)
	if err != nil || measured.IsZero() {
		return FreshnessProjection{
			State:         FreshnessUnknown,
			PolicySeconds: FreshnessPolicySeconds(target),
			Basis:         "last_measured_at",
			EvaluatedAt:   evaluatedAt,
			Reason:        "measurement_timestamp_invalid",
		}
	}
	if measured.After(now) {
		return FreshnessProjection{
			State:         FreshnessUnknown,
			PolicySeconds: FreshnessPolicySeconds(target),
			Basis:         "last_measured_at",
			EvaluatedAt:   evaluatedAt,
			Reason:        "measurement_timestamp_in_future",
		}
	}

	policy := FreshnessPolicySeconds(target)
	age := int64(now.Sub(measured.Time).Seconds())
	proj := FreshnessProjection{
		AgeSeconds:    &age,
		PolicySeconds: policy,
		Basis:         "last_measured_at",
		EvaluatedAt:   evaluatedAt,
	}
	if age > int64(policy) {
		proj.State = FreshnessStale
		proj.Reason = "measurement_age_exceeds_policy"
	} else {
		proj.State = FreshnessFresh
	}
	return proj
}

// ProjectOverallState derives the presented overall state from layer evidence
// and freshness. A stale or unknown measurement never presents as healthy, and
// unmeasured layers never claim health.
func ProjectOverallState(freshness FreshnessProjection, layers *LayerSet) string {
	switch freshness.State {
	case FreshnessNotMonitored:
		return StateNotConfigured
	case FreshnessUnknown:
		return StateUnknown
	case FreshnessStale:
		return StateStale
	}
	if layers == nil {
		return StateUnknown
	}
	return OverallState(*layers)
}
