package nfhealth

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeSchedulerRepo struct {
	mu       sync.Mutex
	targets  []HealthTarget
	recorded []string
}

func (f *fakeSchedulerRepo) ListScheduledTargets(_ context.Context, _ int) ([]HealthTarget, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]HealthTarget, len(f.targets))
	copy(out, f.targets)
	return out, nil
}

func (f *fakeSchedulerRepo) RecordCollection(_ context.Context, target *HealthTarget, _ *CollectionResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recorded = append(f.recorded, target.TargetID)
	return nil
}

func (f *fakeSchedulerRepo) setTargets(items []HealthTarget) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.targets = items
}

func (f *fakeSchedulerRepo) recordedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.recorded))
	copy(out, f.recorded)
	return out
}

func scheduledTarget(id string, interval int, lastAttempt string) HealthTarget {
	return HealthTarget{
		TargetID:        id,
		CandidateID:     newUUID(),
		Name:            id,
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: interval,
		Enabled:         true,
		LastAttemptAt:   lastAttempt,
		CreatedAt:       "2026-10-10T00:00:00Z",
		UpdatedAt:       "2026-10-10T00:00:00Z",
	}
}

func TestIsDueHonorsPerTargetInterval(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)

	fast := scheduledTarget("t60", 60, now.Add(-61*time.Second).Format(time.RFC3339))
	if !IsDue(&fast, now) {
		t.Fatal("60s target past its interval must be due")
	}

	notYet := scheduledTarget("t120", 120, now.Add(-30*time.Second).Format(time.RFC3339))
	if IsDue(&notYet, now) {
		t.Fatal("120s target must not be collected early")
	}

	slow := scheduledTarget("t3600", 3600, now.Add(-300*time.Second).Format(time.RFC3339))
	if IsDue(&slow, now) {
		t.Fatal("3600s target must not be collected on the 120s cadence")
	}
}

func TestIsDueRejectsDisabledAndManual(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)

	disabled := scheduledTarget("t-disabled", 60, now.Add(-2*time.Hour).Format(time.RFC3339))
	disabled.Enabled = false
	if IsDue(&disabled, now) {
		t.Fatal("disabled targets must never be scheduled")
	}

	manual := scheduledTarget("t-manual", 60, now.Add(-2*time.Hour).Format(time.RFC3339))
	manual.CollectionMode = CollectionManual
	if IsDue(&manual, now) {
		t.Fatal("manual targets must never be auto-scheduled")
	}
}

func TestIsDueUsesLastAttemptNotStartupTime(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	// Collected 10 seconds ago with a 120s cadence: a scheduler restart at
	// "now" must not collect early.
	recent := scheduledTarget("t-restart", 120, now.Add(-10*time.Second).Format(time.RFC3339))
	if IsDue(&recent, now) {
		t.Fatal("scheduler restart must not trigger a premature immediate collection")
	}
}

func TestSelectDueTargetsServesMoreThanBatchWithoutStarvation(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	targets := make([]HealthTarget, 0, 12)
	for i := 0; i < 12; i++ {
		id := newUUID()
		// Stagger last-attempt so ordering is deterministic.
		last := now.Add(-time.Duration(i+1) * 61 * time.Second).Format(time.RFC3339)
		targets = append(targets, scheduledTarget(id, 60, last))
	}

	seen := map[string]int{}
	// Simulate several ticks with a rotating offset so every due target is
	// eventually served even though the batch limit is smaller than the set.
	for round := 0; round < 8; round++ {
		batch := selectDueTargets(targets, now, MaxGlobalConcurrent, round*MaxGlobalConcurrent)
		if len(batch) == 0 {
			t.Fatal("expected a non-empty due batch")
		}
		for _, b := range batch {
			seen[b.TargetID]++
		}
	}
	if len(seen) < 8 {
		t.Fatalf("expected fair coverage across due targets, saw only %d unique targets", len(seen))
	}
}

