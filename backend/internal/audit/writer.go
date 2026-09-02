package audit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
)

const (
	defaultQueueSize   = 256
	defaultWorkerCount = 2
	maxRetryAttempts   = 3
	retryDelay1        = 100 * time.Millisecond
	retryDelay2        = 200 * time.Millisecond
)

// WriterState represents the lifecycle state of the Writer.
type WriterState int32

const (
	StateOpen    WriterState = 0
	StateClosing WriterState = 1
	StateClosed  WriterState = 2
)

// ErrWriteFailed is returned by Strict mode when a record cannot be persisted
// after all retries. Contains the eventId for correlation.
type ErrWriteFailed struct {
	EventID string
	Err     error
}

func (e *ErrWriteFailed) Error() string {
	return "audit write failed: eventId=" + e.EventID
}

func (e *ErrWriteFailed) Unwrap() error { return e.Err }

// EvidenceStore abstracts audit record persistence for testability.
type EvidenceStore interface {
	Insert(ctx context.Context, record AuditWriteRecord) error
	FindByMongoID(ctx context.Context, id string) (*AuditWriteRecord, error)
}

// MongoEvidenceStore implements EvidenceStore using MongoDB.
type MongoEvidenceStore struct {
	collection *mongo.Collection
}

// NewMongoEvidenceStore creates a new MongoEvidenceStore.
func NewMongoEvidenceStore(collection *mongo.Collection) *MongoEvidenceStore {
	return &MongoEvidenceStore{collection: collection}
}

// Insert persists an audit record to MongoDB.
func (s *MongoEvidenceStore) Insert(ctx context.Context, record AuditWriteRecord) error {
	_, err := s.collection.InsertOne(ctx, record)
	return err
}

// FindByMongoID looks up an audit record by its _id field.
func (s *MongoEvidenceStore) FindByMongoID(ctx context.Context, id string) (*AuditWriteRecord, error) {
	var doc struct {
		ID      string `bson:"id"`
		EventID string `bson:"eventId"`
	}
	err := s.collection.FindOne(ctx, map[string]string{"_id": id}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	return &AuditWriteRecord{ID: doc.ID, EventID: doc.EventID}, nil
}

// pendingRecord wraps a pre-built sanitized record with its write mode.
type pendingRecord struct {
	record AuditWriteRecord
	mode   WriteMode
	ctx    context.Context // request context for Strict; writer context for BestEffort
	doneCh chan<- error    // nil for BestEffort (fire-and-forget)
}

// Writer is a bounded, asynchronous audit record writer.
// It enqueues pre-sanitized records into a fixed-size channel and processes them
// with a small pool of workers. Supports BestEffort (silent drop)
// and Strict (typed error on failure) write modes.
type Writer struct {
	store     EvidenceStore
	queue     chan pendingRecord
	logger    *slog.Logger
	wg        sync.WaitGroup
	mu        sync.RWMutex
	state     WriterState
	closeOnce sync.Once
}

// WriterConfig configures the audit writer.
type WriterConfig struct {
	QueueSize   int
	WorkerCount int
	Logger      *slog.Logger
	WriterCtx   context.Context // lifecycle context for BestEffort; nil = context.Background()
}

// NewWriter creates and starts an audit Writer.
// Call Close() for graceful shutdown.
func NewWriter(store EvidenceStore, cfg WriterConfig) *Writer {
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = defaultQueueSize
	}
	if cfg.WorkerCount <= 0 {
		cfg.WorkerCount = defaultWorkerCount
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.WriterCtx == nil {
		cfg.WriterCtx = context.Background()
	}

	w := &Writer{
		store:  store,
		queue:  make(chan pendingRecord, cfg.QueueSize),
		logger: cfg.Logger,
		state:  StateOpen,
	}

	// Start workers
	w.wg.Add(cfg.WorkerCount)
	for i := 0; i < cfg.WorkerCount; i++ {
		go w.worker(i, cfg.WriterCtx)
	}
	return w
}

// NewWriterLegacy creates a Writer with a mongo.Collection (backwards compatible).
func NewWriterLegacy(collection *mongo.Collection, cfg WriterConfig) *Writer {
	return NewWriter(NewMongoEvidenceStore(collection), cfg)
}

// WriteBestEffort enqueues an audit record for asynchronous persistence.
// Errors are logged but not returned. Returns immediately.
func (w *Writer) WriteBestEffort(input WriteAuditInput) {
	record := BuildRecord(input)

	w.mu.RLock()
	state := w.state
	w.mu.RUnlock()

	if state != StateOpen {
		w.logger.Warn("audit writer not open, dropping record",
			"eventId", record.EventID,
			"action", record.Action,
			"classification", "writer_"+stateString(state))
		return
	}

	p := pendingRecord{
		record: record,
		mode:   BestEffort,
	}

	// Non-blocking enqueue under read lock
	w.mu.RLock()
	if w.state != StateOpen {
		w.mu.RUnlock()
		w.logger.Warn("audit writer not open, dropping record",
			"eventId", record.EventID,
			"action", record.Action,
			"classification", "writer_closing")
		return
	}
	select {
	case w.queue <- p:
		w.mu.RUnlock()
	default:
		w.mu.RUnlock()
		w.logger.Warn("audit queue full, dropping record",
			"eventId", record.EventID,
			"action", record.Action,
			"classification", "queue_full")
	}
}

// WriteStrict enqueues an audit record and waits for persistence.
// Returns nil on success or ErrWriteFailed on failure.
// The provided context controls cancellation and timeout.
func (w *Writer) WriteStrict(ctx context.Context, input WriteAuditInput) error {
	record := BuildRecord(input)

	w.mu.RLock()
	state := w.state
	w.mu.RUnlock()

	if state != StateOpen {
		return &ErrWriteFailed{
			EventID: record.EventID,
			Err:     errors.New("audit writer " + stateString(state)),
		}
	}

	ch := make(chan error, 1)
	p := pendingRecord{
		record: record,
		mode:   Strict,
		ctx:    ctx,
		doneCh: ch,
	}

	// Non-blocking enqueue under read lock
	w.mu.RLock()
	if w.state != StateOpen {
		w.mu.RUnlock()
		return &ErrWriteFailed{
			EventID: record.EventID,
			Err:     errors.New("audit writer closing"),
		}
	}
	select {
	case w.queue <- p:
		w.mu.RUnlock()
	default:
		w.mu.RUnlock()
		return &ErrWriteFailed{
			EventID: record.EventID,
			Err:     errors.New("audit queue full"),
		}
	}

	// Wait for result or context cancellation
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close signals all workers to stop and waits for the queue to drain.
// Safe to call multiple times and concurrently.
// If ctx expires before workers finish, returns ctx.Err()
// but workers continue until they complete.
func (w *Writer) Close(ctx context.Context) error {
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.state = StateClosing
		w.mu.Unlock()
		close(w.queue) // Signal workers to drain and exit
	})

	// Wait for workers with context timeout
	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		w.mu.Lock()
		w.state = StateClosed
		w.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// CloseNow is a convenience for backwards compatibility — closes with 5s timeout.
func (w *Writer) CloseNow() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	w.Close(ctx)
}

