package nfhealth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"subscriber/internal/auth"
)

func TestValidateTargetProbes(t *testing.T) {
	dest := NewDestinationAllowlist("127.0.0.1:9090,127.0.0.1:9091")

	valid := []InterfaceProbe{
		{Family: ProbeFamilySBI, URL: "http://127.0.0.1:9090/sbi"},
		{Family: ProbeFamilyOAM, URL: "https://127.0.0.1:9091/oam"},
	}
	if err := ValidateTargetProbes(valid, dest); err != nil {
		t.Fatalf("valid probes must be accepted: %v", err)
	}
	if err := ValidateTargetProbes(nil, dest); err != nil {
		t.Fatalf("no probes is valid: %v", err)
	}

	cases := map[string][]InterfaceProbe{
		"metrics family": {
			{Family: ProbeFamilyMetrics, URL: "http://127.0.0.1:9090/metrics"},
		},
		"unknown family": {
			{Family: "nope", URL: "http://127.0.0.1:9090/x"},
		},
		"duplicate family": {
			{Family: ProbeFamilySBI, URL: "http://127.0.0.1:9090/a"},
			{Family: ProbeFamilySBI, URL: "http://127.0.0.1:9090/b"},
		},
		"missing url": {
			{Family: ProbeFamilySBI, URL: " "},
		},
		"bad scheme": {
			{Family: ProbeFamilySBI, URL: "ftp://127.0.0.1:9090/sbi"},
		},
		"credentials": {
			{Family: ProbeFamilySBI, URL: "http://user:pass@127.0.0.1:9090/sbi"},
		},
		"not allowlisted": {
			{Family: ProbeFamilySBI, URL: "http://10.0.0.9:9090/sbi"},
		},
		"too many": {
			{Family: ProbeFamilySBI, URL: "http://127.0.0.1:9090/a"},
			{Family: ProbeFamilyOAM, URL: "http://127.0.0.1:9090/b"},
			{Family: ProbeFamilyHealth, URL: "http://127.0.0.1:9090/c"},
			{Family: ProbeFamilySBI, URL: "http://127.0.0.1:9090/d"},
			{Family: ProbeFamilyOAM, URL: "http://127.0.0.1:9090/e"},
		},
	}
	for name, probes := range cases {
		if err := ValidateTargetProbes(probes, dest); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestEffectiveProbesKeepMetricsFirst(t *testing.T) {
	target := &HealthTarget{
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  "http://127.0.0.1:9090/metrics",
		Probes: []InterfaceProbe{
			{Family: ProbeFamilyOAM, URL: "http://127.0.0.1:9092/oam"},
			{Family: ProbeFamilySBI, URL: "http://127.0.0.1:9091/sbi"},
		},
	}
	probes := EffectiveProbes(target)
	if len(probes) != 3 {
		t.Fatalf("want three probes, got %#v", probes)
	}
	want := []string{ProbeFamilyMetrics, ProbeFamilySBI, ProbeFamilyOAM}
	for i, family := range want {
		if probes[i].Family != family {
			t.Fatalf("probe %d must be %s, got %s", i, family, probes[i].Family)
		}
	}

	processOnly := &HealthTarget{CollectorProfile: CollectorProcessOnly}
	if got := EffectiveProbes(processOnly); len(got) != 0 {
		t.Fatalf("process_only has no HTTP probe: %#v", got)
	}
}

func TestAggregateInterfaceEvidenceTakesWorstMeasured(t *testing.T) {
	healthy := ProbeEvidence{Family: ProbeFamilyMetrics, State: StateHealthy, Measured: true}
	unhealthy := ProbeEvidence{Family: ProbeFamilyOAM, State: StateUnhealthy, Measured: true, Reason: InterfaceHTTP5xx}

	aggregate := AggregateInterfaceEvidence([]ProbeEvidence{healthy, unhealthy})
	if aggregate.State != StateUnhealthy || !aggregate.Measured {
		t.Fatalf("the worst measured probe owns the layer: %#v", aggregate)
	}

	single := AggregateInterfaceEvidence([]ProbeEvidence{healthy})
	if single.State != StateHealthy {
		t.Fatalf("a single metrics probe keeps its state: %#v", single)
	}

	none := AggregateInterfaceEvidence([]ProbeEvidence{{Family: ProbeFamilySBI, State: StateNotConfigured}})
	if none.State != StateNotConfigured || none.Measured {
		t.Fatalf("no measured probe is not_configured: %#v", none)
	}
}

func TestEvaluateReachabilityLayer(t *testing.T) {
	status := 404
	layer := EvaluateReachabilityLayer(&ProbeResult{
		Outcome:    InterfaceHTTP4xx,
		HTTPStatus: status,
		ResponseMs: 12,
	})
	if layer.State != StateHealthy || layer.Reason != InterfaceHTTP4xx || !layer.Measured {
		t.Fatalf("a 4xx still proves the endpoint answered: %#v", layer)
	}
	if layer.HTTPStatus == nil || *layer.HTTPStatus != 404 {
		t.Fatalf("the status must stay in the evidence: %#v", layer)
	}

	failing := EvaluateReachabilityLayer(&ProbeResult{Outcome: InterfaceHTTP5xx, HTTPStatus: 500})
	if failing.State != StateUnhealthy {
		t.Fatalf("a 5xx is unhealthy: %#v", failing)
	}
	refused := EvaluateReachabilityLayer(&ProbeResult{Outcome: InterfaceRefused})
	if refused.State != StateUnhealthy {
		t.Fatalf("a refused connection is unhealthy: %#v", refused)
	}
}

func TestBuildInterfaceMatrixRowStates(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	measuredAt := now.Add(-30 * time.Second).Format(time.RFC3339Nano)
	target := &HealthTarget{
		TargetID:         "target-1",
		ResourceID:       "resource-1",
		Name:             "amf-01",
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  "http://127.0.0.1:9090/metrics",
		Probes: []InterfaceProbe{
			{Family: ProbeFamilySBI, URL: "http://127.0.0.1:9091/sbi"},
		},
		CollectionMode: CollectionManual,
		Enabled:        true,
		LastMeasuredAt: measuredAt,
	}
	row := BuildInterfaceMatrixRow(target, now)
	if row.Cells[ProbeFamilyMetrics].State != StateUnknown {
		t.Fatalf("configured but unmeasured is unknown: %#v", row.Cells[ProbeFamilyMetrics])
	}
	if row.Cells[ProbeFamilySBI].State != StateUnknown {
		t.Fatalf("configured but unmeasured sbi is unknown: %#v", row.Cells[ProbeFamilySBI])
	}
	if row.Cells[ProbeFamilyOAM].State != StateNotConfigured {
		t.Fatalf("an undeclared family is not_configured: %#v", row.Cells[ProbeFamilyOAM])
	}
	if row.OverallState != StateUnknown {
		t.Fatalf("no projection means unknown overall: %q", row.OverallState)
	}

	httpStatus := 200
	responseMs := int64(8)
	target.LastProjection = &TargetProjection{
		OverallState: StateDegraded,
		Probes: []ProbeProjection{
			{Family: ProbeFamilyMetrics, State: StateHealthy, MeasuredAt: measuredAt, HTTPStatus: &httpStatus, ResponseMs: &responseMs},
			{Family: ProbeFamilySBI, State: StateDegraded, MeasuredAt: measuredAt, Reason: "slow"},
		},
	}
	row = BuildInterfaceMatrixRow(target, now)
	if row.OverallState != StateDegraded {
		t.Fatalf("overall comes from the projection: %q", row.OverallState)
	}
	metrics := row.Cells[ProbeFamilyMetrics]
	if metrics.State != StateHealthy || metrics.HTTPStatus == nil || *metrics.HTTPStatus != 200 {
		t.Fatalf("metrics cell must carry its evidence: %#v", metrics)
	}
	if row.Cells[ProbeFamilySBI].State != StateDegraded {
		t.Fatalf("sbi keeps its degraded state: %#v", row.Cells[ProbeFamilySBI])
	}
	if row.Cells[ProbeFamilyHealth].State != StateNotConfigured {
		t.Fatalf("an unconfigured family is never red: %#v", row.Cells[ProbeFamilyHealth])
	}

	// An aged measurement is stale, not healthy, and the cell says so.
	target.LastMeasuredAt = now.Add(-2 * time.Hour).Format(time.RFC3339Nano)
	for i := range target.LastProjection.Probes {
		target.LastProjection.Probes[i].MeasuredAt = target.LastMeasuredAt
	}
	row = BuildInterfaceMatrixRow(target, now)
	if row.Cells[ProbeFamilyMetrics].State != StateStale {
		t.Fatalf("an aged measurement is stale: %#v", row.Cells[ProbeFamilyMetrics])
	}
	if row.Cells[ProbeFamilyOAM].State != StateNotConfigured {
		t.Fatalf("staleness must not turn unconfigured families into evidence: %#v", row.Cells[ProbeFamilyOAM])
	}
}

func TestCollectorRecordsExtraProbeEvidence(t *testing.T) {
	metricsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("# TYPE amf_session gauge\namf_session 2\n"))
	}))
	defer metricsServer.Close()

	reachable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "only POST is served here", http.StatusNotFound)
	}))
	defer reachable.Close()

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer failing.Close()

	allow := strings.Join([]string{
		strings.TrimPrefix(metricsServer.URL, "http://"),
		strings.TrimPrefix(reachable.URL, "http://"),
		strings.TrimPrefix(failing.URL, "http://"),
	}, ",")
	collector := NewCollector(
		NewHTTPProber(2*time.Second),
		nil,
		NewDestinationAllowlist(allow),
		NewServiceUnitAllowlist(""),
	)
	target := newTestTarget(t, metricsServer.URL+"/metrics", "", "none")
	target.Probes = []InterfaceProbe{
		{Family: ProbeFamilySBI, URL: reachable.URL + "/sbi"},
		{Family: ProbeFamilyOAM, URL: failing.URL + "/oam"},
	}

	result, err := collector.Collect(context.Background(), target, "tester", false)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if result.Sample == nil {
		t.Fatal("a measured collection must produce a sample")
	}
	if len(result.Sample.Probes) != 3 {
		t.Fatalf("want evidence for three probes, got %#v", result.Sample.Probes)
	}
	byFamily := map[string]ProbeEvidence{}
	for _, probe := range result.Sample.Probes {
		byFamily[probe.Family] = probe
	}
	if byFamily[ProbeFamilyMetrics].State != StateHealthy {
		t.Fatalf("metrics probe must be healthy: %#v", byFamily[ProbeFamilyMetrics])
	}
	if sbi := byFamily[ProbeFamilySBI]; sbi.State != StateHealthy || sbi.Reason != InterfaceHTTP4xx || !sbi.Measured {
		t.Fatalf("a 4xx proves the interface answered: %#v", sbi)
	}
	if oam := byFamily[ProbeFamilyOAM]; oam.State != StateUnhealthy || oam.Reason != InterfaceHTTP5xx {
		t.Fatalf("a 5xx is unhealthy: %#v", oam)
	}
	if result.Sample.Layers.Interface.State != StateUnhealthy {
		t.Fatalf("L2 aggregates the worst probe: %#v", result.Sample.Layers.Interface)
	}

	projection := BuildTargetProjection(target, &result.Sample.Layers, result.Sample.Probes, time.Now().UTC())
	if len(projection.Probes) != 3 {
		t.Fatalf("the projection must persist every probe: %#v", projection.Probes)
	}
	target.LastProjection = &projection
	target.LastMeasuredAt = result.Sample.CollectedAt
	row := BuildInterfaceMatrixRow(target, time.Now().UTC())
	if row.Cells[ProbeFamilySBI].State != StateHealthy {
		t.Fatalf("the matrix reads the projection: %#v", row.Cells[ProbeFamilySBI])
	}
	if row.Cells[ProbeFamilyOAM].State != StateUnhealthy {
		t.Fatalf("the matrix keeps the failing family: %#v", row.Cells[ProbeFamilyOAM])
	}
}

