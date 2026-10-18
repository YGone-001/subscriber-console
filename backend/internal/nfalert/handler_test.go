package nfalert

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"subscriber/internal/auth"
	"subscriber/internal/nfhealth"
)

// stubRepo is a handler-facing repository stub.
type stubRepo struct {
	rules   map[string]*AlertRule
	alerts  map[string]*Alert
	listErr error
}

func newStubRepo() *stubRepo {
	return &stubRepo{rules: map[string]*AlertRule{}, alerts: map[string]*Alert{}}
}

func (s *stubRepo) CreateRule(ctx context.Context, req *CreateRuleRequest, actor string) (*AlertRule, error) {
	rule := &AlertRule{
		RuleID:          "0192f0c0-a000-7000-8000-000000000001",
		SchemaVersion:   SchemaVersion,
		Name:            req.Name,
		Enabled:         true,
		ConditionType:   req.ConditionType,
		Condition:       RuleCondition{},
		Severity:        req.Severity,
		CooldownSeconds: DefaultCooldownSeconds,
		Revision:        1,
	}
	if req.Condition != nil {
		rule.Condition = *req.Condition
	}
	s.rules[rule.RuleID] = rule
	return rule, nil
}

func (s *stubRepo) GetRule(ctx context.Context, ruleID string) (*AlertRule, error) {
	if r, ok := s.rules[ruleID]; ok {
		return r, nil
	}
	return nil, ErrNotFound
}

func (s *stubRepo) ListRules(ctx context.Context, filter RuleListFilter) ([]AlertRule, *string, bool, error) {
	if s.listErr != nil {
		return nil, nil, false, s.listErr
	}
	return []AlertRule{}, nil, false, nil
}

func (s *stubRepo) UpdateRule(ctx context.Context, ruleID string, req *UpdateRuleRequest, actor string) (*AlertRule, *AlertRule, error) {
	existing, ok := s.rules[ruleID]
	if !ok {
		return nil, nil, ErrNotFound
	}
	if existing.Revision != req.ExpectedRevision {
		return nil, nil, ErrRevisionConflict
	}
	updated := *existing
	updated.Name = req.Rule.Name
	updated.Revision = existing.Revision + 1
	s.rules[ruleID] = &updated
	return existing, &updated, nil
}

func (s *stubRepo) DeleteRule(ctx context.Context, ruleID string, actor string) (*AlertRule, []Alert, error) {
	existing, ok := s.rules[ruleID]
	if !ok {
		return nil, nil, ErrNotFound
	}
	delete(s.rules, ruleID)
	return existing, []Alert{}, nil
}

func (s *stubRepo) GetAlert(ctx context.Context, alertID string) (*Alert, error) {
	if a, ok := s.alerts[alertID]; ok {
		return a, nil
	}
	return nil, ErrAlertNotFound
}

func (s *stubRepo) ListAlerts(ctx context.Context, filter AlertListFilter) ([]Alert, *string, bool, error) {
	if s.listErr != nil {
		return nil, nil, false, s.listErr
	}
	return []Alert{}, nil, false, nil
}

func (s *stubRepo) AcknowledgeAlert(ctx context.Context, alertID, actor string) (*Alert, error) {
	a, ok := s.alerts[alertID]
	if !ok {
		return nil, ErrAlertNotFound
	}
	if a.State == AlertStateResolved {
		return nil, ErrAlertResolved
	}
	a.State = AlertStateAcknowledged
	return a, nil
}

func (s *stubRepo) ResolveAlert(ctx context.Context, alertID, actor string) (*Alert, error) {
	a, ok := s.alerts[alertID]
	if !ok {
		return nil, ErrAlertNotFound
	}
	if a.State == AlertStateResolved {
		return nil, ErrAlertResolved
	}
	a.State = AlertStateResolved
	a.ResolvedReason = ResolveReasonManual
	return a, nil
}

// stubLimiter accepts every request.
type stubLimiter struct{}

