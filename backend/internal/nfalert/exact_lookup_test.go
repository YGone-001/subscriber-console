package nfalert

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestExactAlertLookupKeepsListEnvelopeAndReadGate(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	repo := newStubRepo()
	repo.alerts[id] = &Alert{AlertID: id, State: AlertStateActive, RuleName: "selected"}
	h := newTestServer(repo)
	for _, role := range []string{"admin", "operator", "viewer"} {
		rec := doRouted(h, "GET", "/api/nf-alerts?alertId="+id, role, nil)
		var body ListAlertsResponse
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &body) != nil || len(body.Alerts) != 1 || body.Alerts[0].AlertID != id || body.Page.HasMore {
			t.Fatalf("exact lookup failed for %s: %d %s", role, rec.Code, rec.Body.String())
		}
	}
	for _, query := range []string{"alertId=", "alertId=bad", "alertId=" + id + "&q=x", "alertId=" + id + "&alertId=" + id} {
		if rec := doRouted(h, "GET", "/api/nf-alerts?"+query, "viewer", nil); rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid exact query accepted: %s (%d)", query, rec.Code)
		}
	}
	if rec := doJSON(h.ListAlerts, "GET", "/api/nf-alerts?alertId="+id, "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous exact lookup accepted: %d", rec.Code)
	}
	if rec := doRouted(h, "GET", "/api/nf-alerts?alertId=10000000-0000-4000-8000-000000000002", "viewer", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("missing exact alert must be 404: %d", rec.Code)
	}
}
