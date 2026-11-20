package nfhealth

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func windowFixture() (*HealthTarget, []HealthSample, time.Time) {
	now := time.Date(2026, 11, 20, 8, 0, 0, 0, time.UTC)
	target := &HealthTarget{TargetID: "target", ResourceID: "resource", Domain: "5gc", NFType: "SMF", CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint: "http://127.0.0.4:9090/metrics", IntervalSeconds: 120, CollectionMode: CollectionScheduled, Enabled: true}
	samples := []HealthSample{}
	for i := 0; i <= 5; i++ {
		at := now.Add(time.Duration(i-5) * 120 * time.Second).Format(time.RFC3339Nano)
		metrics := []MetricSample{}
		for _, key := range []string{"fivegs_smffunction_sm_n4sessionreport", "fivegs_smffunction_sm_n4sessionreportsucc"} {
			metrics = append(metrics, MetricSample{Key: key, Value: float64(1000 + 20*i), Type: "counter", Unit: "count", Category: CategoryService, ScopeVerified: true, CollectedAt: at})
		}
		samples = append(samples, HealthSample{SampleID: fmt.Sprint(i), TargetID: target.TargetID, ResourceID: target.ResourceID,
			CollectedAt: at, Metrics: metrics, WindowIdentity: "incarnation", WindowBinding: windowBinding(target),
			Layers: LayerSet{Interface: LayerEvidence{State: StateHealthy, Measured: true}, Service: LayerEvidence{State: StateUnknown, Reason: ReasonActivityObserved, Measured: true}}})
	}
	return target, samples, now
}

func TestServiceWindowDeltaPairAndObservationBoundary(t *testing.T) {
	target, samples, now := windowFixture()
	report := EvaluateServiceWindows(target, samples, now, true)
	row := report.Windows[0].Rows[0]
	if row.Quality != "ready" || row.Intervals != 5 || row.CoveragePercent != 100 || row.Delta == nil || *row.Delta != 100 || math.Abs(*row.Rate-1.0/6) > 1e-9 {
		t.Fatalf("wrong interval: %+v", row)
	}
	pair := report.Windows[0].Rows[1]
	if pair.CompletionRatio == nil || *pair.CompletionRatio != 100 || pair.PairReason != "outcome_semantics_unverified" || pair.BusinessJudgement != "not_evaluated" {
		t.Fatalf("unsupported business claim: %+v", pair)
	}
	if report.Windows[1].Rows[0].Quality != "insufficient" {
		t.Fatal("ten minutes cannot prove thirty-minute coverage")
	}
	// The engine never mutates input layers or historical samples.
	if samples[5].Layers.Service.State != StateUnknown {
		t.Fatal("observation changed health")
	}
}

func TestServiceWindowBoundaries(t *testing.T) {
	cases := []struct {
		name   string
		mutate func([]HealthSample)
		reason string
	}{
		{"reset", func(s []HealthSample) { s[5].Metrics[0].Value = 1 }, "counter_reset"},
		{"restart", func(s []HealthSample) { s[5].WindowIdentity = "new" }, "exporter_changed"},
		{"legacy", func(s []HealthSample) { s[5].WindowIdentity = "" }, "identity_unverified"},
		{"privacy", func(s []HealthSample) { s[5].Metrics[0].ScopeVerified = false }, "scope_unverified"},
		{"missing", func(s []HealthSample) { s[2].Metrics = nil }, "metric_missing"},
		{"interface", func(s []HealthSample) { s[2].Layers.Interface.State = StateUnknown }, "interface_invalid"},
		{"resource", func(s []HealthSample) { s[2].ResourceID = "another" }, "identity_mismatch"},
		{"configuration", func(s []HealthSample) { s[2].WindowBinding = "another" }, "configuration_changed"},
		{"duplicate-time", func(s []HealthSample) { s[2].CollectedAt = s[1].CollectedAt }, "timestamp_invalid"},
		{"corrupt", func(s []HealthSample) { s[2].Metrics[0].Value = math.NaN() }, "scope_unverified"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target, samples, now := windowFixture()
			tc.mutate(samples)
			row := EvaluateServiceWindows(target, samples, now, true).Windows[0].Rows[0]
			if row.Excluded[tc.reason] == 0 {
				t.Fatalf("missing exclusion %s: %+v", tc.reason, row)
			}
			if tc.name == "reset" && (row.Delta == nil || *row.Delta != 80) {
				t.Fatal("reset interval was clamped or included")
			}
		})
	}
}

