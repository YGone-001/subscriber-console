package operationsview

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"subscriber/internal/auth"
	"subscriber/internal/discovery"
	"subscriber/internal/inventory"
	"subscriber/internal/nfalert"
	"subscriber/internal/nfhealth"
	"subscriber/internal/topology"
)

// stubInventory implements InventoryStats.
type stubInventory struct {
	counts inventory.ResourceCounts
	err    error
	called bool
}

func (s *stubInventory) ResourceCounts(ctx context.Context) (inventory.ResourceCounts, error) {
	s.called = true
	if s.err != nil {
		return inventory.ResourceCounts{}, s.err
	}
	return s.counts, nil
}

// stubDiscovery implements DiscoveryStats.
type stubDiscovery struct {
	sources    int64
	candidates discovery.ObservationSummary
	sourcesErr error
	summaryErr error
	called     bool
}

func (s *stubDiscovery) CountSources(ctx context.Context) (int, error) {
	s.called = true
	if s.sourcesErr != nil {
		return 0, s.sourcesErr
	}
	return int(s.sources), nil
}

func (s *stubDiscovery) ObservationSummary(ctx context.Context) (discovery.ObservationSummary, error) {
	s.called = true
	if s.summaryErr != nil {
		return discovery.ObservationSummary{}, s.summaryErr
	}
	return s.candidates, nil
}

// stubHealth implements HealthStats.
type stubHealth struct {
	summary nfhealth.HealthTargetStateSummary
	err     error
	called  bool
}

func (s *stubHealth) HealthTargetStateSummary(ctx context.Context, now time.Time) (nfhealth.HealthTargetStateSummary, error) {
	s.called = true
	if s.err != nil {
		return nfhealth.HealthTargetStateSummary{}, s.err
	}
	return s.summary, nil
}

// stubAlerts implements AlertStats.
type stubAlerts struct {
	summary nfalert.AlertSummary
	err     error
	called  bool
}

func (s *stubAlerts) AlertSummary(ctx context.Context) (nfalert.AlertSummary, error) {
	s.called = true
	if s.err != nil {
		return nfalert.AlertSummary{}, s.err
	}
	return s.summary, nil
}

// stubTopology implements TopologyStats.
type stubTopology struct {
	summary topology.EdgeSummary
	err     error
	called  bool
}

func (s *stubTopology) EdgeSummary(ctx context.Context) (topology.EdgeSummary, error) {
	s.called = true
	if s.err != nil {
		return topology.EdgeSummary{}, s.err
	}
	return s.summary, nil
}

// stubLimiter accepts every request.
type stubLimiter struct{}

func (stubLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	return true
}

// denyingLimiter rejects every request with the standard 429 shape.
type denyingLimiter struct{}

func (denyingLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	w.Header().Set("Retry-After", "60")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": "Too many requests"})
	return false
}

func newTestHandler(inv *stubInventory, disc *stubDiscovery, health *stubHealth, alerts *stubAlerts, topo *stubTopology) *Handler {
	fixed := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	service := NewService(inv, disc, health, alerts, topo, func() time.Time { return fixed })
	return NewHandler(service, stubLimiter{}, nil)
}

// withPrincipal installs a principal, mirroring the production middleware
// contract without JWT machinery.
func withPrincipal(role string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if role == "" {
			next(w, r)
			return
		}
		p := &auth.Principal{Username: role + "-user", Role: role, NormalizedRole: role}
		next(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), p)))
	}
}

func doRouted(h *Handler, target, role string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/operations/summary", withPrincipal(role, h.Summary))
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&m); err != nil {
		t.Fatalf("failed to decode response body: %v", err)
	}
	return m
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	m := decodeBody(t, rec)
	code, _ := m["code"].(string)
	return code
}