func (stubLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	return true
}

const (
	viewerToken   = "viewer"
	operatorToken = "operator"
)

// authStub installs a principal for the token used by the test client. It
// mirrors the production middleware contract without JWT machinery.
func withPrincipal(role string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := &auth.Principal{Username: role + "-user", Role: role, NormalizedRole: role}
		next(w, r.WithContext(auth.ContextWithPrincipal(r.Context(), p)))
	}
}

func newTestServer(repo RepositoryAPI) *Handler {
	return NewHandler(repo, stubLimiter{}, nil)
}

func doJSON(h http.HandlerFunc, method, target, token string, body any) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

// doRouted executes a request through a real ServeMux so path values are
// populated exactly as in production.
func doRouted(h *Handler, method, target, role string, body any) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/nf-alerts", withPrincipal(role, h.ListAlerts))
	mux.HandleFunc("GET /api/nf-alerts/meta", withPrincipal(role, h.Meta))
	mux.HandleFunc("GET /api/nf-alerts/rules", withPrincipal(role, h.ListRules))
	mux.HandleFunc("POST /api/nf-alerts/rules", withPrincipal(role, h.CreateRule))
	mux.HandleFunc("GET /api/nf-alerts/rules/{ruleId}", withPrincipal(role, h.GetRule))
	mux.HandleFunc("PUT /api/nf-alerts/rules/{ruleId}", withPrincipal(role, h.UpdateRule))
	mux.HandleFunc("DELETE /api/nf-alerts/rules/{ruleId}", withPrincipal(role, h.DeleteRule))
	mux.HandleFunc("POST /api/nf-alerts/{alertId}/acknowledge", withPrincipal(role, h.AcknowledgeAlert))
	mux.HandleFunc("POST /api/nf-alerts/{alertId}/resolve", withPrincipal(role, h.ResolveAlert))

	var reader *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	m := decodeBody(t, rec)
	code, _ := m["code"].(string)
	return code
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&m); err != nil {
		t.Fatalf("failed to decode response body: %v", err)
	}
	return m
}

