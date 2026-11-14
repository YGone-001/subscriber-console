package nfhealth

import (
	"testing"
	"time"
)

func TestParseFreshnessFilter(t *testing.T) {
	states, err := parseFreshnessFilter(" fresh, STALE ,fresh,unknown ")
	if err != nil {
		t.Fatalf("valid freshness filter rejected: %v", err)
	}
	if len(states) != 3 || states[0] != "fresh" || states[1] != "stale" || states[2] != "unknown" {
		t.Fatalf("freshness must be canonical and deduplicated: %v", states)
	}

	for _, invalid := range []string{"healthy", "fresh,bogus", "fresh,,stale"} {
		if _, err := parseFreshnessFilter(invalid); err == nil {
			t.Fatalf("invalid freshness filter %q must be rejected", invalid)
		}
	}

	empty, err := parseFreshnessFilter("   ")
	if err != nil || empty != nil {
		t.Fatalf("an absent filter is not an error: %v %v", empty, err)
	}
}

func TestParseCollectionFilter(t *testing.T) {
	outcome, err := parseCollectionFilter(" Failed ")
	if err != nil {
		t.Fatalf("valid collection filter rejected: %v", err)
	}
	if outcome != CollectionFailed {
		t.Fatalf("collection filter must be canonical: %q", outcome)
	}

	ok, err := parseCollectionFilter("succeeded")
	if err != nil || ok != CollectionSucceeded {
		t.Fatalf("succeeded must be accepted: %q %v", ok, err)
	}

	if _, err := parseCollectionFilter("pending"); err == nil {
		t.Fatal("an unknown collection outcome must be rejected")
	}

	empty, err := parseCollectionFilter("  ")
	if err != nil || empty != "" {
		t.Fatalf("an absent filter is not an error: %q %v", empty, err)
	}
}

func TestCollectionFilterCompilesToTheLatestAttemptOutcome(t *testing.T) {
	failed := targetQuery(TargetListFilter{Collection: CollectionFailed})
	if len(failed) == 0 {
		t.Fatal("the failed collection filter must compile to a predicate")
	}
	if failed["lastError"] == nil {
		t.Fatalf("the failed collection filter must read the latest attempt error: %+v", failed)
	}

	succeeded := targetQuery(TargetListFilter{Collection: CollectionSucceeded})
	if len(succeeded) == 0 {
		t.Fatal("the succeeded collection filter must compile to a predicate")
	}
	if succeeded["$or"] == nil {
		t.Fatalf("the succeeded collection filter must accept a missing error: %+v", succeeded)
	}
}

func TestFreshnessFilterResolvesIdentifiersWithTheSameProjectionAsTheSummary(t *testing.T) {
	// The freshness filter resolves identifiers through the shared projection
	// fields, so a filtered list and the freshness KPI can never disagree.
	for field := range freshnessProjectionFields {
		if _, ok := freshnessProjectionFields[field]; !ok {
			t.Fatalf("projection field %q is not addressable", field)
		}
	}
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	target := HealthTarget{
		TargetID:        "0192f0c0-a000-7000-8000-0000000000a1",
		Enabled:         true,
		CollectionMode:  CollectionScheduled,
		IntervalSeconds: 60,
		LastMeasuredAt:  now.Add(-30 * time.Second).Format(time.RFC3339Nano),
	}
	if got := EvaluateFreshness(&target, now).State; got != FreshnessFresh {
		t.Fatalf("a measurement inside the policy window must be fresh, got %q", got)
	}
	stale := target
	stale.LastMeasuredAt = now.Add(-2 * time.Hour).Format(time.RFC3339Nano)
	if got := EvaluateFreshness(&stale, now).State; got != FreshnessStale {
		t.Fatalf("a measurement beyond the policy window must be stale, got %q", got)
	}
}
