package nfhealth

import (
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func measuredLayers(state string) *LayerSet {
	return &LayerSet{
		Process:   LayerEvidence{State: state, EvidenceKind: EvidenceProcess, Measured: true},
		Interface: LayerEvidence{State: state, EvidenceKind: EvidenceHTTP, Measured: true},
		Service:   LayerEvidence{State: state, EvidenceKind: EvidenceMetric, Measured: true},
	}
}

func freshTarget(now time.Time) *HealthTarget {
	return &HealthTarget{
		TargetID:         "7c3e1d50-0031-4d31-9f31-000000000031",
		Name:             "amf-01",
		CollectionMode:   CollectionScheduled,
		IntervalSeconds:  60,
		Enabled:          true,
		LastAttemptAt:    now.Add(-10 * time.Second).Format(time.RFC3339Nano),
		LastSuccessAt:    now.Add(-10 * time.Second).Format(time.RFC3339Nano),
		LastMeasuredAt:   now.Add(-10 * time.Second).Format(time.RFC3339Nano),
		UpdatedAt:        now.Format(time.RFC3339Nano),
		SchemaVersion:    SchemaVersion,
		CollectorProfile: CollectorProcessOnly,
	}
}

func TestProjectTargetRiskOrdersTheDutyQueue(t *testing.T) {
	fresh := FreshnessProjection{State: FreshnessFresh}
	stale := FreshnessProjection{State: FreshnessStale}
	unknown := FreshnessProjection{State: FreshnessUnknown}

	cases := []struct {
		name             string
		freshness        FreshnessProjection
		layers           *LayerSet
		collectionFailed bool
		wantState        string
		wantRank         int
	}{
		{"failed collection outranks every evidence state", fresh, measuredLayers(StateHealthy), true, StateHealthy, RiskFailed},
		{"unhealthy evidence", fresh, measuredLayers(StateUnhealthy), false, StateUnhealthy, RiskUnhealthy},
		{"degraded evidence", fresh, measuredLayers(StateDegraded), false, StateDegraded, RiskDegraded},
		{"stale evidence", stale, measuredLayers(StateHealthy), false, StateStale, RiskStale},
		{"never measured is unknown, not healthy", unknown, nil, false, StateUnknown, RiskUnknown},
		{"healthy evidence sorts last", fresh, measuredLayers(StateHealthy), false, StateHealthy, RiskHealthy},
		{"not configured is not a health claim", FreshnessProjection{State: FreshnessNotMonitored}, nil, false, StateNotConfigured, RiskUnknown},
	}

	for _, tc := range cases {
		state, rank := ProjectTargetRisk(tc.freshness, tc.layers, tc.collectionFailed)
		if state != tc.wantState || rank != tc.wantRank {
			t.Fatalf("%s: got (%s,%d) want (%s,%d)", tc.name, state, rank, tc.wantState, tc.wantRank)
		}
	}

	// The ordering is total and strict: failed > unhealthy > degraded > stale >
	// unknown > healthy.
	if !(RiskFailed > RiskUnhealthy && RiskUnhealthy > RiskDegraded &&
		RiskDegraded > RiskStale && RiskStale > RiskUnknown && RiskUnknown > RiskHealthy) {
		t.Fatal("risk ranks must be strictly ordered")
	}
}

func TestBuildTargetProjectionCachesEvidence(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	target := freshTarget(now)

	projection := BuildTargetProjection(target, measuredLayers(StateHealthy), now)
	if projection.OverallState != StateHealthy || projection.RiskRank != RiskHealthy {
		t.Fatalf("healthy evidence must project healthy: %+v", projection)
	}
	if !projection.L1Measured || !projection.L2Measured || !projection.L3Measured || !projection.L3Available {
		t.Fatalf("coverage must mirror the measured layers: %+v", projection)
	}
	if projection.ProjectedAt == "" {
		t.Fatal("a projection records when it was computed")
	}

	failed := freshTarget(now)
	failed.LastError = "http probe timed out"
	projection = BuildTargetProjection(failed, measuredLayers(StateHealthy), now)
	if projection.RiskRank != RiskFailed {
		t.Fatalf("a failed collection must rank failed: %+v", projection)
	}

	stale := freshTarget(now)
	stale.LastMeasuredAt = now.Add(-2 * time.Hour).Format(time.RFC3339Nano)
	stale.LastSuccessAt = now.Add(-2 * time.Hour).Format(time.RFC3339Nano)
	stale.LastAttemptAt = now.Add(-2 * time.Hour).Format(time.RFC3339Nano)
	projection = BuildTargetProjection(stale, measuredLayers(StateHealthy), now)
	if projection.OverallState != StateStale || projection.RiskRank != RiskStale {
		t.Fatalf("aged evidence must project stale: %+v", projection)
	}

	never := freshTarget(now)
	never.LastMeasuredAt = ""
	never.LastSuccessAt = ""
	never.LastAttemptAt = ""
	projection = BuildTargetProjection(never, nil, now)
	if projection.RiskRank != RiskUnknown {
		t.Fatalf("a target without a measurement must rank unknown: %+v", projection)
	}
	if projection.L1Measured || projection.L2Measured || projection.L3Measured {
		t.Fatalf("no measurement means no coverage claim: %+v", projection)
	}
}

func TestUnknownTargetProjectionIsNotHealthy(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	projection := UnknownTargetProjection(now)
	if projection.OverallState != StateUnknown || projection.RiskRank != RiskUnknown {
		t.Fatalf("a new target must start unknown: %+v", projection)
	}
	if projection.L1Measured || projection.L2Measured || projection.L3Measured || projection.L3Available {
		t.Fatalf("a new target must not claim coverage: %+v", projection)
	}
}

func TestTargetQueryCompilesStoredPredicates(t *testing.T) {
	query := targetQuery(TargetListFilter{
		Query:   "amf",
		Enabled: "true",
		Domain:  "5gc",
		Overall: StateDegraded,
		Layers:  []string{"l1", "l2"},
	})
	conditions, ok := query["$and"].([]bson.M)
	if !ok || len(conditions) != 6 {
		t.Fatalf("expected six AND conditions, got %#v", query)
	}
	if conditions[5]["lastProjection.l2Measured"] != true {
		t.Fatalf("layer filter must read the persisted coverage: %#v", conditions[5])
	}
	if conditions[3]["lastProjection.overallState"] != StateDegraded {
		t.Fatalf("state filter must read the persisted projection: %#v", conditions[3])
	}

	// Unknown is the one state that also matches a target written before the
	// projection existed: absence of evidence is unknown, not healthy.
	unknownQuery := targetQuery(TargetListFilter{Overall: StateUnknown})
	or, ok := unknownQuery["$or"].([]bson.M)
	if !ok || len(or) != 2 {
		t.Fatalf("unknown must also match a missing projection: %#v", unknownQuery)
	}
	if _, present := or[1]["lastProjection"]; !present {
		t.Fatalf("the second branch must express a missing projection: %#v", or[1])
	}

	// An empty filter compiles to an empty document rather than an always-true
	// condition hidden inside an operator.
	if len(targetQuery(TargetListFilter{})) != 0 {
		t.Fatal("an empty filter must not add predicates")
	}
}

func TestParseLayerFilter(t *testing.T) {
	layers, err := parseLayerFilter(" L1, l2 ,l1, l3 ")
	if err != nil {
		t.Fatalf("valid layer filter rejected: %v", err)
	}
	if len(layers) != 3 || layers[0] != "l1" || layers[1] != "l2" || layers[2] != "l3" {
		t.Fatalf("layers must be canonical and deduplicated: %v", layers)
	}

	for _, invalid := range []string{"l4", "l1,l4", "l1,,l2"} {
		if _, err := parseLayerFilter(invalid); err == nil {
			t.Fatalf("invalid layer filter %q must be rejected", invalid)
		}
	}

	empty, err := parseLayerFilter("   ")
	if err != nil || empty != nil {
		t.Fatalf("an absent filter is not an error: %v %v", empty, err)
	}
}
