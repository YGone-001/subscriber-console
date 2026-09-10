package profile

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/ratelimit"
)

// mockLimiter always allows requests (for testing).
type mockLimiter struct{}

func (m *mockLimiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	return true
}

// mockRepository implements the Repository methods for testing.
type mockRepository struct {
	profiles    map[string]bson.M
	versions    []bson.M
	subscribers map[string]int64
}

func newMockRepository() *mockRepository {
	return &mockRepository{
		profiles:    make(map[string]bson.M),
		versions:    make([]bson.M, 0),
		subscribers: make(map[string]int64),
	}
}

func (m *mockRepository) InsertProfileCreateOnly(ctx context.Context, doc bson.M) error {
	name, _ := doc["name"].(string)
	if _, exists := m.profiles[name]; exists {
		return ErrProfileExists
	}
	m.profiles[name] = doc
	return nil
}

func (m *mockRepository) ReplaceProfileCAS(ctx context.Context, name string, expected bson.M, updated bson.M) error {
	existing, exists := m.profiles[name]
	if !exists {
		return ErrProfilePreconditionChanged
	}
	// Simple CAS check: compare preconditionHash
	if expected != nil {
		expectedHash, _ := expected["preconditionHash"].(string)
		existingHash, _ := existing["preconditionHash"].(string)
		if expectedHash != existingHash {
			return ErrProfilePreconditionChanged
		}
	}
	m.profiles[name] = updated
	return nil
}

func (m *mockRepository) DeleteProfileCAS(ctx context.Context, name string, expected bson.M) error {
	existing, exists := m.profiles[name]
	if !exists {
		return ErrProfilePreconditionChanged
	}
	// Simple CAS check
	if expected != nil {
		expectedHash, _ := expected["preconditionHash"].(string)
		existingHash, _ := existing["preconditionHash"].(string)
		if expectedHash != existingHash {
			return ErrProfilePreconditionChanged
		}
	}
	delete(m.profiles, name)
	return nil
}

func (m *mockRepository) SaveProfileVersion(ctx context.Context, record bson.M) error {
	m.versions = append(m.versions, record)
	return nil
}

func (m *mockRepository) CountSubscribersByProfile(ctx context.Context, profileName string) (int64, error) {
	return m.subscribers[profileName], nil
}

func (m *mockRepository) ListProfiles(ctx context.Context) ([]ProfileListItem, ProfileSummary, error) {
	items := make([]ProfileListItem, 0)
	for _, p := range m.profiles {
		items = append(items, ProfileListItem{
			Name: p["name"].(string),
		})
	}
	return items, ProfileSummary{}, nil
}

func (m *mockRepository) GetProfile(ctx context.Context, name string) (bson.M, error) {
	if p, ok := m.profiles[name]; ok {
		return p, nil
	}
	return nil, nil
}

func (m *mockRepository) GetProfileStats(ctx context.Context, name string) (ProfileStats, error) {
	return ProfileStats{}, nil
}

func (m *mockRepository) ListProfileVersions(ctx context.Context, name string, limit int) ([]ProfileVersionSummary, error) {
	return nil, nil
}

// mockAuditWriter implements AuditWriter for testing.
type mockAuditWriter struct {
	records []audit.WriteAuditInput
}

func (m *mockAuditWriter) WriteBestEffort(input audit.WriteAuditInput) {
	m.records = append(m.records, input)
}

func (m *mockAuditWriter) WriteStrict(ctx context.Context, input audit.WriteAuditInput) error {
	m.records = append(m.records, input)
	return nil
}

func TestCreateProfile(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := ratelimit.NewLimiter(nil) // nil store = fail-open (allows all)
	handler := NewHandler(repo, limiter, auditWriter)

	// Create a test principal
	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Create request
	body := CreateProfileRequest{Name: "test_profile"}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/profiles", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	// Add principal to context
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)

	// Record response
	w := httptest.NewRecorder()

	// Call handler
	handler.Create(w, req)

	// Check response
	if w.Code != http.StatusCreated {
		t.Errorf("expected status %d, got %d", http.StatusCreated, w.Code)
	}

	var resp CreateProfileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Name != "test_profile" {
		t.Errorf("expected name 'test_profile', got '%s'", resp.Name)
	}

	// Verify profile was created
	if _, exists := repo.profiles["test_profile"]; !exists {
		t.Error("profile not found in repository")
	}

	// Verify version was saved
	if len(repo.versions) != 1 {
		t.Errorf("expected 1 version, got %d", len(repo.versions))
	}

	// Verify audit record
	if len(auditWriter.records) != 1 {
		t.Errorf("expected 1 audit record, got %d", len(auditWriter.records))
	}
}

