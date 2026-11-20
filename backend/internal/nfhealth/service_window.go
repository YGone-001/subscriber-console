package nfhealth

import (
	"encoding/json"
	"math"
	"sort"
	"time"
)

const ServiceWindowVersion = "interval-observation-v1"
const maxWindowHistory = 200

// Reports are observation-only: no threshold, health state, alert, notification
// or inspection finding is derived from an unverified outcome population.
type ServiceWindowReport struct {
	RulesVersion string          `json:"rulesVersion,omitempty" bson:"rulesVersion,omitempty"`
	Version      string          `json:"version" bson:"version"`
	Mode         string          `json:"mode" bson:"mode"`
	EvaluatedAt  string          `json:"evaluatedAt" bson:"evaluatedAt"`
	Complete     bool            `json:"complete" bson:"complete"`
	Reason       string          `json:"reason,omitempty" bson:"reason,omitempty"`
	Windows      []ServiceWindow `json:"windows" bson:"windows"`
}

type ServiceWindow struct {
	Seconds          int                       `json:"seconds" bson:"seconds"`
	From             string                    `json:"from" bson:"from"`
	To               string                    `json:"to" bson:"to"`
	FreshnessSeconds int                       `json:"freshnessSeconds" bson:"freshnessSeconds"`
	MaxGapSeconds    int                       `json:"maxGapSeconds" bson:"maxGapSeconds"`
	Rows             []ServiceWindowRow        `json:"rows" bson:"rows"`
	BusinessRules    []BusinessRuleObservation `json:"businessRules,omitempty" bson:"businessRules,omitempty"`
}

type ServiceWindowRow struct {
	Metric            string           `json:"metric" bson:"metric"`
	Scope             string           `json:"scope" bson:"scope"`
	Type              string           `json:"type" bson:"type"`
	Unit              string           `json:"unit" bson:"unit"`
	Quality           string           `json:"quality" bson:"quality"`
	Reason            string           `json:"reason" bson:"reason"`
	Points            int              `json:"points" bson:"points"`
	Intervals         int              `json:"intervals" bson:"intervals"`
	CoveredSeconds    float64          `json:"coveredSeconds" bson:"coveredSeconds"`
	CoveragePercent   float64          `json:"coveragePercent" bson:"coveragePercent"`
	Delta             *float64         `json:"delta" bson:"delta"`
	Rate              *float64         `json:"rate" bson:"rate"`
	LatestValue       *float64         `json:"latestValue" bson:"latestValue"`
	Excluded          map[string]int   `json:"excluded" bson:"excluded"`
	Evidence          []WindowInterval `json:"evidence" bson:"evidence"`
	PairMetric        string           `json:"pairMetric,omitempty" bson:"pairMetric,omitempty"`
	PairDelta         *float64         `json:"pairDelta,omitempty" bson:"pairDelta,omitempty"`
	CompletionRatio   *float64         `json:"completionRatioPercent,omitempty" bson:"completionRatioPercent,omitempty"`
	PairReason        string           `json:"pairReason,omitempty" bson:"pairReason,omitempty"`
	BusinessJudgement string           `json:"businessJudgement" bson:"businessJudgement"`
}

// IDs and interval endpoints make each included or excluded delta reviewable.
// No original exposition or removed label value is retained.
type WindowInterval struct {
	FromSampleID string   `json:"fromSampleId" bson:"fromSampleId"`
	ToSampleID   string   `json:"toSampleId" bson:"toSampleId"`
	From         string   `json:"from" bson:"from"`
	To           string   `json:"to" bson:"to"`
	Seconds      float64  `json:"seconds" bson:"seconds"`
	Delta        *float64 `json:"delta" bson:"delta"`
	Reason       string   `json:"reason,omitempty" bson:"reason,omitempty"`
}

func windowLimits(target *HealthTarget) (int, int) {
	interval := target.IntervalSeconds
	if interval < MinIntervalSeconds {
		interval = DefaultIntervalSeconds
	}
	gap := interval * 3 / 2
	return gap, gap
}

func unavailableWindows(now time.Time, reason string) *ServiceWindowReport {
	return &ServiceWindowReport{Version: ServiceWindowVersion, Mode: "observation_only",
		RulesVersion: BusinessRulesVersion, EvaluatedAt: now.UTC().Format(time.RFC3339Nano), Reason: reason, Windows: []ServiceWindow{}}
}

