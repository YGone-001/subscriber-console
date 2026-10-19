package nfhealth

import (
	"strings"
	"time"
)

/*
 * Interface probe matrix.
 *
 * A target's L2 evidence used to be exactly one metrics endpoint. The matrix
 * adds a bounded, explicit set of additional interface endpoints so an operator
 * can see, per target, which interface families were actually reached and when.
 *
 * Three rules keep the matrix honest:
 *
 *   - Columns come from the server-owned family list, never from the reference
 *     architecture. A reference point that was never configured is reported as
 *     not_configured, not as reachable or missing.
 *   - A cell always carries the evidence it came from: state, reason, HTTP
 *     status, response time and the measurement timestamp. A family that was
 *     configured but never measured is unknown, never healthy.
 *   - The metrics family is implicit. It is the target's metricsEndpoint, which
 *     already drives L2 and L3; the declared probes are additional families.
 */

// Probe families. The list is server-owned and exposed by GET /api/nf-health/meta.
const (
	ProbeFamilyMetrics = "metrics"
	ProbeFamilySBI     = "sbi"
	ProbeFamilyOAM     = "oam"
	ProbeFamilyHealth  = "health"
)

// CanonicalProbeFamilies is the matrix column order.
var CanonicalProbeFamilies = []string{
	ProbeFamilyMetrics,
	ProbeFamilySBI,
	ProbeFamilyOAM,
	ProbeFamilyHealth,
}

// MaxExtraProbes bounds the additional endpoint probes on one target.
const MaxExtraProbes = 4

// InterfaceProbe is one operator-declared endpoint probe.
type InterfaceProbe struct {
	Family string `json:"family" bson:"family"`
	URL    string `json:"url" bson:"url"`
}

// ProbeEvidence is the measured outcome of one probe in one collection run.
//
// Endpoint is the configured URL, not a resolved dial address: the matrix must
// not expose network topology it did not measure.
type ProbeEvidence struct {
	Family     string `json:"family" bson:"family"`
	Endpoint   string `json:"endpoint" bson:"endpoint"`
	State      string `json:"state" bson:"state"`
	Reason     string `json:"reason,omitempty" bson:"reason,omitempty"`
	HTTPStatus *int   `json:"httpStatus,omitempty" bson:"httpStatus,omitempty"`
	ResponseMs *int64 `json:"responseMs,omitempty" bson:"responseMs,omitempty"`
	Measured   bool   `json:"measured" bson:"measured"`
	MeasuredAt string `json:"measuredAt,omitempty" bson:"measuredAt,omitempty"`
}

// ProbeProjection is the persisted per-family result of the latest collection.
// The matrix reads this projection, so one page costs one bounded query.
type ProbeProjection struct {
	Family     string `json:"family" bson:"family"`
	State      string `json:"state" bson:"state"`
	Reason     string `json:"reason,omitempty" bson:"reason,omitempty"`
	HTTPStatus *int   `json:"httpStatus,omitempty" bson:"httpStatus,omitempty"`
	ResponseMs *int64 `json:"responseMs,omitempty" bson:"responseMs,omitempty"`
	MeasuredAt string `json:"measuredAt,omitempty" bson:"measuredAt,omitempty"`
}

// EffectiveProbes is the probe set a collection runs, in canonical order: the
// implicit metrics endpoint first, then the declared extra families sorted by
// the server vocabulary so evidence order is stable.
func EffectiveProbes(target *HealthTarget) []InterfaceProbe {
	if target == nil {
		return nil
	}
	probes := make([]InterfaceProbe, 0, MaxExtraProbes+1)
	if target.CollectorProfile != CollectorProcessOnly {
		if endpoint := strings.TrimSpace(target.MetricsEndpoint); endpoint != "" {
			probes = append(probes, InterfaceProbe{Family: ProbeFamilyMetrics, URL: endpoint})
		}
	}
	for _, family := range CanonicalProbeFamilies {
		if family == ProbeFamilyMetrics {
			continue
		}
		for _, declared := range target.Probes {
			if declared.Family != family {
				continue
			}
			if endpoint := strings.TrimSpace(declared.URL); endpoint != "" {
				probes = append(probes, InterfaceProbe{Family: family, URL: endpoint})
			}
			break
		}
	}
	return probes
}

