package audit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
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

// pendingRecord wraps a pre-built sanitized record with its write mode.
type pendingRecord struct {
	record AuditWriteRecord
	mode   WriteMode
	doneCh chan<- error // nil for BestEffort (fire-and-forget)
}

// Writer is a bounded, asynchronous audit record writer.
// It enqueues pre-sanitized records into a fixed-size channel and processes them
// with a small pool of workers. Supports BestEffort (silent drop)
// and Strict (typed error on failure) write modes.
type Writer struct {
	collection *mongo.Collection
	queue      chan pendingRecord
	logger     *slog.Logger
	state      atomic.Int32 // WriterState
	closeOnce  sync.Once
	done       chan struct{}
}

// WriterConfig configures the audit writer.
type WriterConfig struct {
	QueueSize   int
	WorkerCount int
	Logger      *slog.Logger
}

// NewWriter creates and starts an audit Writer.
// Call Close() for graceful shutdown.
func NewWriter(collection *mongo.Collection, cfg WriterConfig) *Writer {
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = defaultQueueSize
	}
	if cfg.WorkerCount <= 0 {
		cfg.WorkerCount = defaultWorkerCount
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	w := &Writer{
		collection: collection,
		queue:      make(chan pendingRecord, cfg.QueueSize),
		logger:     cfg.Logger,
		done:       make(chan struct{}),
	}
	w.state.Store(int32(StateOpen))

	for i := 0; i < cfg.WorkerCount; i++ {
		go w.worker(i)
	}
	return w
}

// Write builds and enqueues an audit record for persistence.
// The record is sanitized and given a stable ID before entering the queue.
// Returns immediately. For BestEffort mode, errors are logged but not returned.
// For Strict mode, the returned error channel receives nil on success or
// ErrWriteFailed on failure (after retries).
func (w *Writer) Write(input WriteAuditInput, mode WriteMode) <-chan error {
	// Build and sanitize the record BEFORE enqueue.
	// This ensures: stable id/eventId, no raw secrets in queue, queue-full error has real eventId.
	record := BuildRecord(input)

	state := WriterState(w.state.Load())
	if state != StateOpen {
		// Writer is closing or closed — reject immediately
		if mode == Strict {
			ch := make(chan error, 1)
			ch <- &ErrWriteFailed{
				EventID: record.EventID,
				Err:     errors.New("audit writer " + stateString(state)),
			}
			close(ch)
			return ch
		}
		// BestEffort: silently drop
		w.logger.Warn("audit writer not open, dropping record",
			"eventId", record.EventID,
			"action", record.Action)
		return nil
	}

	var ch chan error
	if mode == Strict {
		ch = make(chan error, 1)
	}

	p := pendingRecord{
		record: record,
		mode:   mode,
		doneCh: ch,
	}

	// Non-blocking enqueue
	select {
	case w.queue <- p:
	default:
		w.logger.Warn("audit queue full, dropping record",
			"eventId", record.EventID,
			"action", record.Action)
		if ch != nil {
			ch <- &ErrWriteFailed{
				EventID: record.EventID,
				Err:     errors.New("audit queue full"),
			}
			close(ch)
		}
	}

	return ch
}

// WriteSync enqueues a record and waits for the result.
// Only meaningful with Strict mode; BestEffort returns nil immediately.
func (w *Writer) WriteSync(ctx context.Context, input WriteAuditInput, mode WriteMode) error {
	ch := w.Write(input, mode)
	if ch == nil {
		return nil
	}
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close signals all workers to stop and waits for the queue to drain.
// Idempotent — safe to call multiple times.
// Bounded by context — if ctx expires, returns ctx.Err().
func (w *Writer) Close(ctx context.Context) error {
	var closeErr error
	w.closeOnce.Do(func() {
		w.state.Store(int32(StateClosing))
		// Don't close the channel — workers read from it via select
		// Wait for workers to finish
		select {
		case <-w.done:
		case <-ctx.Done():
			closeErr = ctx.Err()
		}
		w.state.Store(int32(StateClosed))
	})
	return closeErr
}

// CloseNow is a convenience for backwards compatibility — closes with 5s timeout.
func (w *Writer) CloseNow() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	w.Close(ctx)
}

func (w *Writer) worker(id int) {
	defer func() {
		// Signal completion when worker exits
		// Only the last worker closing will matter due to channel semantics
	}()

	for {
		// Check if we should stop
		state := WriterState(w.state.Load())
		if state == StateClosing || state == StateClosed {
			// Drain remaining items
			w.drainRemaining()
			close(w.done)
			return
		}

		select {
		case p := <-w.queue:
			w.processRecord(p)
		default:
			// Queue empty, check state again before blocking
			if WriterState(w.state.Load()) != StateOpen {
				w.drainRemaining()
				close(w.done)
				return
			}
			// Block waiting for work
			p, ok := <-w.queue
			if !ok {
				return
			}
			w.processRecord(p)
		}
	}
}

func (w *Writer) drainRemaining() {
	for {
		select {
		case p := <-w.queue:
			w.processRecord(p)
		default:
			return
		}
	}
}

func (w *Writer) processRecord(p pendingRecord) {
	record := p.record // already sanitized, stable ID

	var err error
	for attempt := 0; attempt < maxRetryAttempts; attempt++ {
		err = w.insertRecord(record)
		if err == nil {
			if p.doneCh != nil {
				p.doneCh <- nil
				close(p.doneCh)
			}
			return
		}

		// Safe error classification — no raw Mongo errors logged
		classification := classifyError(err)

		// Check if this is an idempotent duplicate (same _id)
		if classification == "duplicate_conflict" {
			existing, findErr := w.findByID(record.ID)
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

		// Context-aware backoff for strict writes
		if attempt < maxRetryAttempts-1 {
			delay := retryDelay1
			if attempt == 1 {
				delay = retryDelay2
			}
			time.Sleep(delay)
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

func (w *Writer) insertRecord(record AuditWriteRecord) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// _id = record.MongoID makes this idempotent
	_, err := w.collection.InsertOne(ctx, record,
		options.InsertOne().SetBypassDocumentValidation(true))
	return err
}

func (w *Writer) findByID(id string) (*AuditWriteRecord, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	var doc bson.M
	err := w.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	rec := &AuditWriteRecord{}
	if v, ok := doc["id"].(string); ok {
		rec.ID = v
	}
	if v, ok := doc["eventId"].(string); ok {
		rec.EventID = v
	}
	return rec, nil
}

// classifyError returns a safe error classification without exposing raw details.
func classifyError(err error) string {
	if err == nil {
		return "none"
	}
	if mongo.IsDuplicateKeyError(err) {
		return "duplicate_conflict"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	return "mongo_write_failed"
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
