package nfhealth

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"testing"
	"time"
)

func TestMetricOutcomePublicationAndOrdering(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	base := now.Add(-10 * time.Minute)
	id := "metric-target"
	resource := "metric-resource"
	for i, at := range []time.Time{base, base.Add(100 * time.Millisecond), base.Add(time.Second), base.Add(2 * time.Second)} {
		run := HealthRun{RunID: string(rune('a' + i)), TargetID: id, ResourceID: resource, StartedAt: at.Format(time.RFC3339Nano), Status: RunStatusFailed, MetricRecorded: true}
		if err := repo.InsertRun(ctx, &run); err != nil {
			t.Fatal(err)
		}
	}
	batch, err := repo.MetricOutcomes(ctx, id, resource, base, now, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !batch.More || len(batch.Outcomes) != 2 || batch.Outcomes[0].Run.RunID != "a" || batch.Outcomes[1].Run.RunID != "b" {
		t.Fatalf("instant ordering/page boundary %+v", batch)
	}
	pending := HealthRun{RunID: "pending", TargetID: "pending-target", ResourceID: resource, StartedAt: now.Add(-time.Second).Format(time.RFC3339Nano), Status: RunStatusFailed}
	if err := repo.InsertRun(ctx, &pending); err != nil {
		t.Fatal(err)
	}
	batch, err = repo.MetricOutcomes(ctx, pending.TargetID, resource, base, now, 128)
	if err != nil || !batch.More || batch.Reason != "recording_pending" || len(batch.Outcomes) != 0 {
		t.Fatalf("unpublished run skipped %+v %v", batch, err)
	}
	_, err = db.Collection("app_nf_health_runs").UpdateOne(ctx, bson.M{"_id": "pending"}, bson.M{"$set": bson.M{"metricRecorded": true, "sampleId": "expired"}})
	if err != nil {
		t.Fatal(err)
	}
	batch, err = repo.MetricOutcomes(ctx, pending.TargetID, resource, base, now, 128)
	if err != nil || batch.More || batch.Gaps != 1 || batch.Outcomes[0].Sample != nil {
		t.Fatalf("TTL absence invented data %+v %v", batch, err)
	}
	// A successfully recorded failure is eligible evidence without any sample.
	target := &HealthTarget{TargetID: "recorded", ResourceID: resource, CollectorProfile: CollectorProcessOnly}
	if _, err := db.Collection("app_nf_health_targets").InsertOne(ctx, target); err != nil {
		t.Fatal(err)
	}
	result := &CollectionResult{Run: HealthRun{RunID: "published", TargetID: target.TargetID, ResourceID: resource, StartedAt: now.Format(time.RFC3339Nano), Status: RunStatusFailed}}
	if err := repo.RecordCollection(ctx, target, result); err != nil {
		t.Fatal(err)
	}
	run, err := repo.GetRun(ctx, "published")
	if err != nil || !run.MetricRecorded {
		t.Fatal("successful recording lacks publication marker", err)
	}
	for i := 0; i < 3; i++ {
		run := HealthRun{RunID: string(rune('x' + i)), TargetID: "dense", ResourceID: resource, StartedAt: now.Add(-time.Minute).Add(time.Duration(i+1) * 100 * time.Millisecond).Format(time.RFC3339Nano), Status: RunStatusFailed, MetricRecorded: true}
		if err := repo.InsertRun(ctx, &run); err != nil {
			t.Fatal(err)
		}
	}
	batch, err = repo.MetricOutcomes(ctx, "dense", resource, base, now, 2)
	if err != nil || !batch.More || batch.Reason != "same_second_budget" || len(batch.Outcomes) != 0 {
		t.Fatalf("dense second silently truncated %+v %v", batch, err)
	}
	if _, err := repo.MetricOutcomes(ctx, id, resource, base.Add(-3*time.Hour), now, 128); err == nil {
		t.Fatal("unbounded lookback accepted")
	}

}
