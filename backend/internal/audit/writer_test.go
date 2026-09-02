package audit

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

// newTestWriter creates a Writer for testing without starting workers.
// The done channel is pre-closed so Close() returns immediately.
func newTestWriter(queueSize int) *Writer {
	done := make(chan struct{})
	close(done) // Pre-close so Close() doesn't hang
	return &Writer{
		queue:  make(chan pendingRecord, queueSize),
		done:   done,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestWriter_States(t *testing.T) {
	// Test state transitions without real MongoDB
	w := newTestWriter(10)

	// Initial state should be open
	if w.state.Load() != int32(StateOpen) {
		t.Errorf("expected initial state=open, got %d", w.state.Load())
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

func TestWriter_Write_Basic(t *testing.T) {
	// Create a writer with no collection (will fail to persist, but we can test enqueue)
	w := newTestWriter(2)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// BestEffort write should return nil channel
	ch := w.Write(input, BestEffort)
	if ch != nil {
		t.Error("expected nil channel for BestEffort write")
	}

	// Queue should have 1 item
	if len(w.queue) != 1 {
		t.Errorf("expected queue length 1, got %d", len(w.queue))
	}
}

func TestWriter_Write_Strict(t *testing.T) {
	w := newTestWriter(2)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// Strict write should return error channel
	ch := w.Write(input, Strict)
	if ch == nil {
		t.Error("expected non-nil channel for Strict write")
	}

	// Queue should have 1 item
	if len(w.queue) != 1 {
		t.Errorf("expected queue length 1, got %d", len(w.queue))
	}
}

func TestWriter_Write_AfterClose(t *testing.T) {
	w := newTestWriter(10)
	w.state.Store(int32(StateClosed))

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// BestEffort should silently drop
	ch := w.Write(input, BestEffort)
	if ch != nil {
		t.Error("expected nil channel for BestEffort write after close")
	}

	// Strict should return error
	ch = w.Write(input, Strict)
	if ch == nil {
		t.Error("expected non-nil channel for Strict write after close")
	}
	err := <-ch
	if err == nil {
		t.Error("expected error for Strict write after close")
	}
}

func TestWriter_Write_DuringClosing(t *testing.T) {
	w := newTestWriter(10)
	w.state.Store(int32(StateClosing))

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// BestEffort should silently drop
	ch := w.Write(input, BestEffort)
	if ch != nil {
		t.Error("expected nil channel for BestEffort write during closing")
	}

	// Strict should return error
	ch = w.Write(input, Strict)
	if ch == nil {
		t.Error("expected non-nil channel for Strict write during closing")
	}
	err := <-ch
	if err == nil {
		t.Error("expected error for Strict write during closing")
	}
}

func TestWriter_Write_FullQueue(t *testing.T) {
	w := newTestWriter(1)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// First write should succeed
	ch1 := w.Write(input, BestEffort)
	if ch1 != nil {
		t.Error("expected nil channel for first BestEffort write")
	}

	// Second write should fail (queue full)
	ch2 := w.Write(input, BestEffort)
	if ch2 != nil {
		t.Error("expected nil channel for BestEffort write when queue full")
	}

	// Strict mode should return error
	ch3 := w.Write(input, Strict)
	if ch3 == nil {
		t.Error("expected non-nil channel for Strict write when queue full")
	}
	err := <-ch3
	if err == nil {
		t.Error("expected error for Strict write when queue full")
	}
}

func TestWriter_Close_Idempotent(t *testing.T) {
	w := newTestWriter(10)
	// No repo - close should still work

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

func TestWriter_Close_BoundedByContext(t *testing.T) {
	// Create a writer with a large queue that won't drain
	w := newTestWriter(1000)

	// Fill queue
	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}
	for i := 0; i < 100; i++ {
		w.Write(input, BestEffort)
	}

	// Close with short timeout - should not hang
	shortCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := w.Close(shortCtx)
	elapsed := time.Since(start)

	// Should complete quickly (within 200ms)
	if elapsed > 200*time.Millisecond {
		t.Errorf("close took too long: %v", elapsed)
	}

	// Error might be non-nil due to context timeout, that's ok
	_ = err
}

func TestWriter_CloseNow(t *testing.T) {
	w := newTestWriter(10)

	// CloseNow should complete within 5s
	start := time.Now()
	w.CloseNow()
	elapsed := time.Since(start)

	if elapsed > 6*time.Second {
		t.Errorf("CloseNow took too long: %v", elapsed)
	}
}

func TestWriter_StateTransitions(t *testing.T) {
	w := newTestWriter(10)

	// Initial state
	if w.state.Load() != int32(StateOpen) {
		t.Error("expected initial state=open")
	}

	// After close
	w.Close(context.Background())
	if w.state.Load() != int32(StateClosed) {
		t.Error("expected state=closed after close")
	}
}

func TestWriter_WriteSync_Basic(t *testing.T) {
	w := newTestWriter(10)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// BestEffort should return nil immediately
	err := w.WriteSync(context.Background(), input, BestEffort)
	if err != nil {
		t.Errorf("expected nil error for BestEffort WriteSync, got %v", err)
	}
}

func TestWriter_WriteSync_StrictTimeout(t *testing.T) {
	w := newTestWriter(10)

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// Strict mode with timeout - should timeout since no workers
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	err := w.WriteSync(ctx, input, Strict)
	if err == nil {
		t.Error("expected error for Strict WriteSync with timeout")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("expected DeadlineExceeded, got %v", err)
	}
}

func TestWriter_WriteSync_AfterClose(t *testing.T) {
	w := newTestWriter(10)
	w.state.Store(int32(StateClosed))

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	// Strict mode after close should return error
	err := w.WriteSync(context.Background(), input, Strict)
	if err == nil {
		t.Error("expected error for Strict WriteSync after close")
	}
}

func TestWriter_ContextCancellation(t *testing.T) {
	w := newTestWriter(10)

	// Enqueue with cancelled context
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	input := WriteAuditInput{
		Module:   "test",
		Action:   "test.action",
		Resource: &ResourceInput{Type: "api"},
		Result:   "success",
	}

	err := w.WriteSync(ctx, input, Strict)
	if err == nil {
		t.Error("expected error with cancelled context")
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
