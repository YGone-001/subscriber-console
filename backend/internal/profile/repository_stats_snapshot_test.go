package profile

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func countRows(total int) map[string]profileSubscriberStats {
	return map[string]profileSubscriberStats{
		"Gold": {total: total, active: total, restricted: 0},
	}
}

func TestCachedSubscriberCountsAnswersFromSnapshotWithinTTL(t *testing.T) {
	repo := &Repository{}
	calls := 0
	fetch := func(context.Context) (map[string]profileSubscriberStats, error) {
		calls++
		return countRows(calls), nil
	}

	first, err := repo.cachedSubscriberCounts(context.Background(), fetch)
	if err != nil {
		t.Fatalf("first read failed: %v", err)
	}
	second, err := repo.cachedSubscriberCounts(context.Background(), fetch)
	if err != nil {
		t.Fatalf("second read failed: %v", err)
	}

	if calls != 1 {
		t.Errorf("aggregations run = %d, want 1 for two reads inside the window", calls)
	}
	if first["Gold"].total != 1 || second["Gold"].total != 1 {
		t.Errorf("both reads must serve the same snapshot, got %d and %d", first["Gold"].total, second["Gold"].total)
	}
}

func TestCachedSubscriberCountsRefreshesOnceTheWindowCloses(t *testing.T) {
	repo := &Repository{}
	calls := 0
	fetch := func(context.Context) (map[string]profileSubscriberStats, error) {
		calls++
		return countRows(calls), nil
	}

	if _, err := repo.cachedSubscriberCounts(context.Background(), fetch); err != nil {
		t.Fatal(err)
	}
	if repo.statsCache == nil {
		t.Fatal("a successful aggregation must be snapshotted")
	}
	if remaining := time.Until(repo.statsCache.expiresAt); remaining <= 0 || remaining > subscriberStatsTTL {
		t.Errorf("snapshot lifetime = %v, want within (0, %v]", remaining, subscriberStatsTTL)
	}

	// Age the snapshot instead of sleeping, then read again.
	repo.statsCache.expiresAt = time.Now().Add(-time.Millisecond)
	fresh, err := repo.cachedSubscriberCounts(context.Background(), fetch)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Errorf("aggregations run = %d, want a refresh after expiry", calls)
	}
	if fresh["Gold"].total != 2 {
		t.Errorf("refreshed counts = %+v, want the new aggregation result", fresh)
	}
}

func TestCachedSubscriberCountsNeverSnapshotsAFailure(t *testing.T) {
	repo := &Repository{}
	unavailable := errors.New("account store down")

	if _, err := repo.cachedSubscriberCounts(context.Background(),
		func(context.Context) (map[string]profileSubscriberStats, error) { return nil, unavailable }); err == nil {
		t.Fatal("a failed aggregation must surface so the list can degrade to unavailable")
	}
	if repo.statsCache != nil {
		t.Error("a failure must not be replayed for the whole TTL window")
	}

	counts, err := repo.cachedSubscriberCounts(context.Background(),
		func(context.Context) (map[string]profileSubscriberStats, error) { return countRows(7), nil })
	if err != nil {
		t.Fatalf("the next read must retry live, got %v", err)
	}
	if counts["Gold"].total != 7 {
		t.Errorf("recovered counts = %+v", counts)
	}
}

func TestCachedSubscriberCountsCoalescesConcurrentReads(t *testing.T) {
	repo := &Repository{}
	var mu sync.Mutex
	calls := 0
	fetch := func(context.Context) (map[string]profileSubscriberStats, error) {
		mu.Lock()
		calls++
		seen := calls
		mu.Unlock()
		return countRows(seen), nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			counts, err := repo.cachedSubscriberCounts(context.Background(), fetch)
			if err != nil {
				t.Errorf("concurrent read failed: %v", err)
			}
			if counts == nil {
				t.Error("concurrent read returned no counters")
			}
		}()
	}
	wg.Wait()

	if calls != 1 {
		t.Errorf("aggregations run = %d, want 1 while 16 list reads were served", calls)
	}
}
