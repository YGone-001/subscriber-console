package nfhealth

import (
	"context"
	"fmt"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"sort"
	"time"
)

// MetricOutcomeBatch is bounded recording evidence, not a historical coverage
// assertion. Runs are never TTL-deleted; missing samples remain explicit gaps.
type MetricOutcomeBatch struct {
	Outcomes []CollectionResult
	More     bool
	Reason   string
	Gaps     int
}

func (r *Repository) MetricOutcomes(ctx context.Context, targetID, resourceID string, from, to time.Time, limit int) (MetricOutcomeBatch, error) {
	if limit < 1 || limit > 128 || to.Before(from) || to.Sub(from) > 2*time.Hour+time.Second {
		return MetricOutcomeBatch{Outcomes: []CollectionResult{}}, fmt.Errorf("invalid metric replay budget")
	}
	return r.metricOutcomes(ctx, targetID, resourceID, from, to, limit, to)
}

// AggregateOutcomes shares publication, identity and ordering checks with alerts.
// Its fixed hour plus leading continuity allowance is bounded to 2.5 hours.
func (r *Repository) AggregateOutcomes(ctx context.Context, targetID, resourceID string, from, to time.Time) (MetricOutcomeBatch, error) {
	if to.Before(from) || to.Sub(from) > 150*time.Minute {
		return MetricOutcomeBatch{}, fmt.Errorf("invalid aggregation window")
	}
	return r.metricOutcomes(ctx, targetID, resourceID, from, to, 10000, time.Now().UTC())
}

func (r *Repository) metricOutcomes(ctx context.Context, targetID, resourceID string, from, to time.Time, limit int, publicationNow time.Time) (MetricOutcomeBatch, error) {
	batch := MetricOutcomeBatch{Outcomes: []CollectionResult{}}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// Canonical controller timestamps are UTC RFC3339Nano. Broad whole-second
	// bounds include both fractional and nonfractional representations. Never
	// split the final second of a limited page: lexical fractional order differs
	// from instant order at the whole-second representation.
	lo := from.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05")
	hi := to.UTC().Truncate(time.Second).Add(time.Second).Format("2006-01-02T15:04:05")
	cursor, err := r.runs.Find(ctx, bson.M{"targetId": targetID, "startedAt": bson.M{"$gte": lo, "$lt": hi}}, options.Find().SetSort(bson.D{{Key: "startedAt", Value: 1}, {Key: "_id", Value: 1}}).SetLimit(int64(limit+1)).SetProjection(bson.M{"targetId": 1, "resourceId": 1, "startedAt": 1, "completedAt": 1, "status": 1, "sampleId": 1, "metricRecorded": 1}))
	if err != nil {
		return batch, err
	}
	defer cursor.Close(ctx)
	var runs []HealthRun
	if err := cursor.All(ctx, &runs); err != nil {
		return batch, err
	}
	cutoff := to.Add(time.Nanosecond)
	if len(runs) > limit {
		last, err := time.Parse(time.RFC3339Nano, runs[len(runs)-1].StartedAt)
		if err != nil {
			return batch, err
		}
		cutoff = last.Truncate(time.Second)
		batch.More = true
		batch.Reason = "batch_limit"
	}
	sort.Slice(runs, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339Nano, runs[i].StartedAt)
		b, _ := time.Parse(time.RFC3339Nano, runs[j].StartedAt)
		if a.Equal(b) {
			return runs[i].RunID < runs[j].RunID
		}
		return a.Before(b)
	})
	selected := []HealthRun{}
	ids := []string{}
	for _, run := range runs {
		at, err := time.Parse(time.RFC3339Nano, run.StartedAt)
		if err != nil || run.StartedAt != at.UTC().Format(time.RFC3339Nano) {
			batch.More = true
			batch.Reason = "noncanonical_time"
			return batch, nil
		}
		if at.Before(from) || at.After(to) || !at.Before(cutoff) {
			continue
		}
		// A just-written run may be between insert and publication. Stop at it;
		// never let a newer live callback move the watermark past this barrier.
		if !run.MetricRecorded && publicationNow.Sub(at) < 30*time.Second {
			batch.More = true
			batch.Reason = "recording_pending"
			break
		}
		selected = append(selected, run)
		if run.MetricRecorded && run.SampleID != "" {
			ids = append(ids, run.SampleID)
		}
	}
	samples := map[string]HealthSample{}
	if len(ids) > 0 {
		rows, err := r.samples.Find(ctx, bson.M{"_id": bson.M{"$in": ids}, "targetId": targetID}, options.Find().SetLimit(int64(limit)).SetProjection(bson.M{"targetId": 1, "resourceId": 1, "runId": 1, "collectedAt": 1, "layers": 1, "probes": 1, "metrics": 1, "windowIdentity": 1, "windowBinding": 1}))
		if err != nil {
			return batch, err
		}
		defer rows.Close(ctx)
		for rows.Next(ctx) {
			var sample HealthSample
			if err := rows.Decode(&sample); err != nil {
				return batch, err
			}
			samples[sample.SampleID] = sample
		}
		if err := rows.Err(); err != nil {
			return batch, err
		}
	}
	duplicates := map[string]int{}
	for _, run := range selected {
		duplicates[run.StartedAt]++
	}
	for _, run := range selected {
		result := CollectionResult{Run: run}
		if run.MetricRecorded {
			if sample, ok := samples[run.SampleID]; ok && sample.RunID == run.RunID && sample.ResourceID == resourceID && run.ResourceID == resourceID {
				copy := sample
				result.Sample = &copy
			}
		}
		if duplicates[run.StartedAt] > 1 {
			result.Sample = nil
			batch.Gaps++
		}
		if !run.MetricRecorded || (run.SampleID != "" && result.Sample == nil) {
			batch.Gaps++
		}
		batch.Outcomes = append(batch.Outcomes, result)
	}
	if batch.More && len(batch.Outcomes) == 0 && batch.Reason == "batch_limit" {
		batch.Reason = "same_second_budget"
	}
	return batch, nil
}
