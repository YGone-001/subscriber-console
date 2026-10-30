package discovery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"subscriber/internal/audit"
)

// Clock is the injectable time source for scan admission and scheduling.
type Clock interface {
	Now() time.Time
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

// ScanRepository is the write surface a scan needs. It is a subset of the
// handler repository so the shared scanner can be constructed independently.
type ScanRepository interface {
	InsertRun(ctx context.Context, run *DiscoveryRun) error
	CompleteRun(ctx context.Context, run *DiscoveryRun) error
	UpsertObservation(ctx context.Context, sourceID, adapterType string, profile *NormalizedProfile, now string) (bool, bool, bool, error)
	MarkMissing(ctx context.Context, sourceID string, seenIDs map[string]struct{}, now string) (int, error)
	UpdateSourceScanMeta(ctx context.Context, sourceID, completedAt, lastError string) error
}

// Scanner is the single scan execution path shared by the manual endpoint and
// the scheduler. Holding one coordinator is what makes the documented global
// and per-source single-flight bounds real across both entry points; separate
// locks would let a scheduled and a manual scan reach the same NRF together.
type Scanner struct {
	repo        ScanRepository
	adapters    *AdapterRegistry
	auditWriter AuditWriter
	clock       Clock

	mu          sync.Mutex
	activeScans map[string]string // sourceId -> runId
	lastScanAt  map[string]time.Time
	globalScan  bool
}

// NewScanner constructs the shared scan executor.
func NewScanner(repo ScanRepository, adapters *AdapterRegistry, auditWriter AuditWriter) *Scanner {
	return &Scanner{
		repo:        repo,
		adapters:    adapters,
		auditWriter: auditWriter,
		clock:       systemClock{},
		activeScans: map[string]string{},
		lastScanAt:  map[string]time.Time{},
	}
}

// NewScannerWithClock constructs a scanner with an injectable test clock.
func NewScannerWithClock(repo ScanRepository, adapters *AdapterRegistry, auditWriter AuditWriter, clock Clock) *Scanner {
	s := NewScanner(repo, adapters, auditWriter)
	if clock != nil {
		s.clock = clock
	}
	return s
}

// LastAttempt returns the in-memory attempt time for a source. It complements
// the persisted lastScanAt while a scan is starting or when metadata persistence
// lags.
func (s *Scanner) LastAttempt(sourceID string) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	last, ok := s.lastScanAt[sourceID]
	return last, ok
}

// Scan executes one bounded scan. Manual callers receive classified failures;
// scheduled callers can ignore the error because the run outcome is already
// persisted. Admission failures return a nil run and are safe to retry on a
// later tick.
func (s *Scanner) Scan(ctx context.Context, src *DiscoverySource, trigger, actor, role string) (*DiscoveryRun, error) {
	if src == nil {
		return nil, errors.New("discovery source is required")
	}
	if !src.Enabled {
		return nil, ErrSourceDisabled
	}
	adapter, err := s.adapters.Get(src.AdapterType)
	if err != nil {
		return nil, ErrUnsupportedAdapter
	}

	now := s.now()
	s.mu.Lock()
	if s.globalScan || s.activeScans[src.SourceID] != "" {
		s.mu.Unlock()
		return nil, ErrScanInProgress
	}
	if last, ok := s.lastScanAt[src.SourceID]; ok {
		if now.Sub(last) < time.Duration(MinScanIntervalSeconds)*time.Second {
			s.mu.Unlock()
			return nil, ErrScanRateLimited
		}
	}

	run := &DiscoveryRun{
		RunID:         audit.GenerateUUID(),
		SchemaVersion: SchemaVersion,
		SourceID:      src.SourceID,
		StartedAt:     CurrentTimestamp(),
		Status:        RunStatusRunning,
		Trigger:       trigger,
		InitiatedBy:   actor,
	}
	s.activeScans[src.SourceID] = run.RunID
	s.globalScan = true
	s.lastScanAt[src.SourceID] = now
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.activeScans, src.SourceID)
		s.globalScan = false
		s.mu.Unlock()
	}()

	if err := s.repo.InsertRun(ctx, run); err != nil {
		return nil, err
	}
	if trigger == ScanTriggerManual {
		s.audit("discovery.scan.request", src.SourceID, actor, role, "success", map[string]any{"runId": run.RunID})
	}

	scanCtx, cancel := context.WithTimeout(ctx, time.Duration(TotalScanDeadlineSec)*time.Second)
	defer cancel()

	batch, scanErr := adapter.Discover(scanCtx, *src)
	completedAt := CurrentTimestamp()
	run.CompletedAt = completedAt

	if scanErr != nil {
		run.Status = RunStatusFailed
		run.ErrorCode, run.ErrorSummary = classifyScanError(scanErr)
		s.finish(src, run, completedAt, run.ErrorSummary, trigger, actor, role)
		return run, &ScanFailure{Code: run.ErrorCode, Summary: run.ErrorSummary}
	}

	seen := map[string]struct{}{}
	for _, profile := range batch.Profiles {
		seen[profile.ExternalNfInstanceID] = struct{}{}
		created, updated, _, upsertErr := s.repo.UpsertObservation(context.Background(), src.SourceID, src.AdapterType, profile, completedAt)
		if upsertErr != nil {
			run.Status = RunStatusFailed
			run.ErrorCode = "DISCOVERY_RESPONSE_INVALID"
			run.ErrorSummary = SanitizeSummary(upsertErr.Error())
			s.finish(src, run, completedAt, run.ErrorSummary, trigger, actor, role)
			return run, fmt.Errorf("failed to persist observation: %w", upsertErr)
		}
		run.DiscoveredCount++
		if created {
			run.CreatedCount++
		} else if updated {
			run.UpdatedCount++
		} else {
			run.UnchangedCount++
		}
	}

	// Missing is inferred only from a complete, untruncated successful scan.
	// lastSuccessAt likewise moves only on that path: partial and failed
	// attempts refresh lastScanAt and record lastError without claiming a
	// success time.
	if batch.Complete {
		missing, missErr := s.repo.MarkMissing(context.Background(), src.SourceID, seen, completedAt)
		if missErr == nil {
			run.MissingCount = missing
		}
		run.Status = RunStatusSuccess
		s.finish(src, run, completedAt, "", trigger, actor, role)
	} else {
		run.Status = RunStatusPartial
		run.ErrorCode = "DISCOVERY_RESPONSE_LIMIT_EXCEEDED"
		run.ErrorSummary = "scan truncated; absence not inferred"
		s.finish(src, run, completedAt, run.ErrorSummary, trigger, actor, role)
	}
	return run, nil
}