func (w *Writer) worker(id int, writerCtx context.Context) {
	defer w.wg.Done()

	// for range queue: drains remaining items then exits when channel closes
	for p := range w.queue {
		w.processRecord(p, writerCtx)
	}
}

func (w *Writer) processRecord(p pendingRecord, writerCtx context.Context) {
	record := p.record // already sanitized, stable ID

	// Determine context for this operation
	ctx := p.ctx
	if ctx == nil {
		ctx = writerCtx
	}

	var err error
	for attempt := 0; attempt < maxRetryAttempts; attempt++ {
		err = w.storeInsert(ctx, record)
		if err == nil {
			if p.doneCh != nil {
				p.doneCh <- nil
				close(p.doneCh)
			}
			return
		}

		// Safe error classification — no raw Mongo errors logged
		classification := classifyError(err)

		// Check for context cancellation
		if classification == "cancelled" || classification == "timeout" {
			break
		}

		// Check if this is an idempotent duplicate (same _id)
		if classification == "duplicate_conflict" {
			existing, findErr := w.storeFindByID(ctx, record.ID)
			if findErr == nil && existing != nil &&
				existing.ID == record.ID && existing.EventID == record.EventID {
				// Idempotent retry — same logical record already persisted
				if p.doneCh != nil {
					p.doneCh <- nil
					close(p.doneCh)
				}
				return
			}
			// Different record with same _id — this is a real conflict
			err = fmt.Errorf("audit id conflict: _id=%s", record.ID)
			break
		}

		// Context-aware backoff for retries
		if attempt < maxRetryAttempts-1 {
			delay := retryDelay1
			if attempt == 1 {
				delay = retryDelay2
			}
			select {
			case <-time.After(delay):
				// Continue to next attempt
			case <-ctx.Done():
				err = ctx.Err()
				break
			}
		}
	}

	// All retries failed — log safe classification only
	w.logger.Error("audit record persist failed",
		"eventId", record.EventID,
		"action", record.Action,
		"attempts", maxRetryAttempts,
		"classification", classifyError(err))

	if p.mode == Strict && p.doneCh != nil {
		p.doneCh <- &ErrWriteFailed{
			EventID: record.EventID,
			Err:     err,
		}
		close(p.doneCh)
	}
	// BestEffort: silently drop (already logged with safe classification)
}

func (w *Writer) storeInsert(ctx context.Context, record AuditWriteRecord) error {
	// Add per-attempt timeout
	attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return w.store.Insert(attemptCtx, record)
}

func (w *Writer) storeFindByID(ctx context.Context, id string) (*AuditWriteRecord, error) {
	// Add per-attempt timeout
	attemptCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return w.store.FindByMongoID(attemptCtx, id)
}

// classifyError returns a safe error classification without exposing raw details.
func classifyError(err error) string {
	if err == nil {
		return "none"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	// Check for MongoDB duplicate key error by string matching
	// (mongo.IsDuplicateKeyError may not work with all error types)
	errStr := err.Error()
	if len(errStr) > 0 {
		// Check for common duplicate key error patterns
		for _, pattern := range []string{"E11000", "duplicate key", "duplicate_key"} {
			if contains(errStr, pattern) {
				return "duplicate_conflict"
			}
		}
	}
	return "mongo_write_failed"
}

// contains checks if s contains substr (case-insensitive).
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstr(s, substr))
}

func containsSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func stateString(s WriterState) string {
	switch s {
	case StateOpen:
		return "open"
	case StateClosing:
		return "closing"
	case StateClosed:
		return "closed"
	default:
		return "unknown"
	}
}

// IsWriteFailed checks if an error is an ErrWriteFailed.
func IsWriteFailed(err error) (*ErrWriteFailed, bool) {
	var wf *ErrWriteFailed
	if errors.As(err, &wf) {
		return wf, true
	}
	return nil, false
}
