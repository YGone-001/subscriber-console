package runtimeinv

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"subscriber/internal/auth"
)

// ---------------------------------------------------------------- fakes

type fakeStreamSessions struct {
	mu    sync.Mutex
	errs  []error
	calls int
}

func (f *fakeStreamSessions) ValidateSession(_ context.Context, _ *auth.Claims) (*auth.Principal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.calls
	f.calls++
	if i < len(f.errs) && f.errs[i] != nil {
		return nil, f.errs[i]
	}
	return &auth.Principal{}, nil
}

func (f *fakeStreamSessions) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// streamWriter is a flush-aware ResponseWriter for SSE tests.
type streamWriter struct {
	mu       sync.Mutex
	header   http.Header
	status   int
	body     strings.Builder
	flushed  int
	deadline bool
	notify   chan struct{}
}

func newStreamWriter() *streamWriter {
	return &streamWriter{header: make(http.Header), notify: make(chan struct{}, 32)}
}

func (w *streamWriter) Header() http.Header { return w.header }

func (w *streamWriter) WriteHeader(status int) {
	w.mu.Lock()
	w.status = status
	w.mu.Unlock()
}

func (w *streamWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	n, err := w.body.Write(p)
	w.mu.Unlock()
	return n, err
}

func (w *streamWriter) Flush() {
	w.mu.Lock()
	w.flushed++
	w.mu.Unlock()
	select {
	case w.notify <- struct{}{}:
	default:
	}
}

func (w *streamWriter) SetWriteDeadline(time.Time) error {
	w.mu.Lock()
	w.deadline = true
	w.mu.Unlock()
	return nil
}

func (w *streamWriter) text() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.body.String()
}

// failingInventory simulates an inventory gateway outage.
type failingInventory struct{}

func (f *failingInventory) FindDiscovered(ctx context.Context, system string, externalIDs []string) (map[string]ResourceRef, error) {
	return nil, errors.New("inventory unavailable")
}

func (f *failingInventory) FindCompatible(ctx context.Context, domain, role string) ([]ResourceRef, error) {
	return nil, errors.New("inventory unavailable")
}

func (f *failingInventory) CreateDiscovered(ctx context.Context, spec DiscoveredSpec, actor string) (ResourceRef, bool, error) {
	return ResourceRef{}, false, errors.New("inventory unavailable")
}

// newStreamService builds a scanned service over a deterministic procfs fixture.
func newStreamService(t *testing.T, pid int, comm, exe string) *Service {
	t.Helper()
	f := newFixture(t)
	f.process(pid, comm, exe, 1000, 500, 102400, 204800, nil)
	clock := &fakeClock{now: time.Unix(1700000000, 0)}
	service := NewService(newTestScanner(f, clock), NewMemoryStateStore(), ServiceOptions{
		Enabled:  true,
		Interval: time.Hour,
		Clock:    clock.Now,
	})
	if _, err := service.scan(context.Background(), TriggerStartup); err != nil {
		t.Fatalf("startup scan: %v", err)
	}
	return service
}

// streamHarness wires a StreamHandler with a fast broadcast cadence.
type streamHarness struct {
	handler *StreamHandler
}

func newStreamHarness(t *testing.T) *streamHarness {
	t.Helper()
	h := NewStreamHandler(newStreamService(t, 101, "amfd", "/opt/open5gs/bin/amf"), &fakeStreamSessions{}, newFakeInventory(), newFakeTargets())
	h.sampleEvery = 10 * time.Millisecond
	h.heartbeatAt = 25 * time.Millisecond
	return &streamHarness{handler: h}
}

func streamRequest(ctx context.Context, role string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/runtime/stream", nil).WithContext(ctx)
	p := &auth.Principal{Username: "user_" + role, Role: role, NormalizedRole: role, SessionVersion: 1}
	return r.WithContext(auth.ContextWithPrincipal(r.Context(), p))
}

