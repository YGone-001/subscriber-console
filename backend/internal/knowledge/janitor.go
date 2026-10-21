package knowledge

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

const (
	// JanitorInterval is the cleanup cadence.
	JanitorInterval = time.Hour
	// UnboundFileTTL is how long an unclaimed upload may survive before cleanup.
	UnboundFileTTL = 24 * time.Hour
	// JanitorBatchSize bounds a single cleanup pass.
	JanitorBatchSize = 200
)

// Janitor periodically reclaims two classes of stale attachment:
//   - unbound uploads older than the TTL (an entry was never saved);
//   - orphan files whose owning entry no longer exists.
//
// Each pass moves the on-disk bytes to trash and removes the metadata record.
// Both operations are best-effort and bounded, so a transient failure degrades
// to a log line instead of blocking the console.
type Janitor struct {
	repo     *Repository
	store    *FileStore
	logger   *slog.Logger
	interval time.Duration
	stop     chan struct{}
	wg       sync.WaitGroup
}

// NewJanitor creates a knowledge attachment janitor.
func NewJanitor(repo *Repository, store *FileStore, logger *slog.Logger) *Janitor {
	if logger == nil {
		logger = slog.Default()
	}
	return &Janitor{
		repo:     repo,
		store:    store,
		logger:   logger,
		interval: JanitorInterval,
		stop:     make(chan struct{}),
	}
}

// Start launches the janitor goroutine. It is idempotent.
func (j *Janitor) Start(ctx context.Context) {
	j.wg.Add(1)
	go func() {
		defer j.wg.Done()
		j.runOnce(ctx)
		ticker := time.NewTicker(j.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				j.runOnce(ctx)
			case <-j.stop:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Stop signals the janitor to exit and waits for it.
func (j *Janitor) Stop() {
	select {
	case <-j.stop:
	default:
		close(j.stop)
	}
	j.wg.Wait()
}

func (j *Janitor) runOnce(ctx context.Context) {
	j.reclaimUnbound(ctx)
	j.reclaimOrphans(ctx)
}

func (j *Janitor) reclaimUnbound(ctx context.Context) {
	cutoff := time.Now().UTC().Add(-UnboundFileTTL).Format(time.RFC3339)
	metas, err := j.repo.ListUnboundBefore(ctx, cutoff, JanitorBatchSize)
	if err != nil {
		j.logger.Warn("knowledge janitor: unbound scan failed", "error", err)
		return
	}
	j.reclaim(ctx, metas)
}

func (j *Janitor) reclaimOrphans(ctx context.Context) {
	metas, err := j.repo.ListOrphanFiles(ctx, JanitorBatchSize)
	if err != nil {
		j.logger.Warn("knowledge janitor: orphan scan failed", "error", err)
		return
	}
	j.reclaim(ctx, metas)
}

func (j *Janitor) reclaim(ctx context.Context, metas []FileMeta) {
	for _, meta := range metas {
		if err := j.store.Trash(meta.ID); err != nil {
			j.logger.Warn("knowledge janitor: trash failed", "fileId", meta.ID, "error", err)
			continue
		}
		if err := j.repo.ReleaseFile(ctx, meta.ID); err != nil {
			j.logger.Warn("knowledge janitor: metadata release failed", "fileId", meta.ID, "error", err)
		}
	}
}