func TestCreateRuleRequiresConfigure(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doJSON(withPrincipal("viewer", h.CreateRule), "POST", "/api/nf-alerts/rules", viewerToken, map[string]any{
		"name": "r", "conditionType": ConditionTypeState,
		"condition": map[string]any{"scope": "overall", "state": "unhealthy"},
		"severity":  SeverityCritical,
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer must be forbidden, got %d", rec.Code)
	}
}

func TestCreateRuleHappyPath(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doJSON(withPrincipal("operator", h.CreateRule), "POST", "/api/nf-alerts/rules", operatorToken, map[string]any{
		"name":            "AMF unhealthy",
		"conditionType":   "state",
		"condition":       map[string]any{"scope": "overall", "state": "unhealthy"},
		"severity":        "critical",
		"cooldownSeconds": 0,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	m := decodeBody(t, rec)
	if m["ruleId"] != "0192f0c0-a000-7000-8000-000000000001" {
		t.Fatalf("unexpected rule id: %v", m["ruleId"])
	}
	if m["cooldownSeconds"].(float64) != DefaultCooldownSeconds {
		t.Fatalf("zero cooldown must normalize to default, got %v", m["cooldownSeconds"])
	}
}

func TestCreateRuleRejectsUnknownFieldsAndBadPayload(t *testing.T) {
	h := newTestServer(newStubRepo())
	// Unknown field must be rejected (strict decoding).
	rec := doJSON(withPrincipal("operator", h.CreateRule), "POST", "/api/nf-alerts/rules", operatorToken, map[string]any{
		"name": "r", "conditionType": "state", "severity": "critical", "unexpected": true,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field must be rejected, got %d", rec.Code)
	}
	// Trailing content after JSON must be rejected.
	req := httptest.NewRequest("POST", "/api/nf-alerts/rules", strings.NewReader(`{"name":"r","conditionType":"state","severity":"critical"} trailing`))
	req.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	withPrincipal("operator", h.CreateRule)(rec2, req)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("trailing content must be rejected, got %d", rec2.Code)
	}
	// Empty body must be rejected.
	req3 := httptest.NewRequest("POST", "/api/nf-alerts/rules", strings.NewReader(""))
	rec3 := httptest.NewRecorder()
	withPrincipal("operator", h.CreateRule)(rec3, req3)
	if rec3.Code != http.StatusBadRequest {
		t.Fatalf("empty body must be rejected, got %d", rec3.Code)
	}
}

func TestCreateRuleRejectsBothScopeDimensions(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "POST", "/api/nf-alerts/rules", "operator", map[string]any{
		"name": "r", "conditionType": "run_failed", "severity": "critical",
		"targetId":   "0192f0c0-a000-7000-8000-000000000000",
		"resourceId": "0192f0c0-a000-7000-8000-000000000002",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("both dimensions must be rejected, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "NF_ALERT_INVALID_TARGET_SCOPE" {
		t.Fatalf("expected NF_ALERT_INVALID_TARGET_SCOPE, got %q", code)
	}
}

func TestUpdateRuleRevisionConflict(t *testing.T) {
	repo := newStubRepo()
	rule, _ := repo.CreateRule(context.Background(), &CreateRuleRequest{
		Name: "r", ConditionType: ConditionTypeRunFailed, Severity: SeverityCritical,
	}, "op")
	h := newTestServer(repo)
	rec := doRouted(h, "PUT", "/api/nf-alerts/rules/"+rule.RuleID, "operator", map[string]any{
		"expectedRevision": 999,
		"rule": map[string]any{
			"name": "r2", "enabled": true, "conditionType": "run_failed", "severity": "critical", "cooldownSeconds": 0,
		},
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("revision conflict must be 409, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "NF_ALERT_REVISION_CONFLICT" {
		t.Fatalf("expected NF_ALERT_REVISION_CONFLICT, got %q", code)
	}
}

func TestUpdateRuleNotFound(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "PUT", "/api/nf-alerts/rules/0192f0c0-a000-7000-8000-00000000dead", "operator", map[string]any{
		"expectedRevision": 1,
		"rule": map[string]any{
			"name": "r", "enabled": true, "conditionType": "run_failed", "severity": "critical", "cooldownSeconds": 0,
		},
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "NF_ALERT_RULE_NOT_FOUND" {
		t.Fatalf("expected NF_ALERT_RULE_NOT_FOUND, got %q", code)
	}
}

func TestGetRuleRejectsMalformedID(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "GET", "/api/nf-alerts/rules/not-a-uuid", "viewer", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed id must be 400, got %d", rec.Code)
	}
}

func TestDeleteRuleNotFound(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "DELETE", "/api/nf-alerts/rules/0192f0c0-a000-7000-8000-00000000dead", "operator", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestListAlertsRejectsUnsupportedQuery(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "GET", "/api/nf-alerts?state=active&nfType=amf", "viewer", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unsupported query parameter must be 400, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "UNSUPPORTED_QUERY_PARAMETER" {
		t.Fatalf("expected UNSUPPORTED_QUERY_PARAMETER, got %q", code)
	}
}

func TestListAlertsRejectsCursorWithLimit(t *testing.T) {
	h := newTestServer(newStubRepo())
	target := "/api/nf-alerts?cursor=eyJhdCI6IjIwMjYtMTAtMThUMTA6MDA6MDBaIiwiaWQiOiJpZC0xIn0&limit=10"
	rec := doRouted(h, "GET", target, "viewer", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("cursor+limit must be rejected, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "UNSUPPORTED_QUERY_COMBINATION" {
		t.Fatalf("expected UNSUPPORTED_QUERY_COMBINATION, got %q", code)
	}
}

func TestListAlertsRejectsBadStateFilter(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "GET", "/api/nf-alerts?state=Closed", "viewer", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid state filter must be 400, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "NF_ALERT_INVALID_STATE_FILTER" {
		t.Fatalf("expected NF_ALERT_INVALID_STATE_FILTER, got %q", code)
	}
}

func TestListAlertsEmptyResultIsArray(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "GET", "/api/nf-alerts", "viewer", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	m := decodeBody(t, rec)
	alerts, ok := m["alerts"].([]any)
	if !ok || len(alerts) != 0 {
		t.Fatalf("alerts must be an empty array, got %T", m["alerts"])
	}
}

func TestMetaEndpointVocabulary(t *testing.T) {
	h := newTestServer(newStubRepo())
	rec := doRouted(h, "GET", "/api/nf-alerts/meta", "viewer", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	m := decodeBody(t, rec)
	states, _ := m["stateConditionValues"].([]any)
	if len(states) != 3 {
		t.Fatalf("state vocabulary must exclude not_configured and stale: %v", states)
	}
	for _, s := range states {
		if s == nfhealth.StateStale || s == nfhealth.StateNotConfigured {
			t.Fatalf("non-alarmable state advertised in meta: %v", s)
		}
	}
	if m["minCooldownSeconds"].(float64) != MinCooldownSeconds {
		t.Fatalf("meta cooldown bounds mismatch")
	}
}

func TestAcknowledgeAndResolveSemantics(t *testing.T) {
	repo := newStubRepo()
	repo.alerts["0192f0c0-a000-7000-8000-0000000000aa"] = &Alert{
		AlertID: "0192f0c0-a000-7000-8000-0000000000aa",
		RuleID:  "r1", TargetID: "t1", State: AlertStateActive, Severity: SeverityCritical,
	}
	repo.alerts["0192f0c0-a000-7000-8000-0000000000bb"] = &Alert{
		AlertID: "0192f0c0-a000-7000-8000-0000000000bb",
		RuleID:  "r1", TargetID: "t2", State: AlertStateResolved,
	}
	h := newTestServer(repo)

	rec := doRouted(h, "POST", "/api/nf-alerts/0192f0c0-a000-7000-8000-0000000000aa/acknowledge", "operator", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("acknowledge expected 200, got %d", rec.Code)
	}
	// Acknowledging a resolved alert must conflict.
	rec = doRouted(h, "POST", "/api/nf-alerts/0192f0c0-a000-7000-8000-0000000000bb/acknowledge", "operator", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("acknowledging resolved must be 409, got %d", rec.Code)
	}
	if code := errorCode(t, rec); code != "NF_ALERT_INSTANCE_RESOLVED" {
		t.Fatalf("expected NF_ALERT_INSTANCE_RESOLVED, got %q", code)
	}
	// Unknown alert id must 404.
	rec = doRouted(h, "POST", "/api/nf-alerts/0192f0c0-a000-7000-8000-00000000dead/resolve", "operator", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown alert must be 404, got %d", rec.Code)
	}
}

func TestHandlerRequiresAuthentication(t *testing.T) {
	h := newTestServer(newStubRepo())
	// No principal installed: the handler must reject with 401.
	req := httptest.NewRequest("GET", "/api/nf-alerts", nil)
	rec := httptest.NewRecorder()
	h.ListAlerts(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request must be 401, got %d", rec.Code)
	}
}

func TestStubRepoErrorPropagation(t *testing.T) {
	repo := newStubRepo()
	repo.listErr = errors.New("boom")
	h := newTestServer(repo)
	rec := doJSON(withPrincipal("viewer", h.ListAlerts), "GET", "/api/nf-alerts", viewerToken, nil)
	// Unknown repository errors map to the validation fallback path; the
	// contract only guarantees a 4xx/5xx, never a 2xx with partial data.
	if rec.Code < 400 {
		t.Fatalf("repository error must not succeed, got %d", rec.Code)
	}
}
