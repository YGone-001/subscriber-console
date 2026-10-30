package discovery

import (
	"context"
	"testing"
)

type blockingAdapter struct {
	started chan struct{}
	release chan struct{}
}

func (a *blockingAdapter) Type() string { return AdapterNRF }

func (a *blockingAdapter) Discover(ctx context.Context, src DiscoverySource) (*ObservationBatch, error) {
	close(a.started)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-a.release:
		return &ObservationBatch{Complete: true}, nil
	}
}

func TestScannerEnforcesSingleFlightAndRateLimit(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	adapter := &blockingAdapter{started: make(chan struct{}), release: make(chan struct{})}
	scanner := NewScanner(repo, NewAdapterRegistry(adapter), &dummyAudit{})

	firstDone := make(chan error, 1)
	go func() {
		_, err := scanner.Scan(context.Background(), src, ScanTriggerManual, "operator", "operator")
		firstDone <- err
	}()

	<-adapter.started
	if _, err := scanner.Scan(context.Background(), src, ScanTriggerManual, "operator", "operator"); err != ErrScanInProgress {
		t.Fatalf("second concurrent scan error = %v, want ErrScanInProgress", err)
	}
	close(adapter.release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first scan failed: %v", err)
	}

	if _, err := scanner.Scan(context.Background(), src, ScanTriggerManual, "operator", "operator"); err != ErrScanRateLimited {
		t.Fatalf("immediate repeat scan error = %v, want ErrScanRateLimited", err)
	}
}

func TestScheduledRunIsNotUserAudited(t *testing.T) {
	repo := newMockRepo()
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777", TransportMode: TransportH2C,
	}, "tester")
	audit := &dummyAudit{}
	scanner := NewScanner(repo, NewAdapterRegistry(&mockAdapter{batch: &ObservationBatch{Complete: true}}), audit)

	run, err := scanner.Scan(context.Background(), src, ScanTriggerScheduled, "scheduler", "")
	if err != nil {
		t.Fatalf("scheduled scan failed: %v", err)
	}
	if run.Trigger != ScanTriggerScheduled || run.InitiatedBy != "scheduler" {
		t.Fatalf("scheduled run trigger/initiator = %q/%q", run.Trigger, run.InitiatedBy)
	}
	if len(audit.actions) != 0 {
		t.Fatalf("scheduled scans must not enter the user audit stream: %v", audit.actions)
	}
}
