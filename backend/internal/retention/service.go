package retention

import (
	"context"
	"fmt"
	"strings"
	"time"

	"subscriber/internal/audit"
	"subscriber/internal/knowledge"
	"subscriber/internal/nfhealth"
)

type Service struct {
	repo         *Repository
	auditWriter  *audit.Writer
	retentionDay int
	now          func() time.Time
}

func NewService(repo *Repository, auditWriter *audit.Writer, retentionDays int) *Service {
	return &Service{repo: repo, auditWriter: auditWriter, retentionDay: retentionDays, now: time.Now}
}

func (s *Service) Settings() Settings {
	enabled := s.retentionDay > 0
	cutoff := ""
	if enabled {
		cutoff = s.now().UTC().AddDate(0, 0, -s.retentionDay).Format(time.RFC3339)
	}
	return Settings{
		RetentionDays: s.retentionDay,
		Enabled:       enabled,
		Cutoff:        cutoff,
		Confirmation:  ConfirmationPhrase,
	}
}

func (s *Service) Preview(ctx context.Context, limit int) (Preview, error) {
	settings := s.Settings()
	preview := Preview{Settings: settings, Candidates: []Candidate{}, DataClasses: s.DataClasses()}
	if !settings.Enabled {
		return preview, nil
	}
	limit = clampLimit(limit)
	all, total, err := s.repo.ListCandidates(ctx, s.now().UTC().AddDate(0, 0, -s.retentionDay))
	if err != nil {
		return Preview{}, err
	}
	preview.EligibleCount = total
	if len(all) > limit {
		all = all[:limit]
	}
	preview.Candidates = all
	return preview, nil
}

// DataClasses is the read-only retention matrix. It states the policy owner and
// the cleanup mode; only the OCS terminated-contract class is purgeable here.
func (s *Service) DataClasses() []DataClassPolicy {
	return []DataClassPolicy{
		{Key: "ocs_terminated_contracts", Mode: "manual_purge", RetentionDays: s.retentionDay, Configurable: true, Purgeable: true},
		{Key: "nf_health_samples", Mode: "ttl", RetentionDays: nfhealth.DefaultRetentionDays, Configurable: false, Purgeable: false},
		{Key: "knowledge_unbound_attachments", Mode: "janitor", RetentionDays: int(knowledge.UnboundFileTTL / (24 * time.Hour)), Configurable: false, Purgeable: false},
		{Key: "notification_deliveries", Mode: "unbounded", RetentionDays: 0, Configurable: false, Purgeable: false},
		{Key: "audit_logs", Mode: "unbounded", RetentionDays: 0, Configurable: false, Purgeable: false},
		{Key: "legacy_alerts", Mode: "unbounded", RetentionDays: 0, Configurable: false, Purgeable: false},
	}
}

// PreviewTarget shows one contract regardless of its age. It is used by the
// explicit CLI maintenance path, never by the administrative console.
func (s *Service) PreviewTarget(ctx context.Context, imsi string) (*Candidate, error) {
	return s.repo.GetCandidate(ctx, imsi)
}

func (s *Service) Purge(ctx context.Context, opts PurgeOptions) (PurgeResult, error) {
	if err := s.validate(opts); err != nil {
		return PurgeResult{}, err
	}
	limit := clampLimit(opts.Limit)
	all, total, err := s.repo.ListCandidates(ctx, s.now().UTC().AddDate(0, 0, -s.retentionDay))
	if err != nil {
		return PurgeResult{}, err
	}
	truncated := len(all) > limit
	if truncated {
		all = all[:limit]
	}
	result, err := s.purgeCandidates(ctx, all, opts)
	if err != nil {
		return result, err
	}
	result.Truncated = truncated
	result.Remaining = total - result.PurgedCandidates
	if result.Remaining < 0 {
		result.Remaining = 0
	}
	return result, nil
}

func (s *Service) PurgeTarget(ctx context.Context, imsi string, opts PurgeOptions) (PurgeResult, error) {
	if err := s.validate(opts); err != nil {
		return PurgeResult{}, err
	}
	candidate, err := s.repo.GetCandidate(ctx, imsi)
	if err != nil {
		return PurgeResult{}, err
	}
	if candidate == nil {
		return PurgeResult{}, ErrContractNotFound
	}
	return s.purgeCandidates(ctx, []Candidate{*candidate}, opts)
}

func (s *Service) validate(opts PurgeOptions) error {
	if s.retentionDay <= 0 {
		return ErrRetentionDisabled
	}
	if strings.TrimSpace(opts.Confirmation) != ConfirmationPhrase {
		return ErrConfirmationNeeded
	}
	if strings.TrimSpace(opts.Reason) == "" {
		return ErrReasonRequired
	}
	return nil
}

func (s *Service) purgeCandidates(ctx context.Context, candidates []Candidate, opts PurgeOptions) (PurgeResult, error) {
	result := PurgeResult{DryRun: false, Requested: len(candidates), Skipped: []string{}, Warnings: []string{}}
	for _, candidate := range candidates {
		counts, err := s.repo.PurgeContract(ctx, candidate.IMSI)
		if err == ErrNotTerminated {
			result.Skipped = append(result.Skipped, candidate.IMSI)
			continue
		}
		if err != nil {
			return result, fmt.Errorf("purge %s: %w", candidate.IMSI, err)
		}
		result.PurgedCandidates++
		result.PurgedContracts += int(counts.Contracts)
		result.PurgedBalances += int(counts.Balances)
		result.PurgedAdjustments += int(counts.Adjustments)
		if s.auditWriter == nil {
			result.Warnings = append(result.Warnings, "audit writer unavailable for "+candidate.IMSI)
			continue
		}
		input := audit.WriteAuditInput{
			Action:   "PURGE",
			Module:   "ocs-retention",
			TargetID: "ocs-subscriber:" + candidate.IMSI,
			Actor:    opts.Actor,
			Reason:   strings.TrimSpace(opts.Reason),
			Before: map[string]any{
				"imsi":         candidate.IMSI,
				"terminatedAt": candidate.TerminatedAt,
				"contracts":    counts.Contracts,
				"balances":     counts.Balances,
				"adjustments":  counts.Adjustments,
			},
			Result: "success",
			Metadata: map[string]any{
				"retentionDays": s.retentionDay,
				"cascade":       "adjustments->balances->contracts",
			},
		}
		if err := s.auditWriter.WriteStrict(ctx, input); err != nil {
			result.Warnings = append(result.Warnings, "audit write failed for "+candidate.IMSI+": "+err.Error())
		}
	}
	return result, nil
}

func clampLimit(limit int) int {
	if limit <= 0 {
		return 100
	}
	if limit > 1000 {
		return 1000
	}
	return limit
}