func fullStubs() (*stubInventory, *stubDiscovery, *stubHealth, *stubAlerts, *stubTopology) {
	return &stubInventory{
			counts: inventory.ResourceCounts{Total: 3, ByKind: map[string]int64{"network_function": 3}},
		},
		&stubDiscovery{
			sources:    2,
			candidates: discovery.ObservationSummary{Seen: 5, Missing: 1, Stale: 2, Linked: 4, Unlinked: 3},
		},
		&stubHealth{
			summary: nfhealth.HealthTargetStateSummary{
				Configured: 4, Enabled: 3,
				FreshnessByState: map[string]int64{"fresh": 2, "stale": 1, "unknown": 1},
				OverallByState:   map[string]int64{"healthy": 2, "stale": 1, "unknown": 1},
				LayersByState: map[string]map[string]int64{
					"process":   {"healthy": 3, "unknown": 1},
					"interface": {"healthy": 2, "not_configured": 2},
					"service":   {"unknown": 4},
				},
			},
		},
		&stubAlerts{
			summary: nfalert.AlertSummary{
				TotalRules: 2, EnabledRules: 1,
				AlertsByState:  map[string]int64{"active": 1, "resolved": 2},
				OpenBySeverity: map[string]int64{"critical": 1},
			},
		},
		&stubTopology{
			summary: topology.EdgeSummary{Total: 4, Active: 3, Retired: 1, ActiveByRelationship: map[string]int64{"contains": 3}},
		}
}

func TestSummaryDefaultsToAllSections(t *testing.T) {
	inv, disc, health, alerts, topo := fullStubs()
	h := newTestHandler(inv, disc, health, alerts, topo)
	rec := doRouted(h, "/api/operations/summary", "viewer")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	m := decodeBody(t, rec)
	sections, _ := m["sections"].([]any)
	if len(sections) != 5 {
		t.Fatalf("expected 5 sections, got %v", m["sections"])
	}
	if m["generatedAt"] != "2026-10-18T12:00:00Z" {
		t.Fatalf("unexpected generatedAt: %v", m["generatedAt"])
	}
	for _, key := range []string{"inventory", "discovery", "health", "alerts", "topology"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("missing section %s", key)
		}
	}
	if !inv.called || !disc.called || !health.called || !alerts.called || !topo.called {
		t.Fatalf("default request must query all sections")
	}
}

func TestSummarySectionSubsetSkipsUnrequestedSources(t *testing.T) {
	inv, disc, health, alerts, topo := fullStubs()
	h := newTestHandler(inv, disc, health, alerts, topo)
	rec := doRouted(h, "/api/operations/summary?sections=discovery,alerts", "viewer")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	m := decodeBody(t, rec)
	if _, ok := m["inventory"]; ok {
		t.Fatalf("unrequested inventory section must be omitted")
	}
	if _, ok := m["discovery"]; !ok {
		t.Fatalf("requested discovery section must be present")
	}
	if _, ok := m["alerts"]; !ok {
		t.Fatalf("requested alerts section must be present")
	}
	if inv.called || health.called || topo.called {
		t.Fatalf("unrequested sections must not be queried")
	}
	if !disc.called || !alerts.called {
		t.Fatalf("requested sections must be queried")
	}
	sections, _ := m["sections"].([]any)
	if len(sections) != 2 {
		t.Fatalf("expected 2 echoed sections, got %v", m["sections"])
	}
}

func TestSummarySectionValues(t *testing.T) {
	inv, disc, health, alerts, topo := fullStubs()
	h := newTestHandler(inv, disc, health, alerts, topo)
	rec := doRouted(h, "/api/operations/summary", "viewer")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	m := decodeBody(t, rec)

	invSection := m["inventory"].(map[string]any)
	if invSection["completeness"] != CompletenessComplete || invSection["scope"] != ScopeFullCollection {
		t.Fatalf("inventory section must be complete/full_collection, got %v", invSection)
	}
	counts := invSection["counts"].(map[string]any)
	if counts["total"].(float64) != 3 {
		t.Fatalf("expected inventory total 3, got %v", counts["total"])
	}

	discSection := m["discovery"].(map[string]any)
	if discSection["sources"].(float64) != 2 {
		t.Fatalf("expected 2 sources, got %v", discSection["sources"])
	}
	candidates := discSection["candidates"].(map[string]any)
	if candidates["seen"].(float64) != 5 || candidates["unlinked"].(float64) != 3 {
		t.Fatalf("unexpected candidates summary: %v", candidates)
	}

	healthSection := m["health"].(map[string]any)
	targets := healthSection["targets"].(map[string]any)
	if targets["configured"].(float64) != 4 || targets["enabled"].(float64) != 3 {
		t.Fatalf("unexpected health targets: %v", targets)
	}

	alertsSection := m["alerts"].(map[string]any)
	alertsBody := alertsSection["alerts"].(map[string]any)
	if alertsBody["enabledRules"].(float64) != 1 {
		t.Fatalf("expected 1 enabled rule, got %v", alertsBody["enabledRules"])
	}
	openBySeverity := alertsBody["openBySeverity"].(map[string]any)
	if openBySeverity["critical"].(float64) != 1 {
		t.Fatalf("expected 1 open critical, got %v", openBySeverity)
	}

	topoSection := m["topology"].(map[string]any)
	edges := topoSection["edges"].(map[string]any)
	if edges["active"].(float64) != 3 || edges["retired"].(float64) != 1 {
		t.Fatalf("unexpected edge summary: %v", edges)
	}
}

