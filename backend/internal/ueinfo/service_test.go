package ueinfo

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeFetcher struct {
	mmeItems []upstreamUE
	amfItems []upstreamUE
	smfItems []upstreamUE
	metrics  []byte
	mmeErr   error
	amfErr   error
	smfErr   error
	textErr  error
}

func (f *fakeFetcher) FetchUEInfo(_ context.Context, host string) ([]upstreamUE, error) {
	if host == "mme:9090" {
		return f.mmeItems, f.mmeErr
	}
	return f.amfItems, f.amfErr
}

func (f *fakeFetcher) FetchPDUInfo(_ context.Context, _ string) ([]upstreamUE, error) {
	return f.smfItems, f.smfErr
}

func (f *fakeFetcher) FetchUESActive(_ context.Context, _ string) ([]byte, error) {
	return f.metrics, f.textErr
}

type fakeSubscribers struct {
	msisdns map[string]string
	count   int64
	err     error
}

func (f *fakeSubscribers) LookupMSISDNs(_ context.Context, _ []string) (map[string]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.msisdns, nil
}

func (f *fakeSubscribers) Count(_ context.Context) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	return f.count, nil
}

func testSources() Sources {
	return Sources{MME: "mme:9090", AMF: "amf:9090", SMF: "smf:9090"}
}

func testFetcher() *fakeFetcher {
	return &fakeFetcher{
		mmeItems: []upstreamUE{
			{SUPI: "imsi-460020000000001", Domain: "EPS", RAT: "E-UTRA", MMState: "registered", CMState: "idle"},
		},
		amfItems: []upstreamUE{
			{SUPI: "460020000000002", Domain: "5GS", RAT: "NR", CMState: "connected"},
		},
		smfItems: []upstreamUE{
			{SUPI: "imsi-460020000000001", PDN: []upstreamPDN{{APN: "internet", QCI: 9, EBI: 5, PDUState: "active", IPv4: "10.0.0.2"}}},
		},
		metrics: []byte("# TYPE ues_active gauge\nues_active 5\n"),
	}
}

func TestSnapshotMergesAndEnriches(t *testing.T) {
	service := NewService(testSources(), nil, testFetcher(), &fakeSubscribers{
		msisdns: map[string]string{"460020000000001": "18800000001"},
		count:   12,
	})
	service.now = func() time.Time { return time.Unix(1700000000, 0) }

	snapshot := service.Snapshot(context.Background())
	if !snapshot.Configured || !snapshot.Complete {
		t.Fatalf("expected configured complete snapshot: %+v", snapshot)
	}
	if snapshot.Summary.Total != 2 {
		t.Fatalf("expected 2 merged UEs, got %d", snapshot.Summary.Total)
	}
	if snapshot.Summary.Registered == nil || *snapshot.Summary.Registered != 1 {
		t.Fatalf("registered count must be 1: %+v", snapshot.Summary)
	}
	if snapshot.Summary.Idle == nil || *snapshot.Summary.Idle != 1 {
		t.Fatalf("idle count must be 1: %+v", snapshot.Summary)
	}
	if snapshot.Summary.Connected == nil || *snapshot.Summary.Connected != 1 {
		t.Fatalf("connected count must be 1: %+v", snapshot.Summary)
	}
	if snapshot.Summary.EPC5GCOnlineUsers == nil || *snapshot.Summary.EPC5GCOnlineUsers != 5 {
		t.Fatalf("online users must be 5: %+v", snapshot.Summary)
	}
	if snapshot.Summary.IMSOnlineUsers != nil {
		t.Fatal("IMS online users must stay unavailable in this phase")
	}
	if snapshot.Summary.TotalSubscribers == nil || *snapshot.Summary.TotalSubscribers != 12 {
		t.Fatalf("total subscribers must be 12: %+v", snapshot.Summary)
	}
	if len(snapshot.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(snapshot.Items))
	}
	first := snapshot.Items[0]
	if first.SUPI != "460020000000001" || first.MSISDN != "18800000001" {
		t.Fatalf("SUPI normalization or MSISDN enrichment failed: %+v", first)
	}
	if first.PDNCount != 1 || len(first.PDN) != 1 {
		t.Fatalf("PDN merge failed: %+v", first)
	}
}

