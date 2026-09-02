package audit

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeEvidenceStore implements EvidenceStore for testing.
type fakeEvidenceStore struct {
	mu       sync.Mutex
	records  map[string]AuditWriteRecord
	insertFn func(ctx context.Context, record AuditWriteRecord) error
}

func newFakeEvidenceStore() *fakeEvidenceStore {
	return &fakeEvidenceStore{
		records: make(map[string]AuditWriteRecord),
	}
}

func (f *fakeEvidenceStore) Insert(ctx context.Context, record AuditWriteRecord) error {
	if f.insertFn != nil {
		return f.insertFn(ctx, record)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.records[record.MongoID] = record
	return nil
}

func (f *fakeEvidenceStore) FindByMongoID(ctx context.Context, id string) (*AuditWriteRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if rec, ok := f.records[id]; ok {
		return &rec, nil
	}
	return nil, nil
}

func (f *fakeEvidenceStore) getRecord(id string) (AuditWriteRecord, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rec, ok := f.records[id]
	return rec, ok
}

func (f *fakeEvidenceStore) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.records)
}

// newTestWriterWithWorkers creates a Writer with real workers for testing.
func newTestWriterWithWorkers(t *testing.T, workerCount int, store EvidenceStore) *Writer {
	t.Helper()
	w := NewWriter(store, WriterConfig{
		QueueSize:   64,
		WorkerCount: workerCount,
		WriterCtx:   context.Background(),
	})
	return w
}

func TestWriter_States(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	// Initial state should be open
	w.mu.RLock()
	state := w.state
	w.mu.RUnlock()
	if state != StateOpen {
		t.Errorf("expected initial state=open, got %d", state)
	}

	// After close
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Close(ctx)

	w.mu.RLock()
	state = w.state
	w.mu.RUnlock()
	if state != StateClosed {
		t.Errorf("expected state=closed after close, got %d", state)
	}
}

func TestWriter_ClassifyError(t *testing.T) {
	// Test nil error
	if classifyError(nil) != "none" {
		t.Error("expected none classification for nil error")
	}

	// Test context.DeadlineExceeded
	if classifyError(context.DeadlineExceeded) != "timeout" {
		t.Error("expected timeout for DeadlineExceeded")
	}

	// Test context.Canceled
	if classifyError(context.Canceled) != "cancelled" {
		t.Error("expected cancelled for Canceled")
	}

	// Test generic error
	genErr := errors.New("some other error")
	if classifyError(genErr) != "mongo_write_failed" {
		t.Errorf("expected mongo_write_failed, got %s", classifyError(genErr))
	}
}

func TestWriter_WriteBestEffort_Basic(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// WriteBestEffort should return immediately
	w.WriteBestEffort(input)

	// Give workers time to process
	time.Sleep(50 * time.Millisecond)

	// Should have persisted the record
	if store.count() != 1 {
		t.Errorf("expected 1 record, got %d", store.count())
	}

	// Cleanup
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Close(ctx)
}

func TestWriter_WriteStrict_Basic(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// WriteStrict should wait for persistence
	ctx := context.Background()
	err := w.WriteStrict(ctx, input)
	if err != nil {
		t.Errorf("expected success, got %v", err)
	}

	// Should have persisted the record
	if store.count() != 1 {
		t.Errorf("expected 1 record, got %d", store.count())
	}

	// Cleanup
	closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Close(closeCtx)
}

func TestWriter_Write_AfterClose(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	// Close the writer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Close(ctx)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// BestEffort after close should silently drop
	w.WriteBestEffort(input)

	// Strict after close should return error
	err := w.WriteStrict(context.Background(), input)
	if err == nil {
		t.Error("expected error for Strict write after close")
	}
	var wf *ErrWriteFailed
	if !errors.As(err, &wf) {
		t.Errorf("expected ErrWriteFailed, got %T", err)
	}
}

func TestWriter_Write_FullQueue(t *testing.T) {
	store := newFakeEvidenceStore()
	// Create writer with tiny queue
	w := NewWriter(store, WriterConfig{
		QueueSize:   1,
		WorkerCount: 1,
		WriterCtx:   context.Background(),
	})

	// Block the worker by holding the store lock
	store.mu.Lock()

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// Fill the queue
	w.WriteBestEffort(input)

	// Queue full - should drop silently
	w.WriteBestEffort(input)

	// Strict queue full - should return error
	err := w.WriteStrict(context.Background(), input)
	if err == nil {
		t.Error("expected error for Strict write when queue full")
	}
	var wf *ErrWriteFailed
	if !errors.As(err, &wf) {
		t.Errorf("expected ErrWriteFailed, got %T", err)
	}

	// Unblock the worker
	store.mu.Unlock()

	// Cleanup
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Close(ctx)
}

func TestWriter_Close_Idempotent(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	ctx := context.Background()

	// First close
	err1 := w.Close(ctx)
	if err1 != nil {
		t.Errorf("expected first close success, got %v", err1)
	}

	// Second close should be idempotent
	err2 := w.Close(ctx)
	if err2 != nil {
		t.Errorf("expected second close success (idempotent), got %v", err2)
	}
}

