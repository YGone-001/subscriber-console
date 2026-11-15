package knowledge

import (
	"testing"
	"time"
)

func TestLatencyTrackerSnapshot(t *testing.T) {
	tracker := &latencyTracker{}
	for _, duration := range []time.Duration{
		10 * time.Millisecond,
		20 * time.Millisecond,
		30 * time.Millisecond,
		40 * time.Millisecond,
		50 * time.Millisecond,
	} {
		tracker.record(duration)
	}
	snapshot := tracker.snapshot()
	if snapshot.Samples != 5 || snapshot.P50Ms != 30 || snapshot.P95Ms != 50 || snapshot.MaxMs != 50 {
		t.Fatalf("unexpected latency snapshot: %+v", snapshot)
	}
}

func TestLatencyTrackerIsBounded(t *testing.T) {
	tracker := &latencyTracker{}
	for index := 0; index < maxLatencySamples+50; index += 1 {
		tracker.record(time.Millisecond)
	}
	snapshot := tracker.snapshot()
	if snapshot.Samples != maxLatencySamples || snapshot.MaxMs != 1 {
		t.Fatalf("unexpected bounded snapshot: %+v", snapshot)
	}
}
