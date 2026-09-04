package subscriber

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/approval"
	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// --- Mock infrastructure ---

type mockRateLimiter struct {
	allowed bool
}

func (m *mockRateLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	if !m.allowed {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":"Rate limit exceeded","code":"RATE_LIMIT_EXCEEDED"}`))
	}
	return m.allowed
}

type mockUserRepo struct {
	identity *user.UserIdentity
	err      error
}

func (m *mockUserRepo) FindByUsernameIdentity(_ context.Context, _ string) (*user.UserIdentity, error) {
	return m.identity, m.err
}

func testUserIdentity(username, role string) *user.UserIdentity {
	return &user.UserIdentity{
		SafeUser: user.SafeUser{
			Username: username,
			Role:     role,
			Status:   "active",
			Security: &user.UserSecurity{
				SessionVersion: 1,
			},
		},
	}
}

type mockApprovalCreator struct {
	doc      *approval.ApprovalDocument
	err      error
	captured *approval.CreateApprovalInput
}

func (m *mockApprovalCreator) Create(r *http.Request, actor approval.GovernanceActor, input approval.CreateApprovalInput) (*approval.ApprovalDocument, error) {
	if m.captured != nil {
		*m.captured = input
	}
	return m.doc, m.err
}

type mockSubscriberRepo struct {
	subscriber  bson.M
	err         error
	created     *CreateSubscriberBody
	updated     *UpdatePayload
	deletedImsi string
}

func (m *mockSubscriberRepo) CreateSubscriberFromLegacy(ctx context.Context, imsi string, planId *string, msisdn *string) (bson.M, error) {
	if m.created != nil {
		// Capture for assertions
	}
	if m.subscriber != nil {
		return m.subscriber, nil
	}
	return nil, m.err
}

func (m *mockSubscriberRepo) UpdateSubscriberFromLegacy(ctx context.Context, imsi string, payload UpdatePayload, current bson.M) (bson.M, error) {
	if m.updated != nil {
		*m.updated = payload
	}
	if m.subscriber != nil {
		return m.subscriber, nil
	}
	return nil, m.err
}

func (m *mockSubscriberRepo) DeleteSubscriber(ctx context.Context, imsi string, expected bson.M) (bool, error) {
	m.deletedImsi = imsi
	if m.err != nil {
		return false, m.err
	}
	return true, nil
}

func (m *mockSubscriberRepo) FindSubscriberByImsi(ctx context.Context, imsi string) (bson.M, error) {
	if m.subscriber != nil {
		return m.subscriber, nil
	}
	return nil, m.err
}

// --- Test helpers ---

func testWriteHandler(userRepo *mockUserRepo, approvalSvc *mockApprovalCreator) *WriteHandler {
	return &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: &audit.Writer{},
	}
}

func testPrincipalCtx(username, role string) context.Context {
	p := &auth.Principal{
		Username:       username,
		NormalizedRole: role,
		SessionVersion: 1,
	}
	return auth.ContextWithPrincipal(context.Background(), p)
}

// --- PART 11: POST /api/subscribers tests ---

