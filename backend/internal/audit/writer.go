package audit

import (
	"context"
	"errors"
	"log/slog"
	"sync"
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

// ErrWriteFailed is returned by Strict mode when a record cannot be persisted
// after all retries. Contains the eventId for correlation.
type ErrWriteFailed struct {
	EventID string
	Err     error
}

func (e *ErrWriteFailed) Error() string {
	return "audit write failed: " + e.Err.Error() + " (eventId=" + e.EventID + ")"
}

func (e *ErrWriteFailed) Unwrap() error { return e.Err }

// pendingRecord wraps an input with its write mode and result channel.
type pendingRecord struct {
	input  WriteAuditInput
	mode   WriteMode
	doneCh chan<- error // nil for BestEffort (fire-and-forget)
}

// Writer is a bounded, asynchronous audit record writer.
// It enqueues records into a fixed-size channel and processes them
// with a small pool of workers. Supports BestEffort (silent drop)
// and Strict (typed error on failure) write modes.
type Writer struct {
	collection *mongo.Collection
	queue      chan pendingRecord
	logger     *slog.Logger

	wg     sync.WaitGroup
	cancel context.CancelFunc
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

	ctx, cancel := context.WithCancel(context.Background())
	w := &Writer{
		collection: collection,
		queue:      make(chan pendingRecord, cfg.QueueSize),
		logger:     cfg.Logger,
		cancel:     cancel,
	}

	for i := 0; i < cfg.WorkerCount; i++ {
		w.wg.Add(1)
		go w.worker(ctx, i)
	}
	return w
}

// Write enqueues an audit record for persistence.
// Returns immediately. For BestEffort mode, errors are logged but not returned.
// For Strict mode, the returned error channel receives nil on success or
// ErrWriteFailed on failure (after retries).
func (w *Writer) Write(input WriteAuditInput, mode WriteMode) <-chan error {
	var ch chan error
	if mode == Strict {
		ch = make(chan error, 1)
	}

	p := pendingRecord{
		input:  input,
		mode:   mode,
		doneCh: ch,
	}

	// Non-blocking enqueue: if queue is full, drop the record
	select {
	case w.queue <- p:
	default:
		w.logger.Warn("audit queue full, dropping record",
			"action", input.Action,
			"module", input.Module,
			"mode", mode)
		if ch != nil {
			ch <- &ErrWriteFailed{
				EventID: "(dropped)",
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
// Pending records are processed before shutdown.
func (w *Writer) Close() {
	w.cancel()
	// Don't close the channel — workers read from it until context is done.
	// Wait for workers to finish processing remaining items.
	w.wg.Wait()
}

func (w *Writer) worker(ctx context.Context, id int) {
	defer w.wg.Done()
	for {
		select {
		case <-ctx.Done():
			// Drain remaining items in queue
			for {
				select {
				case p := <-w.queue:
					w.processRecord(p)
				default:
					return
				}
			}
		case p := <-w.queue:
			w.processRecord(p)
		}
	}
}

func (w *Writer) processRecord(p pendingRecord) {
	record := BuildRecord(p.input)

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
		// Retry with backoff
		if attempt == 0 {
			time.Sleep(retryDelay1)
		} else if attempt == 1 {
			time.Sleep(retryDelay2)
		}
	}

	// All retries failed
	w.logger.Error("audit record insert failed after retries",
		"eventId", record.EventID,
		"action", record.Action,
		"attempts", maxRetryAttempts,
		"error", err)

	if p.mode == Strict && p.doneCh != nil {
		p.doneCh <- &ErrWriteFailed{
			EventID: record.EventID,
			Err:     err,
		}
		close(p.doneCh)
	}
	// BestEffort: silently drop (already logged)
}

func (w *Writer) insertRecord(record AuditWriteRecord) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// _id = record.ID makes this idempotent — duplicate inserts are safe
	_, err := w.collection.InsertOne(ctx, record,
		options.InsertOne().SetBypassDocumentValidation(true))
	if err != nil {
		// Check for duplicate key (idempotent retry safety)
		if mongo.IsDuplicateKeyError(err) {
			return nil // Already inserted
		}
		return err
	}
	return nil
}

// IsWriteFailed checks if an error is an ErrWriteFailed.
func IsWriteFailed(err error) (*ErrWriteFailed, bool) {
	var wf *ErrWriteFailed
	if errors.As(err, &wf) {
		return wf, true
	}
	return nil, false
}

// EnsureIndexes creates the indexes needed for the audit writer collection.
// Should be called once at startup.
func EnsureAuditIndexes(ctx context.Context, collection *mongo.Collection) error {
	indexes := []mongo.IndexModel{
		{Keys: bson.D{{Key: "timestamp", Value: -1}}},
		{Keys: bson.D{{Key: "action", Value: 1}}},
		{Keys: bson.D{{Key: "module", Value: 1}}},
		{Keys: bson.D{{Key: "result", Value: 1}}},
		{Keys: bson.D{{Key: "actor", Value: 1}}},
		{Keys: bson.D{{Key: "targetId", Value: 1}}},
		{Keys: bson.D{{Key: "request.requestId", Value: 1}}},
		{Keys: bson.D{{Key: "correlationId", Value: 1}}},
	}
	_, err := collection.Indexes().CreateMany(ctx, indexes)
	return err
}
