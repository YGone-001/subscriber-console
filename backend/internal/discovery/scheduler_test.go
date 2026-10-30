package discovery

import (
	"context"
	"testing"
	"time"
)

type fakeSchedulerRepo struct {
	sources []DiscoverySource
	err     error
	calls   int
}

func (r *fakeSchedulerRepo) ListScheduledSources(ctx context.Context, limit int) ([]DiscoverySource, error) {
	r.calls++
	if r.err != nil {
		return nil, r.err
	}
	return r.sources, nil
}

type fakeScheduledScanner struct {
	attempts map[string]time.Time
	scans    []string
	err      error
}

func (s *fakeScheduledScanner) Scan(ctx context.Context, src *DiscoverySource, trigger, actor, role string) (*DiscoveryRun, error) {
	s.scans = append(s.scans, src.SourceID)
	return &DiscoveryRun{RunID: "run-" + src.SourceID, Status: RunStatusSuccess, Trigger: trigger}, s.err
}

func (s *fakeScheduledScanner) LastAttempt(sourceID string) (time.Time, bool) {
	last, ok := s.attempts[sourceID]
	return last, ok
}

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }

func TestSchedulerScansOneDueSourcePerTick(t *testing.T) {
	now := time.Date(2026, 10, 31, 8, 0, 0, 0, time.UTC)
	repo := &fakeSchedulerRepo{sources: []DiscoverySource{
		{
			SourceID: "due-oldest", Enabled: true, ScanIntervalSeconds: 60,
			CreatedAt: "2026-10-31T07:00:00Z", LastScanAt: "2026-10-31T07:30:00Z",
		},
		{
			SourceID: "due-newer", Enabled: true, ScanIntervalSeconds: 60,
			CreatedAt: "2026-10-31T07:00:00Z", LastScanAt: "2026-10-31T07:50:00Z",
		},
		{
			SourceID: "not-due", Enabled: true, ScanIntervalSeconds: 600,
			CreatedAt: "2026-10-31T07:00:00Z", LastScanAt: "2026-10-31T07:59:00Z",
		},
	}}
	scanner := &fakeScheduledScanner{attempts: map[string]time.Time{}}
	scheduler := NewSchedulerWithClock(repo, scanner, fixedClock{now: now})

	scheduler.Tick(context.Background())

	if len(scanner.scans) != 1 || scanner.scans[0] != "due-oldest" {
		t.Fatalf("scans = %v, want exactly the oldest due source", scanner.scans)
	}
}

func TestSchedulerNeverScansManualOnlyOrDisabledSources(t *testing.T) {
	now := time.Date(2026, 10, 31, 8, 0, 0, 0, time.UTC)
	repo := &fakeSchedulerRepo{sources: []DiscoverySource{
		{SourceID: "manual", Enabled: true, ScanIntervalSeconds: 0, CreatedAt: "2026-10-31T07:00:00Z"},
		{SourceID: "disabled", Enabled: false, ScanIntervalSeconds: 60, CreatedAt: "2026-10-31T07:00:00Z"},
	}}
	scanner := &fakeScheduledScanner{attempts: map[string]time.Time{}}
	scheduler := NewSchedulerWithClock(repo, scanner, fixedClock{now: now})

	scheduler.Tick(context.Background())

	if len(scanner.scans) != 0 {
		t.Fatalf("scans = %v, want none", scanner.scans)
	}
}

func TestSchedulerStopsAtGlobalSingleFlight(t *testing.T) {
	now := time.Date(2026, 10, 31, 8, 0, 0, 0, time.UTC)
	repo := &fakeSchedulerRepo{sources: []DiscoverySource{
		{SourceID: "first", Enabled: true, ScanIntervalSeconds: 60, CreatedAt: "2026-10-31T07:00:00Z"},
		{SourceID: "second", Enabled: true, ScanIntervalSeconds: 60, CreatedAt: "2026-10-31T07:00:00Z"},
	}}
	scanner := &fakeScheduledScanner{
		attempts: map[string]time.Time{},
		err:      ErrScanInProgress,
	}
	scheduler := NewSchedulerWithClock(repo, scanner, fixedClock{now: now})

	scheduler.Tick(context.Background())

	if len(scanner.scans) != 1 {
		t.Fatalf("scans = %v, one busy scan must end the tick", scanner.scans)
	}
}

func TestSchedulerSkipsWhenRepositoryFailsOrContextCancels(t *testing.T) {
	now := time.Date(2026, 10, 31, 8, 0, 0, 0, time.UTC)
	repo := &fakeSchedulerRepo{err: context.Canceled}
	scanner := &fakeScheduledScanner{attempts: map[string]time.Time{}}
	scheduler := NewSchedulerWithClock(repo, scanner, fixedClock{now: now})

	scheduler.Tick(context.Background())
	if len(scanner.scans) != 0 {
		t.Fatalf("scans = %v, want none after a repository failure", scanner.scans)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	scheduler.Tick(ctx)
	if len(scanner.scans) != 0 {
		t.Fatalf("scans = %v, want none after cancellation", scanner.scans)
	}
}
