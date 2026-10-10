package nfhealth

import (
	"context"
	"sync"
	"time"
)

// Scheduler runs bounded scheduled collections for explicitly enabled targets.
// It lives inside the existing Go process and never becomes a second daemon.
type Scheduler struct {
	repo      SchedulerRepository
	collector *Collector

	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	interval time.Duration
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
		interval:  time.Duration(DefaultIntervalSeconds) * time.Second,
	}
}

// Start begins scheduled collection. Only explicitly enabled scheduled targets
// are collected. Startup is jittered to avoid a burst.
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
	// Avoid a burst on startup: wait one interval before the first tick.
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

func (s *Scheduler) tick(ctx context.Context) {
	targets, err := s.repo.ListScheduledTargets(ctx, MaxGlobalConcurrent*4)
	if err != nil || len(targets) == 0 {
		return
	}

	sem := make(chan struct{}, MaxGlobalConcurrent)
	var wg sync.WaitGroup
	for i := range targets {
		target := targets[i]
		if !target.Enabled || target.CollectionMode != CollectionScheduled {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
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
