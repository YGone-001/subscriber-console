package notification

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"subscriber/internal/alert"
	"subscriber/internal/auth"
)

type fakeAlerts struct {
	mu        sync.Mutex
	responses []*alert.ListAlertsResponse
	errs      []error
	calls     int
}

func (f *fakeAlerts) ListAlerts(_ context.Context, _ int64) (*alert.ListAlertsResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.calls
	f.calls++
	if i < len(f.errs) && f.errs[i] != nil {
		return nil, f.errs[i]
	}
	if i >= len(f.responses) {
		return f.responses[len(f.responses)-1], nil
	}
	return f.responses[i], nil
}

func (f *fakeAlerts) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type fakeSessions struct {
	mu    sync.Mutex
	errs  []error
	calls int
}

func (f *fakeSessions) ValidateSession(_ context.Context, _ *auth.Claims) (*auth.Principal, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.calls
	f.calls++
	if i < len(f.errs) && f.errs[i] != nil {
		return nil, f.errs[i]
	}
	return &auth.Principal{}, nil
}

func (f *fakeSessions) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

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

func testHandler(alerts AlertReader, sessions SessionRevalidator) *Handler {
	h := NewHandler(alerts, sessions)
	h.pollEvery = 10 * time.Millisecond
	h.heartbeatAt = 25 * time.Millisecond
	return h
}

func testRequest(ctx context.Context) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/notifications/stream", nil).WithContext(ctx)
	p := &auth.Principal{Username: "viewer_user", Role: "viewer", NormalizedRole: "viewer", SessionVersion: 1}
	return r.WithContext(auth.ContextWithPrincipal(r.Context(), p))
}

func waitFor(t *testing.T, w *streamWriter, contains string) {
	t.Helper()
	deadline := time.After(time.Second)
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

func TestSSEFrameEncoding(t *testing.T) {
	frame, err := eventFrame("init", map[string]string{"value": "ok"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(frame), "event: init\ndata: {\"value\":\"ok\"}\n\n"; got != want {
		t.Fatalf("frame = %q, want %q", got, want)
	}
	if got, want := string(commentFrame("ping")), ":ping\n\n"; got != want {
		t.Fatalf("comment = %q, want %q", got, want)
	}
}

func TestInitialFailureEmitsEmptyInitAndClearsDeadline(t *testing.T) {
	alerts := &fakeAlerts{responses: []*alert.ListAlertsResponse{{Alerts: []alert.AlertDocument{}}}, errs: []error{errors.New("mongo down")}}
	sessions := &fakeSessions{}
	w := newStreamWriter()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { testHandler(alerts, sessions).ServeHTTP(w, testRequest(ctx)); close(done) }()
	waitFor(t, w, "event: init")
	if !strings.Contains(w.text(), "\"activeCount\":0") || !strings.Contains(w.text(), "\"recent\":[]") {
		t.Fatalf("initial failure must emit empty init: %s", w.text())
	}
	if !w.deadline || w.status != http.StatusOK || w.header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("stream headers or deadline were not configured")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not exit after context cancellation")
	}
}

func TestUpdateHeartbeatAndSessionExpiry(t *testing.T) {
	initial := &alert.ListAlertsResponse{Alerts: []alert.AlertDocument{}, ActiveCount: 0}
	updated := &alert.ListAlertsResponse{Alerts: []alert.AlertDocument{{ID: "a"}}, ActiveCount: 1}
	alerts := &fakeAlerts{responses: []*alert.ListAlertsResponse{initial, updated, updated, updated, updated}}
	sessions := &fakeSessions{errs: []error{nil, nil, nil, errors.New("SESSION_REVOKED")}}
	w := newStreamWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { testHandler(alerts, sessions).ServeHTTP(w, testRequest(ctx)); close(done) }()
	waitFor(t, w, "event: alerts_update")
	waitFor(t, w, ":ping\n\n")
	waitFor(t, w, "event: session_expired\ndata: {}\n\n")
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not exit after session expiry")
	}
	text := w.text()
	if strings.Index(text, "event: session_expired") < strings.Index(text, "event: alerts_update") {
		t.Fatalf("session event arrived before update: %s", text)
	}
}

func TestClientCancellationStopsPolling(t *testing.T) {
	alerts := &fakeAlerts{responses: []*alert.ListAlertsResponse{{Alerts: []alert.AlertDocument{}, ActiveCount: 0}}}
	sessions := &fakeSessions{}
	w := newStreamWriter()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { testHandler(alerts, sessions).ServeHTTP(w, testRequest(ctx)); close(done) }()
	waitFor(t, w, "event: init")
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not stop")
	}
	reads, checks := alerts.callCount(), sessions.callCount()
	time.Sleep(40 * time.Millisecond)
	if alerts.callCount() != reads || sessions.callCount() != checks {
		t.Fatalf("polling continued after cancellation")
	}
}

func TestFlusherIsRequired(t *testing.T) {
	alerts := &fakeAlerts{responses: []*alert.ListAlertsResponse{{Alerts: []alert.AlertDocument{}}}}
	request := testRequest(context.Background())
	recorder := httptest.NewRecorder()
	// httptest.ResponseRecorder implements Flusher, so wrap it to remove that capability.
	plain := plainWriter{ResponseWriter: recorder}
	NewHandler(alerts, &fakeSessions{}).ServeHTTP(plain, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

type plainWriter struct{ http.ResponseWriter }