/* ----------------------------------------------------------------- handler -- */

type matrixRepo struct {
	targets []HealthTarget
	next    *string
	hasMore bool
	err     error
	filter  TargetListFilter
}

func (r *matrixRepo) CreateTarget(context.Context, *CreateTargetRequest, string) (*HealthTarget, error) {
	return nil, nil
}

func (r *matrixRepo) GetTarget(context.Context, string) (*HealthTarget, error) { return nil, nil }

func (r *matrixRepo) ListTargets(_ context.Context, filter TargetListFilter) ([]HealthTarget, *string, bool, error) {
	r.filter = filter
	return r.targets, r.next, r.hasMore, r.err
}

func (r *matrixRepo) UpdateTarget(context.Context, string, *UpdateTargetRequest, string) (*HealthTarget, *HealthTarget, error) {
	return nil, nil, nil
}

func (r *matrixRepo) InsertRun(context.Context, *HealthRun) error { return nil }

func (r *matrixRepo) GetRun(context.Context, string) (*HealthRun, error) { return nil, nil }

func (r *matrixRepo) ListRuns(context.Context, RunListFilter) ([]HealthRun, *string, bool, error) {
	return nil, nil, false, nil
}

func (r *matrixRepo) InsertSample(context.Context, *HealthSample) error { return nil }

