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

func TestScheduledScanAgesSeenEvidenceWithoutInferringAbsence(t *testing.T) {
	repo := newMockRepo()
	interval := 300
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777",
		TransportMode: TransportH2C, ScanIntervalSeconds: &interval,
	}, "tester")
	_, _, _, _ = repo.UpsertObservation(context.Background(), src.SourceID, AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "old", NfType: "AMF", NfStatus: "REGISTERED"},
		"2020-01-01T00:00:00Z")

	failing := NewScanner(repo, NewAdapterRegistry(&mockAdapter{err: ErrProtocol}), &dummyAudit{})
	run, err := failing.Scan(context.Background(), src, ScanTriggerScheduled, "scheduler", "")
	if err == nil || run.Status != RunStatusFailed {
		t.Fatalf("failed scan = %+v err=%v", run, err)
	}
	if len(repo.staleCalls) != 1 {
		t.Fatalf("stale sweeps = %d, want one", len(repo.staleCalls))
	}
	var candidate *NFObservation
	for _, item := range repo.candidates {
		candidate = item
	}
	if candidate.ObservationState != ObservationStale {
		t.Fatalf("old seen evidence must age to stale, got %q", candidate.ObservationState)
	}
	if run.MissingCount != 0 {
		t.Fatalf("staleness must never infer absence, missing=%d", run.MissingCount)
	}

	// A later successful observation restores the same candidate to seen.
	recovering := NewScanner(repo, NewAdapterRegistry(&mockAdapter{batch: &ObservationBatch{
		Complete: true,
		Profiles: []*NormalizedProfile{{ExternalNfInstanceID: "old", NfType: "AMF", NfStatus: "REGISTERED"}},
	}}), &dummyAudit{})
	if _, err := recovering.Scan(context.Background(), src, ScanTriggerScheduled, "scheduler", ""); err != nil {
		t.Fatalf("recovery scan failed: %v", err)
	}
	if candidate.ObservationState != ObservationSeen {
		t.Fatalf("successful observation must restore seen, got %q", candidate.ObservationState)
	}
}

func TestManualOnlySourceNeverAgesEvidence(t *testing.T) {
	repo := newMockRepo()
	zero := 0
	src, _ := repo.CreateSource(context.Background(), &CreateSourceRequest{
		Name: "nrf", AdapterType: AdapterNRF, BaseURL: "http://127.0.0.10:7777",
		TransportMode: TransportH2C, ScanIntervalSeconds: &zero,
	}, "tester")
	_, _, _, _ = repo.UpsertObservation(context.Background(), src.SourceID, AdapterNRF,
		&NormalizedProfile{ExternalNfInstanceID: "old", NfType: "AMF", NfStatus: "REGISTERED"},
		"2020-01-01T00:00:00Z")

	scanner := NewScanner(repo, NewAdapterRegistry(&mockAdapter{err: ErrProtocol}), &dummyAudit{})
	if _, err := scanner.Scan(context.Background(), src, ScanTriggerManual, "operator", "operator"); err == nil {
		t.Fatal("scan should fail")
	}
	if len(repo.staleCalls) != 0 {
		t.Fatalf("manual-only source must not promise freshness, sweeps=%d", len(repo.staleCalls))
	}
	for _, item := range repo.candidates {
		if item.ObservationState != ObservationSeen {
			t.Fatalf("manual-only evidence must stay seen, got %q", item.ObservationState)
		}
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