func TestSummarySectionFailureMarksOnlyThatSectionUnavailable(t *testing.T) {
	inv, disc, health, alerts, topo := fullStubs()
	inv.err = errors.New("inventory down")
	h := newTestHandler(inv, disc, health, alerts, topo)
	rec := doRouted(h, "/api/operations/summary", "viewer")
	if rec.Code != http.StatusOK {
		t.Fatalf("one failing source must not fail the whole response, got %d: %s", rec.Code, rec.Body.String())
	}
	m := decodeBody(t, rec)
	invSection := m["inventory"].(map[string]any)
	if invSection["completeness"] != CompletenessUnavailable {
		t.Fatalf("failed inventory section must be unavailable, got %v", invSection)
	}
	if invSection["error"] != ErrCodeSectionUnavailable {
		t.Fatalf("failed section must carry the error code, got %v", invSection["error"])
	}
	if _, ok := invSection["counts"]; ok {
		t.Fatalf("failed section must not carry stale counts")
	}
	// All other sections must remain complete.
	for _, key := range []string{"discovery", "health", "alerts", "topology"} {
		section := m[key].(map[string]any)
		if section["completeness"] != CompletenessComplete {
			t.Fatalf("section %s must remain complete, got %v", key, section)
		}
	}
}

func TestSummaryRejectsUnknownAndDuplicatedSections(t *testing.T) {
	inv, disc, health, alerts, topo := fullStubs()
	h := newTestHandler(inv, disc, health, alerts, topo)
	for _, raw := range []string{"bogus", "discovery,bogus", "discovery,discovery", ",discovery", "discovery,"} {
		rec := doRouted(h, "/api/operations/summary?sections="+raw, "viewer")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("sections=%q must be rejected with 400, got %d", raw, rec.Code)
		}
		if errorCode(t, rec) != ErrCodeInvalidSection {
			t.Fatalf("sections=%q must be rejected with %s", raw, ErrCodeInvalidSection)
		}
	}
	if inv.called || disc.called || health.called || alerts.called || topo.called {
		t.Fatalf("rejected requests must not query any source")
	}
}

func TestSummaryRequiresAuthentication(t *testing.T) {
	inv, disc, health, alerts, topo := fullStubs()
	h := newTestHandler(inv, disc, health, alerts, topo)
	rec := doRouted(h, "/api/operations/summary", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request must be 401, got %d", rec.Code)
	}
	if errorCode(t, rec) != "AUTH_INVALID_TOKEN" {
		t.Fatalf("expected AUTH_INVALID_TOKEN, got %v", errorCode(t, rec))
	}
}

func TestSummaryRateLimited(t *testing.T) {
	inv, disc, health, alerts, topo := fullStubs()
	fixed := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	service := NewService(inv, disc, health, alerts, topo, func() time.Time { return fixed })
	h := NewHandler(service, denyingLimiter{}, nil)
	rec := doRouted(h, "/api/operations/summary", "viewer")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited request must be 429, got %d", rec.Code)
	}
	if inv.called || disc.called || health.called || alerts.called || topo.called {
		t.Fatalf("rate-limited request must not query any source")
	}
}

func TestParseSections(t *testing.T) {
	got, err := parseSections("")
	if err != nil || len(got) != 5 {
		t.Fatalf("empty value must default to all sections, got %v, %v", got, err)
	}
	got, err = parseSections("  ")
	if err != nil || len(got) != 5 {
		t.Fatalf("blank value must default to all sections, got %v, %v", got, err)
	}
	got, err = parseSections("health,inventory")
	if err != nil || len(got) != 2 || got[0] != "health" || got[1] != "inventory" {
		t.Fatalf("sections must preserve request order, got %v, %v", got, err)
	}
	got, err = parseSections(" health , inventory ")
	if err != nil || len(got) != 2 {
		t.Fatalf("whitespace around names must be tolerated, got %v, %v", got, err)
	}
	if _, err := parseSections("Inventory"); err == nil {
		t.Fatalf("section names are case sensitive; unknown casing must be rejected")
	}
}
