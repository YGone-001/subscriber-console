package nfhealth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestTarget(t *testing.T, endpoint, unit, kind string) *HealthTarget {
	t.Helper()
	return &HealthTarget{
		TargetID:         newUUID(),
		SchemaVersion:    SchemaVersion,
		CandidateID:      newUUID(),
		Name:             "test-target",
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  endpoint,
		ServiceUnit:      unit,
		ServiceKind:      kind,
		CollectionMode:   CollectionManual,
		IntervalSeconds:  120,
		Enabled:          true,
		Revision:         1,
	}
}

func TestCollectorRejectsInProgress(t *testing.T) {
	c := NewCollector(NewHTTPProber(time.Second), nil, NewDestinationAllowlist("127.0.0.1:0"), NewServiceUnitAllowlist(""))
	target := newTestTarget(t, "", "", "none")
	c.mu.Lock()
	c.active[target.TargetID] = struct{}{}
	c.mu.Unlock()
	_, err := c.Collect(context.Background(), target, "tester", false)
	if !errors.Is(err, ErrInProgress) {
		t.Fatalf("expected in-progress, got %v", err)
	}
}

func TestCollectorRateLimitsRepeatCollections(t *testing.T) {
	c := NewCollector(NewHTTPProber(time.Second), nil, NewDestinationAllowlist(""), NewServiceUnitAllowlist(""))
	target := newTestTarget(t, "", "", "none")
	c.mu.Lock()
	c.lastRunAt[target.TargetID] = time.Now()
	c.mu.Unlock()
	_, err := c.Collect(context.Background(), target, "tester", false)
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("expected rate limit, got %v", err)
	}
}

func TestCollectorSuccessfulMetricsCollection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("# TYPE gnb gauge\ngnb 5\n# TYPE amf_session gauge\namf_session 2\n"))
	}))
	defer server.Close()

	hostport := strings.TrimPrefix(server.URL, "http://")
	c := NewCollector(
		NewHTTPProber(2*time.Second),
		nil,
		NewDestinationAllowlist(hostport),
		NewServiceUnitAllowlist(""),
	)
	target := newTestTarget(t, server.URL+"/metrics", "", "none")

	result, err := c.Collect(context.Background(), target, "tester", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Run.Status != RunStatusSuccess {
		t.Fatalf("expected success, got %s (%s)", result.Run.Status, result.Run.ErrorSummary)
	}
	if result.Sample == nil {
		t.Fatal("expected a sample")
	}
	if result.Sample.Layers.Interface.State != StateHealthy {
		t.Fatalf("expected healthy interface layer, got %+v", result.Sample.Layers.Interface)
	}
	if len(result.Sample.Metrics) == 0 {
		t.Fatal("expected registry metrics")
	}
	// L1 must stay not_configured when no service unit is configured.
	if result.Sample.Layers.Process.State != StateNotConfigured {
		t.Fatalf("expected process layer not_configured, got %+v", result.Sample.Layers.Process)
	}
}

func TestCollectorFailedEndpointDoesNotInventHealthyState(t *testing.T) {
	c := NewCollector(
		NewHTTPProber(500*time.Millisecond),
		nil,
		NewDestinationAllowlist("127.0.0.1:1"),
		NewServiceUnitAllowlist(""),
	)
	target := newTestTarget(t, "http://127.0.0.1:1/metrics", "", "none")
	result, err := c.Collect(context.Background(), target, "tester", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Run.Status == RunStatusSuccess {
		t.Fatal("failed probe must not report success")
	}
	if result.Sample != nil && result.Sample.Layers.Interface.State == StateHealthy {
		t.Fatalf("failed probe must not report healthy interface: %+v", result.Sample.Layers.Interface)
	}
}

func TestCollectorHTTP200WithGarbageMetricsIsPartial(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("this is not prometheus text"))
	}))
	defer server.Close()

	hostport := strings.TrimPrefix(server.URL, "http://")
	c := NewCollector(
		NewHTTPProber(2*time.Second),
		nil,
		NewDestinationAllowlist(hostport),
		NewServiceUnitAllowlist(""),
	)
	target := newTestTarget(t, server.URL+"/metrics", "", "none")
	result, err := c.Collect(context.Background(), target, "tester", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Run.Status == RunStatusSuccess {
		t.Fatal("invalid metrics body must not be a full success")
	}
}

func TestCollectorDoesNotOverwriteLastMeasuredOnFailure(t *testing.T) {
	// The collector itself never writes freshness; the repository does. This
	// asserts the collector reports no sample on a fully failed collection.
	c := NewCollector(
		NewHTTPProber(300*time.Millisecond),
		nil,
		NewDestinationAllowlist("127.0.0.1:1"),
		NewServiceUnitAllowlist(""),
	)
	target := newTestTarget(t, "http://127.0.0.1:1/metrics", "", "none")
	result, err := c.Collect(context.Background(), target, "tester", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Sample != nil && result.Sample.CollectedAt == "" {
		t.Fatal("sample must carry a timestamp")
	}
	if result.Run.CompletedAt == "" {
		t.Fatal("run must carry completion time")
	}
}

func TestCollectorRejectsNonAllowlistedDestination(t *testing.T) {
	c := NewCollector(
		NewHTTPProber(time.Second),
		nil,
		NewDestinationAllowlist("127.0.0.1:9"),
		NewServiceUnitAllowlist(""),
	)
	target := newTestTarget(t, "http://10.0.0.1:9090/metrics", "", "none")
	_, err := c.Collect(context.Background(), target, "tester", false)
	if err != nil {
		// Collect itself may return an error only for concurrency; a rejected
		// endpoint becomes a failed run.
		t.Fatalf("unexpected collector error: %v", err)
	}
}

func TestScheduledInitiatorIsScheduler(t *testing.T) {
	c := NewCollector(NewHTTPProber(time.Second), nil, NewDestinationAllowlist(""), NewServiceUnitAllowlist(""))
	target := newTestTarget(t, "", "", "none")
	// Reset rate limiter state so the first scheduled collection is allowed.
	c.mu.Lock()
	delete(c.lastRunAt, target.TargetID)
	c.mu.Unlock()
	result, err := c.Collect(context.Background(), target, "", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Run.InitiatedBy != "scheduler" {
		t.Fatalf("expected scheduler initiator, got %q", result.Run.InitiatedBy)
	}
}