func TestServiceWindowNoTrafficHistoricalTotalsAndScopeMismatch(t *testing.T) {
	target, samples, now := windowFixture()
	for i := range samples {
		for j := range samples[i].Metrics {
			samples[i].Metrics[j].Value = 9999
		}
	}
	report := EvaluateServiceWindows(target, samples, now, true)
	if report.Windows[0].Rows[0].Reason != "no_activity" || report.Windows[0].Rows[1].CompletionRatio != nil || report.Windows[0].Rows[1].PairReason != "no_requests" {
		t.Fatal("historical totals or 0/0 became success")
	}
	for i := range samples {
		samples[i].Metrics[1].Labels = map[string]string{"instance": "other"}
	}
	report = EvaluateServiceWindows(target, samples, now, true)
	if report.Windows[0].Rows[1].PairReason != "pair_missing" {
		t.Fatal("cross-scope pairing")
	}
}

func TestServiceWindowPairRequiresIdenticalIntervals(t *testing.T) {
	target, samples, now := windowFixture()
	// A boundary completion may exceed requests: never clamp it to 100%.
	for i := range samples {
		for j := range samples[i].Metrics {
			if strings.HasSuffix(samples[i].Metrics[j].Key, "succ") {
				samples[i].Metrics[j].Value *= 2
			}
		}
	}
	report := EvaluateServiceWindows(target, samples[:6], now, true)
	if report.Windows[0].Rows[1].CompletionRatio != nil || report.Windows[0].Rows[1].PairReason != "window_boundary_mismatch" {
		t.Fatal("invalid ratio accepted")
	}
	target, samples, now = windowFixture()
	target.IntervalSeconds = 60
	points := []HealthSample{}
	for i := 0; i <= 10; i++ {
		point := samples[0]
		point.SampleID = fmt.Sprint(i)
		point.CollectedAt = now.Add(time.Duration(i-10) * 60 * time.Second).Format(time.RFC3339Nano)
		point.WindowBinding = windowBinding(target)
		point.Metrics = append([]MetricSample(nil), point.Metrics...)
		for j := range point.Metrics {
			point.Metrics[j].Value = float64(i * 20)
		}
		if i == 5 {
			point.Metrics = point.Metrics[:1]
		}
		points = append(points, point)
	}
	paired := EvaluateServiceWindows(target, points, now, true).Windows[0].Rows[1]
	if paired.Quality != "ready" || paired.PairReason != "pair_intervals_differ" || paired.CompletionRatio != nil {
		t.Fatalf("different populations paired: %+v", paired)
	}
}

func TestServiceWindowExtraProbeCannotRewriteMetricsEvidence(t *testing.T) {
	target, samples, now := windowFixture()
	for i := range samples {
		samples[i].Layers.Interface.State = StateDegraded
		samples[i].Probes = []ProbeEvidence{{Family: ProbeFamilyMetrics, State: StateHealthy, Measured: true}, {Family: ProbeFamilySBI, State: StateUnhealthy, Measured: true}}
	}
	if EvaluateServiceWindows(target, samples, now, true).Windows[0].Rows[0].Quality != "ready" {
		t.Fatal("unrelated probe erased metrics interval")
	}
}

