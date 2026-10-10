package nfhealth

import (
	"testing"
	"time"
)

func freshnessTarget(mode string, interval int, lastMeasured string) *HealthTarget {
	return &HealthTarget{
		TargetID:        newUUID(),
		Name:            "freshness",
		CollectionMode:  mode,
		IntervalSeconds: interval,
		Enabled:         true,
		LastMeasuredAt:  lastMeasured,
	}
}

func TestFreshnessRecentValidSampleIsFresh(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	target := freshnessTarget(CollectionScheduled, 120, now.Add(-30*time.Second).Format(time.RFC3339))
	proj := EvaluateFreshness(target, now)
	if proj.State != FreshnessFresh {
		t.Fatalf("recent valid sample must be fresh, got %s", proj.State)
	}
	if proj.AgeSeconds == nil || *proj.AgeSeconds != 30 {
		t.Fatalf("age must be 30 seconds, got %v", proj.AgeSeconds)
	}
}

func TestFreshnessOldValidSampleIsStale(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	// 120s interval + 90s grace = 210s policy; 400s old is stale.
	target := freshnessTarget(CollectionScheduled, 120, now.Add(-400*time.Second).Format(time.RFC3339))
	proj := EvaluateFreshness(target, now)
	if proj.State != FreshnessStale {
		t.Fatalf("old valid sample must be stale, got %s", proj.State)
	}
}

func TestFreshnessNoSampleIsUnknown(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	target := freshnessTarget(CollectionScheduled, 120, "")
	proj := EvaluateFreshness(target, now)
	if proj.State != FreshnessUnknown {
		t.Fatalf("no sample must be unknown, got %s", proj.State)
	}
}

func TestFreshnessDisabledTargetIsNotMonitored(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	target := freshnessTarget(CollectionScheduled, 120, now.Add(-10*time.Second).Format(time.RFC3339))
	target.Enabled = false
	proj := EvaluateFreshness(target, now)
	if proj.State != FreshnessNotMonitored {
		t.Fatalf("disabled target must be not_monitored, got %s", proj.State)
	}
}

func TestFreshnessFutureDatedSampleIsInvalid(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	target := freshnessTarget(CollectionScheduled, 120, now.Add(2*time.Hour).Format(time.RFC3339))
	proj := EvaluateFreshness(target, now)
	if proj.State != FreshnessUnknown {
		t.Fatalf("future-dated sample must be invalid/unknown, got %s", proj.State)
	}
	if proj.Reason != "measurement_timestamp_in_future" {
		t.Fatalf("expected future-timestamp reason, got %s", proj.Reason)
	}
}

func TestFreshnessManualTargetUsesAgeBasedWindow(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	// Manual monitoring is never presented as continuously current: a sample
	// older than the manual window is stale even if "recent" by some intervals.
	target := freshnessTarget(CollectionManual, 60, now.Add(-2*ManualFreshnessWindowSeconds*time.Second).Format(time.RFC3339))
	proj := EvaluateFreshness(target, now)
	if proj.State != FreshnessStale {
		t.Fatalf("manual target past its age window must be stale, got %s", proj.State)
	}
	if proj.PolicySeconds != ManualFreshnessWindowSeconds {
		t.Fatalf("manual policy must be the explicit age window, got %d", proj.PolicySeconds)
	}

	freshManual := freshnessTarget(CollectionManual, 60, now.Add(-time.Minute).Format(time.RFC3339))
	freshProj := EvaluateFreshness(freshManual, now)
	if freshProj.State != FreshnessFresh {
		t.Fatalf("manual sample inside the age window must be fresh, got %s", freshProj.State)
	}
}

func TestFreshnessLongIntervalUsesConfiguredPolicy(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	// 3600s interval + 90s grace = 3690s; 3600s old is still fresh.
	target := freshnessTarget(CollectionScheduled, 3600, now.Add(-3600*time.Second).Format(time.RFC3339))
	proj := EvaluateFreshness(target, now)
	if proj.State != FreshnessFresh {
		t.Fatalf("long-interval target within its policy must be fresh, got %s", proj.State)
	}
	if proj.PolicySeconds != 3600+StalenessGraceSeconds {
		t.Fatalf("policy must be interval + grace, got %d", proj.PolicySeconds)
	}
}

func TestProjectOverallStateNeverPresentsStaleAsHealthy(t *testing.T) {
	layers := LayerSet{
		Process:   LayerEvidence{State: StateHealthy, EvidenceKind: EvidenceSystemd, Measured: true},
		Interface: LayerEvidence{State: StateHealthy, EvidenceKind: EvidenceHTTP, Measured: true},
		Service:   LayerEvidence{State: StateHealthy, EvidenceKind: EvidenceMetric, Measured: true},
	}
	stale := FreshnessProjection{State: FreshnessStale}
	if got := ProjectOverallState(stale, &layers); got != StateStale {
		t.Fatalf("stale measurement must project stale even when layers are healthy, got %s", got)
	}
	unknown := FreshnessProjection{State: FreshnessUnknown}
	if got := ProjectOverallState(unknown, &layers); got != StateUnknown {
		t.Fatalf("unknown measurement must project unknown, got %s", got)
	}
	fresh := FreshnessProjection{State: FreshnessFresh}
	if got := ProjectOverallState(fresh, &layers); got != StateHealthy {
		t.Fatalf("fresh healthy layers must project healthy, got %s", got)
	}
}

func TestProjectOverallStatePartialRunIsCorrectlyQualified(t *testing.T) {
	// Partial run with valid L1 only: the measured layer is qualified through
	// coverage, and unmeasured layers never claim health.
	layers := LayerSet{
		Process:   LayerEvidence{State: StateHealthy, EvidenceKind: EvidenceSystemd, Measured: true},
		Interface: LayerEvidence{State: StateNotConfigured, EvidenceKind: EvidenceNone, Measured: false},
		Service:   LayerEvidence{State: StateNotConfigured, EvidenceKind: EvidenceNone, Measured: false},
	}
	cov := CoverageFromLayers(layers)
	if !cov.L1Measured || cov.L2Measured || cov.L3Measured {
		t.Fatalf("L1-only coverage must be qualified, got %+v", cov)
	}
	fresh := FreshnessProjection{State: FreshnessFresh}
	got := ProjectOverallState(fresh, &layers)
	// The frozen OverallState contract projects the single measured layer.
	if got != OverallState(layers) {
		t.Fatalf("fresh projection must agree with layer aggregation, got %s", got)
	}
	// An unmeasured layer never becomes healthy on its own.
	empty := LayerSet{
		Process:   LayerEvidence{State: StateNotConfigured, Measured: false},
		Interface: LayerEvidence{State: StateNotConfigured, Measured: false},
		Service:   LayerEvidence{State: StateNotConfigured, Measured: false},
	}
	if got := ProjectOverallState(FreshnessProjection{State: FreshnessFresh}, &empty); got == StateHealthy {
		t.Fatal("unmeasured layers must never claim healthy")
	}
}