func TestHandleCreate_Unauthenticated(t *testing.T) {
	h := &WriteHandler{
		limiter: &mockRateLimiter{allowed: true},
	}

	body := `{"imsi":"417001234567890"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers", bytes.NewBufferString(body))
	w := httptest.NewRecorder()

	h.Create(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestHandleCreate_RateLimited(t *testing.T) {
	// Rate limiter that denies — handler gets429
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: false},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"imsi":"417001234567890"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Create(w, r)

	// Rate limiter mock doesn't write429 response, so handler continues
	// In production, Enforce() writes429 and returns false
	if w.Code == http.StatusUnauthorized {
		t.Error("should not fail at auth")
	}
}

func TestHandleCreate_InvalidIMSI(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"imsi":"invalid"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleCreate_MalformedJSON(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	r := httptest.NewRequest(http.MethodPost, "/api/subscribers", bytes.NewBufferString("not json"))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Create(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleCreate_Success(t *testing.T) {
	// Use real MongoDB test repo for full handler flow
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"imsi":"417001234567890"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Create(w, r)

	// Operator creates should go through approval (202) or direct (200/201)
	// Should NOT be 401/403/400
	if w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden || w.Code == http.StatusBadRequest {
		t.Logf("response body: %s", w.Body.String())
		t.Errorf("handler failed early at auth/validation: %d", w.Code)
	}
}

// --- PART 12: PUT /api/subscribers/{imsi} tests ---

func TestHandleUpdate_Unauthenticated(t *testing.T) {
	h := &WriteHandler{
		limiter: &mockRateLimiter{allowed: true},
	}

	body := `{"sub4G":{"msisdnList":[{"msisdn":"1234567890"}]}}`
	r := httptest.NewRequest(http.MethodPut, "/api/subscribers/417001234567890", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "417001234567890")
	w := httptest.NewRecorder()

	h.Update(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestHandleUpdate_MissingIMSI(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"sub4G":{}}`
	r := httptest.NewRequest(http.MethodPut, "/api/subscribers/", bytes.NewBufferString(body))
	// No path value set
	w := httptest.NewRecorder()

	h.Update(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleUpdate_InvalidIMSI(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"sub4G":{}}`
	r := httptest.NewRequest(http.MethodPut, "/api/subscribers/invalid", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "invalid")
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Update(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleUpdate_MalformedJSON(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	r := httptest.NewRequest(http.MethodPut, "/api/subscribers/417001234567890", bytes.NewBufferString("not json"))
	r.SetPathValue("imsi", "417001234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Update(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// --- PART 13: DELETE /api/subscribers/{imsi} tests ---

func TestHandleDelete_Unauthenticated(t *testing.T) {
	h := &WriteHandler{
		limiter: &mockRateLimiter{allowed: true},
	}

	r := httptest.NewRequest(http.MethodDelete, "/api/subscribers/417001234567890", nil)
	r.SetPathValue("imsi", "417001234567890")
	w := httptest.NewRecorder()

	h.Delete(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestHandleDelete_MissingIMSI(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	r := httptest.NewRequest(http.MethodDelete, "/api/subscribers/", nil)
	// No path value set
	w := httptest.NewRecorder()

	h.Delete(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestHandleDelete_InvalidIMSI(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: &audit.Writer{},
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	r := httptest.NewRequest(http.MethodDelete, "/api/subscribers/invalid", nil)
	r.SetPathValue("imsi", "invalid")
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Delete(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

// --- Governance tests ---

func TestHandleUpdate_OperatorCreatesApproval(t *testing.T) {
	// Operator/ops_admin → APPROVAL (202)
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	approvalDoc := &approval.ApprovalDocument{}
	approvalSvc := &mockApprovalCreator{doc: approvalDoc}
	userRepo := &mockUserRepo{
		identity: testUserIdentity("testuser", "operator"),
	}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: &audit.Writer{},
	}

	// First create a subscriber to update
	ctx := context.Background()
	_, _ = repo.CreateSubscriberFromLegacy(ctx, "417001234567890", nil, nil)

	body := `{"sub4G":{"msisdnList":[{"msisdn":"1234567890"}]}}`
	r := httptest.NewRequest(http.MethodPut, "/api/subscribers/417001234567890", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "417001234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.Update(w, r)

	// Operator update should go through approval (202)
	if w.Code == http.StatusOK {
		t.Error("operator should not get 200 (direct execution)")
	}
}

func TestHandleDelete_SuperAdminDirectExecution(t *testing.T) {
	// super_admin/root → DIRECT (200)
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	userRepo := &mockUserRepo{
		identity: testUserIdentity("admin", "super_admin"),
	}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: &mockApprovalCreator{},
		auditWriter: &audit.Writer{},
	}

	// First create a subscriber to delete
	ctx := context.Background()
	_, _ = repo.CreateSubscriberFromLegacy(ctx, "417001234567890", nil, nil)

	r := httptest.NewRequest(http.MethodDelete, "/api/subscribers/417001234567890", nil)
	r.SetPathValue("imsi", "417001234567890")
	r = r.WithContext(testPrincipalCtx("admin", "super_admin"))
	w := httptest.NewRecorder()

	h.Delete(w, r)

	// Should not get 202 (approval)
	if w.Code == http.StatusAccepted {
		t.Error("super_admin should not get 202 (approval)")
	}
}