func TestServiceWindowFreshnessReadProjectionAndBounds(t *testing.T) {
	target, samples, now := windowFixture()
	latest := samples[len(samples)-1]
	latest.ServiceWindows = EvaluateServiceWindows(target, samples, now, true)
	projected := ProjectServiceWindows(target, &latest, now.Add(181*time.Second))
	if projected.Windows[0].Rows[0].Quality != "stale" || latest.ServiceWindows.Windows[0].Rows[0].Quality != "ready" {
		t.Fatal("read mutated fixed evidence or failed to age it")
	}
	if EvaluateServiceWindows(target, samples, now, false).Complete {
		t.Fatal("truncated history accepted")
	}
	target.MetricsEndpoint = "http://127.0.0.9:9090/metrics"
	if ProjectServiceWindows(target, &latest, now).Reason != "configuration_changed" {
		t.Fatal("old endpoint history accepted")
	}
	if windowScope(MetricSample{Labels: map[string]string{"instance": "x;nf=y"}}) == windowScope(MetricSample{Labels: map[string]string{"instance": "x", "nf": "y"}}) {
		t.Fatal("scope collision")
	}
}

func TestServiceWindowRejectsGapAndDuplicateScope(t *testing.T) {
	target, samples, now := windowFixture()
	samples = append(samples[:2], samples[3:]...)
	row := EvaluateServiceWindows(target, samples, now, true).Windows[0].Rows[0]
	if row.Excluded["gap"] != 1 || row.Quality == "ready" {
		t.Fatalf("bridged missing observation: %+v", row)
	}
	target, samples, now = windowFixture()
	for i := range samples {
		samples[i].Metrics = append(samples[i].Metrics, samples[i].Metrics[0])
	}
	row = EvaluateServiceWindows(target, samples, now, true).Windows[0].Rows[0]
	if row.Quality != "unavailable" || row.Delta != nil {
		t.Fatal("collapsed scopes accepted")
	}
}

func TestServiceWindowThirtyMinuteBoundaryAndOverflow(t *testing.T) {
	target, samples, now := windowFixture()
	points := []HealthSample{}
	for i := 0; i <= 15; i++ {
		point := samples[0]
		point.SampleID = fmt.Sprint(i)
		point.CollectedAt = now.Add(time.Duration(i-15) * 120 * time.Second).Format(time.RFC3339Nano)
		point.Metrics = append([]MetricSample(nil), point.Metrics...)
		for j := range point.Metrics {
			point.Metrics[j].Value = float64(i * 20)
		}
		points = append(points, point)
	}
	row := EvaluateServiceWindows(target, points, now, true).Windows[1].Rows[0]
	if row.Quality != "ready" || row.CoveragePercent != 100 || row.Intervals != 15 {
		t.Fatalf("lost boundary evidence: %+v", row)
	}
	for i := range points {
		points[i].Metrics[0].Value = 0
		if i%2 == 1 {
			points[i].Metrics[0].Value = math.MaxFloat64
		}
	}
	report := EvaluateServiceWindows(target, points, now, true)
	row = report.Windows[1].Rows[0]
	if row.Quality != "unavailable" || row.Reason != "numeric_overflow" {
		t.Fatal("overflow became usable")
	}
	if _, err := json.Marshal(report); err != nil {
		t.Fatal("overflow broke JSON response", err)
	}
}

func TestWindowScopeParserPrivacyAndMalformedLabels(t *testing.T) {
	for _, labels := range []string{"", `{instance="one"}`, `{instance="one",nf="SMF"}`} {
		out, err := ParsePrometheusText([]byte("pfcp_peers_active"+labels+" 1\n"), "now", nil, "5gc", "SMF")
		if err != nil || len(out.Samples) != 1 || !out.Samples[0].ScopeVerified {
			t.Fatalf("safe scope rejected: %s", labels)
		}
	}
	for _, labels := range []string{`{plmnid="00101"}`, `{instance="one",instance="two"}`, `{nf=SMF}`, `{instance="one",broken}`, `{instance="one\"two"}`} {
		out, err := ParsePrometheusText([]byte("pfcp_peers_active"+labels+" 1\n"), "now", nil, "5gc", "SMF")
		if err == nil && len(out.Samples) > 0 && out.Samples[0].ScopeVerified {
			t.Fatalf("unverified scope accepted: %s", labels)
		}
	}
}

