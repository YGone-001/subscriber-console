package knowledge

import (
	"sync"
	"time"
)

const maxLatencySamples = 200

// latencyTracker keeps a bounded in-process view of list request latency. It is
// deliberately not persisted: it exists to expose an end-to-end p95 alongside
// the read-only MongoDB query baseline, not to become a metrics backend.
type latencyTracker struct {
	mu      sync.Mutex
	samples []int64
	maximum int64
}

func (t *latencyTracker) record(duration time.Duration) {
	if t == nil {
		return
	}
	ms := duration.Milliseconds()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.samples = append(t.samples, ms)
	if len(t.samples) > maxLatencySamples {
		t.samples = t.samples[len(t.samples)-maxLatencySamples:]
	}
	if ms > t.maximum {
		t.maximum = ms
	}
}

func (t *latencyTracker) snapshot() LatencySnapshot {
	if t == nil {
		return LatencySnapshot{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.samples) == 0 {
		return LatencySnapshot{}
	}
	sorted := append([]int64(nil), t.samples...)
	for i := 1; i < len(sorted); i++ {
		value := sorted[i]
		j := i - 1
		for j >= 0 && sorted[j] > value {
			sorted[j+1] = sorted[j]
			j--
		}
		sorted[j+1] = value
	}
	return LatencySnapshot{
		Samples: len(sorted),
		P50Ms:   float64(percentile(sorted, 0.50)),
		P95Ms:   float64(percentile(sorted, 0.95)),
		MaxMs:   float64(t.maximum),
	}
}

func percentile(sorted []int64, ratio float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	index := int(float64(len(sorted)-1)*ratio + 0.5)
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return sorted[index]
}
