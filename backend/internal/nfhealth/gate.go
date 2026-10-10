package nfhealth

import (
	"context"
	"sync"
)

// CollectionGate is the shared bounded admission mechanism used by both manual
// and scheduled collections. A scheduler-only semaphore is insufficient because
// manual collection would bypass the global limit.
type CollectionGate struct {
	mu   sync.Mutex
	sem  chan struct{}
	max  int
	busy int
}

// NewCollectionGate constructs a gate with the configured global concurrency.
func NewCollectionGate() *CollectionGate {
	max := MaxGlobalConcurrent
	if max < 1 {
		max = 1
	}
	return &CollectionGate{
		sem: make(chan struct{}, max),
		max: max,
	}
}

// Acquire blocks until a global collection slot is available or ctx is done.
func (g *CollectionGate) Acquire(ctx context.Context) error {
	if g == nil {
		return nil
	}
	select {
	case g.sem <- struct{}{}:
		g.mu.Lock()
		g.busy++
		g.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// TryAcquire takes a slot without blocking. Returns false when the gate is full.
func (g *CollectionGate) TryAcquire() bool {
	if g == nil {
		return true
	}
	select {
	case g.sem <- struct{}{}:
		g.mu.Lock()
		g.busy++
		g.mu.Unlock()
		return true
	default:
		return false
	}
}

// Release returns a previously acquired slot.
func (g *CollectionGate) Release() {
	if g == nil {
		return
	}
	select {
	case <-g.sem:
		g.mu.Lock()
		if g.busy > 0 {
			g.busy--
		}
		g.mu.Unlock()
	default:
	}
}

// InUse reports how many global slots are currently held.
func (g *CollectionGate) InUse() int {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.busy
}

// Limit reports the configured global concurrency bound.
func (g *CollectionGate) Limit() int {
	if g == nil {
		return 0
	}
	return g.max
}
