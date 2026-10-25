package nfhealth

import (
	"context"
	"sync"
)

// CollectionGate is the shared bounded admission mechanism used by both manual
// and scheduled collections. A scheduler-only semaphore is insufficient because
// manual collection would bypass the global limit.
//
// Admission is split by the cost of the work, not by who asked for it:
// collections that may reach the network draw from the global bound, while
// process_only collections draw from the local bound. A local scan therefore
// can neither consume a network slot nor be starved behind one.
type CollectionGate struct {
	mu   sync.Mutex
	sem  chan struct{}
	max  int
	busy int
	// localSem bounds local, network-free collections.
	localSem  chan struct{}
	localMax  int
	localBusy int
}

// NewCollectionGate constructs a gate with the configured global concurrency.
func NewCollectionGate() *CollectionGate {
	max := MaxGlobalConcurrent
	if max < 1 {
		max = 1
	}
	local := MaxLocalConcurrent
	if local < 1 {
		local = 1
	}
	return &CollectionGate{
		sem:      make(chan struct{}, max),
		max:      max,
		localSem: make(chan struct{}, local),
		localMax: local,
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

// TryAcquireClass takes a slot without blocking from the bound that matches the
// work class: local for network-free collections, global otherwise.
func (g *CollectionGate) TryAcquireClass(local bool) bool {
	if local {
		return g.tryAcquireLocal()
	}
	return g.TryAcquire()
}

// ReleaseClass returns a slot previously acquired from the given class.
func (g *CollectionGate) ReleaseClass(local bool) {
	if local {
		g.releaseLocal()
		return
	}
	g.Release()
}

func (g *CollectionGate) tryAcquireLocal() bool {
	if g == nil {
		return true
	}
	select {
	case g.localSem <- struct{}{}:
		g.mu.Lock()
		g.localBusy++
		g.mu.Unlock()
		return true
	default:
		return false
	}
}

func (g *CollectionGate) releaseLocal() {
	if g == nil {
		return
	}
	select {
	case <-g.localSem:
		g.mu.Lock()
		if g.localBusy > 0 {
			g.localBusy--
		}
		g.mu.Unlock()
	default:
	}
}

// LocalInUse reports how many local collection slots are currently held.
func (g *CollectionGate) LocalInUse() int {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.localBusy
}

// LocalLimit reports the configured local concurrency bound.
func (g *CollectionGate) LocalLimit() int {
	if g == nil {
		return 0
	}
	return g.localMax
}

// Limit reports the configured global concurrency bound.
func (g *CollectionGate) Limit() int {
	if g == nil {
		return 0
	}
	return g.max
}