// finish persists scan outcome metadata and the completed run. Both writes use
// a detached context so a canceled HTTP request cannot lose the evidence of a
// scan that already executed.
func (s *Scanner) finish(src *DiscoverySource, run *DiscoveryRun, completedAt, lastError, trigger, actor, role string) {
	_ = s.repo.UpdateSourceScanMeta(context.Background(), src.SourceID, completedAt, lastError)
	_ = s.repo.CompleteRun(context.Background(), run)
	if trigger == ScanTriggerManual {
		// The audit result mirrors the recorded run outcome: a failed or
		// truncated scan must never be audited as a success.
		s.audit("discovery.scan.complete", src.SourceID, actor, role, run.Status, map[string]any{
			"runId":      run.RunID,
			"outcome":    run.Status,
			"errorCode":  run.ErrorCode,
			"discovered": run.DiscoveredCount,
		})
	}
}

func (s *Scanner) audit(action, sourceID, actor, role, result string, after map[string]any) {
	if s.auditWriter == nil {
		return
	}
	s.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: action,
		Module: "discovery",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: actor,
			Role:     role,
		},
		Resource:  &audit.ResourceInput{Type: "discovery", ID: sourceID},
		TargetID:  sourceID,
		After:     after,
		Result:    result,
		RiskLevel: "low",
	})
}

// classifyScanError maps an adapter failure to a stable discovery error code.
func classifyScanError(err error) (string, string) {
	msg := SanitizeSummary(err.Error())
	switch {
	case errors.Is(err, ErrDestinationNotAllowed):
		return "DISCOVERY_TARGET_NOT_ALLOWED", msg
	case errors.Is(err, ErrResponseTooLarge):
		return "DISCOVERY_RESPONSE_LIMIT_EXCEEDED", msg
	case errors.Is(err, ErrProtocol):
		return "DISCOVERY_PROTOCOL_ERROR", msg
	case errors.Is(err, ErrSourceDisabled):
		return "DISCOVERY_SOURCE_DISABLED", msg
	case strings.Contains(msg, "transport error") || strings.Contains(msg, "connection refused") || strings.Contains(msg, "timeout"):
		return "DISCOVERY_TRANSPORT_ERROR", msg
	case strings.Contains(msg, "status"):
		return "DISCOVERY_PROTOCOL_ERROR", msg
	default:
		return "DISCOVERY_RESPONSE_INVALID", msg
	}
}

func (s *Scanner) now() time.Time {
	if s.clock == nil {
		return time.Now().UTC()
	}
	return s.clock.Now().UTC()
}
