package ocs

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/user"
)

type createTestEvidenceStore struct{}

func (createTestEvidenceStore) Insert(context.Context, audit.AuditWriteRecord) error { return nil }
func (createTestEvidenceStore) FindByMongoID(context.Context, string) (*audit.AuditWriteRecord, error) {
	return nil, nil
}

type createTestLimiter struct{ allowed bool }

func (l createTestLimiter) Enforce(http.ResponseWriter, *http.Request, string, int, int) bool {
	return l.allowed
}

type createTestUserRepo struct{ identity *user.UserIdentity }

func (r createTestUserRepo) FindByUsernameIdentity(context.Context, string) (*user.UserIdentity, error) {
	return r.identity, nil
}

type fakeContractProvisioner struct {
	contract   bson.M
	adopted    bool
	err        error
	calls      int
	gotIMSI    string
	gotPlan    string
	gotMsisdn  string
	gotTraffic map[string]any
}

func (f *fakeContractProvisioner) ProvisionContractForExistingSubscriber(_ context.Context, imsi, planID, requestedMsisdn string, ocsTraffic map[string]any) (bson.M, bool, error) {
	f.calls++
	f.gotIMSI = imsi
	f.gotPlan = planID
	f.gotMsisdn = requestedMsisdn
	f.gotTraffic = ocsTraffic
	return f.contract, f.adopted, f.err
}

type createTestCodedError struct {
	code    string
	details map[string]any
}

func (e createTestCodedError) Error() string                { return e.code }
func (e createTestCodedError) ErrorCode() string            { return e.code }
func (e createTestCodedError) ErrorDetails() map[string]any { return e.details }

func newCreateHandlerForTest(t *testing.T, provisioner ContractProvisioner) *SubscriberWriteHandler {
	t.Helper()
	identity := &user.UserIdentity{SafeUser: user.SafeUser{
		Username: "testuser",
		Role:     "admin",
		Status:   "active",
		Security: &user.UserSecurity{SessionVersion: 0},
	}}
	return &SubscriberWriteHandler{
		limiter:             createTestLimiter{allowed: true},
		userRepo:            createTestUserRepo{identity: identity},
		auditWriter:         audit.NewWriter(createTestEvidenceStore{}, audit.WriterConfig{}),
		contractProvisioner: provisioner,
	}
}

func postContractCreate(t *testing.T, h *SubscriberWriteHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/ocs/subscribers", bytes.NewBufferString(body))
	principal := &auth.Principal{Username: "testuser", Role: "admin", NormalizedRole: "admin", SessionVersion: 0}
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	w := httptest.NewRecorder()
	h.Create(w, req)
	return w
}

func TestContractCreate_ProvisionsThroughTheSharedWriter(t *testing.T) {
	provisioner := &fakeContractProvisioner{
		contract: bson.M{"imsi": "417010000000301", "plan_id": "plan_a", "status": "active"},
		adopted:  false,
	}
	h := newCreateHandlerForTest(t, provisioner)

	w := postContractCreate(t, h, `{"imsi":"417010000000301","plan_id":"plan_a","msisdn":"963900000301",`+
		`"ocsTraffic":{"traffic_total":1024},"reason":"provision for existing subscriber"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", w.Code, w.Body.String())
	}
	if provisioner.calls != 1 || provisioner.gotIMSI != "417010000000301" || provisioner.gotPlan != "plan_a" || provisioner.gotMsisdn != "963900000301" {
		t.Errorf("provisioner call = %+v", provisioner)
	}
	if provisioner.gotTraffic["traffic_total"] == nil {
		t.Errorf("ocsTraffic was not forwarded: %+v", provisioner.gotTraffic)
	}
	if !strings.Contains(w.Body.String(), `"balanceAdopted":false`) {
		t.Errorf("response must report the adoption decision: %s", w.Body.String())
	}
}

func TestContractCreate_RejectsClientChosenLifecycleStatus(t *testing.T) {
	provisioner := &fakeContractProvisioner{}
	h := newCreateHandlerForTest(t, provisioner)

	w := postContractCreate(t, h, `{"imsi":"417010000000302","plan_id":"plan_a","status":"terminated"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "OCS_INVALID_STATUS") {
		t.Fatalf("status = %d, body=%s; want 400 OCS_INVALID_STATUS", w.Code, w.Body.String())
	}
	if provisioner.calls != 0 {
		t.Error("no provisioning must run when the status is rejected")
	}
}

func TestContractCreate_RequiresAnExplicitPlan(t *testing.T) {
	provisioner := &fakeContractProvisioner{}
	h := newCreateHandlerForTest(t, provisioner)

	w := postContractCreate(t, h, `{"imsi":"417010000000303"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "OCS_PLAN_ID_REQUIRED") {
		t.Fatalf("status = %d, body=%s; want 400 OCS_PLAN_ID_REQUIRED", w.Code, w.Body.String())
	}
	if provisioner.calls != 0 {
		t.Error("no provisioning must run without an explicit plan")
	}
}

func TestContractCreate_MapsRetainedHistoryConflict(t *testing.T) {
	provisioner := &fakeContractProvisioner{err: createTestCodedError{code: "OCS_CONTRACT_RETAINED"}}
	h := newCreateHandlerForTest(t, provisioner)

	w := postContractCreate(t, h, `{"imsi":"417010000000304","plan_id":"plan_a"}`)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "OCS_CONTRACT_RETAINED") {
		t.Fatalf("status = %d, body=%s; want 409 OCS_CONTRACT_RETAINED", w.Code, w.Body.String())
	}
}

func TestContractCreate_SurfacesValidationDetails(t *testing.T) {
	provisioner := &fakeContractProvisioner{
		err: createTestCodedError{code: "VALIDATION_ERROR", details: map[string]any{"message": "ocsTraffic.traffic_total must be non-negative"}},
	}
	h := newCreateHandlerForTest(t, provisioner)

	w := postContractCreate(t, h, `{"imsi":"417010000000305","plan_id":"plan_a"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "ocsTraffic.traffic_total must be non-negative") {
		t.Fatalf("status = %d, body=%s; want 400 with the validation detail", w.Code, w.Body.String())
	}
}

func TestContractCreate_FailsClosedWithoutProvisioner(t *testing.T) {
	h := newCreateHandlerForTest(t, nil)

	w := postContractCreate(t, h, `{"imsi":"417010000000306","plan_id":"plan_a"}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 when no provisioner is wired", w.Code)
	}
}