func (r *matrixRepo) GetSample(context.Context, string) (*HealthSample, error) { return nil, nil }

func (r *matrixRepo) ListSamples(context.Context, SampleListFilter) ([]HealthSample, *string, bool, error) {
	return nil, nil, false, nil
}

func (r *matrixRepo) LatestStatusForTargets(context.Context, []string) (map[string]BatchTargetStatus, error) {
	return nil, nil
}

func (r *matrixRepo) RecordCollection(context.Context, *HealthTarget, *CollectionResult) error {
	return nil
}

func TestInterfaceMatrixHandler(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	repo := &matrixRepo{targets: []HealthTarget{{
		TargetID:         "target-1",
		Name:             "amf-01",
		CollectorProfile: CollectorHTTPMetrics,
		MetricsEndpoint:  "http://127.0.0.1:9090/metrics",
		CollectionMode:   CollectionManual,
		LastMeasuredAt:   now,
		LastProjection: &TargetProjection{
			OverallState: StateHealthy,
			Probes: []ProbeProjection{
				{Family: ProbeFamilyMetrics, State: StateHealthy, MeasuredAt: now},
			},
		},
	}}}
	handler := NewHandler(repo, nil, nil, nil, nil, nil, nil)

	principal := &auth.Principal{Username: "viewer", Role: "viewer", NormalizedRole: "viewer"}
	req := httptest.NewRequest(http.MethodGet, "/api/nf-health/interfaces?domain=5gc", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	recorder := httptest.NewRecorder()
	handler.InterfaceMatrix(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("matrix must be readable, got %d (%s)", recorder.Code, recorder.Body.String())
	}
	var payload InterfaceMatrixResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Columns) != len(CanonicalProbeFamilies) {
		t.Fatalf("columns must be the server vocabulary: %#v", payload.Columns)
	}
	if len(payload.Rows) != 1 || payload.Rows[0].Cells[ProbeFamilyMetrics].State != StateHealthy {
		t.Fatalf("unexpected row: %#v", payload.Rows)
	}
	if repo.filter.Sort != TargetSortRisk {
		t.Fatalf("the matrix defaults to the duty queue order: %#v", repo.filter)
	}
	if repo.filter.Domain != "5gc" {
		t.Fatalf("the domain filter must reach the query: %#v", repo.filter)
	}

	bad := httptest.NewRequest(http.MethodGet, "/api/nf-health/interfaces?sort=nope", nil)
	bad = bad.WithContext(auth.ContextWithPrincipal(bad.Context(), principal))
	recorder = httptest.NewRecorder()
	handler.InterfaceMatrix(recorder, bad)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("an unknown sort token must be rejected, got %d", recorder.Code)
	}

	unsupported := httptest.NewRequest(http.MethodGet, "/api/nf-health/interfaces?enabled=true", nil)
	unsupported = unsupported.WithContext(auth.ContextWithPrincipal(unsupported.Context(), principal))
	recorder = httptest.NewRecorder()
	handler.InterfaceMatrix(recorder, unsupported)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("unsupported parameters must be rejected, got %d", recorder.Code)
	}

	anonymous := httptest.NewRecorder()
	handler.InterfaceMatrix(anonymous, httptest.NewRequest(http.MethodGet, "/api/nf-health/interfaces", nil))
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("the matrix requires a session, got %d", anonymous.Code)
	}
}
