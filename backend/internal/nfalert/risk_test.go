package nfalert

import (
	"net/http"
	"testing"
)

func TestAlertRiskRankOrdersTheDutyQueue(t *testing.T) {
	cases := []struct {
		name     string
		state    string
		severity string
		want     int
	}{
		{"critical active leads", AlertStateActive, SeverityCritical, 0},
		{"warning active", AlertStateActive, SeverityWarning, 1},
		{"info active", AlertStateActive, SeverityInfo, 2},
		{"critical acknowledged", AlertStateAcknowledged, SeverityCritical, 10},
		{"warning acknowledged", AlertStateAcknowledged, SeverityWarning, 11},
		{"critical resolved", AlertStateResolved, SeverityCritical, 20},
		{"info resolved trails", AlertStateResolved, SeverityInfo, 22},
	}
	previous := -1
	for _, tc := range cases {
		got := alertRiskRank(tc.state, tc.severity)
		if got != tc.want {
			t.Fatalf("%s: got %d want %d", tc.name, got, tc.want)
		}
		if got <= previous && previous != -1 && tc.want != previous {
			t.Fatalf("%s: rank must increase along the table", tc.name)
		}
		previous = got
	}

	// An unknown token is never promoted above real work: it sorts after the
	// worst known combination instead of masquerading as rank 0.
	if alertRiskRank("unknown", SeverityCritical) <= alertRiskRank(AlertStateResolved, SeverityInfo) {
		t.Fatal("an unknown state must sort behind the resolved tail")
	}
	if alertRiskRank(AlertStateActive, "unknown") <= alertRiskRank(AlertStateActive, SeverityInfo) {
		t.Fatal("an unknown severity must sort behind info")
	}
}

func TestListAlertsAcceptsScopeAndRiskSort(t *testing.T) {
	h := newTestServer(newStubRepo())
	for _, target := range []string{
		"/api/nf-alerts?scope=open",
		"/api/nf-alerts?scope=history",
		"/api/nf-alerts?sort=risk",
		"/api/nf-alerts?scope=open&sort=risk&severity=critical&limit=10",
	} {
		rec := doRouted(h, "GET", target, "viewer", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s must be accepted, got %d (%s)", target, rec.Code, rec.Body.String())
		}
	}
}

func TestListAlertsRejectsContradictoryScope(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "GET", "/api/nf-alerts?scope=open&state=resolved", "viewer", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("scope+state must be 400, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "UNSUPPORTED_QUERY_COMBINATION" {
		t.Fatalf("expected UNSUPPORTED_QUERY_COMBINATION, got %q", code)
	}
}

func TestListAlertsRejectsUnknownScopeAndSort(t *testing.T) {
	h := newTestServer(newStubRepo())
	for _, target := range []string{
		"/api/nf-alerts?scope=recent",
		"/api/nf-alerts?sort=oldest",
	} {
		rec := doRouted(h, "GET", target, "viewer", nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s must be 400, got %d", target, rec.Code)
		}
		if code := errorCode(t, rec); code != "INVALID_QUERY_PARAMETER" {
			t.Fatalf("%s: expected INVALID_QUERY_PARAMETER, got %q", target, code)
		}
	}
}