func TestSnapshotKeepsUnavailableSourcesExplicit(t *testing.T) {
	fetcher := testFetcher()
	fetcher.mmeErr = &FetchError{Reason: ReasonTimeout}
	service := NewService(testSources(), nil, fetcher, nil)

	snapshot := service.Snapshot(context.Background())
	if snapshot.Complete {
		t.Fatal("a failed source must make the snapshot incomplete")
	}
	if snapshot.Summary.Registered != nil {
		t.Fatal("no MM state was reported, so registered must be nil")
	}
	if snapshot.Summary.Idle == nil || *snapshot.Summary.Idle != 0 {
		t.Fatalf("reported CM states must still be counted: %+v", snapshot.Summary)
	}
	var mme SourceStatus
	for _, source := range snapshot.Sources {
		if source.ID == "mme" {
			mme = source
		}
	}
	if mme.State != SourceUnavailable || mme.Reason != ReasonTimeout {
		t.Fatalf("mme status must be explicitly unavailable: %+v", mme)
	}
}

func TestSnapshotWithoutConfiguration(t *testing.T) {
	service := NewService(Sources{}, nil, testFetcher(), nil)
	snapshot := service.Snapshot(context.Background())
	if snapshot.Configured {
		t.Fatal("empty sources must not be configured")
	}
	if snapshot.Summary.Total != 0 || snapshot.Summary.EPC5GCOnlineUsers != nil {
		t.Fatalf("unconfigured snapshot must not fabricate counts: %+v", snapshot.Summary)
	}
}

func TestSnapshotRejectsInvalidConfiguration(t *testing.T) {
	service := NewService(Sources{}, errors.New("bad config"), testFetcher(), nil)
	snapshot := service.Snapshot(context.Background())
	if snapshot.Configured {
		t.Fatal("invalid configuration must not be configured")
	}
	if len(snapshot.Sources) != 1 || snapshot.Sources[0].State != SourceInvalidConfig {
		t.Fatalf("invalid configuration status missing: %+v", snapshot.Sources)
	}
}

func TestSnapshotMetricAbsentIsNotZero(t *testing.T) {
	fetcher := testFetcher()
	fetcher.metrics = []byte("# TYPE other_metric gauge\nother_metric 1\n")
	service := NewService(testSources(), nil, fetcher, nil)
	snapshot := service.Snapshot(context.Background())
	if snapshot.Summary.EPC5GCOnlineUsers != nil {
		t.Fatal("an absent metric must not be reported as zero")
	}
	var metrics SourceStatus
	for _, source := range snapshot.Sources {
		if source.ID == "smf_metrics" {
			metrics = source
		}
	}
	if metrics.State != SourceUnavailable || metrics.Reason != ReasonMetricAbsent {
		t.Fatalf("metric absence must be explicit: %+v", metrics)
	}
	if snapshot.Complete {
		t.Fatal("metric absence must make the snapshot incomplete")
	}
}

func TestFilterAndPage(t *testing.T) {
	items := []UE{
		{SUPI: "460020000000001", MSISDN: "18800000001", Domain: "EPS", MMState: "registered"},
		{SUPI: "460020000000002", MSISDN: "18800000002", Domain: "5GS", CMState: "connected"},
		{SUPI: "460020000000003", Domain: "EPS"},
	}
	filtered, total := FilterAndPage(items, Query{Search: "18800000002", Limit: 50})
	if total != 1 || len(filtered) != 1 || filtered[0].SUPI != "460020000000002" {
		t.Fatalf("search filter failed: %+v total=%d", filtered, total)
	}
	filtered, total = FilterAndPage(items, Query{Domain: "5GS", Limit: 50})
	if total != 1 || filtered[0].Domain != "5GS" {
		t.Fatalf("domain filter failed: %+v total=%d", filtered, total)
	}
	filtered, total = FilterAndPage(items, Query{State: "unknown", Limit: 50})
	if total != 1 || filtered[0].SUPI != "460020000000003" {
		t.Fatalf("state filter failed: %+v total=%d", filtered, total)
	}
	filtered, total = FilterAndPage(items, Query{Limit: 1, Offset: 1})
	if total != 3 || len(filtered) != 1 || filtered[0].SUPI != "460020000000002" {
		t.Fatalf("pagination failed: %+v total=%d", filtered, total)
	}
}

func TestParseUESActive(t *testing.T) {
	value, reason := parseUESActive([]byte("# TYPE ues_active gauge\nues_active 5\n"), time.Unix(1700000000, 0))
	if reason != "" || value == nil || *value != 5 {
		t.Fatalf("expected 5 active UEs, got value=%v reason=%s", value, reason)
	}
	value, reason = parseUESActive([]byte("# TYPE other_metric gauge\nother_metric 1\n"), time.Unix(1700000000, 0))
	if value != nil || reason != ReasonMetricAbsent {
		t.Fatalf("expected metric_absent, got value=%v reason=%s", value, reason)
	}
}