// EvaluateServiceWindows is pure, bounded and deterministic. Failed interface
// observations remain in the sequence so a later success cannot bridge a gap.
func EvaluateServiceWindows(target *HealthTarget, samples []HealthSample, now time.Time, complete bool) *ServiceWindowReport {
	report := unavailableWindows(now, "")
	if target.CollectorProfile != CollectorHTTPMetrics {
		report.Reason = "not_configured"
		report.Complete = true
		return report
	}
	if !complete || len(samples) > maxWindowHistory {
		report.Reason = "history_incomplete"
		return report
	}
	report.Complete = true
	ordered := make([]HealthSample, 0, len(samples))
	for _, sample := range samples {
		at, err := time.Parse(time.RFC3339Nano, sample.CollectedAt)
		if err == nil && !at.After(now) && !at.Before(now.Add(-30*time.Minute)) {
			ordered = append(ordered, sample)
		}
	}
	sort.Slice(ordered, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339Nano, ordered[i].CollectedAt)
		b, _ := time.Parse(time.RFC3339Nano, ordered[j].CollectedAt)
		if a.Equal(b) {
			return ordered[i].SampleID < ordered[j].SampleID
		}
		return a.Before(b)
	})
	if len(ordered) == 0 {
		report.Reason = "no_samples"
		return report
	}
	latest := ordered[len(ordered)-1]
	if latest.WindowBinding == "" {
		report.Reason = "warming_up"
		return report
	}
	if latest.TargetID != target.TargetID || latest.ResourceID != target.ResourceID || latest.WindowBinding != windowBinding(target) {
		report.Reason = "configuration_changed"
		return report
	}
	if latest.WindowIdentity == "" {
		report.Reason = "identity_unverified"
	}
	freshness, gap := windowLimits(target)
	for _, seconds := range []int{600, 1800} {
		window := ServiceWindow{Seconds: seconds, From: now.Add(-time.Duration(seconds) * time.Second).UTC().Format(time.RFC3339Nano),
			To: now.UTC().Format(time.RFC3339Nano), FreshnessSeconds: freshness, MaxGapSeconds: gap, Rows: []ServiceWindowRow{}}
		current := windowSeries(latest.Metrics)
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			metric := current[key][0]
			row := evaluateWindowRow(target, ordered, latest, metric, key, now, seconds, gap, freshness)
			window.Rows = append(window.Rows, row)
		}
		pairWindowRows(&window)
		window.BusinessRules = EvaluateBusinessRules(target, window)
		report.Windows = append(report.Windows, window)
	}
	if len(report.Windows[0].Rows) == 0 {
		report.Reason = "no_supported_service_kpi"
	}
	return report
}

func windowSeries(metrics []MetricSample) map[string][]MetricSample {
	out := map[string][]MetricSample{}
	for i, metric := range metrics {
		if i >= MaxMetricSamples {
			break
		}
		if metric.Category != CategoryService {
			continue
		}
		out[metric.Key+"\x00"+windowScope(metric)] = append(out[metric.Key+"\x00"+windowScope(metric)], metric)
	}
	return out
}

func windowScope(metric MetricSample) string {
	// JSON preserves boundaries even when a safe value contains '=' or ';'.
	raw, _ := json.Marshal(metric.Labels)
	return string(raw)
}

func finiteWindowMetric(metric MetricSample) bool {
	return metric.ScopeVerified && !math.IsNaN(metric.Value) && !math.IsInf(metric.Value, 0) && metric.Value >= 0
}

func windowMetricsValid(sample HealthSample) bool {
	for _, probe := range sample.Probes {
		if probe.Family == ProbeFamilyMetrics {
			return probe.Measured && probe.State == StateHealthy
		}
	}
	return sample.Layers.Interface.Measured && sample.Layers.Interface.State == StateHealthy
}