// ProbeConfigured reports whether a family has an endpoint on this target.
func ProbeConfigured(target *HealthTarget, family string) bool {
	if target == nil {
		return false
	}
	if family == ProbeFamilyMetrics {
		return target.CollectorProfile != CollectorProcessOnly && strings.TrimSpace(target.MetricsEndpoint) != ""
	}
	if target.CollectorProfile == CollectorProcessOnly {
		return false
	}
	for _, declared := range target.Probes {
		if declared.Family == family && strings.TrimSpace(declared.URL) != "" {
			return true
		}
	}
	return false
}

// AggregateInterfaceEvidence folds per-probe evidence into the single L2 layer
// the health model already understands.
//
// The worst measured state wins; ties keep the earlier probe, and the probe set
// is ordered with the metrics endpoint first. A target with only the metrics
// probe therefore keeps exactly the L2 state it had before the matrix existed.
func AggregateInterfaceEvidence(probes []ProbeEvidence) LayerEvidence {
	var chosen *ProbeEvidence
	for i := range probes {
		if !probes[i].Measured {
			continue
		}
		if chosen == nil || probeSeverity(probes[i].State) > probeSeverity(chosen.State) {
			chosen = &probes[i]
		}
	}
	if chosen == nil {
		return LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
		}
	}
	return LayerEvidence{
		State:        chosen.State,
		EvidenceKind: EvidenceHTTP,
		Reason:       chosen.Reason,
		HTTPStatus:   chosen.HTTPStatus,
		ResponseMs:   chosen.ResponseMs,
		Measured:     true,
	}
}

func probeSeverity(state string) int {
	switch state {
	case StateUnhealthy:
		return 3
	case StateDegraded:
		return 2
	case StateUnknown, StateStale:
		return 1
	case StateHealthy:
		return 0
	default:
		return -1
	}
}

// EvaluateReachabilityLayer evaluates a non-metrics interface probe.
//
// Such a probe answers exactly one question: did the endpoint respond? Any HTTP
// response below 500 proves the interface is served, so a 4xx is reachable with
// its status kept in the evidence; it is not a claim about the operation the
// interface implements. Refused, timed out and 5xx endpoints are unhealthy.
func EvaluateReachabilityLayer(probe *ProbeResult) LayerEvidence {
	if probe == nil {
		return LayerEvidence{
			State:        StateNotConfigured,
			EvidenceKind: EvidenceNone,
			Reason:       ReasonNotConfigured,
		}
	}
	out := LayerEvidence{
		EvidenceKind: EvidenceHTTP,
		ResponseMs:   &probe.ResponseMs,
		Measured:     true,
	}
	if status := probe.HTTPStatus; status > 0 {
		out.HTTPStatus = &status
	}
	switch probe.Outcome {
	case InterfaceValid:
		out.State = StateHealthy
	case InterfaceHTTP4xx:
		out.State = StateHealthy
		out.Reason = InterfaceHTTP4xx
	case InterfaceHTTP5xx:
		out.State = StateUnhealthy
		out.Reason = InterfaceHTTP5xx
	case InterfaceRefused:
		out.State = StateUnhealthy
		out.Reason = InterfaceRefused
	case InterfaceTimeout:
		out.State = StateUnhealthy
		out.Reason = InterfaceTimeout
	case InterfaceInvalid:
		out.State = StateUnhealthy
		out.Reason = InterfaceInvalid
	case InterfaceNotConfig:
		out.State = StateNotConfigured
		out.Reason = ReasonNotConfigured
		out.Measured = false
	default:
		out.State = StateUnknown
		out.Reason = "collection_error"
	}
	return out
}

// NormalizeProbes trims and copies declared probes for storage.
func NormalizeProbes(probes []InterfaceProbe) []InterfaceProbe {
	if len(probes) == 0 {
		return nil
	}
	out := make([]InterfaceProbe, 0, len(probes))
	for _, probe := range probes {
		out = append(out, InterfaceProbe{
			Family: strings.TrimSpace(probe.Family),
			URL:    strings.TrimSpace(probe.URL),
		})
	}
	return out
}

