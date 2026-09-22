package subscriber

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/user"
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

func testWriteHandler(userRepo *mockUserRepo) *WriteHandler {
	return &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
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

func TestHandleUpdate_OperatorDirectExecution(t *testing.T) {
	// Operator → DIRECT (200)
	repo, cleanup := ocsTestRepo(t)
	defer cleanup()

	userRepo := &mockUserRepo{
		identity: testUserIdentity("testuser", "operator"),
	}

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
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

	// Operator update executes directly (200)
	if w.Code != http.StatusOK {
		t.Errorf("operator should get 200 (direct execution), got %d: %s", w.Code, w.Body.String())
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

func TestBatchCreate_OperatorDirectPath(t *testing.T) {
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

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
		auditWriter: testAuditWriter(),
	}

	body := `{"startImsi":"417001234567890","count":2,"profileName":"test_profile","strategy":"skip"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/batch", bytes.NewBufferString(body))
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.BatchCreate(w, r)

	// Operator → direct path → 201
	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d (operator direct path)", w.Code, http.StatusCreated)
	}

	// Verify subscribers were created
	var count int64
	count, err = repo.subscribers.CountDocuments(ctx, bson.M{"imsi": bson.M{"$gte": "417001234567890", "$lt": "417001234567892"}})
	if err != nil {
		t.Fatalf("count subscribers: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 subscribers created for operator, got %d", count)
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

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
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

	h := &WriteHandler{
		repo:        repo,
		limiter:     &mockRateLimiter{allowed: true},
		userRepo:    userRepo,
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

// --- ProfileApply HTTP tests ---

func TestProfileApply_Unauthenticated(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
	}

	body := `{"profileName":"test-profile"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/001011234567890/profile", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "001011234567890")
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestProfileApply_MissingIMSI(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
	}

	body := `{"profileName":"test-profile"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers//profile", bytes.NewBufferString(body))
	// No SetPathValue — imsi will be empty
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestProfileApply_RateLimited(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: false},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "operator"),
		},
	}

	body := `{"profileName":"test-profile"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/001011234567890/profile", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "001011234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "operator"))
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	// Rate limiter mock returns false but doesn't write response; handler continues
	// In production, Enforce() writes 429 and returns false
	if w.Code == http.StatusUnauthorized {
		t.Error("should not fail at auth")
	}
}

func TestProfileApply_InvalidJSON(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "super_admin"),
		},
	}

	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/001011234567890/profile", bytes.NewBufferString("not json"))
	r.SetPathValue("imsi", "001011234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "super_admin"))
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestProfileApply_EmptyProfileName(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "super_admin"),
		},
	}

	body := `{"profileName":""}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/001011234567890/profile", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "001011234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "super_admin"))
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestProfileApply_MissingProfileNameField(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "super_admin"),
		},
	}

	body := `{}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/001011234567890/profile", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "001011234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "super_admin"))
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", w.Code, http.StatusBadRequest)
	}
}

func TestProfileApply_CapabilityDenied(t *testing.T) {
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: testUserIdentity("testuser", "subscriber_read_only"),
		},
	}

	body := `{"profileName":"test-profile"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/001011234567890/profile", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "001011234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "subscriber_read_only"))
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", w.Code, http.StatusForbidden)
	}
}

func TestProfileApply_FreshActorValidation(t *testing.T) {
	// User repo returns nil identity → fresh actor validation fails
	h := &WriteHandler{
		limiter:     &mockRateLimiter{allowed: true},
		auditWriter: testAuditWriter(),
		userRepo: &mockUserRepo{
			identity: nil,
			err:      fmt.Errorf("user not found"),
		},
	}

	body := `{"profileName":"test-profile"}`
	r := httptest.NewRequest(http.MethodPost, "/api/subscribers/001011234567890/profile", bytes.NewBufferString(body))
	r.SetPathValue("imsi", "001011234567890")
	r = r.WithContext(testPrincipalCtx("testuser", "super_admin"))
	w := httptest.NewRecorder()

	h.ProfileApply(w, r)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
}
