package runtimeinv

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Service owns the single shared scanner of one backend instance.
//
// There is exactly one scan loop per process: browsers never start a scan, and
// the observations endpoint always serves the cached snapshot.
type Service struct {
	scanner *Scanner
	store   StateStore
	clock   func() time.Time
	logger  *slog.Logger

	interval  time.Duration
	enabled   bool
	minManual time.Duration
	freshness time.Duration
	bootstrap bool

	mu         sync.Mutex
	states     map[string]ComponentState
	snapshot   *Snapshot
	lastScanAt time.Time
	scanning   bool
	lastManual time.Time
	started    bool
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// ServiceOptions configures the scan lifecycle.
type ServiceOptions struct {
	Enabled           bool
	Interval          time.Duration
	MinManualInterval time.Duration
	Clock             func() time.Time
	Logger            *slog.Logger
	BootstrapEnabled  bool
}

// NewService constructs the scan lifecycle.
func NewService(scanner *Scanner, store StateStore, opts ServiceOptions) *Service {
	clock := opts.Clock
	if clock == nil {
		clock = time.Now
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = 10 * time.Second
	}
	minimum := opts.MinManualInterval
	if minimum <= 0 {
		minimum = 2 * time.Second
	}
	if store == nil {
		store = NewMemoryStateStore()
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	freshness := 3 * interval
	if freshness < 30*time.Second {
		freshness = 30 * time.Second
	}
	return &Service{
		scanner:   scanner,
		store:     store,
		clock:     clock,
		logger:    logger,
		interval:  interval,
		enabled:   opts.Enabled,
		minManual: minimum,
		freshness: freshness,
		bootstrap: opts.BootstrapEnabled,
		states:    map[string]ComponentState{},
	}
}

// Start loads the persisted observation memory and begins scanning.
//
// The startup scan runs immediately so the operational surface is populated
// without any Inventory record and without waiting for the first tick.
func (s *Service) Start(ctx context.Context) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.mu.Unlock()

	loadCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	states, err := s.store.Load(loadCtx)
	cancel()
	if err != nil {
		s.logger.Warn("runtime discovery state load failed", "error", err)
		states = map[string]ComponentState{}
	}
	s.mu.Lock()
	s.states = states
	s.mu.Unlock()

	if !s.enabled {
		s.logger.Info("runtime discovery scanner disabled")
		return
	}

	if _, err := s.scan(ctx, TriggerStartup); err != nil {
		s.logger.Warn("runtime discovery startup scan failed", "error", err)
	}

	runCtx, runCancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.cancel = runCancel
	s.mu.Unlock()
	s.wg.Add(1)
	go s.loop(runCtx)
}

// Stop cancels the scan loop and waits for in-flight work.
func (s *Service) Stop() {
	s.mu.Lock()
	cancel := s.cancel
	s.cancel = nil
	s.started = false
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.wg.Wait()
}

func (s *Service) loop(ctx context.Context) {
	defer s.wg.Done()
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := s.scan(ctx, TriggerScheduled); err != nil && err != ErrScanInProgress {
				s.logger.Warn("runtime discovery scan failed", "error", err)
			}
		}
	}
}

// Rescan performs one authorized manual scan. It is bounded by an overlap guard
// and a minimum interval so a client can never drive sustained scanning.
func (s *Service) Rescan(ctx context.Context) (*Snapshot, error) {
	if !s.enabled {
		return nil, ErrScannerDisabled
	}
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return nil, ErrScanInProgress
	}
	now := s.clock().UTC()
	if !s.lastManual.IsZero() && now.Sub(s.lastManual) < s.minManual {
		s.mu.Unlock()
		return nil, ErrScanRateLimited
	}
	s.lastManual = now
	s.mu.Unlock()

	snapshot, err := s.scan(ctx, TriggerManual)
	if err != nil {
		return nil, err
	}
	// Return a detached projection so a caller can decorate the response (for
	// example with association projections) without mutating the cached
	// snapshot that other requests read concurrently.
	return projectFreshness(snapshot, s.clock().UTC(), s.freshness, true), nil
}

func (s *Service) scan(ctx context.Context, trigger string) (*Snapshot, error) {
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return nil, ErrScanInProgress
	}
	s.scanning = true
	prior := s.states
	s.mu.Unlock()

	snapshot, next := s.scanner.Scan(ctx, trigger, prior)

	s.mu.Lock()
	changed := diffStates(prior, next)
	s.states = next
	s.snapshot = snapshot
	s.lastScanAt = s.clock().UTC()
	s.scanning = false
	s.mu.Unlock()

	if len(changed) > 0 {
		saveCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := s.store.Save(saveCtx, changed); err != nil {
			s.logger.Warn("runtime discovery state save failed", "error", err)
		}
		cancel()
	}
	return snapshot, nil
}

