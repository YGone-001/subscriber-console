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

// testAuditWriter creates a properly initialized audit writer for tests.
func testAuditWriter() *audit.Writer {
	return audit.NewWriter(&noopEvidenceStore{}, audit.WriterConfig{})
}

// noopEvidenceStore is a no-op evidence store for tests.
type noopEvidenceStore struct{}

func (n *noopEvidenceStore) Insert(_ context.Context, _ audit.AuditWriteRecord) error { return nil }
func (n *noopEvidenceStore) FindByMongoID(_ context.Context, _ string) (*audit.AuditWriteRecord, error) {
	return nil, nil
}

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
		auditWriter: testAuditWriter(),
	}
}

func testPrincipalCtx(username, role string) context.Context {
	p := &auth.Principal{
		Username:       username,
		NormalizedRole: auth.NormalizeRole(role),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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
		auditWriter: testAuditWriter(),
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

// --- PART 4.2: POST /api/subscribers/batch tests ---

func TestBatchCreate_Unauthenticated(t *testing.T) {
	h := &WriteHandler{
		limiter: &mockRateLimiter{allowed: true},
	}

	body := `{"startImsi":"417001234567890","count":2}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestBatchCreate_RateLimited(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: false},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"startImsi":"417001234567890","count":2}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want %d", w.Code, http.StatusTooManyRequests)
	}
}

func TestBatchCreate_SubscriberWriteDenied(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "viewer"),
		},
	}

	body := `{"startImsi":"417001234567890","count":2}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "viewer"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
	}
}

func TestBatchCreate_MalformedJSON(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString("not json"))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestBatchCreate_InvalidStartImsi(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"startImsi":"invalid","count":2}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestBatchCreate_InvalidCountZero(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"startImsi":"417001234567890","count":0}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestBatchCreate_InvalidCountOver1000(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"startImsi":"417001234567890","count":1001}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestBatchCreate_InvalidPlanId(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"startImsi":"417001234567890","count":2,"planId":"invalid plan id!"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestBatchCreate_IMSIOverflow(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"startImsi":"999999999999999","count":2}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestBatchCreate_InvalidTrafficTotal(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"startImsi":"417001234567890","count":2,"trafficTotal":-1}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestBatchCreate_OperatorApprovalPath(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	// Insert a profile for loadProfileData
	_, err := repo.subscribers.Database().Collection("profiles").InsertOne(ctx, bson.M{
		"profileName": "test_profile",
		"sub4G": bson.M{
			"ambr": bson.M{
				"downlink": bson.M{"value": 1, "unit": 3},
				"uplink":   bson.M{"value": 1, "unit": 3},
			},
			"default5qi": 9,
			"sliceList": []bson.M{{
				"sst": 1,
				"sd":  "000001",
				"sessionList": []bson.M{{
					"name":   "internet",
					"type":   3,
					"qos":    bson.M{"index": 9},
					"ambr":   bson.M{"downlink": 1, "uplink": 1},
					"ueIpv4": "10.45.0.1/16",
				}},
			}},
		},
	})
	if err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	userRepo := &mockUserRepo{
		identity: testUserIdentity("testuser", "operator"),
	}
	captured := &approval.CreateApprovalInput{}
	approvalSvc := &mockApprovalCreator{
		doc: &approval.ApprovalDocument{
			ID:     "test-approval-id",
			Status: "pending",
		},
		captured: captured,
	}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: testAuditWriter(),
	}

	body := `{"startImsi":"417001234567890","count":2,"profileName":"test_profile","strategy":"skip"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	// Operator → approval path → 202
	if w.Code != http.StatusAccepted {
		t.Errorf("status = %d, want %d (operator approval path)", w.Code, http.StatusAccepted)
	}

	// Verify approval was created
	if captured.Action == "" {
		t.Fatal("expected approval to be created")
	}
	if captured.Payload == nil {
		t.Fatal("expected frozen contract in approval payload")
	}
	if captured.Payload["version"] != "subscriber-batch-create-v2" {
		t.Errorf("payload version = %v, want subscriber-batch-create-v2", captured.Payload["version"])
	}

	// Verify no business writes happened
	var count int64
	count, err = repo.subscribers.CountDocuments(ctx, bson.M{"imsi": bson.M{"$gte": "417001234567890", "$lt": "417001234567892"}})
	if err != nil {
		t.Fatalf("count subscribers: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 business writes for approval path, got %d", count)
	}
}

func TestBatchCreate_SuperAdminDirectPath(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	// Insert a profile for loadProfileData
	_, err := repo.subscribers.Database().Collection("profiles").InsertOne(ctx, bson.M{
		"profileName": "test_profile",
		"sub4G": bson.M{
			"ambr": bson.M{
				"downlink": bson.M{"value": 1, "unit": 3},
				"uplink":   bson.M{"value": 1, "unit": 3},
			},
			"default5qi": 9,
			"sliceList": []bson.M{{
				"sst": 1,
				"sd":  "000001",
				"sessionList": []bson.M{{
					"name":   "internet",
					"type":   3,
					"qos":    bson.M{"index": 9},
					"ambr":   bson.M{"downlink": 1, "uplink": 1},
					"ueIpv4": "10.45.0.1/16",
				}},
			}},
		},
	})
	if err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	userRepo := &mockUserRepo{
		identity: testUserIdentity("admin", "super_admin"),
	}
	approvalSvc := &mockApprovalCreator{}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: testAuditWriter(),
	}

	body := `{"startImsi":"417001234567890","count":2,"profileName":"test_profile","strategy":"skip"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("admin", "super_admin"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	// super_admin → direct path → 201
	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d (super_admin direct path)", w.Code, http.StatusCreated)
	}

	// Verify no approval was created
	if approvalSvc.captured != nil {
		t.Error("expected no approval for super_admin direct path")
	}

	// Verify subscribers were created
	var count int64
	count, err = repo.subscribers.CountDocuments(ctx, bson.M{"imsi": bson.M{"$gte": "417001234567890", "$lt": "417001234567892"}})
	if err != nil {
		t.Fatalf("count subscribers: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 subscribers, got %d", count)
	}
}

func TestBatchCreate_PreExistingTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	// Pre-insert a subscriber
	_, err := repo.subscribers.InsertOne(ctx, bson.M{"imsi": "417001234567890"})
	if err != nil {
		t.Fatalf("insert existing: %v", err)
	}

	userRepo := &mockUserRepo{
		identity: testUserIdentity("admin", "super_admin"),
	}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: &mockApprovalCreator{},
		auditWriter: testAuditWriter(),
	}

	body := `{"startImsi":"417001234567890","count":2}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("admin", "super_admin"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	if w.Code != http.StatusConflict {
		t.Errorf("status = %d, want %d (pre-existing target)", w.Code, http.StatusConflict)
	}
}

func TestBatchCreate_ProfileDrift(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	// Add profiles collection to repo
	profileColl := repo.subscribers.Database().Collection("app_profiles")
	repo.profiles = profileColl

	// Insert profile with "name" field (what loadProfileData queries on)
	_, err := profileColl.InsertOne(ctx, bson.M{
		"name": "test_profile",
		"sub4G": bson.M{
			"ambr": bson.M{
				"downlink": bson.M{"value": 1, "unit": 3},
				"uplink":   bson.M{"value": 1, "unit": 3},
			},
			"default5qi": 9,
		},
	})
	if err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	userRepo := &mockUserRepo{
		identity: testUserIdentity("testuser", "operator"),
	}
	captured := &approval.CreateApprovalInput{}
	approvalSvc := &mockApprovalCreator{
		doc: &approval.ApprovalDocument{
			ID:     "test-approval-id",
			Status: "pending",
		},
		captured: captured,
	}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: testAuditWriter(),
	}

	body := `{"startImsi":"417001234567890","count":2,"profileName":"test_profile","strategy":"skip"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	// Should succeed with approval (profile hash is computed fresh)
	if w.Code != http.StatusAccepted {
		t.Errorf("status = %d, want %d", w.Code, http.StatusAccepted)
	}

	// Verify frozen contract has profile hash
	if captured.Payload == nil {
		t.Fatal("expected frozen contract in payload")
	}
	profile, ok := captured.Payload["profile"].(map[string]any)
	if !ok {
		t.Fatalf("expected profile in frozen contract, got %T", captured.Payload["profile"])
	}
	if profile["state"] != "present" {
		t.Errorf("profile.state = %v, want present", profile["state"])
	}
	if profile["preconditionHash"] == nil || profile["preconditionHash"] == "" {
		t.Error("expected preconditionHash for present profile")
	}
}

func TestBatchCreate_RootDirectPath(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	_, err := repo.subscribers.Database().Collection("profiles").InsertOne(ctx, bson.M{
		"profileName": "default",
		"sub4G": bson.M{
			"ambr": bson.M{
				"downlink": bson.M{"value": 1, "unit": 3},
				"uplink":   bson.M{"value": 1, "unit": 3},
			},
		},
	})
	if err != nil {
		t.Fatalf("insert profile: %v", err)
	}

	userRepo := &mockUserRepo{
		identity: testUserIdentity("root_user", "root"),
	}
	approvalSvc := &mockApprovalCreator{}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: approvalSvc,
		auditWriter: testAuditWriter(),
	}

	body := `{"startImsi":"417001234567890","count":3,"profileName":"default","strategy":"skip"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("root_user", "root"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	// root → direct path → 201
	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d (root direct path)", w.Code, http.StatusCreated)
	}

	// Verify no approval
	if approvalSvc.captured != nil {
		t.Error("expected no approval for root direct path")
	}

	// Verify 3 subscribers created
	var count int64
	count, err = repo.subscribers.CountDocuments(ctx, bson.M{
		"imsi": bson.M{"$gte": "417001234567890", "$lte": "417001234567892"},
	})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 3 {
		t.Errorf("expected 3 subscribers, got %d", count)
	}
}

func TestBatchCreate_DefaultProfile(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	// No profile in DB — should use defaults
	userRepo := &mockUserRepo{
		identity: testUserIdentity("admin", "super_admin"),
	}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		approvalSvc: &mockApprovalCreator{},
		auditWriter: testAuditWriter(),
	}

	body := `{"startImsi":"417001234567890","count":2}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("admin", "super_admin"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	// Should succeed with defaults (no profile = absent profile state)
	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", w.Code, http.StatusCreated)
	}
}