func TestSchedulerTickRespectsIntervals(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	clock := &FixedClock{T: now}

	due := scheduledTarget(newUUID(), 60, now.Add(-2*time.Minute).Format(time.RFC3339))
	notDue := scheduledTarget(newUUID(), 3600, now.Add(-time.Minute).Format(time.RFC3339))

	repo := &fakeSchedulerRepo{targets: []HealthTarget{due, notDue}}
	c := NewCollectorWithGate(NewHTTPProber(time.Second), nil, NewDestinationAllowlist(""), NewServiceUnitAllowlist(""), NewCollectionGate(), clock)
	s := NewSchedulerWithClock(repo, c, clock)

	s.Tick(context.Background())

	recorded := repo.recordedIDs()
	if len(recorded) != 1 {
		t.Fatalf("expected exactly one due collection, got %d", len(recorded))
	}
	if recorded[0] != due.TargetID {
		t.Fatalf("expected the due target to be collected, got %s", recorded[0])
	}
}

func TestCollectionGateBoundsManualAndScheduledTogether(t *testing.T) {
	gate := NewCollectionGate()
	if gate.Limit() != MaxGlobalConcurrent {
		t.Fatalf("gate limit %d must equal MaxGlobalConcurrent %d", gate.Limit(), MaxGlobalConcurrent)
	}

	ctx := context.Background()
	for i := 0; i < MaxGlobalConcurrent; i++ {
		if err := gate.Acquire(ctx); err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
	}
	if gate.TryAcquire() {
		t.Fatal("gate must reject a third admission while two collections are running")
	}
	gate.Release()
	if !gate.TryAcquire() {
		t.Fatal("gate must admit after a slot is released")
	}
}

func TestCollectorGlobalGateRejectsManualWhenScheduledOccupiesSlots(t *testing.T) {
	gate := NewCollectionGate()
	clock := &FixedClock{T: time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)}
	c := NewCollectorWithGate(NewHTTPProber(time.Second), nil, NewDestinationAllowlist(""), NewServiceUnitAllowlist(""), gate, clock)

	// Occupy every global slot as a scheduled collection would.
	for i := 0; i < MaxGlobalConcurrent; i++ {
		if !gate.TryAcquire() {
			t.Fatalf("failed to occupy slot %d", i)
		}
	}

	target := newTestTarget(t, "", "", "none")
	_, err := c.Collect(context.Background(), target, "operator", false)
	if err == nil {
		t.Fatal("manual collection must be rejected when the shared gate is saturated")
	}

	// Free a slot and confirm admission resumes.
	gate.Release()
	c.mu.Lock()
	delete(c.active, target.TargetID)
	delete(c.lastRunAt, target.TargetID)
	c.mu.Unlock()
	if _, err := c.Collect(context.Background(), target, "operator", false); err != nil {
		t.Fatalf("manual collection must proceed once a shared slot is free: %v", err)
	}
}

func TestCollectorRejectsOverlappingCollectionForSameTarget(t *testing.T) {
	c := NewCollectorWithGate(NewHTTPProber(time.Second), nil, NewDestinationAllowlist(""), NewServiceUnitAllowlist(""), NewCollectionGate(), &FixedClock{T: time.Now().UTC()})
	target := newTestTarget(t, "", "", "none")
	c.mu.Lock()
	c.active[target.TargetID] = struct{}{}
	c.mu.Unlock()
	if _, err := c.Collect(context.Background(), target, "operator", true); err != ErrInProgress {
		t.Fatalf("overlapping scheduled collection must be rejected, got %v", err)
	}
}

func TestSchedulerShutdownCancelsInFlightWork(t *testing.T) {
	repo := &fakeSchedulerRepo{}
	c := NewCollectorWithGate(NewHTTPProber(time.Second), nil, NewDestinationAllowlist(""), NewServiceUnitAllowlist(""), NewCollectionGate(), &FixedClock{T: time.Now().UTC()})
	s := NewSchedulerWithClock(repo, c, &FixedClock{T: time.Now().UTC()})
	s.SetInterval(5 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	time.Sleep(20 * time.Millisecond)
	cancel()
	s.Stop()
	// Stop returns only after in-flight work finishes; reaching this point
	// without a hang is the assertion.
}
