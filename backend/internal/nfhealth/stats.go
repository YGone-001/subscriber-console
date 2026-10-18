package nfhealth

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// HealthTargetStateSummary is the full-population monitoring state projection
// for the operations summary. Every distribution is derived with the same
// authoritative projection the target list uses (EvaluateFreshness +
// ProjectOverallState), so summary KPIs and per-target rows cannot disagree.
//
// Failed counts targets whose latest completed attempt recorded an error
// (target.lastError is set on failure and cleared on the next success), not
// targets with merely old measurements.
type HealthTargetStateSummary struct {
	Configured       int64                       `json:"configured"`
	Enabled          int64                       `json:"enabled"`
	Failed           int64                       `json:"failed"`
	FreshnessByState map[string]int64            `json:"freshnessByState"`
	OverallByState   map[string]int64            `json:"overallByState"`
	LayersByState    map[string]map[string]int64 `json:"layersByState"`
}

// freshnessProjectionFields is the minimal target projection needed to
// evaluate freshness and the latest-attempt error state in memory.
var freshnessProjectionFields = bson.M{
	"_id":             1,
	"enabled":         1,
	"collectionMode":  1,
	"intervalSeconds": 1,
	"lastMeasuredAt":  1,
	"lastError":       1,
}

// HealthTargetStateSummary projects the full target population (not one page)
// into freshness, overall and per-layer state distributions.
//
// Bounded aggregation strategy:
//   - targets are read once with a projection of only the freshness fields;
//   - the latest sample per target is resolved by a single sort+group
//     aggregation served by the (targetId, collectedAt) index - no per-target
//     query and no page-size truncation.
func (r *Repository) HealthTargetStateSummary(ctx context.Context, now time.Time) (HealthTargetStateSummary, error) {
	summary := HealthTargetStateSummary{
		FreshnessByState: map[string]int64{},
		OverallByState:   map[string]int64{},
		LayersByState: map[string]map[string]int64{
			"process":   {},
			"interface": {},
			"service":   {},
		},
	}

	// Full target read with the freshness-only projection. The target
	// collection is operator-authored configuration, not time-series data,
	// so its size is bounded by the number of configured targets.
	opts := options.Find().SetProjection(freshnessProjectionFields)
	targetCursor, err := r.targets.Find(ctx, bson.M{}, opts)
	if err != nil {
		return HealthTargetStateSummary{}, err
	}
	var targets []HealthTarget
	if err := targetCursor.All(ctx, &targets); err != nil {
		return HealthTargetStateSummary{}, err
	}

	// Latest sample layers per target across the whole collection. The sort
	// key matches the nf_health_samples_target_collected index exactly.
	pipeline := mongo.Pipeline{
		{{Key: "$sort", Value: bson.D{
			{Key: "targetId", Value: 1},
			{Key: "collectedAt", Value: -1},
			{Key: "_id", Value: -1},
		}}},
		{{Key: "$group", Value: bson.M{
			"_id":    "$targetId",
			"layers": bson.M{"$first": "$layers"},
		}}},
	}
	sampleCursor, err := r.samples.Aggregate(ctx, pipeline)
	if err != nil {
		return HealthTargetStateSummary{}, err
	}
	var sampleRows []struct {
		TargetID string   `bson:"_id"`
		Layers   LayerSet `bson:"layers"`
	}
	if err := sampleCursor.All(ctx, &sampleRows); err != nil {
		return HealthTargetStateSummary{}, err
	}
	latestLayers := make(map[string]LayerSet, len(sampleRows))
	for _, row := range sampleRows {
		latestLayers[row.TargetID] = row.Layers
	}

	summary.Configured = int64(len(targets))
	for i := range targets {
		target := targets[i]
		if target.Enabled {
			summary.Enabled++
		}
		if target.LastError != "" {
			summary.Failed++
		}

		freshness := EvaluateFreshness(&target, now)
		summary.FreshnessByState[freshness.State]++

		var layers *LayerSet
		if ls, ok := latestLayers[target.TargetID]; ok {
			layers = &ls
		}
		summary.OverallByState[ProjectOverallState(freshness, layers)]++

		// Per-layer distribution with list-view semantics: a layer without
		// any sample is unknown (nothing was measured), a layer inside a
		// sample but not measured is not_configured, a measured layer reports
		// its evidence state. Unmeasured layers never claim health.
		layerStates := [3]struct {
			name string
			ev   LayerEvidence
		}{
			{"process", layersProcess(layers)},
			{"interface", layersInterface(layers)},
			{"service", layersService(layers)},
		}
		for _, layer := range layerStates {
			state := StateUnknown
			if layers != nil {
				if layer.ev.Measured {
					state = layer.ev.State
					if state == "" {
						state = StateUnknown
					}
				} else {
					state = StateNotConfigured
				}
			}
			summary.LayersByState[layer.name][state]++
		}
	}
	return summary, nil
}

func layersProcess(layers *LayerSet) LayerEvidence {
	if layers == nil {
		return LayerEvidence{}
	}
	return layers.Process
}

func layersInterface(layers *LayerSet) LayerEvidence {
	if layers == nil {
		return LayerEvidence{}
	}
	return layers.Interface
}

func layersService(layers *LayerSet) LayerEvidence {
	if layers == nil {
		return LayerEvidence{}
	}
	return layers.Service
}
