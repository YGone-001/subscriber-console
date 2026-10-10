package nfhealth

import (
	"context"
	"sync"
	"time"
)

// Scheduler runs bounded scheduled collections for explicitly enabled targets.
// It lives inside the existing Go process and never becomes a second daemon.
//
// Cadence is per target: a target is collected when
// now >= lastAttemptAt + intervalSeconds. Overlapping collections are rejected,
// disabled and manual targets are never auto-scheduled, and the shared
// CollectionGate bounds global concurrency across manual and scheduled work.
type Scheduler struct {
	repo      SchedulerRepository
	collector *Collector
	clock     Clock

	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	interval time.Duration
	// cursor rotates the fetch window so targets beyond one batch limit are
	// not starved when the due set is larger than the batch.
	cursor int
}

// SchedulerRepository is the read surface the scheduler needs.
type SchedulerRepository interface {
	ListScheduledTargets(ctx context.Context, limit int) ([]HealthTarget, error)
	RecordCollection(ctx context.Context, target *HealthTarget, result *CollectionResult) error
}

// NewScheduler constructs a scheduler with a bounded tick interval.
func NewScheduler(repo SchedulerRepository, collector *Collector) *Scheduler {
	return &Scheduler{
		repo:      repo,
		collector: collector,
		clock:     SystemClock{},
		interval:  time.Duration(DefaultIntervalSeconds) * time.Second,
	}
}

// NewSchedulerWithClock constructs a scheduler with an injectable test clock.
func NewSchedulerWithClock(repo SchedulerRepository, collector *Collector, clock Clock) *Scheduler {
	s := NewScheduler(repo, collector)
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

// Start begins scheduled collection. Only explicitly enabled scheduled targets
// are collected. The first tick is delayed to avoid a startup burst.
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

// Stop cancels scheduled collection and waits for in-flight work to finish.
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
	// Avoid a burst on startup: wait one interval before the first tick. Due
	// calculation still uses lastAttemptAt, so a restart never collects a
	// target early relative to its configured cadence.
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
	// Over-fetch so targets beyond one batch limit are still considered.
	batch := MaxGlobalConcurrent
	window := batch * 4
	if window < 8 {
		window = 8
	}

	targets, err := s.repo.ListScheduledTargets(ctx, window)
	if err != nil || len(targets) == 0 {
		return
	}

	now := s.now()
	due := selectDueTargets(targets, now, batch, s.advanceCursor(len(targets)))
	if len(due) == 0 {
		return
	}

	var wg sync.WaitGroup
	for i := range due {
		target := due[i]
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ctx.Err() != nil {
				return
			}
			if s.collector.InProgress(target.TargetID) {
				return
			}
			result, err := s.collector.Collect(ctx, &target, "scheduler", true)
			if err != nil {
				return
			}
			_ = s.repo.RecordCollection(ctx, &target, result)
		}()
	}
	wg.Wait()
}

// IsDue reports whether a scheduled target is due at the given instant.
// Authoritative basis is lastAttemptAt; a never-attempted target is due only
// when its interval has elapsed since it was created (or immediately if no
// timestamps exist, which the startup delay still throttles).
func IsDue(target *HealthTarget, now time.Time) bool {
	if target == nil {
		return false
	}
	if !target.Enabled {
		return false
	}
	if target.CollectionMode != CollectionScheduled {
		return false
	}
	interval := target.IntervalSeconds
	if interval < MinIntervalSeconds {
		interval = MinIntervalSeconds
	}
	if interval > MaxIntervalSeconds {
		interval = MaxIntervalSeconds
	}
	period := time.Duration(interval) * time.Second

	basis := ""
	if target.LastAttemptAt != "" {
		basis = target.LastAttemptAt
	} else if target.UpdatedAt != "" {
		basis = target.UpdatedAt
	} else if target.CreatedAt != "" {
		basis = target.CreatedAt
	}
	if basis == "" {
		return true
	}
	last, err := ParseBSONTime(basis)
	if err != nil {
		return false
	}
	return !now.Before(last.Time.Add(period))
}

// selectDueTargets filters to due scheduled targets and applies a rotating
// window so a due set larger than the batch is served fairly across ticks.
func selectDueTargets(targets []HealthTarget, now time.Time, batch, offset int) []HealthTarget {
	if batch < 1 {
		batch = 1
	}
	due := make([]*HealthTarget, 0, len(targets))
	for i := range targets {
		t := targets[i]
		if IsDue(&t, now) {
			due = append(due, &t)
		}
	}
	if len(due) == 0 {
		return nil
	}
	// Least-recently-attempted first keeps cadence fair without starvation.
	sortTargetsByLastAttempt(due)

	if len(due) <= batch {
		out := make([]HealthTarget, 0, len(due))
		for _, t := range due {
			out = append(out, *t)
		}
		return out
	}
	if offset < 0 {
		offset = 0
	}
	out := make([]HealthTarget, 0, batch)
	for i := 0; i < batch; i++ {
		out = append(out, *due[(offset+i)%len(due)])
	}
	return out
}

func sortTargetsByLastAttempt(items []*HealthTarget) {
	for i := 1; i < len(items); i++ {
		j := i
		for j > 0 && lastAttemptLess(items[j], items[j-1]) {
			items[j], items[j-1] = items[j-1], items[j]
			j--
		}
	}
}

func lastAttemptLess(a, b *HealthTarget) bool {
	ak := a.LastAttemptAt
	if ak == "" {
		ak = a.CreatedAt
	}
	bk := b.LastAttemptAt
	if bk == "" {
		bk = b.CreatedAt
	}
	return ak < bk
}

func (s *Scheduler) advanceCursor(n int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n <= 0 {
		return s.cursor
	}
	offset := s.cursor % n
	s.cursor = (s.cursor + MaxGlobalConcurrent) % n
	return offset
}

func (s *Scheduler) now() time.Time {
	if s.clock == nil {
		return time.Now().UTC()
	}
	return s.clock.Now().UTC()
}