func TestWindowExporterRestartAndLocalPIDReuse(t *testing.T) {
	target, _, _ := windowFixture()
	metrics := []MetricSample{{Key: "process_start_time_seconds", Value: 123, ScopeVerified: true}}
	if windowExporterIdentity(target, metrics, "before", "after") != "" {
		t.Fatal("restart during probe accepted")
	}
	if windowExporterIdentity(target, metrics, "same", "same") == "" {
		t.Fatal("stable local incarnation rejected")
	}
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "sys/kernel/random"), 0700)
	_ = os.MkdirAll(filepath.Join(root, "42"), 0700)
	_ = os.WriteFile(filepath.Join(root, "sys/kernel/random/boot_id"), []byte("00000000-0000-0000-0000-000000000001"), 0600)
	_ = os.WriteFile(filepath.Join(root, "42/comm"), []byte("smfd\n"), 0600)
	target.ServiceKind = "process"
	target.ServiceUnit = "smfd"
	process := LayerEvidence{State: StateHealthy, MainPID: 42}
	stat := func(ticks string) {
		_ = os.WriteFile(filepath.Join(root, "42/stat"), []byte("42 (smfd) S "+strings.Repeat("0 ", 18)+ticks), 0600)
	}
	stat("100")
	before := windowProcessToken(root, target, process)
	stat("101")
	after := windowProcessToken(root, target, process)
	if before == "" || after == "" || before == after {
		t.Fatal("PID reuse not distinguished")
	}
	metrics[0].Value = 0
	if windowExporterIdentity(target, metrics, before, before) != "" {
		t.Fatal("missing incarnation accepted")
	}
}

func TestServiceWindowRepositoryPersistsAndReturnsEvidence(t *testing.T) {
	repo, _, cleanup := nfhealthTestRepo(t)
	defer cleanup()
	target, err := repo.CreateTarget(context.Background(), &CreateTargetRequest{Name: "window fixture", ResourceID: "window-resource", CollectorProfile: CollectorHTTPMetrics, MetricsEndpoint: "http://127.0.0.4:9090/metrics", ServiceKind: "none", CollectionMode: CollectionScheduled, IntervalSeconds: 120}, "tester")
	if err != nil {
		t.Fatal(err)
	}
	_, samples, now := windowFixture()
	var lastReport *ServiceWindowReport
	for i := range samples {
		s := samples[i]
		s.TargetID = target.TargetID
		s.ResourceID = target.ResourceID
		s.WindowBinding = windowBinding(target)
		s.RunID = fmt.Sprint("run-", i)
		result := &CollectionResult{Run: HealthRun{RunID: s.RunID, TargetID: target.TargetID, Status: RunStatusSuccess}, Sample: &s}
		if err := repo.RecordCollection(context.Background(), target, result); err != nil {
			t.Fatal(err)
		}
		lastReport = result.Sample.ServiceWindows
	}
	stored, err := repo.GetSample(context.Background(), samples[5].SampleID)
	if err != nil || lastReport == nil || lastReport.Windows[0].Rows[0].Quality != "ready" || stored.WindowIdentity == "" {
		t.Fatalf("missing persisted result: %v %+v", err, stored)
	}
	if stored.ServiceWindows != nil {
		t.Fatal("derived report multiplied historical storage")
	}
	if stored.Layers.Service.State != StateUnknown {
		t.Fatal("observation changed authoritative L3")
	}
	stored.ServiceWindows = lastReport
	raw, _ := json.Marshal(ProjectServiceWindows(target, stored, now))
	if strings.Contains(string(raw), "windowIdentity") || strings.Contains(string(raw), "incarnation") {
		t.Fatal("internal identity exposed")
	}
}