func evaluateWindowRow(target *HealthTarget, samples []HealthSample, latest HealthSample, metric MetricSample, key string, now time.Time, seconds, gap, freshness int) ServiceWindowRow {
	row := ServiceWindowRow{Metric: metric.Key, Scope: windowScope(metric), Type: metric.Type, Unit: metric.Unit,
		Quality: "insufficient", Reason: "warming_up", Excluded: map[string]int{}, Evidence: []WindowInterval{}, BusinessJudgement: "not_evaluated"}
	lastAt, _ := time.Parse(time.RFC3339Nano, latest.CollectedAt)
	if finiteWindowMetric(metric) {
		value := metric.Value
		row.LatestValue = &value
	}
	from := now.Add(-time.Duration(seconds) * time.Second)
	var points []HealthSample
	timestamps := map[int64]int{}
	for _, sample := range samples {
		at, _ := time.Parse(time.RFC3339Nano, sample.CollectedAt)
		if !at.Before(from) {
			points = append(points, sample)
			timestamps[at.UnixNano()]++
		}
	}
	for _, point := range points {
		series := windowSeries(point.Metrics)[key]
		pointAt, _ := time.Parse(time.RFC3339Nano, point.CollectedAt)
		if timestamps[pointAt.UnixNano()] == 1 && len(series) == 1 && finiteWindowMetric(series[0]) && point.WindowIdentity == latest.WindowIdentity && latest.WindowIdentity != "" &&
			point.WindowBinding == latest.WindowBinding && point.TargetID == target.TargetID && point.ResourceID == target.ResourceID && windowMetricsValid(point) {
			row.Points++
		}
	}
	var total float64
	for i := 1; i < len(points); i++ {
		a, b := points[i-1], points[i]
		ta, _ := time.Parse(time.RFC3339Nano, a.CollectedAt)
		tb, _ := time.Parse(time.RFC3339Nano, b.CollectedAt)
		evidence := WindowInterval{FromSampleID: a.SampleID, ToSampleID: b.SampleID, From: a.CollectedAt, To: b.CollectedAt, Seconds: tb.Sub(ta).Seconds()}
		left, right := windowSeries(a.Metrics)[key], windowSeries(b.Metrics)[key]
		switch {
		case a.TargetID != target.TargetID || b.TargetID != target.TargetID || a.ResourceID != target.ResourceID || b.ResourceID != target.ResourceID:
			evidence.Reason = "identity_mismatch"
		case a.WindowBinding != latest.WindowBinding || b.WindowBinding != latest.WindowBinding:
			evidence.Reason = "configuration_changed"
		case latest.WindowIdentity == "" || a.WindowIdentity == "" || b.WindowIdentity == "":
			evidence.Reason = "identity_unverified"
		case a.WindowIdentity != latest.WindowIdentity || b.WindowIdentity != latest.WindowIdentity:
			evidence.Reason = "exporter_changed"
		case evidence.Seconds < MinIntervalSeconds || timestamps[ta.UnixNano()] != 1 || timestamps[tb.UnixNano()] != 1:
			evidence.Reason = "timestamp_invalid"
		case evidence.Seconds > float64(gap):
			evidence.Reason = "gap"
		case !windowMetricsValid(a) || !windowMetricsValid(b):
			evidence.Reason = "interface_invalid"
		case len(left) == 0 || len(right) == 0:
			evidence.Reason = "metric_missing"
		case len(left) != 1 || len(right) != 1 || !finiteWindowMetric(left[0]) || !finiteWindowMetric(right[0]):
			evidence.Reason = "scope_unverified"
		case left[0].Type != metric.Type || right[0].Type != metric.Type || left[0].Unit != metric.Unit || right[0].Unit != metric.Unit:
			evidence.Reason = "metric_incompatible"
		case metric.Type == "counter" && right[0].Value < left[0].Value:
			evidence.Reason = "counter_reset"
		default:
			if metric.Type == "counter" {
				delta := right[0].Value - left[0].Value
				if math.IsInf(total+delta, 0) {
					evidence.Reason = "numeric_overflow"
				} else {
					evidence.Delta = &delta
					total += delta
				}
			}
			if evidence.Reason == "" {
				row.Intervals++
				row.CoveredSeconds += evidence.Seconds
			}
		}
		if evidence.Reason != "" {
			row.Excluded[evidence.Reason]++
		}
		row.Evidence = append(row.Evidence, evidence)
	}
	row.CoveragePercent = math.Min(100, row.CoveredSeconds/float64(seconds)*100)
	if metric.Type == "counter" && row.Intervals > 0 {
		row.Delta = &total
		rate := total / row.CoveredSeconds
		row.Rate = &rate
	}
	switch {
	case row.Excluded["numeric_overflow"] > 0:
		row.Quality = "unavailable"
		row.Reason = "numeric_overflow"
	case now.Sub(lastAt) > time.Duration(freshness)*time.Second:
		row.Quality = "stale"
		row.Reason = "sample_stale"
	case latest.WindowIdentity == "":
		row.Quality = "unavailable"
		row.Reason = "identity_unverified"
	case len(windowSeries(latest.Metrics)[key]) != 1 || !finiteWindowMetric(metric):
		row.Quality = "unavailable"
		row.Reason = "scope_unverified"
	case !windowMetricsValid(latest):
		row.Quality = "unavailable"
		row.Reason = "interface_invalid"
	case row.Points < 5 || row.Intervals < 4 || row.CoveragePercent+1e-9 < 80:
		row.Reason = "insufficient_coverage"
	case metric.Type == "gauge":
		row.Quality = "ready"
		row.Reason = "activity_only"
	case total == 0:
		row.Quality = "ready"
		row.Reason = "no_activity"
	default:
		row.Quality = "ready"
		row.Reason = "interval_observed"
	}
	return row
}