// Snapshot returns the cached current-state publication. It never starts a scan.
func (s *Service) Snapshot() *Snapshot {
	s.mu.Lock()
	snapshot := s.snapshot
	enabled := s.enabled
	s.mu.Unlock()

	if snapshot == nil {
		return s.placeholderSnapshot(enabled)
	}
	return projectFreshness(snapshot, s.clock().UTC(), s.freshness, enabled)
}

// LastScanAt reports when the last scan completed.
func (s *Service) LastScanAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastScanAt
}

// Enabled reports whether the background scanner is active.
func (s *Service) Enabled() bool { return s.enabled }

// Interval returns the configured scan interval.
func (s *Service) Interval() time.Duration { return s.interval }

// FreshnessSeconds returns the observation freshness policy in seconds.
func (s *Service) FreshnessSeconds() int { return int(s.freshness / time.Second) }

// MinManualIntervalSeconds returns the manual rescan minimum interval.
func (s *Service) MinManualIntervalSeconds() int { return int(s.minManual / time.Second) }

// Host returns the server-owned host identity.
func (s *Service) Host() HostIdentity { return s.scanner.Host() }

// Registry returns the recognition registry.
func (s *Service) Registry() *Registry { return s.scanner.Registry() }

// BootstrapEnabled reports whether the bootstrap gateways are wired.
func (s *Service) BootstrapEnabled() bool { return s.bootstrap }

// placeholderSnapshot describes a service that has not produced a snapshot yet.
// Every component is reported as not_configured, never as stopped.
func (s *Service) placeholderSnapshot(enabled bool) *Snapshot {
	now := s.clock().UTC()
	reason := ReasonScannerDisabled
	status := StatusNotConfigured
	if enabled {
		reason = "no_scan_yet"
		status = StatusUnknown
	}
	snapshot := &Snapshot{
		ProfileID:      ProfileCNMSCompat,
		ProfileVersion: ProfileVersion,
		Host:           s.scanner.Host(),
		Registry:       s.scanner.Registry().Counts(),
		GeneratedAt:    now.Format(time.RFC3339Nano),
		Components:     []Observation{},
		Scan: ScanMetadata{
			Trigger:         "none",
			Status:          "not_scanned",
			Complete:        false,
			IntervalSeconds: int(s.interval / time.Second),
		},
	}
	for _, component := range s.scanner.Registry().Components() {
		observation := baseObservation(component)
		observation.RuntimeStatus = status
		observation.StatusReason = reason
		snapshot.Components = append(snapshot.Components, observation)
	}
	snapshot.Counts = countStatuses(snapshot.Components)
	return snapshot
}

// projectFreshness marks an expired observation as stale. A stale observation
// keeps its previous status so the operator can see what was last accepted.
func projectFreshness(snapshot *Snapshot, now time.Time, freshness time.Duration, enabled bool) *Snapshot {
	if snapshot == nil {
		return nil
	}
	out := *snapshot
	out.Components = make([]Observation, len(snapshot.Components))
	copy(out.Components, snapshot.Components)

	expired := false
	reason := ReasonObservationExpired
	if !enabled {
		expired = true
		reason = ReasonScannerDisabled
	} else if snapshot.Scan.Status != ScanFailed && snapshot.Scan.CompletedAt != "" {
		if completed, err := time.Parse(time.RFC3339Nano, snapshot.Scan.CompletedAt); err == nil {
			expired = now.Sub(completed) > freshness
		}
	}

	if !expired {
		return &out
	}
	for index := range out.Components {
		observation := &out.Components[index]
		// Only an accepted runtime observation can expire. A component that was
		// never detected stays not_detected; a configuration state stays a
		// configuration state.
		switch observation.RuntimeStatus {
		case StatusRunning, StatusStopped, StatusUnverified:
		default:
			continue
		}
		observation.PreviousStatus = observation.RuntimeStatus
		observation.RuntimeStatus = StatusStale
		observation.StatusReason = reason
	}
	out.Counts = countStatuses(out.Components)
	return &out
}

func diffStates(prior, next map[string]ComponentState) []ComponentState {
	changed := make([]ComponentState, 0, len(next))
	for key, value := range next {
		previous, ok := prior[key]
		if ok && previous == value {
			continue
		}
		changed = append(changed, value)
	}
	return changed
}