// ProbeEvidenceFromLayer turns one evaluated probe into persisted evidence.
func ProbeEvidenceFromLayer(family, endpoint string, layer LayerEvidence, measuredAt string) ProbeEvidence {
	evidence := ProbeEvidence{
		Family:     family,
		Endpoint:   strings.TrimSpace(endpoint),
		State:      layer.State,
		Reason:     layer.Reason,
		HTTPStatus: layer.HTTPStatus,
		ResponseMs: layer.ResponseMs,
		Measured:   layer.Measured,
	}
	if layer.Measured {
		evidence.MeasuredAt = measuredAt
	}
	return evidence
}

// InterfaceCell is one matrix cell.
type InterfaceCell struct {
	State      string `json:"state"`
	Reason     string `json:"reason,omitempty"`
	HTTPStatus *int   `json:"httpStatus,omitempty"`
	ResponseMs *int64 `json:"responseMs,omitempty"`
	MeasuredAt string `json:"measuredAt,omitempty"`
}

// InterfaceMatrixRow is one target row of the matrix.
type InterfaceMatrixRow struct {
	TargetID       string                   `json:"targetId"`
	ResourceID     string                   `json:"resourceId,omitempty"`
	Name           string                   `json:"name"`
	NFType         string                   `json:"nfType,omitempty"`
	Domain         string                   `json:"domain,omitempty"`
	OverallState   string                   `json:"overallState"`
	Freshness      string                   `json:"freshness"`
	LastMeasuredAt string                   `json:"lastMeasuredAt,omitempty"`
	Cells          map[string]InterfaceCell `json:"cells"`
}

// InterfaceMatrixResponse is the GET /api/nf-health/interfaces payload.
type InterfaceMatrixResponse struct {
	GeneratedAt string               `json:"generatedAt"`
	Columns     []string             `json:"columns"`
	Rows        []InterfaceMatrixRow `json:"rows"`
	Page        PageInfo             `json:"page"`
}

// BuildInterfaceMatrixRow projects one target onto the matrix.
//
// A configured family with no persisted probe result is unknown: configuration
// is not evidence. A measured family whose target measurement has aged out of
// the freshness policy is stale, not healthy.
func BuildInterfaceMatrixRow(target *HealthTarget, now time.Time) InterfaceMatrixRow {
	freshness := EvaluateFreshness(target, now)
	row := InterfaceMatrixRow{
		TargetID:       target.TargetID,
		ResourceID:     target.ResourceID,
		Name:           target.Name,
		NFType:         target.NFType,
		Domain:         target.Domain,
		Freshness:      freshness.State,
		LastMeasuredAt: target.LastMeasuredAt,
		Cells:          map[string]InterfaceCell{},
	}
	if target.LastProjection != nil {
		row.OverallState = target.LastProjection.OverallState
	}
	if row.OverallState == "" {
		row.OverallState = StateUnknown
	}

	for _, family := range CanonicalProbeFamilies {
		cell := InterfaceCell{State: StateNotConfigured}
		if !ProbeConfigured(target, family) {
			row.Cells[family] = cell
			continue
		}
		cell.State = StateUnknown
		if target.LastProjection != nil {
			for _, probe := range target.LastProjection.Probes {
				if probe.Family != family {
					continue
				}
				cell = InterfaceCell{
					State:      probe.State,
					Reason:     probe.Reason,
					HTTPStatus: probe.HTTPStatus,
					ResponseMs: probe.ResponseMs,
					MeasuredAt: probe.MeasuredAt,
				}
				if cell.State == "" {
					cell.State = StateUnknown
				}
				if cell.MeasuredAt == "" {
					cell.State = StateUnknown
				} else if freshness.State == FreshnessStale {
					cell.State = StateStale
				}
				break
			}
		}
		row.Cells[family] = cell
	}
	return row
}

// ProjectProbes copies measured evidence into the persisted projection.
func ProjectProbes(probes []ProbeEvidence) []ProbeProjection {
	if len(probes) == 0 {
		return nil
	}
	out := make([]ProbeProjection, 0, len(probes))
	for _, probe := range probes {
		out = append(out, ProbeProjection{
			Family:     probe.Family,
			State:      probe.State,
			Reason:     probe.Reason,
			HTTPStatus: probe.HTTPStatus,
			ResponseMs: probe.ResponseMs,
			MeasuredAt: probe.MeasuredAt,
		})
	}
	return out
}