func waitForStream(t *testing.T, w *streamWriter, contains string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if strings.Contains(w.text(), contains) {
			return
		}
		select {
		case <-w.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %q in %q", contains, w.text())
		}
	}
}

// ---------------------------------------------------------------- tests

func TestStreamRequiresAuth(t *testing.T) {
	h := newStreamHarness(t)
	recorder := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/runtime/stream", nil)
	h.handler.ServeHTTP(recorder, r)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestStreamRequiresReadPermission(t *testing.T) {
	h := newStreamHarness(t)
	recorder := httptest.NewRecorder()
	// An unknown role resolves to no permissions, so the read gate rejects it.
	r := streamRequest(context.Background(), "no-such-role")
	h.handler.ServeHTTP(recorder, r)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
}

func TestStreamFlusherIsRequired(t *testing.T) {
	h := newStreamHarness(t)
	recorder := httptest.NewRecorder()
	// httptest.ResponseRecorder implements Flusher, so wrap it to remove that capability.
	plain := plainStreamWriter{ResponseWriter: recorder}
	h.handler.ServeHTTP(plain, streamRequest(context.Background(), "viewer"))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

type plainStreamWriter struct{ http.ResponseWriter }

func TestStreamServesSnapshotFramesAndHeartbeat(t *testing.T) {
	h := newStreamHarness(t)
	w := newStreamWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.handler.Start(ctx)
	done := make(chan struct{})
	go func() { h.handler.ServeHTTP(w, streamRequest(ctx, "viewer")); close(done) }()
	waitForStream(t, w, ":waiting")
	waitForStream(t, w, "event: snapshot")
	if !strings.Contains(w.text(), "\"hostId\":\"host-test\"") {
		t.Fatalf("snapshot frame missing host identity: %s", w.text())
	}
	if !strings.Contains(w.text(), "\"associationsComplete\":true") {
		t.Fatalf("association projection must be complete: %s", w.text())
	}
	if !strings.Contains(w.text(), "\"state\":\"absent\"") {
		t.Fatalf("unassociated components must stay absent: %s", w.text())
	}
	waitForStream(t, w, ":ping")
	if !w.deadline || w.status != http.StatusOK || w.header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("stream headers or deadline were not configured")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not exit after context cancellation")
	}
}

func TestStreamBroadcastIsSharedAcrossSubscribers(t *testing.T) {
	h := newStreamHarness(t)
	first, second := newStreamWriter(), newStreamWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.handler.Start(ctx)
	doneFirst, doneSecond := make(chan struct{}), make(chan struct{})
	go func() { h.handler.ServeHTTP(first, streamRequest(ctx, "viewer")); close(doneFirst) }()
	go func() { h.handler.ServeHTTP(second, streamRequest(ctx, "viewer")); close(doneSecond) }()

	// Both subscribers must receive the same shared broadcast frames; one
	// sample loop fans out to every connection.
	waitForStream(t, first, "event: snapshot")
	waitForStream(t, second, "event: snapshot")

	frame := h.handler.sample()
	if frame == nil || frame.Snapshot == nil {
		t.Fatal("sample must produce a frame")
	}

	cancel()
	select {
	case <-doneFirst:
	case <-time.After(2 * time.Second):
		t.Fatal("first subscriber did not exit")
	}
	select {
	case <-doneSecond:
	case <-time.After(2 * time.Second):
		t.Fatal("second subscriber did not exit")
	}
}

func TestStreamSessionExpiryStopsStream(t *testing.T) {
	h := newStreamHarness(t)
	h.handler.sessions = &fakeStreamSessions{errs: []error{nil, nil, nil, errors.New("SESSION_REVOKED")}}
	w := newStreamWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.handler.Start(ctx)
	done := make(chan struct{})
	go func() { h.handler.ServeHTTP(w, streamRequest(ctx, "viewer")); close(done) }()
	waitForStream(t, w, "event: session_expired\ndata: {}\n\n")
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not exit after session expiry")
	}
}

