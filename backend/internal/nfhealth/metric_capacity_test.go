package nfhealth

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// TestMetricAggregateBacklogRecovery measures how a bounded repair converges. A
// twelve-hour gap must be repaired within the per-tick budget, newest first, and
// no single tick may exceed MaxMetricHoursPerTick published hours.
func TestMetricAggregateBacklogRecovery(t *testing.T) {
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	metricAggregateIndexes(t, ctx, repo)
	target := aggregateTarget()
	target.TargetID = newUUID()
	target.ResourceID = newUUID()
	if _, err := repo.targets.InsertOne(ctx, target); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	latest := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour).Add(-time.Hour)
	const gapFrom, gapTo = 6, 18 // twelve consecutive missing hours
	seeded := 0
	for i := 0; i < MetricTrendWindowHours*6; i++ {
		if i >= gapFrom && i < gapTo {
			continue
		}
		slot := latest.Add(-time.Duration(i) * time.Hour)
		for m := 0; m < 3; m++ {
			row := aggregateObservation(target, slot.Add(time.Duration(m)*2*time.Minute), float64(100*analysisMiB+i), "backlog-epoch")
			if err := repo.InsertRun(ctx, &row.Run); err != nil {
				t.Fatal(err)
			}
			if err := repo.InsertSample(ctx, row.Sample); err != nil {
				t.Fatal(err)
			}
		}
		seeded++
	}
	count := func() int64 {
		// Only buckets that actually carry an observation count as repaired. An
		// hour proven only by a boundary point is published empty on purpose.
		value, err := db.Collection("app_nf_metric_aggregates").CountDocuments(ctx, bson.M{"targetId": target.TargetID, "metric": MetricAggregateMetric, "period": MetricHourPeriod, "segments.0": bson.M{"$exists": true}})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	worker := NewMetricAggregateWorker(repo, true, func(context.Context, *HealthTarget) error { return nil })
	ticks, maxPerTick := 0, int64(0)
	for ; ticks < 24; ticks++ {
		before := count()
		worker.Tick(ctx, now)
		delta := count() - before
		if delta > maxPerTick {
			maxPerTick = delta
		}
		if count() == int64(seeded) {
			ticks++
			break
		}
	}
	published := count()
	if maxPerTick > MaxMetricHoursPerTick {
		t.Fatalf("a single tick published %d hours, budget is %d", maxPerTick, MaxMetricHoursPerTick)
	}
	if published != int64(seeded) {
		t.Fatalf("repair converged on %d of %d seeded hours after %d ticks", published, seeded, ticks)
	}
	// Every seeded hour must be published at no more than three per tick.
	if ticks < seeded/MaxMetricHoursPerTick {
		t.Fatalf("converged faster than the per-tick budget allows: %d ticks", ticks)
	}
	t.Logf("BACKLOG seeded=%d published=%d ticks=%d max_per_tick=%d", seeded, published, ticks, maxPerTick)
}

// TestMetricAnalysisLoadBudget replays the analysis read path at the documented
// capacity shape and reports latency and index usage.
func TestMetricAnalysisLoadBudget(t *testing.T) {
	if os.Getenv("NF_METRIC_LOAD_TEST") != "1" {
		t.Skip("set NF_METRIC_LOAD_TEST=1 to run the capacity replay")
	}
	repo, db, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	ctx := context.Background()
	metricAggregateIndexes(t, ctx, repo)
	const targets, hours = 100, 720
	now := time.Now().UTC()
	latest := now.Add(-MetricAggregateGrace).UTC().Truncate(time.Hour)
	value, median, change := float64(100*analysisMiB), float64(96*analysisMiB), float64(4*analysisMiB)
	batch := make([]any, 0, 1000)
	inserted := 0
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if _, err := repo.metricAnalyses().InsertMany(ctx, batch); err != nil {
			t.Fatal(err)
		}
		inserted += len(batch)
		batch = batch[:0]
	}
	for i := 0; i < targets; i++ {
		targetID := fmt.Sprintf("33333333-3333-4333-8333-%012d", i)
		for h := 0; h < hours; h++ {
			start := latest.Add(-time.Duration(h+1) * time.Hour)
			batch = append(batch, MetricAnalysis{
				ID: analysisID(targetID, MetricAggregateMetric, start), Kind: "baseline", TargetID: targetID,
				Metric: MetricAggregateMetric, Series: "unlabeled", BucketStart: start,
				AlgorithmVersion: MetricAnalysisVersion, PolicyVersion: MetricAnalysisPolicyVersion,
				State: AnalysisOK, Unit: "bytes", Value: &value, Median: &median, AbsoluteChange: &change,
				BaselineExpected: 48, BaselineEligible: 48, BaselinePresent: 48, BaselineCoverage: 1,
				Revision: 1, ComputedAt: now, ExpiresAt: start.AddDate(0, 0, MetricAnalysisRetentionDays),
			})
			if len(batch) == 1000 {
				flush()
			}
		}
	}
	flush()
	latencies := make([]time.Duration, 0, 20)
	for i := 0; i < 20; i++ {
		started := time.Now()
		view, err := repo.MetricAnalyses(ctx, MetricAnalysisQuery{
			TargetID: fmt.Sprintf("33333333-3333-4333-8333-%012d", i), Metric: MetricAggregateMetric, Kind: "baseline",
			From: latest.Add(-MaxMetricHourHistoryDays * 24 * time.Hour), To: latest, Limit: 200,
		}, now)
		if err != nil {
			t.Fatal(err)
		}
		latencies = append(latencies, time.Since(started))
		if len(view.Items) != 200 || !view.Page.HasMore {
			t.Fatalf("unexpected page shape: items=%d more=%v", len(view.Items), view.Page.HasMore)
		}
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	var explain bson.M
	err := db.RunCommand(ctx, bson.D{
		{Key: "explain", Value: bson.D{
			{Key: "find", Value: "app_nf_metric_analysis"},
			{Key: "filter", Value: bson.M{"targetId": fmt.Sprintf("33333333-3333-4333-8333-%012d", 0), "metric": MetricAggregateMetric, "series": "unlabeled", "kind": "baseline", "algorithmVersion": MetricAnalysisVersion, "bucketStart": bson.M{"$gte": latest.Add(-720 * time.Hour), "$lt": latest}}},
			{Key: "sort", Value: bson.M{"bucketStart": -1}},
		}},
		{Key: "verbosity", Value: "executionStats"},
	}).Decode(&explain)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(explain)
	indexHit := strings.Contains(string(raw), "nf_metric_analysis_read")
	scanned := int64(0)
	if match := regexp.MustCompile(`"totalDocsExamined":(\d+)`).FindStringSubmatch(string(raw)); len(match) == 2 {
		scanned, _ = strconv.ParseInt(match[1], 10, 64)
	}
	t.Logf("ANALYSIS_LOAD targets=%d hours=%d docs=%d p50=%s p95=%s scanned=%d index=%v",
		targets, hours, inserted, latencies[len(latencies)/2].Round(time.Microsecond), latencies[len(latencies)*95/100].Round(time.Microsecond), scanned, indexHit)
	if !indexHit {
		head := string(raw)
		if len(head) > 600 {
			head = head[:600]
		}
		t.Fatalf("analysis read did not use nf_metric_analysis_read: %s", head)
	}
}