// Pair only identical included intervals and an identical verified scope. This
// observed completion/request ratio is explicitly not a transaction success
// rate: cross-window completions and outcome semantics remain unverified.
func pairWindowRows(window *ServiceWindow) {
	for i := range window.Rows {
		row := &window.Rows[i]
		def, ok := LookupMetric(row.Metric)
		if !ok || def.HealthRule != HealthRuleSuccessRatioPair {
			continue
		}
		row.PairMetric = def.HealthPair
		row.PairReason = "pair_missing"
		for j := range window.Rows {
			pair := &window.Rows[j]
			if pair.Metric != def.HealthPair || pair.Scope != row.Scope {
				continue
			}
			row.PairReason = "pair_not_ready"
			if row.Quality != "ready" || pair.Quality != "ready" {
				break
			}
			if len(row.Evidence) != len(pair.Evidence) {
				break
			}
			aligned := true
			for k := range row.Evidence {
				a, b := row.Evidence[k], pair.Evidence[k]
				if a.FromSampleID != b.FromSampleID || a.ToSampleID != b.ToSampleID || a.Reason != b.Reason {
					aligned = false
					break
				}
			}
			if !aligned || row.Delta == nil || pair.Delta == nil {
				row.PairReason = "pair_intervals_differ"
				break
			}
			value := *pair.Delta
			row.PairDelta = &value
			if value == 0 {
				row.PairReason = "no_requests"
				break
			}
			if *row.Delta > value {
				row.PairReason = "window_boundary_mismatch"
				break
			}
			ratio := *row.Delta / value * 100
			row.CompletionRatio = &ratio
			row.PairReason = "outcome_semantics_unverified"
			break
		}
	}
}

// Window endpoints stay fixed at collection time. Read projections update freshness
// without changing their endpoints or writing any document.
func ProjectServiceWindows(target *HealthTarget, sample *HealthSample, now time.Time) *ServiceWindowReport {
	if sample == nil || sample.ServiceWindows == nil {
		return unavailableWindows(now, "warming_up")
	}
	if sample.WindowBinding == "" {
		return unavailableWindows(now, "warming_up")
	}
	if sample.WindowBinding != windowBinding(target) {
		return unavailableWindows(now, "configuration_changed")
	}
	if !target.Enabled {
		return unavailableWindows(now, "not_monitored")
	}
	report := *sample.ServiceWindows
	report.EvaluatedAt = now.UTC().Format(time.RFC3339Nano)
	report.Windows = append([]ServiceWindow(nil), report.Windows...)
	at, err := time.Parse(time.RFC3339Nano, sample.CollectedAt)
	freshness, _ := windowLimits(target)
	if err != nil || at.After(now) || now.Sub(at) > time.Duration(freshness)*time.Second {
		report.Reason = "sample_stale"
		for i := range report.Windows {
			report.Windows[i].Rows = append([]ServiceWindowRow(nil), report.Windows[i].Rows...)
			for j := range report.Windows[i].Rows {
				report.Windows[i].Rows[j].Quality = "stale"
				report.Windows[i].Rows[j].Reason = "sample_stale"
			}
			report.Windows[i].BusinessRules = append([]BusinessRuleObservation(nil), report.Windows[i].BusinessRules...)
			for j := range report.Windows[i].BusinessRules {
				report.Windows[i].BusinessRules[j].Status = "stale"
				report.Windows[i].BusinessRules[j].Reason = "sample_stale"
				report.Windows[i].BusinessRules[j].Quality = "stale"
			}
		}
	}
	return &report
}