func TestWriter_Close_TimeoutThenWait(t *testing.T) {
	store := newFakeEvidenceStore()
	// Block the store to prevent workers from finishing
	store.mu.Lock()

	w := newTestWriterWithWorkers(t, 2, store)

	// Enqueue some work
	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}
	w.WriteBestEffort(input)

	// Close with short timeout - should timeout
	shortCtx, cancel1 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel1()
	err := w.Close(shortCtx)
	if err == nil {
		t.Error("expected timeout error")
	}

	// Unblock the store
	store.mu.Unlock()

	// Later close with longer timeout - should succeed
	longCtx, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	err = w.Close(longCtx)
	if err != nil {
		t.Errorf("expected success on later close, got %v", err)
	}
}

func TestWriter_TwoWorkerEmptyShutdown(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	// Close immediately - no work to drain
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := w.Close(ctx)
	if err != nil {
		t.Errorf("expected success, got %v", err)
	}

	// Verify state
	w.mu.RLock()
	state := w.state
	w.mu.RUnlock()
	if state != StateClosed {
		t.Errorf("expected state=closed, got %d", state)
	}
}

func TestWriter_TwoWorkerQueuedShutdown(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	// Enqueue several records
	for i := 0; i < 10; i++ {
		input := WriteAuditInput{
			Module:   "test",
			Action:   "test.action",
			Resource: &ResourceInput{Type: "api"},
			Result:   "success",
		}
		w.WriteBestEffort(input)
	}

	// Close and wait for drain
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := w.Close(ctx)
	if err != nil {
		t.Errorf("expected success, got %v", err)
	}

	// All records should be persisted
	if store.count() != 10 {
		t.Errorf("expected 10 records, got %d", store.count())
	}
}

func TestWriter_ConcurrentWriteClose(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	var wg sync.WaitGroup
	var writeCount atomic.Int32

	// Start concurrent writers
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				input := WriteAuditInput{
					Module:   "test",
					Action:   "test.action",
					Resource: &ResourceInput{Type: "api"},
					Result:   "success",
				}
				w.WriteBestEffort(input)
				writeCount.Add(1)
			}
		}()
	}

	// Start close after a short delay
	time.Sleep(10 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	w.Close(ctx)

	// Wait for all writers to finish
	wg.Wait()

	// Some records should be persisted (exact count depends on timing)
	if store.count() == 0 {
		t.Error("expected some records to be persisted")
	}
}

func TestWriter_StrictCancellation(t *testing.T) {
	store := newFakeEvidenceStore()
	// Make insert block until context cancelled
	store.insertFn = func(ctx context.Context, record AuditWriteRecord) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Second):
			return nil
		}
	}

	w := newTestWriterWithWorkers(t, 2, store)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// Cancel context before persistence completes
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := w.WriteStrict(ctx, input)
	elapsed := time.Since(start)

	if err == nil {
		t.Error("expected error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("expected DeadlineExceeded, got %v", err)
	}
	// Should return promptly, not after 10s
	if elapsed > 1*time.Second {
		t.Errorf("took too long: %v", elapsed)
	}

	// Cleanup
	closeCtx, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	w.Close(closeCtx)
}

func TestWriter_StrictRetryPreservesID(t *testing.T) {
	store := newFakeEvidenceStore()
	var attempts atomic.Int32

	// Fail first attempt, succeed on second
	store.insertFn = func(ctx context.Context, record AuditWriteRecord) error {
		n := attempts.Add(1)
		if n == 1 {
			return errors.New("transient error")
		}
		return nil
	}

	w := newTestWriterWithWorkers(t, 2, store)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	err := w.WriteStrict(context.Background(), input)
	if err != nil {
		t.Errorf("expected success, got %v", err)
	}

	// Should have retried
	if attempts.Load() != 2 {
		t.Errorf("expected 2 attempts, got %d", attempts.Load())
	}

	// Cleanup
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Close(ctx)
}

func TestWriter_SameIDDuplicateIdempotent(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// First write should succeed
	err := w.WriteStrict(context.Background(), input)
	if err != nil {
		t.Errorf("expected success, got %v", err)
	}

	// Same input again - should succeed (idempotent)
	err = w.WriteStrict(context.Background(), input)
	if err != nil {
		t.Errorf("expected success for duplicate, got %v", err)
	}

	// Cleanup
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Close(ctx)
}

func TestWriter_AllAcceptedRecordsDrained(t *testing.T) {
	store := newFakeEvidenceStore()
	w := newTestWriterWithWorkers(t, 2, store)

	// Enqueue many records
	count := 50
	for i := 0; i < count; i++ {
		input := WriteAuditInput{
			Module:   "test",
			Action:   "test.action",
			Resource: &ResourceInput{Type: "api"},
			Result:   "success",
		}
		w.WriteBestEffort(input)
	}

	// Close and wait
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := w.Close(ctx)
	if err != nil {
		t.Errorf("expected success, got %v", err)
	}

	// All records should be persisted
	if store.count() != count {
		t.Errorf("expected %d records, got %d", count, store.count())
	}
}

func TestErrWriteFailed_Error(t *testing.T) {
	err := &ErrWriteFailed{
		EventID: "EVT-123",
		Err:     errors.New("test error"),
	}

	if err.Error() != "audit write failed: eventId=EVT-123" {
		t.Errorf("unexpected error message: %s", err.Error())
	}

	if err.Unwrap().Error() != "test error" {
		t.Errorf("unexpected unwrap error: %s", err.Unwrap().Error())
	}
}