func TestStreamSampleMarksAssociationsUnresolvedOnGatewayError(t *testing.T) {
	service := newStreamService(t, 102, "smfd", "/opt/open5gs/bin/smf")
	h := NewStreamHandler(service, &fakeStreamSessions{}, &failingInventory{}, newFakeTargets())
	frame := h.sample()
	if frame == nil {
		t.Fatal("sample must produce a frame")
	}
	if frame.AssociationsComplete {
		t.Fatal("association lookup failure must mark the frame incomplete")
	}
	for _, observation := range frame.Snapshot.Components {
		if observation.InventoryAssociation.State != AssociationUnresolved {
			t.Fatalf("observation %s must be unresolved, got %q", observation.ComponentID, observation.InventoryAssociation.State)
		}
	}
}

func TestStreamSampleAttachesAssociations(t *testing.T) {
	service := newStreamService(t, 103, "amfd", "/opt/open5gs/bin/amf")
	inventory := newFakeInventory()
	inventory.discovered[RuntimeKey("host-test", "amf", "amfd")] = ResourceRef{ResourceID: "res-amf", Kind: "network_function"}
	targets := newFakeTargets()
	targets.byResource["res-amf"] = "tgt-amf"
	h := NewStreamHandler(service, &fakeStreamSessions{}, inventory, targets)
	frame := h.sample()
	if frame == nil {
		t.Fatal("sample must produce a frame")
	}
	if !frame.AssociationsComplete {
		t.Fatal("successful lookups must keep the frame complete")
	}
	found := false
	for _, observation := range frame.Snapshot.Components {
		if observation.ComponentID != "amf" {
			continue
		}
		found = true
		if observation.InventoryAssociation.State != AssociationAssociated || observation.InventoryAssociation.ID != "res-amf" {
			t.Fatalf("inventory association = %+v, want res-amf", observation.InventoryAssociation)
		}
		if observation.NFHealthAssociation.State != AssociationAssociated || observation.NFHealthAssociation.ID != "tgt-amf" {
			t.Fatalf("nf health association = %+v, want tgt-amf", observation.NFHealthAssociation)
		}
	}
	if !found {
		t.Fatal("amf observation missing from snapshot")
	}
}

func TestStreamSampleServesPlaceholderBeforeFirstScan(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Unix(1700000000, 0)}
	service := NewService(newTestScanner(f, clock), NewMemoryStateStore(), ServiceOptions{
		Enabled:  true,
		Interval: time.Hour,
		Clock:    clock.Now,
	})
	h := NewStreamHandler(service, &fakeStreamSessions{}, newFakeInventory(), newFakeTargets())
	frame := h.sample()
	if frame == nil {
		t.Fatal("the placeholder snapshot must be served before the first scan")
	}
	if frame.Snapshot.Scan.Status != "not_scanned" {
		t.Fatalf("scan status = %q, want not_scanned", frame.Snapshot.Scan.Status)
	}
	for _, observation := range frame.Snapshot.Components {
		if observation.RuntimeStatus != StatusUnknown {
			t.Fatalf("placeholder observation %s must be unknown, got %q", observation.ComponentID, observation.RuntimeStatus)
		}
	}
}

func TestStreamStartIsIdempotentAndStopsWithContext(t *testing.T) {
	h := newStreamHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	h.handler.Start(ctx)
	h.handler.Start(ctx)
	cancel()
	select {
	case <-h.handler.quit:
	case <-time.After(2 * time.Second):
		t.Fatal("broadcast loop did not stop after context cancellation")
	}
}

func TestStreamHeartbeatRevalidatesSession(t *testing.T) {
	h := newStreamHarness(t)
	w := newStreamWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.handler.Start(ctx)
	done := make(chan struct{})
	go func() { h.handler.ServeHTTP(w, streamRequest(ctx, "viewer")); close(done) }()
	waitForStream(t, w, ":ping")
	if h.handler.sessions.(*fakeStreamSessions).callCount() == 0 {
		t.Fatal("heartbeat must revalidate the session")
	}
	cancel()
	<-done
}
