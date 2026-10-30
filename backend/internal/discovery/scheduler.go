package discovery

import (
	"context"
	"sync"
	"time"
)

// Scheduler runs bounded periodic scans for sources that carry a positive
// scan interval. It lives inside the existing Go process and never becomes a
// second daemon.
//
// Cadence is per source: a source is scanned when
// now >= last attempt + scanIntervalSeconds. The shared Scanner owns the
// single-flight and rate-limit state, so scheduled work can never overlap a
// manual scan of the same source or exceed the global live-scan bound. Manual
// scans remain available at any time and refresh the same cadence basis.
type Scheduler struct {
	repo    SchedulerRepository
	scanner ScheduledScanner
	clock   Clock

	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	interval time.Duration
}

// SchedulerRepository is the read surface the scheduler needs.
type SchedulerRepository interface {
	ListScheduledSources(ctx context.Context, limit int) ([]DiscoverySource, error)
}

// ScheduledScanner is the scan surface the scheduler needs.
type ScheduledScanner interface {
	Scan(ctx context.Context, src *DiscoverySource, trigger, actor, role string) (*DiscoveryRun, error)
	LastAttempt(sourceID string) (time.Time, bool)
}

// NewScheduler constructs a scheduler with a bounded tick interval.
func NewScheduler(repo SchedulerRepository, scanner ScheduledScanner) *Scheduler {
	return &Scheduler{
		repo:     repo,
		scanner:  scanner,
		clock:    systemClock{},
		interval: time.Duration(SchedulerTickSeconds) * time.Second,
	}
}

// NewSchedulerWithClock constructs a scheduler with an injectable test clock.
func NewSchedulerWithClock(repo SchedulerRepository, scanner ScheduledScanner, clock Clock) *Scheduler {
	s := NewScheduler(repo, scanner)
	if clock != nil {
		s.clock = clock
	}
	return s
}

// SetInterval overrides the scheduler tick interval. Intended for tests.
func (s *Scheduler) SetInterval(d time.Duration) {
	if d > 0 {
		s.interval = d
	}
}

// Start begins scheduled scanning. The first tick is delayed to avoid a
// startup burst; due calculation still uses persisted lastScanAt, so a restart
// never scans a source early relative to its configured cadence.
func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.running = true
	s.mu.Unlock()

	s.wg.Add(1)
	go s.loop(runCtx)
}

// Stop cancels scheduled scanning and waits for in-flight work to finish.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	cancel := s.cancel
	s.running = false
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.wg.Wait()
}

func (s *Scheduler) loop(ctx context.Context) {
	defer s.wg.Done()
	timer := time.NewTimer(s.interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.tick(ctx)
			timer.Reset(s.interval)
		}
	}
}

// Tick runs one scheduling pass. Exposed for deterministic tests.
func (s *Scheduler) Tick(ctx context.Context) {
	s.tick(ctx)
}

func (s *Scheduler) tick(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	sources, err := s.repo.ListScheduledSources(ctx, MaxScheduledSources)
	if err != nil || len(sources) == 0 {
		return
	}
	now := s.now()
	for i := range sources {
		src := &sources[i]
		last, hasAttempt := s.scanner.LastAttempt(src.SourceID)
		if !IsSourceDue(src, now, last, hasAttempt) {
			continue
		}
		// The global live-scan bound is one: a scheduled scan occupies this
		// tick entirely, and the next due source waits for the next tick.
		_, _ = s.scanner.Scan(ctx, src, ScanTriggerScheduled, "scheduler", "")
		return
	}
}

func (s *Scheduler) now() time.Time {
	if s.clock == nil {
		return time.Now().UTC()
	}
	return s.clock.Now().UTC()
}
