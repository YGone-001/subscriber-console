package nfhealth

import "time"

// Duty-queue ordering.
//
// Higher is worse, so the list endpoint sorts the risk rank descending and a
// healthy target is always last. The ranks are deliberately coarse: they order
// attention, they do not claim a health degree. Layer states keep their own
// vocabulary and are never folded into one of these ranks.
const (
	RiskHealthy   = 0
	RiskUnknown   = 1
	RiskStale     = 2
	RiskDegraded  = 3
	RiskUnhealthy = 4
	RiskFailed    = 5
)

// Canonical sort tokens accepted by GET /api/nf-health/targets.
const (
	TargetSortUpdated = "updated"
	TargetSortRisk    = "risk"
)

// TargetProjection is the server-owned projection of the latest accepted
// measurement, persisted on the target document.
//
// The list endpoint filters and orders on these fields, which keeps a duty
// queue read to one indexed query instead of deriving state for every target.
// The projection is a cached reading of evidence: the collector rewrites it,
// no read path ever does, and a target that has never been measured carries the
// unknown rank rather than a healthy one.
type TargetProjection struct {
	OverallState string `json:"overallState" bson:"overallState"`
	RiskRank     int    `json:"riskRank" bson:"riskRank"`
	L1Measured   bool   `json:"l1Measured" bson:"l1Measured"`
	L2Measured   bool   `json:"l2Measured" bson:"l2Measured"`
	L3Measured   bool   `json:"l3Measured" bson:"l3Measured"`
	L3Available  bool   `json:"l3Available" bson:"l3Available"`
	// Probes is the per-family interface evidence of the latest collection, so
	// the matrix reads one bounded row per target instead of loading samples.
	Probes      []ProbeProjection `json:"probes,omitempty" bson:"probes,omitempty"`
	ProjectedAt string            `json:"projectedAt" bson:"projectedAt"`
}

// ProjectTargetRisk maps evidence onto the duty-queue ordering.
//
//	failed     the latest collection attempt failed, so this attempt produced
//	           no accepted evidence
//	unhealthy  accepted evidence reports a failing layer
//	degraded   accepted evidence reports partial failure
//	stale      evidence exists but is older than the freshness policy
//	unknown    no accepted measurement, or no applicable layer state
//	healthy    accepted, fresh, and every measured layer healthy
func ProjectTargetRisk(freshness FreshnessProjection, layers *LayerSet, collectionFailed bool) (string, int) {
	overall := ProjectOverallState(freshness, layers)
	if collectionFailed {
		return overall, RiskFailed
	}
	switch overall {
	case StateUnhealthy:
		return overall, RiskUnhealthy
	case StateDegraded:
		return overall, RiskDegraded
	case StateStale:
		return overall, RiskStale
	case StateHealthy:
		return overall, RiskHealthy
	default:
		return overall, RiskUnknown
	}
}

// BuildTargetProjection computes the persisted projection for one target with
// the same helpers the read projection uses, so ordering can never disagree
// with the state the page renders.
func BuildTargetProjection(target *HealthTarget, layers *LayerSet, probes []ProbeEvidence, now time.Time) TargetProjection {
	projected := *target
	projected.LastProjection = nil
	coverage := CoverageSummary{}
	if layers != nil {
		coverage = CoverageFromLayers(*layers)
	}
	overall, rank := ProjectTargetRisk(EvaluateFreshness(&projected, now), layers, projected.LastError != "")
	return TargetProjection{
		OverallState: overall,
		RiskRank:     rank,
		L1Measured:   coverage.L1Measured,
		L2Measured:   coverage.L2Measured,
		L3Measured:   coverage.L3Measured,
		L3Available:  coverage.L3Available,
		Probes:       ProjectProbes(probes),
		ProjectedAt:  now.UTC().Format(time.RFC3339Nano),
	}
}

// UnknownTargetProjection is the starting projection of a newly configured
// target: nothing has been measured yet, so it is unknown, never healthy.
func UnknownTargetProjection(now time.Time) *TargetProjection {
	return &TargetProjection{
		OverallState: StateUnknown,
		RiskRank:     RiskUnknown,
		ProjectedAt:  now.UTC().Format(time.RFC3339Nano),
	}
}
