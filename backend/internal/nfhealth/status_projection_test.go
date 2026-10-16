package nfhealth

import (
	"context"
	"testing"
	"time"
)

// seedSampleForTarget inserts one measurement sample for a target.
func seedSampleForTarget(t *testing.T, repo *Repository, sampleID, targetID, collectedAt string) {
	t.Helper()
	sample := nfhealthTestSample(targetID, "run-"+sampleID, sampleID, collectedAt,
		time.Now().UTC().AddDate(0, 0, DefaultRetentionDays))
	sample.Layers = LayerSet{
		Process:   LayerEvidence{State: StateHealthy, Measured: true},
		Interface: LayerEvidence{State: StateHealthy, Measured: true},
		Service:   LayerEvidence{State: StateUnknown, Measured: true, Reason: ReasonActivityObserved},
	}
	sample.Metrics = []MetricSample{
		{Key: "mme_session", Value: 3, Unit: "count", Type: "gauge",
			Source: "metrics_endpoint", CollectedAt: collectedAt, Category: CategoryService},
		{Key: "process_resident_memory_bytes", Value: 2048, Unit: "bytes", Type: "gauge",
			Source: "metrics_endpoint", CollectedAt: collectedAt, Category: CategoryResource},
	}
	if err := repo.InsertSample(context.Background(), sample); err != nil {
		t.Fatalf("insert sample %s: %v", sampleID, err)
	}
}

func seedRunForTarget(t *testing.T, repo *Repository, runID, targetID, startedAt, status string) {
	t.Helper()
	run := &HealthRun{
		RunID:       runID,
		TargetID:    targetID,
		Status:      status,
		StartedAt:   startedAt,
		InitiatedBy: "operator1",
	}
	if err := repo.InsertRun(context.Background(), run); err != nil {
		t.Fatalf("insert run %s: %v", runID, err)
	}
}

// TestLatestStatusForTargetsSelectsMostRecentEvidence proves the bounded batch
// projection returns the most recent sample and run per target.
func TestLatestStatusForTargetsSelectsMostRecentEvidence(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	first := nfhealthTestTarget(t, repo, "status-target-a")
	second := nfhealthTestTarget(t, repo, "status-target-b")
	third := nfhealthTestTarget(t, repo, "status-target-c")

	seedSampleForTarget(t, repo, "sample-a-old", first.TargetID, "2026-10-01T00:00:00Z")
	seedSampleForTarget(t, repo, "sample-a-new", first.TargetID, "2026-10-02T00:00:00Z")
	seedSampleForTarget(t, repo, "sample-b", second.TargetID, "2026-10-03T00:00:00Z")
	seedRunForTarget(t, repo, "run-a-old", first.TargetID, "2026-10-01T01:00:00Z", "failed")
	seedRunForTarget(t, repo, "run-a-new", first.TargetID, "2026-10-02T01:00:00Z", "success")

	statuses, err := repo.LatestStatusForTargets(ctx, []string{first.TargetID, second.TargetID, third.TargetID})
	if err != nil {
		t.Fatalf("latest status: %v", err)
	}
	if len(statuses) != 2 {
		t.Fatalf("only targets with evidence must be reported, got %d", len(statuses))
	}
	entryA, ok := statuses[first.TargetID]
	if !ok || entryA.Sample == nil {
		t.Fatalf("target A must carry its latest sample: %+v", entryA)
	}
	if entryA.Sample.SampleID != "sample-a-new" {
		t.Fatalf("the most recent sample must win, got %s", entryA.Sample.SampleID)
	}
	if entryA.Run == nil || entryA.Run.RunID != "run-a-new" || entryA.Run.Status != "success" {
		t.Fatalf("the most recent run must win: %+v", entryA.Run)
	}
	entryB := statuses[second.TargetID]
	if entryB.Sample == nil || entryB.Sample.SampleID != "sample-b" || entryB.Run != nil {
		t.Fatalf("target B projection is wrong: %+v", entryB)
	}
	if _, ok := statuses[third.TargetID]; ok {
		t.Fatal("a target without evidence must not be reported as having evidence")
	}
}

func TestLatestStatusForTargetsEmptyInputPerformsNoQuery(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	statuses, err := repo.LatestStatusForTargets(context.Background(), nil)
	if err != nil {
		t.Fatalf("empty input: %v", err)
	}
	if len(statuses) != 0 {
		t.Fatalf("empty input must yield an empty projection, got %d", len(statuses))
	}
}

// TestLatestStatusProjectionFeedsCoverageAndOverallState proves the batch
// evidence drives the same coverage/overall projection the detail path uses.
func TestLatestStatusProjectionFeedsCoverageAndOverallState(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()

	target := nfhealthTestTarget(t, repo, "status-target-coverage")
	seedSampleForTarget(t, repo, "sample-cov", target.TargetID, time.Now().UTC().Format(time.RFC3339Nano))

	statuses, err := repo.LatestStatusForTargets(ctx, []string{target.TargetID})
	if err != nil {
		t.Fatalf("latest status: %v", err)
	}
	sample := statuses[target.TargetID].Sample
	if sample == nil {
		t.Fatal("expected a latest sample")
	}
	coverage := CoverageFromLayers(sample.Layers)
	if !coverage.L1Measured || !coverage.L2Measured || !coverage.L3Measured {
		t.Fatalf("coverage must reflect the stored layers: %+v", coverage)
	}
	freshness := EvaluateFreshness(target, time.Now().UTC())
	overall := ProjectOverallState(freshness, &sample.Layers)
	if overall == StateHealthy {
		t.Fatalf("activity-only service evidence must not project healthy, got %s", overall)
	}
	if overall != StateUnknown {
		t.Fatalf("expected unknown overall state, got %s", overall)
	}
	// Resource metrics are exposed separately from service measurements.
	resources := resourceCategoryMetrics(sample.Metrics)
	if len(resources) != 1 || resources[0].Key != "process_resident_memory_bytes" {
		t.Fatalf("only resource-category metrics may be projected: %+v", resources)
	}
}