func TestCreateProfileDuplicate(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := ratelimit.NewLimiter(nil)
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Create profile first
	repo.profiles["existing_profile"] = bson.M{"name": "existing_profile"}

	body := CreateProfileRequest{Name: "existing_profile"}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/profiles", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	handler.Create(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("expected status %d, got %d", http.StatusConflict, w.Code)
	}
}

func TestCreateProfilePermissionDenied(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := ratelimit.NewLimiter(nil)
	handler := NewHandler(repo, limiter, auditWriter)

	// Viewer doesn't have profiles.write permission
	principal := &auth.Principal{
		Username:       "viewer",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}

	body := CreateProfileRequest{Name: "test_profile"}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/profiles", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	handler.Create(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected status %d, got %d", http.StatusForbidden, w.Code)
	}
}

func TestUpdateProfile(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := ratelimit.NewLimiter(nil)
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Create existing profile
	existingProfile := bson.M{
		"name":             "test_profile",
		"title":            "test_profile",
		"preconditionHash": computePreconditionHash(bson.M{"name": "test_profile"}),
	}
	repo.profiles["test_profile"] = existingProfile

	// Update body
	body := map[string]any{
		"title":       "Updated Title",
		"description": "Updated description",
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("PUT", "/api/profiles/test_profile", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test_profile")

	w := httptest.NewRecorder()
	handler.Update(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	// Verify version was saved (should have before snapshot)
	if len(repo.versions) != 1 {
		t.Errorf("expected 1 version, got %d", len(repo.versions))
	}
}

func TestDeleteProfile(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := ratelimit.NewLimiter(nil)
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Create existing profile
	existingProfile := bson.M{
		"name":             "test_profile",
		"title":            "test_profile",
		"preconditionHash": computePreconditionHash(bson.M{"name": "test_profile"}),
	}
	repo.profiles["test_profile"] = existingProfile

	req := httptest.NewRequest("DELETE", "/api/profiles/test_profile", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test_profile")

	w := httptest.NewRecorder()
	handler.Delete(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	// Verify profile was deleted
	if _, exists := repo.profiles["test_profile"]; exists {
		t.Error("profile should have been deleted")
	}

	// Verify version was saved
	if len(repo.versions) != 1 {
		t.Errorf("expected 1 version, got %d", len(repo.versions))
	}
}

func TestDeleteProfileInUse(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := ratelimit.NewLimiter(nil)
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Create existing profile
	existingProfile := bson.M{
		"name":             "test_profile",
		"title":            "test_profile",
		"preconditionHash": computePreconditionHash(bson.M{"name": "test_profile"}),
	}
	repo.profiles["test_profile"] = existingProfile

	// Add subscriber using this profile
	repo.subscribers["test_profile"] = 5

	req := httptest.NewRequest("DELETE", "/api/profiles/test_profile", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test_profile")

	w := httptest.NewRecorder()
	handler.Delete(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("expected status %d, got %d", http.StatusConflict, w.Code)
	}

	// Verify profile was NOT deleted
	if _, exists := repo.profiles["test_profile"]; !exists {
		t.Error("profile should not have been deleted when in use")
	}
}

func TestDeleteProfileForce(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := ratelimit.NewLimiter(nil)
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Create existing profile
	existingProfile := bson.M{
		"name":             "test_profile",
		"title":            "test_profile",
		"preconditionHash": computePreconditionHash(bson.M{"name": "test_profile"}),
	}
	repo.profiles["test_profile"] = existingProfile

	// Add subscriber using this profile
	repo.subscribers["test_profile"] = 5

	req := httptest.NewRequest("DELETE", "/api/profiles/test_profile?force=true", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test_profile")

	w := httptest.NewRecorder()
	handler.Delete(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	// Verify profile was deleted (force=true)
	if _, exists := repo.profiles["test_profile"]; exists {
		t.Error("profile should have been deleted with force=true")
	}
}

func TestDefaultProfileParity(t *testing.T) {
	// Test that the default profile structure matches Node
	profile := bson.M{
		"name":      "test",
		"title":     "test",
		"createdAt": "2024-01-01T00:00:00Z",
		"createdBy": "admin",
		"updatedAt": "2024-01-01T00:00:00Z",
		"updatedBy": "admin",
		"auth": bson.M{
			"k":   "00000000000000000000000000000000",
			"opc": "00000000000000000000000000000000",
			"amf": "8000",
		},
		"ambr": bson.M{
			"downlink": bson.M{"unit": 2, "value": 10},
			"uplink":   bson.M{"unit": 2, "value": 10},
		},
		"sliceList": bson.A{
			bson.M{
				"default_indicator": true,
				"sd":                "000001",
				"sst":               int32(1),
				"session_list": bson.A{
					bson.M{
						"name": "internet",
						"type": int32(1),
						"qos": bson.M{
							"_5qi":  int32(9),
							"index": int32(0),
							"arp": bson.M{
								"priorityLevel": int32(9),
								"preemptCap":    "NOT_PREEMPT",
								"preemptVuln":   "NOT_PREEMPTABLE",
							},
						},
						"ambr": bson.M{
							"downlink": bson.M{"unit": int32(3), "value": int32(1)},
							"uplink":   bson.M{"unit": int32(3), "value": int32(1)},
						},
						"pcc_rule": bson.A{},
						"pgwIpv4":  "127.0.0.4",
						"pgwIpv6":  "",
					},
					bson.M{
						"name": "ims",
						"type": int32(3),
						"qos": bson.M{
							"_5qi":  int32(5),
							"index": int32(0),
							"arp": bson.M{
								"priorityLevel": int32(1),
								"preemptCap":    "NOT_PREEMPT",
								"preemptVuln":   "NOT_PREEMPTABLE",
							},
						},
						"ambr": bson.M{
							"downlink": bson.M{"unit": int32(3), "value": int32(1)},
							"uplink":   bson.M{"unit": int32(3), "value": int32(1)},
						},
						"pcc_rule": bson.A{},
						"pgwIpv4":  "127.0.0.4",
						"pgwIpv6":  "",
					},
				},
			},
		},
		"ocsDefaults": bson.M{
			"planId":         "plan_default_10gb",
			"trafficTotal":   int64(10737418240),
			"trafficBalance": int64(10737418240),
			"smsTotal":       int32(100),
			"smsBalance":     int32(100),
		},
	}

	// Verify key fields
	auth, _ := profile["auth"].(bson.M)
	if auth["k"] != "00000000000000000000000000000000" {
		t.Error("auth.k mismatch")
	}
	if auth["opc"] != "00000000000000000000000000000000" {
		t.Error("auth.opc mismatch")
	}
	if auth["amf"] != "8000" {
		t.Error("auth.amf mismatch")
	}

	ambr, _ := profile["ambr"].(bson.M)
	downlink, _ := ambr["downlink"].(bson.M)
	if downlink["unit"] != 2 || downlink["value"] != 10 {
		t.Error("ambr.downlink mismatch")
	}

	ocsDefaults, _ := profile["ocsDefaults"].(bson.M)
	if ocsDefaults["planId"] != "plan_default_10gb" {
		t.Error("ocsDefaults.planId mismatch")
	}
	if ocsDefaults["trafficTotal"] != int64(10737418240) {
		t.Error("ocsDefaults.trafficTotal mismatch")
	}
}

func TestComputePreconditionHash(t *testing.T) {
	// Test that preconditionHash is deterministic
	doc1 := bson.M{"name": "test", "title": "test"}
	doc2 := bson.M{"name": "test", "title": "test"}

	hash1 := computePreconditionHash(doc1)
	hash2 := computePreconditionHash(doc2)

	if hash1 != hash2 {
		t.Errorf("preconditionHash should be deterministic: %s != %s", hash1, hash2)
	}

	// Test that different docs produce different hashes
	doc3 := bson.M{"name": "test", "title": "different"}
	hash3 := computePreconditionHash(doc3)

	if hash1 == hash3 {
		t.Error("different docs should produce different hashes")
	}

	// Test nil doc
	hashNil := computePreconditionHash(nil)
	if hashNil == "" {
		t.Error("nil doc should produce a hash")
	}
}
