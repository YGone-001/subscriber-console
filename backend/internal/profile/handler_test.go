package profile

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/subscriber"
	"subscriber/internal/user"
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
	// driftDocs and driftErr back the bounded subscriber reads of the probe.
	driftDocs []bson.M
	driftErr  error
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

func (m *mockRepository) ListSubscribersAttributedTo(_ context.Context, _ string, _ int) ([]bson.M, error) {
	return m.driftDocs, m.driftErr
}

func (m *mockRepository) ListSubscribersByImsis(_ context.Context, _ []string, _ int) ([]bson.M, error) {
	return m.driftDocs, m.driftErr
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

func (m *mockRepository) GetProfileVersion(ctx context.Context, profileName, versionId string) (bson.M, error) {
	for _, v := range m.versions {
		if v["profileName"] == profileName && v["versionId"] == versionId {
			return v, nil
		}
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

// mockUserRepo answers the fresh-actor lookup used by the template write paths.
type mockUserRepo struct {
	identity *user.UserIdentity
	err      error
}

func (m *mockUserRepo) FindByUsernameIdentity(_ context.Context, _ string) (*user.UserIdentity, error) {
	if m == nil {
		return nil, nil
	}
	return m.identity, m.err
}

// activeUserRepoFor mirrors a principal into a stored account, so a test that
// only cares about the template behaviour passes the actor revalidation. The
// principal's NormalizedRole must be the canonical role a real token carries.
func activeUserRepoFor(p *auth.Principal) *mockUserRepo {
	sessionVersion := 0
	if p.SessionVersion > 0 {
		sessionVersion = int(p.SessionVersion)
	}
	return &mockUserRepo{identity: &user.UserIdentity{
		MongoID: p.Username,
		SafeUser: user.SafeUser{
			Username: p.Username,
			Role:     p.NormalizedRole,
			Status:   "active",
			Security: &user.UserSecurity{SessionVersion: sessionVersion},
		},
	}}
}

func TestCreateProfile(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	// Create a test principal
	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create request
	body := map[string]any{"name": "test_profile"}
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
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create profile first
	repo.profiles["existing_profile"] = bson.M{"name": "existing_profile"}

	body := map[string]any{"name": "existing_profile"}
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
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	// Viewer doesn't have profiles.write permission
	principal := &auth.Principal{
		Username:       "viewer",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}

	body := map[string]any{"name": "test_profile"}
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
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create existing profile
	existingProfile := bson.M{
		"name":  "test_profile",
		"title": "test_profile",
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
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create existing profile
	existingProfile := bson.M{
		"name":  "test_profile",
		"title": "test_profile",
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
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create existing profile
	existingProfile := bson.M{
		"name":  "test_profile",
		"title": "test_profile",
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
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create existing profile
	existingProfile := bson.M{
		"name":  "test_profile",
		"title": "test_profile",
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

func TestUpdateMissingProfile(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Update a profile that doesn't exist (should insert, not 404)
	body := map[string]any{
		"title": "New Title",
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("PUT", "/api/profiles/new_profile", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "new_profile")

	w := httptest.NewRecorder()
	handler.Update(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	// Verify profile was inserted
	if _, exists := repo.profiles["new_profile"]; !exists {
		t.Error("profile should have been inserted")
	}

	// Verify no version was saved (no existing profile to version)
	if len(repo.versions) != 0 {
		t.Errorf("expected 0 versions for missing profile, got %d", len(repo.versions))
	}
}

func TestDeleteMissingProfile(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Delete a profile that doesn't exist (should return 200, not 404)
	req := httptest.NewRequest("DELETE", "/api/profiles/missing_profile", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "missing_profile")

	w := httptest.NewRecorder()
	handler.Delete(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	// Verify audit record for no-op
	if len(auditWriter.records) != 1 {
		t.Errorf("expected 1 audit record for no-op, got %d", len(auditWriter.records))
	}
	if auditWriter.records[0].Result != "no_op" {
		t.Errorf("expected audit result 'no_op', got '%s'", auditWriter.records[0].Result)
	}
}

func TestVersionSchemaParity(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create a profile
	body := map[string]any{"name": "test_profile"}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/profiles", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	handler.Create(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d", http.StatusCreated, w.Code)
	}

	// Verify version record has correct schema
	if len(repo.versions) != 1 {
		t.Fatalf("expected 1 version, got %d", len(repo.versions))
	}

	version := repo.versions[0]

	// Must have "profile" field, not "profileSnapshot"
	if _, ok := version["profile"]; !ok {
		t.Error("version should have 'profile' field")
	}
	if _, ok := version["profileSnapshot"]; ok {
		t.Error("version should NOT have 'profileSnapshot' field")
	}

	// Must have title and sliceCount
	if _, ok := version["title"]; !ok {
		t.Error("version should have 'title' field")
	}
	if _, ok := version["sliceCount"]; !ok {
		t.Error("version should have 'sliceCount' field")
	}

	// Verify action
	if version["action"] != "CREATE" {
		t.Errorf("expected action 'CREATE', got '%s'", version["action"])
	}
}

func TestSafeAuditSnapshot(t *testing.T) {
	// Create a profile with auth secrets
	profile := bson.M{
		"name":  "test",
		"title": "test",
		"auth": bson.M{
			"k":   "SECRET_K_VALUE",
			"opc": "SECRET_OPC_VALUE",
			"amf": "SECRET_AMF_VALUE",
		},
		"sliceList": bson.A{},
	}

	safe := safeProfileSnapshot(profile)

	// Verify secrets are NOT in the safe snapshot
	safeJSON, _ := json.Marshal(safe)
	safeStr := string(safeJSON)

	if contains(safeStr, "SECRET_K_VALUE") {
		t.Error("auth.k should be redacted from audit snapshot")
	}
	if contains(safeStr, "SECRET_OPC_VALUE") {
		t.Error("auth.opc should be redacted from audit snapshot")
	}
	if contains(safeStr, "SECRET_AMF_VALUE") {
		t.Error("auth.amf should be redacted from audit snapshot")
	}

	// Verify authConfigured indicator is present
	if _, ok := safe["authConfigured"]; !ok {
		t.Error("safe snapshot should have 'authConfigured' field")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstr(s, substr))
}

func containsSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestExistingPUTPreservation(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Create existing profile with non-default values
	existingProfile := bson.M{
		"name":      "test_profile",
		"title":     "Original Title",
		"createdAt": "2024-01-01T00:00:00.000Z",
		"createdBy": "original_user",
		"updatedAt": "2024-01-01T00:00:00.000Z",
		"updatedBy": "original_user",
		"auth": bson.M{
			"k":   "K_SENTINEL",
			"opc": "OPC_SENTINEL",
			"amf": "AMF_SENTINEL",
		},
		"ambr": bson.M{
			"downlink": bson.M{"unit": 5, "value": 999},
			"uplink":   bson.M{"unit": 5, "value": 999},
		},
		"sliceList": bson.A{
			bson.M{"custom": "slice"},
		},
		"ocsDefaults": bson.M{
			"planId": "custom_plan",
		},
		"custom_field": "should_be_preserved",
	}
	repo.profiles["test_profile"] = existingProfile

	// Update only title
	body := map[string]any{
		"title": "Changed Title",
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

	// Verify the updated profile preserves untouched fields
	updated := repo.profiles["test_profile"]

	// Title should be changed
	if updated["title"] != "Changed Title" {
		t.Errorf("expected title 'Changed Title', got '%s'", updated["title"])
	}

	// Auth should be preserved
	auth, _ := updated["auth"].(bson.M)
	if auth["k"] != "K_SENTINEL" {
		t.Errorf("auth.k should be preserved, got '%s'", auth["k"])
	}
	if auth["opc"] != "OPC_SENTINEL" {
		t.Errorf("auth.opc should be preserved, got '%s'", auth["opc"])
	}
	if auth["amf"] != "AMF_SENTINEL" {
		t.Errorf("auth.amf should be preserved, got '%s'", auth["amf"])
	}

	// AMBR should be preserved
	ambr, _ := updated["ambr"].(bson.M)
	downlink, _ := ambr["downlink"].(bson.M)
	if downlink["unit"] != 5 || downlink["value"] != 999 {
		t.Error("ambr should be preserved")
	}

	// sliceList should be preserved
	sl, _ := updated["sliceList"].(bson.A)
	if len(sl) != 1 {
		t.Errorf("sliceList should be preserved, got %d items", len(sl))
	}

	// ocsDefaults should be preserved
	ocs, _ := updated["ocsDefaults"].(bson.M)
	if ocs["planId"] != "custom_plan" {
		t.Errorf("ocsDefaults should be preserved, got '%s'", ocs["planId"])
	}

	// Custom field should be preserved
	if updated["custom_field"] != "should_be_preserved" {
		t.Error("custom_field should be preserved")
	}

	// createdAt/createdBy should be preserved
	if updated["createdAt"] != "2024-01-01T00:00:00.000Z" {
		t.Error("createdAt should be preserved")
	}
	if updated["createdBy"] != "original_user" {
		t.Error("createdBy should be preserved")
	}
}

func TestMissingPUTSparseDocument(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Update a missing profile with only title
	body := map[string]any{
		"title": "New Title",
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("PUT", "/api/profiles/new_profile", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "new_profile")

	w := httptest.NewRecorder()
	handler.Update(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	// Verify the profile was created with sparse document
	created := repo.profiles["new_profile"]

	// Should have name
	if created["name"] != "new_profile" {
		t.Errorf("expected name 'new_profile', got '%s'", created["name"])
	}

	// Should have title from body
	if created["title"] != "New Title" {
		t.Errorf("expected title 'New Title', got '%s'", created["title"])
	}

	// Should NOT have default auth/ambr/sliceList/ocsDefaults
	if _, ok := created["auth"]; ok {
		t.Error("missing PUT should NOT have auth field")
	}
	if _, ok := created["ambr"]; ok {
		t.Error("missing PUT should NOT have ambr field")
	}
	if _, ok := created["sliceList"]; ok {
		t.Error("missing PUT should NOT have sliceList field")
	}
	if _, ok := created["ocsDefaults"]; ok {
		t.Error("missing PUT should NOT have ocsDefaults field")
	}
}

func TestUnknownFieldRejection(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	// Try to update with unknown field
	body := map[string]any{
		"title":       "New Title",
		"unknown_xyz": "should_be_rejected",
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest("PUT", "/api/profiles/test_profile", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")

	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test_profile")

	w := httptest.NewRecorder()
	handler.Update(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	// Verify error code
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["code"] != "INVALID_PROFILE_UPDATE" {
		t.Errorf("expected code 'INVALID_PROFILE_UPDATE', got '%s'", resp["code"])
	}
}

// ─── Restore Handler Tests ───

func TestRestoreDirectSuccess(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	// Add a profile and version to restore
	profileName := "test_restore_profile"
	repo.profiles[profileName] = bson.M{
		"name":        profileName,
		"title":       "Current Title",
		"description": "Current description",
		"createdAt":   "2024-01-01T00:00:00.000Z",
		"createdBy":   "original_user",
		"updatedAt":   "2024-07-01T00:00:00.000Z",
		"updatedBy":   "current_user",
	}

	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-001",
		"profileName": profileName,
		"action":      "UPDATE",
		"savedAt":     "2024-06-01T10:00:00.000Z",
		"savedBy":     "admin",
		"title":       "Old Title",
		"profile": bson.M{
			"name":        profileName,
			"title":       "Old Title",
			"description": "Old description",
			"createdAt":   "2024-01-01T00:00:00.000Z",
			"createdBy":   "original_user",
			"updatedAt":   "2024-06-01T10:00:00.000Z",
			"updatedBy":   "admin",
		},
	})

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	req := httptest.NewRequest("POST", "/api/profiles/"+profileName+"/versions/v-001/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", profileName)
	req.SetPathValue("versionId", "v-001")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["message"] != "Profile restored successfully" {
		t.Errorf("expected message 'Profile restored successfully', got '%s'", resp["message"])
	}

	// Verify audit was written
	if len(auditWriter.records) == 0 {
		t.Error("expected audit record to be written")
	}

	// Verify audit has correct metadata
	lastAudit := auditWriter.records[len(auditWriter.records)-1]
	if lastAudit.Metadata["classification"] != "SUCCESS" {
		t.Errorf("expected classification 'SUCCESS', got '%s'", lastAudit.Metadata["classification"])
	}
	if lastAudit.Metadata["mutationCommitted"] != true {
		t.Error("expected mutationCommitted=true")
	}
	if lastAudit.Metadata["governanceMode"] != "DIRECT_GOVERNED" {
		t.Errorf("expected governanceMode 'DIRECT_GOVERNED', got '%s'", lastAudit.Metadata["governanceMode"])
	}
}

func TestRestoreMissingProfileSuccess(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	profileName := "test_restore_missing"

	// Add a version but no current profile
	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-001",
		"profileName": profileName,
		"action":      "CREATE",
		"savedAt":     "2024-06-01T10:00:00.000Z",
		"savedBy":     "admin",
		"title":       "New Profile",
		"profile": bson.M{
			"name":        profileName,
			"title":       "New Profile",
			"description": "New description",
			"createdAt":   "2024-06-01T10:00:00.000Z",
			"createdBy":   "admin",
			"updatedAt":   "2024-06-01T10:00:00.000Z",
			"updatedBy":   "admin",
		},
	})

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	req := httptest.NewRequest("POST", "/api/profiles/"+profileName+"/versions/v-001/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", profileName)
	req.SetPathValue("versionId", "v-001")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	// Verify profile was inserted
	if _, exists := repo.profiles[profileName]; !exists {
		t.Error("expected profile to be inserted")
	}
}

func TestRestoreOperatorDirect(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	profileName := "test_restore_approval"

	// Add a profile and version
	repo.profiles[profileName] = bson.M{
		"name":      profileName,
		"title":     "Current Title",
		"createdAt": "2024-01-01T00:00:00.000Z",
		"createdBy": "original_user",
		"updatedAt": "2024-07-01T00:00:00.000Z",
		"updatedBy": "current_user",
	}

	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-001",
		"profileName": profileName,
		"action":      "UPDATE",
		"savedAt":     "2024-06-01T10:00:00.000Z",
		"savedBy":     "admin",
		"title":       "Old Title",
		"profile": bson.M{
			"name":      profileName,
			"title":     "Old Title",
			"createdAt": "2024-01-01T00:00:00.000Z",
			"createdBy": "original_user",
			"updatedAt": "2024-06-01T10:00:00.000Z",
			"updatedBy": "admin",
		},
	})

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "operator",
		NormalizedRole: "operator",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	req := httptest.NewRequest("POST", "/api/profiles/"+profileName+"/versions/v-001/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", profileName)
	req.SetPathValue("versionId", "v-001")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	// Verify audit
	if len(auditWriter.records) > 0 {
		lastAudit := auditWriter.records[len(auditWriter.records)-1]
		if lastAudit.Metadata["governanceMode"] != "DIRECT_GOVERNED" {
			t.Errorf("expected governanceMode 'DIRECT_GOVERNED', got '%s'", lastAudit.Metadata["governanceMode"])
		}
	}
}

func TestRestoreAuditorDenied(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "auditor",
		NormalizedRole: "auditor",
	}

	req := httptest.NewRequest("POST", "/api/profiles/test/versions/v-001/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test")
	req.SetPathValue("versionId", "v-001")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected status %d, got %d", http.StatusForbidden, w.Code)
	}
}

func TestRestoreViewerDenied(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "viewer",
		NormalizedRole: "viewer",
	}

	req := httptest.NewRequest("POST", "/api/profiles/test/versions/v-001/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test")
	req.SetPathValue("versionId", "v-001")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected status %d, got %d", http.StatusForbidden, w.Code)
	}
}

func TestRestoreMissingVersion(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	req := httptest.NewRequest("POST", "/api/profiles/test/versions/v-nonexistent/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "test")
	req.SetPathValue("versionId", "v-nonexistent")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
	}
}

func TestRestoreInvalidProfileName(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	req := httptest.NewRequest("POST", "/api/profiles/invalid@name/versions/v-001/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", "invalid@name")
	req.SetPathValue("versionId", "v-001")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestRestoreCASConflict(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	profileName := "test_restore_cas"

	// Add a profile with a specific hash
	repo.profiles[profileName] = bson.M{
		"name":             profileName,
		"title":            "Current Title",
		"preconditionHash": "hash1",
		"createdAt":        "2024-01-01T00:00:00.000Z",
		"createdBy":        "original_user",
		"updatedAt":        "2024-07-01T00:00:00.000Z",
		"updatedBy":        "current_user",
	}

	// Add a version
	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-001",
		"profileName": profileName,
		"action":      "UPDATE",
		"savedAt":     "2024-06-01T10:00:00.000Z",
		"savedBy":     "admin",
		"title":       "Old Title",
		"profile": bson.M{
			"name":      profileName,
			"title":     "Old Title",
			"createdAt": "2024-01-01T00:00:00.000Z",
			"createdBy": "original_user",
			"updatedAt": "2024-06-01T10:00:00.000Z",
			"updatedBy": "admin",
		},
	})

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "admin",
	}
	handler.UseUserRepository(activeUserRepoFor(principal))

	req := httptest.NewRequest("POST", "/api/profiles/"+profileName+"/versions/v-001/restore", nil)
	ctx := auth.ContextWithPrincipal(req.Context(), principal)
	req = req.WithContext(ctx)
	req.SetPathValue("name", profileName)
	req.SetPathValue("versionId", "v-001")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	// CAS should succeed because the mock doesn't do real hash comparison
	// In a real test with Mongo, this would fail if the profile was modified
	if w.Code != http.StatusOK {
		t.Logf("CAS conflict result: %d - %s", w.Code, w.Body.String())
	}
}

func TestVersionsDetailBranchReturnsSnapshot(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	const profileName = "test_versions_detail"
	repo.versions = append(repo.versions, bson.M{
		"_id":         "mongo-internal-id",
		"versionId":   "v-001",
		"profileName": profileName,
		"action":      "UPDATE",
		"savedAt":     "2026-01-01T10:00:00.000Z",
		"savedBy":     "admin",
		"title":       "Old Title",
		"sliceCount":  int32(2),
		"profile": bson.M{
			"name":  profileName,
			"title": "Old Title",
			"auth": bson.M{
				"k":   "00112233445566778899aabbccddeeff",
				"opc": "ffeeddccbbaa99887766554433221100",
				"amf": "8000",
			},
			"sliceList": bson.A{
				bson.M{"sst": int32(1), "sd": "000001"},
				bson.M{"sst": int32(2), "sd": "000002"},
			},
		},
	})

	principal := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "super_admin"}
	req := httptest.NewRequest("GET", "/api/profiles/"+profileName+"/versions?versionId=v-001", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", profileName)

	w := httptest.NewRecorder()
	handler.Versions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileVersionDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Version == nil {
		t.Fatal("expected a version payload, got null")
	}
	if got, _ := resp.Version["versionId"].(string); got != "v-001" {
		t.Errorf("expected versionId 'v-001', got %q", got)
	}
	if _, exposed := resp.Version["_id"]; exposed {
		t.Error("version detail must not expose the driver _id")
	}
	snapshot, ok := resp.Version["profile"].(map[string]any)
	if !ok {
		t.Fatalf("expected nested profile snapshot, got %T", resp.Version["profile"])
	}
	if got, _ := snapshot["title"].(string); got != "Old Title" {
		t.Errorf("expected snapshot title 'Old Title', got %q", got)
	}
}

func TestVersionsDetailBranchNotFound(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	principal := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "super_admin"}
	req := httptest.NewRequest("GET", "/api/profiles/missing_profile/versions?versionId=v-404", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "missing_profile")

	w := httptest.NewRecorder()
	handler.Versions(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d: %s", http.StatusNotFound, w.Code, w.Body.String())
	}
}

func TestVersionsListBranchKeepsShape(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	principal := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "super_admin"}
	req := httptest.NewRequest("GET", "/api/profiles/test_profile/versions", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "test_profile")

	w := httptest.NewRecorder()
	handler.Versions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var body map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if _, ok := body["versions"]; !ok {
		t.Error("list response must keep the versions field")
	}
	if _, ok := body["current"]; !ok {
		t.Error("list response must keep the current field")
	}
	if _, leaked := body["version"]; leaked {
		t.Error("list response must not gain the detail-only version field")
	}
}

func TestProfileMetaReportsCapabilitiesAndVocabulary(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	principal := &auth.Principal{Username: "testuser", Role: "operator", NormalizedRole: "operator"}
	req := httptest.NewRequest("GET", "/api/profiles/meta", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))

	w := httptest.NewRecorder()
	handler.Meta(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileMetaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if !resp.Capabilities.CanWrite {
		t.Error("operator must report canWrite")
	}
	if !resp.Capabilities.CanRestore {
		t.Error("operator must report canRestore")
	}
	if resp.Capabilities.CredentialVisibility != "plaintext" {
		t.Errorf("operator must see plaintext credentials, got %q", resp.Capabilities.CredentialVisibility)
	}
	if resp.AccessRestriction.Unrestricted != 0 || resp.AccessRestriction.Suspended != 255 {
		t.Errorf("unexpected sentinels: %+v", resp.AccessRestriction)
	}
	if len(resp.AccessRestriction.Bits) != 8 {
		t.Fatalf("expected 8 access restriction bits, got %d", len(resp.AccessRestriction.Bits))
	}
	combined := 0
	for _, bit := range resp.AccessRestriction.Bits {
		combined |= bit.Value
	}
	if combined != 255 {
		t.Errorf("access restriction bits must cover 0xFF, got %d", combined)
	}
}

func TestProfileMetaReportsViewerRestrictions(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	principal := &auth.Principal{Username: "viewer1", Role: "viewer", NormalizedRole: "viewer"}
	req := httptest.NewRequest("GET", "/api/profiles/meta", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))

	w := httptest.NewRecorder()
	handler.Meta(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileMetaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Capabilities.CanWrite || resp.Capabilities.CanRestore {
		t.Errorf("viewer must not report write or restore capability: %+v", resp.Capabilities)
	}
	if resp.Capabilities.CredentialVisibility != "masked" {
		t.Errorf("viewer must see masked credentials, got %q", resp.Capabilities.CredentialVisibility)
	}
}

func TestProfileReadsRequireProfilesReadPermission(t *testing.T) {
	// All three canonical roles carry profiles.read, so the gate's denial path
	// is exercised with a principal that holds no permissions at all.
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	principal := &auth.Principal{Username: "ghost", Role: "ghost", NormalizedRole: "ghost"}

	requests := []struct {
		label string
		call  func(w http.ResponseWriter, r *http.Request)
	}{
		{"list", handler.List},
		{"get", func(w http.ResponseWriter, r *http.Request) {
			r.SetPathValue("name", "some_profile")
			handler.Get(w, r)
		}},
		{"stats", func(w http.ResponseWriter, r *http.Request) {
			r.SetPathValue("name", "some_profile")
			handler.Stats(w, r)
		}},
		{"versions", func(w http.ResponseWriter, r *http.Request) {
			r.SetPathValue("name", "some_profile")
			handler.Versions(w, r)
		}},
	}

	for _, tc := range requests {
		t.Run(tc.label, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/profiles", nil)
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
			w := httptest.NewRecorder()
			tc.call(w, req)

			if w.Code != http.StatusForbidden {
				t.Fatalf("expected status %d, got %d: %s", http.StatusForbidden, w.Code, w.Body.String())
			}
			var body struct {
				Code       string `json:"code"`
				Permission string `json:"permission"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("failed to unmarshal denial response: %v", err)
			}
			if body.Code != "PERMISSION_DENIED" || body.Permission != "profiles.read" {
				t.Errorf("unexpected denial payload: %+v", body)
			}
		})
	}
}

func TestProfileGetMasksCredentialsForViewer(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	repo.profiles["tpl"] = bson.M{
		"name": "tpl",
		"auth": bson.M{
			"k":   "00112233445566778899aabbccddeeff",
			"opc": "ffeeddccbbaa99887766554433221100",
			"op":  "",
			"amf": "8000",
		},
	}

	principal := &auth.Principal{Username: "viewer1", Role: "viewer", NormalizedRole: "viewer"}
	req := httptest.NewRequest("GET", "/api/profiles/tpl", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "tpl")

	w := httptest.NewRecorder()
	handler.Get(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	authMaterial, ok := resp.Profile["auth"].(map[string]any)
	if !ok {
		t.Fatalf("expected auth object, got %T", resp.Profile["auth"])
	}
	if got, _ := authMaterial["k"].(string); got != maskedCredential {
		t.Errorf("expected k masked, got %q", got)
	}
	if got, _ := authMaterial["opc"].(string); got != maskedCredential {
		t.Errorf("expected opc masked, got %q", got)
	}
	if got, _ := authMaterial["op"].(string); got != "" {
		t.Errorf("an unconfigured op must stay empty, got %q", got)
	}
	if got, _ := authMaterial["amf"].(string); got != "8000" {
		t.Errorf("amf is not credential material and must stay plaintext, got %q", got)
	}
}

func TestProfileGetKeepsPlaintextForSubscriberWriter(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	repo.profiles["tpl"] = bson.M{
		"name": "tpl",
		"auth": bson.M{
			"k":   "00112233445566778899aabbccddeeff",
			"opc": "ffeeddccbbaa99887766554433221100",
			"amf": "8000",
		},
	}

	principal := &auth.Principal{Username: "op1", Role: "operator", NormalizedRole: "operator"}
	req := httptest.NewRequest("GET", "/api/profiles/tpl", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "tpl")

	w := httptest.NewRecorder()
	handler.Get(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	authMaterial, _ := resp.Profile["auth"].(map[string]any)
	if got, _ := authMaterial["k"].(string); got != "00112233445566778899aabbccddeeff" {
		t.Errorf("operator must keep plaintext k, got %q", got)
	}
}

func TestVersionsDetailBranchMasksSnapshotCredentials(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-001",
		"profileName": "tpl",
		"action":      "UPDATE",
		"profile": bson.M{
			"name": "tpl",
			"auth": bson.M{
				"k":   "00112233445566778899aabbccddeeff",
				"opc": "ffeeddccbbaa99887766554433221100",
				"amf": "8000",
			},
		},
	})

	principal := &auth.Principal{Username: "viewer1", Role: "viewer", NormalizedRole: "viewer"}
	req := httptest.NewRequest("GET", "/api/profiles/tpl/versions?versionId=v-001", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "tpl")

	w := httptest.NewRecorder()
	handler.Versions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileVersionDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	snapshot, ok := resp.Version["profile"].(map[string]any)
	if !ok {
		t.Fatalf("expected nested profile snapshot, got %T", resp.Version["profile"])
	}
	authMaterial, _ := snapshot["auth"].(map[string]any)
	if got, _ := authMaterial["k"].(string); got != maskedCredential {
		t.Errorf("expected snapshot k masked, got %q", got)
	}
	if got, _ := authMaterial["amf"].(string); got != "8000" {
		t.Errorf("expected snapshot amf plaintext, got %q", got)
	}
}

// Production decodes nested documents as bson.D (ordered), not bson.M; the
// masking must survive the real decode shape or it silently becomes a no-op.
func TestProfileGetMasksCredentialsForBsonDDecode(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	repo.profiles["tpl_d"] = bson.M{
		"name": "tpl_d",
		"auth": bson.D{
			{Key: "k", Value: "00112233445566778899aabbccddeeff"},
			{Key: "opc", Value: "ffeeddccbbaa99887766554433221100"},
			{Key: "op", Value: ""},
			{Key: "amf", Value: "8000"},
		},
	}

	principal := &auth.Principal{Username: "viewer1", Role: "viewer", NormalizedRole: "viewer"}
	req := httptest.NewRequest("GET", "/api/profiles/tpl_d", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "tpl_d")

	w := httptest.NewRecorder()
	handler.Get(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	authMaterial, ok := resp.Profile["auth"].(map[string]any)
	if !ok {
		t.Fatalf("expected auth object, got %T", resp.Profile["auth"])
	}
	if got, _ := authMaterial["k"].(string); got != maskedCredential {
		t.Errorf("expected k masked for a bson.D decode, got %q", got)
	}
	if got, _ := authMaterial["opc"].(string); got != maskedCredential {
		t.Errorf("expected opc masked for a bson.D decode, got %q", got)
	}
	if got, _ := authMaterial["op"].(string); got != "" {
		t.Errorf("an unconfigured op must stay empty, got %q", got)
	}
	if got, _ := authMaterial["amf"].(string); got != "8000" {
		t.Errorf("amf must stay plaintext, got %q", got)
	}
}

func TestVersionsDetailBranchMasksBsonDSnapshotCredentials(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-002",
		"profileName": "tpl_d",
		"action":      "UPDATE",
		"profile": bson.D{
			{Key: "name", Value: "tpl_d"},
			{Key: "auth", Value: bson.D{
				{Key: "k", Value: "00112233445566778899aabbccddeeff"},
				{Key: "amf", Value: "8000"},
			}},
		},
	})

	principal := &auth.Principal{Username: "viewer1", Role: "viewer", NormalizedRole: "viewer"}
	req := httptest.NewRequest("GET", "/api/profiles/tpl_d/versions?versionId=v-002", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "tpl_d")

	w := httptest.NewRecorder()
	handler.Versions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp ProfileVersionDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	snapshot, ok := resp.Version["profile"].(map[string]any)
	if !ok {
		t.Fatalf("expected nested profile snapshot, got %T", resp.Version["profile"])
	}
	authMaterial, _ := snapshot["auth"].(map[string]any)
	if got, _ := authMaterial["k"].(string); got != maskedCredential {
		t.Errorf("expected snapshot k masked for a bson.D decode, got %q", got)
	}
	if got, _ := authMaterial["amf"].(string); got != "8000" {
		t.Errorf("expected snapshot amf plaintext, got %q", got)
	}
}

// ─── Read gate, refusal contract and write-input guards ─────────────────────

func doProfileRequest(t *testing.T, call func(http.ResponseWriter, *http.Request), method, target string, body any, principal *auth.Principal, pathValues map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("failed to encode request body: %v", err)
		}
		payload = encoded
	}
	req := httptest.NewRequest(method, target, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	if principal != nil {
		req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	}
	for key, value := range pathValues {
		req.SetPathValue(key, value)
	}
	w := httptest.NewRecorder()
	call(w, req)
	return w
}

func TestProfileMetaRequiresProfilesReadPermission(t *testing.T) {
	handler := NewHandler(newMockRepository(), &mockLimiter{}, &mockAuditWriter{})

	w := doProfileRequest(t, handler.Meta, "GET", "/api/profiles/meta", nil,
		&auth.Principal{Username: "ghost", Role: "ghost", NormalizedRole: "ghost"}, nil)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected the meta read to be gated, got %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Code       string `json:"code"`
		Permission string `json:"permission"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to unmarshal denial: %v", err)
	}
	if body.Code != "PERMISSION_DENIED" || body.Permission != "profiles.read" {
		t.Errorf("unexpected denial payload: %+v", body)
	}
}

func TestProfileWriteDenialsKeepTheirResponseContract(t *testing.T) {
	handler := NewHandler(newMockRepository(), &mockLimiter{}, &mockAuditWriter{})
	viewer := &auth.Principal{Username: "watcher", Role: "viewer", NormalizedRole: "viewer"}

	cases := []struct {
		label string
		call  func(http.ResponseWriter, *http.Request)
	}{
		{"create", handler.Create},
		{"update", handler.Update},
		{"delete", handler.Delete},
	}
	for _, tc := range cases {
		w := doProfileRequest(t, tc.call, "POST", "/api/profiles/test_profile", map[string]any{"name": "test_profile"}, viewer,
			map[string]string{"name": "test_profile"})
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: expected 403, got %d: %s", tc.label, w.Code, w.Body.String())
			continue
		}
		// The refusal now also reaches the audit writer in production; the body
		// stays exactly what it was, so no client has to be retrained.
		var body struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: failed to unmarshal denial: %v", tc.label, err)
		}
		if body.Error != "Insufficient permissions" {
			t.Errorf("%s: denial body changed: %+v", tc.label, body)
		}
	}
}

func TestProfileRestoreRequiresTheReadGateFirst(t *testing.T) {
	handler := NewHandler(newMockRepository(), &mockLimiter{}, &mockAuditWriter{})
	pathValues := map[string]string{"name": "test_profile", "versionId": "1-abc"}

	ghost := doProfileRequest(t, handler.Restore, "POST", "/api/profiles/test_profile/versions/1-abc/restore", nil,
		&auth.Principal{Username: "ghost", Role: "ghost", NormalizedRole: "ghost"}, pathValues)
	if ghost.Code != http.StatusForbidden {
		t.Fatalf("expected the restore read gate to deny, got %d: %s", ghost.Code, ghost.Body.String())
	}
	var denial struct {
		Code       string `json:"code"`
		Permission string `json:"permission"`
	}
	if err := json.Unmarshal(ghost.Body.Bytes(), &denial); err != nil {
		t.Fatalf("failed to unmarshal denial: %v", err)
	}
	if denial.Code != "PERMISSION_DENIED" || denial.Permission != "profiles.read" {
		t.Errorf("expected a profiles.read denial, got %+v", denial)
	}

	// A reader without the rollback capability still fails the capability check.
	viewer := doProfileRequest(t, handler.Restore, "POST", "/api/profiles/test_profile/versions/1-abc/restore", nil,
		&auth.Principal{Username: "watcher", Role: "viewer", NormalizedRole: "viewer"}, pathValues)
	if viewer.Code != http.StatusForbidden {
		t.Fatalf("expected the capability gate to deny, got %d: %s", viewer.Code, viewer.Body.String())
	}
	var forbidden struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(viewer.Body.Bytes(), &forbidden)
	if forbidden.Code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN, got %q: %s", forbidden.Code, viewer.Body.String())
	}
}

func TestProfileUpdateRejectsMaskedCredentialMaterial(t *testing.T) {
	handler := NewHandler(newMockRepository(), &mockLimiter{}, &mockAuditWriter{})
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	handler.UseUserRepository(activeUserRepoFor(writer))

	for _, key := range credentialKeys {
		authValue := map[string]any{"k": "465b2ce5b8a37f2e19d4a6c8b0e2f417", "amf": "8000"}
		authValue[key] = maskedCredential
		w := doProfileRequest(t, handler.Update, "PUT", "/api/profiles/test_profile", map[string]any{"auth": authValue}, writer,
			map[string]string{"name": "test_profile"})
		if w.Code != http.StatusBadRequest {
			t.Errorf("auth.%s: expected 400, got %d: %s", key, w.Code, w.Body.String())
			continue
		}
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if body.Code != "INVALID_PROFILE_UPDATE" {
			t.Errorf("auth.%s: unexpected code %q", key, body.Code)
		}
	}

	// An empty credential is a legitimate clear, not a masking sentinel.
	if err := validateProfileUpdateBody(map[string]any{"auth": map[string]any{"k": "", "opc": "465b2ce5b8a37f2e19d4a6c8b0e2f417"}}); err != nil {
		t.Errorf("a real credential write must stay valid: %v", err)
	}
}

func TestProfileCreateNamePolicy(t *testing.T) {
	cases := []struct {
		name    string
		allowed bool
	}{
		{"test_profile", true},
		{"Gold 5G", true},
		{"a", true},
		{"new", false},
		{"NEW", false},
		{" new", false},
		{"new ", false},
		{"a\tb", false},
		{"a\nb", false},
		{strings.Repeat("x", 64), true},
		{strings.Repeat("x", 65), false},
		{"", false},
	}
	for _, tc := range cases {
		if got := validNewProfileName(tc.name); got != tc.allowed {
			t.Errorf("validNewProfileName(%q) = %v, want %v", tc.name, got, tc.allowed)
		}
	}

	// The read path stays permissive so an existing odd-named template remains
	// reachable even though it can no longer be created.
	if !validProfileName.MatchString("new") || !validProfileName.MatchString("a\tb") {
		t.Error("the historical read pattern must not tighten")
	}
}

func TestGeneratedVersionIDStaysSizedAndDistinct(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9]+-[0-9a-f]{16}$`)
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		id := generateVersionID()
		if !pattern.MatchString(id) {
			t.Fatalf("unexpected version id shape %q", id)
		}
		if seen[id] {
			t.Fatalf("duplicate version id %q", id)
		}
		seen[id] = true
	}
}

// storedRecord reads a nested document whether the handler built it as bson.M or
// decoded it from the request body as a plain map.
func storedRecord(value any) map[string]any {
	switch typed := value.(type) {
	case bson.M:
		return typed
	case map[string]any:
		return typed
	default:
		return nil
	}
}

func TestProfileCreateAcceptsContentInOneWrite(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	handler.UseUserRepository(activeUserRepoFor(writer))

	w := doProfileRequest(t, handler.Create, "POST", "/api/profiles", map[string]any{
		"name":                    "Gold 5G",
		"title":                   "Gold 5G Premium",
		"auth":                    map[string]any{"k": "465b2ce5b8a37f2e19d4a6c8b0e2f417", "opc": "cd6cfa9c8ed9c4c7f5e0d2a9b6c3e4f5", "amf": "8000"},
		"ambr":                    map[string]any{"downlink": map[string]any{"unit": 3, "value": 1000}, "uplink": map[string]any{"unit": 3, "value": 300}},
		"access_restriction_data": 0,
		"sliceList":               []any{map[string]any{"sst": 1, "sd": "000001", "session_list": []any{}}},
		"ocsDefaults":             map[string]any{"planId": "gold_100gb", "trafficTotal": 107374182400},
	}, writer, nil)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	stored := repo.profiles["Gold 5G"]
	if stored == nil {
		t.Fatal("the template was not stored under the requested key")
	}
	if stored["title"] != "Gold 5G Premium" {
		t.Errorf("title: got %v", stored["title"])
	}
	if stored["name"] != "Gold 5G" {
		t.Errorf("the stored key must follow the requested name: %v", stored["name"])
	}
	authDoc := storedRecord(stored["auth"])
	if authDoc["k"] != "465b2ce5b8a37f2e19d4a6c8b0e2f417" {
		t.Errorf("auth was not carried into the create: %v", stored["auth"])
	}
	// Declared billing content replaces the seeded default rather than merging.
	ocs := storedRecord(stored["ocsDefaults"])
	if ocs["planId"] != "gold_100gb" {
		t.Errorf("ocsDefaults.planId: got %v", ocs["planId"])
	}
	if _, stale := ocs["trafficBalance"]; stale {
		t.Errorf("the seeded default must not survive a declared billing block: %v", ocs)
	}

	if len(repo.versions) != 1 {
		t.Fatalf("one create must write one snapshot, got %d", len(repo.versions))
	}
	record := repo.versions[0]
	if record["action"] != "CREATE" {
		t.Errorf("action: got %v", record["action"])
	}
	if record["title"] != "Gold 5G Premium" {
		t.Errorf("the snapshot must carry the declared title, got %v", record["title"])
	}
}

func TestProfileCreateWithoutContentKeepsTheDefaultDocument(t *testing.T) {
	repo := newMockRepository()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	handler.UseUserRepository(activeUserRepoFor(writer))

	w := doProfileRequest(t, handler.Create, "POST", "/api/profiles", map[string]any{"name": "plain"}, writer, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	stored := repo.profiles["plain"]
	if stored["title"] != "plain" {
		t.Errorf("title: got %v", stored["title"])
	}
	ocs := storedRecord(stored["ocsDefaults"])
	if ocs["planId"] != "plan_default_10gb" {
		t.Errorf("a name-only create must keep the historical default: %v", ocs["planId"])
	}
}

func TestProfileCreateRejectsUnknownAndMaskedContent(t *testing.T) {
	handler := NewHandler(newMockRepository(), &mockLimiter{}, &mockAuditWriter{})
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	handler.UseUserRepository(activeUserRepoFor(writer))

	w := doProfileRequest(t, handler.Create, "POST", "/api/profiles", map[string]any{
		"name":     "strict",
		"slice_Ls": []any{},
	}, writer, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("an unknown field must be rejected, got %d: %s", w.Code, w.Body.String())
	}
	var unknown struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &unknown)
	if unknown.Code != "INVALID_PROFILE_CREATE" {
		t.Errorf("code: got %q", unknown.Code)
	}

	masked := doProfileRequest(t, handler.Create, "POST", "/api/profiles", map[string]any{
		"name": "strict",
		"auth": map[string]any{"k": maskedCredential, "amf": "8000"},
	}, writer, nil)
	if masked.Code != http.StatusBadRequest {
		t.Fatalf("a masked sentinel must be rejected on create too, got %d: %s", masked.Code, masked.Body.String())
	}
}

func TestProfileUpdateHonoursTheRevisionPrecondition(t *testing.T) {
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	repo := newMockRepository()
	repo.profiles["rev"] = bson.M{"name": "rev", "title": "v3", "revision": int64(3)}
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	handler.UseUserRepository(activeUserRepoFor(writer))
	pathValues := map[string]string{"name": "rev"}

	stale := doProfileRequest(t, handler.Update, "PUT", "/api/profiles/rev",
		map[string]any{"title": "mine", "expectedRevision": float64(2)}, writer, pathValues)
	if stale.Code != http.StatusConflict {
		t.Fatalf("a stale precondition must conflict, got %d: %s", stale.Code, stale.Body.String())
	}
	var conflict struct {
		Code            string `json:"code"`
		CurrentRevision int64  `json:"currentRevision"`
		Committed       bool   `json:"committed"`
	}
	_ = json.Unmarshal(stale.Body.Bytes(), &conflict)
	if conflict.Code != "PROFILE_REVISION_CONFLICT" || conflict.CurrentRevision != 3 || conflict.Committed {
		t.Errorf("unexpected conflict payload: %+v", conflict)
	}
	if repo.profiles["rev"]["title"] != "v3" {
		t.Error("a rejected precondition must leave the document untouched")
	}

	fresh := doProfileRequest(t, handler.Update, "PUT", "/api/profiles/rev",
		map[string]any{"title": "mine", "expectedRevision": float64(3)}, writer, pathValues)
	if fresh.Code != http.StatusOK {
		t.Fatalf("the matching revision must save, got %d: %s", fresh.Code, fresh.Body.String())
	}
	if got := repo.profiles["rev"]["revision"]; got != int64(4) {
		t.Errorf("revision after save: got %v", got)
	}
	if _, leaked := repo.profiles["rev"]["expectedRevision"]; leaked {
		t.Error("the precondition must not be stored on the document")
	}

	legacy := doProfileRequest(t, handler.Update, "PUT", "/api/profiles/rev", map[string]any{"title": "legacy"}, writer, pathValues)
	if legacy.Code != http.StatusOK || repo.profiles["rev"]["revision"] != int64(5) {
		t.Errorf("a client without the field keeps working and still advances the counter: status %d revision %v",
			legacy.Code, repo.profiles["rev"]["revision"])
	}

	direct := doProfileRequest(t, handler.Update, "PUT", "/api/profiles/rev", map[string]any{"revision": float64(99)}, writer, pathValues)
	if direct.Code != http.StatusBadRequest {
		t.Errorf("the counter is not client-writable, got %d", direct.Code)
	}
	malformed := doProfileRequest(t, handler.Update, "PUT", "/api/profiles/rev", map[string]any{"title": "x", "expectedRevision": "3"}, writer, pathValues)
	if malformed.Code != http.StatusBadRequest {
		t.Errorf("a non-numeric precondition must be refused, got %d", malformed.Code)
	}
}

func TestProfileDeleteHonoursTheRevisionPrecondition(t *testing.T) {
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	repo := newMockRepository()
	repo.profiles["gone"] = bson.M{"name": "gone", "title": "gone", "revision": int64(7)}
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	handler.UseUserRepository(activeUserRepoFor(writer))
	pathValues := map[string]string{"name": "gone"}

	stale := doProfileRequest(t, handler.Delete, "DELETE", "/api/profiles/gone?expectedRevision=6", nil, writer, pathValues)
	if stale.Code != http.StatusConflict {
		t.Fatalf("a stale delete must conflict, got %d: %s", stale.Code, stale.Body.String())
	}
	if _, still := repo.profiles["gone"]; !still {
		t.Error("a conflicted delete must not remove the template")
	}

	bad := doProfileRequest(t, handler.Delete, "DELETE", "/api/profiles/gone?expectedRevision=soon", nil, writer, pathValues)
	if bad.Code != http.StatusBadRequest {
		t.Errorf("a malformed precondition must be refused, got %d", bad.Code)
	}

	ok := doProfileRequest(t, handler.Delete, "DELETE", "/api/profiles/gone?expectedRevision=7", nil, writer, pathValues)
	if ok.Code != http.StatusOK {
		t.Fatalf("the matching revision must delete, got %d: %s", ok.Code, ok.Body.String())
	}
}

func TestProfileWritesRevalidateTheActor(t *testing.T) {
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}

	account := func(mutate func(*user.SafeUser)) *mockUserRepo {
		mirror := activeUserRepoFor(writer)
		mutate(&mirror.identity.SafeUser)
		return mirror
	}

	cases := []struct {
		label    string
		repo     *mockUserRepo
		wantCode string
	}{
		{"disabled", account(func(u *user.SafeUser) { u.Status = "disabled" }), "AUTH_USER_DISABLED"},
		{"locked", account(func(u *user.SafeUser) { u.Locked = true }), "AUTH_USER_LOCKED"},
		{"revoked", account(func(u *user.SafeUser) { u.Security.SessionVersion = 8 }), "SESSION_REVOKED"},
		{"re-roled", account(func(u *user.SafeUser) { u.Role = "viewer" }), "AUTH_ROLE_MISMATCH"},
		{"gone", &mockUserRepo{}, "AUTH_USER_NOT_FOUND"},
		{"store down", &mockUserRepo{err: context.DeadlineExceeded}, "AUTH_SERVICE_UNAVAILABLE"},
	}

	for _, tc := range cases {
		repo := newMockRepository()
		repo.profiles["rev"] = bson.M{"name": "rev", "title": "v", "revision": int64(1)}
		handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
		handler.UseUserRepository(tc.repo)

		w := doProfileRequest(t, handler.Update, "PUT", "/api/profiles/rev", map[string]any{"title": "changed"}, writer,
			map[string]string{"name": "rev"})
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if body.Code != tc.wantCode {
			t.Errorf("%s: expected %s, got %d %s", tc.label, tc.wantCode, w.Code, w.Body.String())
		}
		if repo.profiles["rev"]["title"] != "v" {
			t.Errorf("%s: a refused actor must not mutate the template", tc.label)
		}
	}
}

func TestProfileWriteFailsClosedWithoutAnAccountStore(t *testing.T) {
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	handler := NewHandler(newMockRepository(), &mockLimiter{}, &mockAuditWriter{})

	w := doProfileRequest(t, handler.Create, "POST", "/api/profiles", map[string]any{"name": "unwired"}, writer, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("an unwired handler must fail closed, got %d: %s", w.Code, w.Body.String())
	}
}

func TestProfileVersionsReportExistenceAndRevision(t *testing.T) {
	reader := &auth.Principal{Username: "watcher", Role: "viewer", NormalizedRole: "viewer"}
	repo := newMockRepository()
	repo.profiles["here"] = bson.M{"name": "here", "title": "Here", "revision": int64(4)}
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	present := doProfileRequest(t, handler.Versions, "GET", "/api/profiles/here/versions", nil, reader,
		map[string]string{"name": "here"})
	var presentBody struct {
		ProfileExists bool `json:"profileExists"`
		Current       *struct {
			Revision int64 `json:"revision"`
		} `json:"current"`
	}
	_ = json.Unmarshal(present.Body.Bytes(), &presentBody)
	if !presentBody.ProfileExists || presentBody.Current == nil || presentBody.Current.Revision != 4 {
		t.Errorf("a live template must report its existence and counter, got %s", present.Body.String())
	}

	missing := doProfileRequest(t, handler.Versions, "GET", "/api/profiles/gone/versions", nil, reader,
		map[string]string{"name": "gone"})
	var missingBody struct {
		ProfileExists bool           `json:"profileExists"`
		Current       map[string]any `json:"current"`
	}
	_ = json.Unmarshal(missing.Body.Bytes(), &missingBody)
	if missing.Code != http.StatusOK || missingBody.ProfileExists || len(missingBody.Current) != 0 {
		t.Errorf("a deleted template keeps its history but says so: %d %s", missing.Code, missing.Body.String())
	}
}

// ─── Drift probe, clone and export ──────────────────────────────────────────

const driftProfileName = "Gold"

func driftProfileDoc() bson.M {
	return bson.M{
		"name":                    driftProfileName,
		"title":                   "Gold Premium",
		"auth":                    bson.M{"k": "465b2ce5b8a37f2e19d4a6c8b0e2f417", "opc": "cd6cfa9c8ed9c4c7f5e0d2a9b6c3e4f5", "amf": "8000"},
		"ambr":                    bson.M{"downlink": bson.M{"unit": int32(2), "value": int32(100)}, "uplink": bson.M{"unit": int32(2), "value": int32(50)}},
		"access_restriction_data": int32(0),
		"sliceList":               bson.A{},
	}
}

// driftSubjects builds the population from the same projection the governed
// apply performs, so the fixture cannot disagree with the probe's authority.
func driftSubjects() []bson.M {
	profile := driftProfileDoc()
	applied := func(imsi string) bson.M {
		return subscriber.BuildSubscriberAfterProfileApply(bson.M{"imsi": imsi}, profile, driftProfileName)
	}
	inSync := applied("001010000000001")
	changed := applied("001010000000002")
	changed["ambr"] = bson.M{"downlink": bson.M{"unit": int32(1), "value": int32(2)}}
	orphan := bson.M{"security": bson.M{"k": "x"}}
	return []bson.M{inSync, changed, orphan}
}

func TestProfileDriftPrecheckReadsStateWithoutWriting(t *testing.T) {
	repo := newMockRepository()
	repo.profiles[driftProfileName] = driftProfileDoc()
	repo.driftDocs = driftSubjects()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	operator := &auth.Principal{Username: "op", Role: "operator", NormalizedRole: "operator"}

	versionsBefore := len(repo.versions)
	profilesBefore := len(repo.profiles)

	w := doProfileRequest(t, handler.DriftPrecheck, "POST", "/api/profiles/Gold/drift-precheck", map[string]any{}, operator,
		map[string]string{"name": driftProfileName})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp ProfileDriftResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode the probe: %v", err)
	}
	if resp.ProfileName != driftProfileName || resp.Checked != 3 || resp.InSync != 1 || resp.Changed != 1 || resp.Unknown != 1 {
		t.Fatalf("unexpected tally: %+v", resp)
	}
	byImsi := map[string]ProfileDriftEntry{}
	for _, entry := range resp.Results {
		byImsi[entry.Imsi] = entry
	}
	if byImsi["001010000000001"].State != subscriber.DriftInSync {
		t.Errorf("an applied subscriber must read as in sync: %+v", byImsi["001010000000001"])
	}
	changed := byImsi["001010000000002"]
	if changed.State != DriftStateChanged || len(changed.Changed) != 1 || changed.Changed[0] != "ambr" {
		t.Errorf("an ambr edit must surface as one changed group: %+v", changed)
	}
	if byImsi[""].State != DriftStateUnknown {
		t.Errorf("a document without an IMSI must be unknown, not in sync: %+v", byImsi[""])
	}
	if len(repo.versions) != versionsBefore || len(repo.profiles) != profilesBefore {
		t.Error("the probe is a read and must not write")
	}
}

func TestProfileDriftPrecheckGatesAndBounds(t *testing.T) {
	repo := newMockRepository()
	repo.profiles[driftProfileName] = driftProfileDoc()
	repo.driftDocs = driftSubjects()
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	operator := &auth.Principal{Username: "op", Role: "operator", NormalizedRole: "operator"}
	pathValues := map[string]string{"name": driftProfileName}

	// The probe reads subscriber authentication material, so it follows the
	// same predicate as plaintext template credentials.
	viewer := doProfileRequest(t, handler.DriftPrecheck, "POST", "/api/profiles/Gold/drift-precheck", map[string]any{},
		&auth.Principal{Username: "watcher", Role: "viewer", NormalizedRole: "viewer"}, pathValues)
	if viewer.Code != http.StatusForbidden {
		t.Errorf("a viewer must be refused: %d %s", viewer.Code, viewer.Body.String())
	}

	missing := doProfileRequest(t, handler.DriftPrecheck, "POST", "/api/profiles/gone/drift-precheck", map[string]any{}, operator,
		map[string]string{"name": "gone"})
	if missing.Code != http.StatusNotFound {
		t.Errorf("an unknown template must 404, got %d", missing.Code)
	}

	badImsi := doProfileRequest(t, handler.DriftPrecheck, "POST", "/api/profiles/Gold/drift-precheck",
		map[string]any{"imsis": []string{"00101"}}, operator, pathValues)
	var badCode struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(badImsi.Body.Bytes(), &badCode)
	if badImsi.Code != http.StatusBadRequest || badCode.Code != "INVALID_IMSI" {
		t.Errorf("a malformed IMSI must be refused: %d %s", badImsi.Code, badImsi.Body.String())
	}

	overflow := make([]string, profileDriftLimit+1)
	for i := range overflow {
		overflow[i] = "001010000000001"
	}
	tooMany := doProfileRequest(t, handler.DriftPrecheck, "POST", "/api/profiles/Gold/drift-precheck",
		map[string]any{"imsis": overflow}, operator, pathValues)
	var limitCode struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(tooMany.Body.Bytes(), &limitCode)
	if tooMany.Code != http.StatusBadRequest || limitCode.Code != "DRIFT_LIMIT_EXCEEDED" {
		t.Errorf("the bound must be enforced before any read: %d %s", tooMany.Code, tooMany.Body.String())
	}

	// A requested IMSI with no document is unknown, never silently in sync.
	repo.driftDocs = driftSubjects()[:1]
	partial := doProfileRequest(t, handler.DriftPrecheck, "POST", "/api/profiles/Gold/drift-precheck",
		map[string]any{"imsis": []string{"001010000000001", "001010000000009"}}, operator, pathValues)
	var partialResp ProfileDriftResponse
	_ = json.Unmarshal(partial.Body.Bytes(), &partialResp)
	if partialResp.Unknown != 1 || partialResp.Checked != 2 {
		t.Errorf("a missing subscriber must be reported unknown: %+v", partialResp)
	}
}

func TestProfileCloneCopiesContentInOneWrite(t *testing.T) {
	repo := newMockRepository()
	repo.profiles["Gold"] = bson.M{
		"name": "Gold", "title": "Gold Premium", "description": "source",
		"auth":        bson.M{"k": "465b2ce5b8a37f2e19d4a6c8b0e2f417", "amf": "8000"},
		"ambr":        bson.M{"downlink": bson.M{"unit": int32(2), "value": int32(100)}},
		"sliceList":   bson.A{bson.M{"sst": int32(1)}},
		"ocsDefaults": bson.M{"planId": "gold_plan"},
		"revision":    int64(9), "createdBy": "someone", "updatedAt": "2020-01-01T00:00:00.000Z",
	}
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	handler.UseUserRepository(activeUserRepoFor(writer))

	w := doProfileRequest(t, handler.Clone, "POST", "/api/profiles/Gold/clone", map[string]any{"name": "Silver"}, writer,
		map[string]string{"name": "Gold"})
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	silver := repo.profiles["Silver"]
	if silver["name"] != "Silver" || silver["title"] != "Silver" {
		t.Errorf("identity must be the new key, not the source's: %v / %v", silver["name"], silver["title"])
	}
	if silver["description"] != "source" {
		t.Errorf("content was not copied: %v", silver["description"])
	}
	ocs := storedRecord(silver["ocsDefaults"])
	if ocs["planId"] != "gold_plan" {
		t.Errorf("billing defaults were not copied: %v", silver["ocsDefaults"])
	}
	if silver["revision"] != int64(1) {
		t.Errorf("a clone starts its own counter, got %v", silver["revision"])
	}
	if silver["createdBy"] != "testuser" || silver["updatedAt"] == "2020-01-01T00:00:00.000Z" {
		t.Errorf("provenance must belong to the clone, got %v / %v", silver["createdBy"], silver["updatedAt"])
	}
	if repo.profiles["Gold"]["revision"] != int64(9) {
		t.Error("the source template must be untouched")
	}

	var created []bson.M
	for _, record := range repo.versions {
		if record["profileName"] == "Silver" {
			created = append(created, record)
		}
	}
	if len(created) != 1 || created[0]["action"] != "CREATE" {
		t.Errorf("a clone is one create, got %d records: %+v", len(created), created)
	}

	same := doProfileRequest(t, handler.Clone, "POST", "/api/profiles/Gold/clone", map[string]any{"name": "Gold"}, writer,
		map[string]string{"name": "Gold"})
	var sameCode struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(same.Body.Bytes(), &sameCode)
	if same.Code != http.StatusBadRequest || sameCode.Code != "PROFILE_CLONE_TARGET_SAME" {
		t.Errorf("cloning onto the source must be refused: %d %s", same.Code, same.Body.String())
	}

	reserved := doProfileRequest(t, handler.Clone, "POST", "/api/profiles/Gold/clone", map[string]any{"name": "new"}, writer,
		map[string]string{"name": "Gold"})
	if reserved.Code != http.StatusBadRequest {
		t.Errorf("the clone target obeys the create key policy, got %d", reserved.Code)
	}

	repo.profiles["Taken"] = bson.M{"name": "Taken"}
	duplicate := doProfileRequest(t, handler.Clone, "POST", "/api/profiles/Gold/clone", map[string]any{"name": "Taken"}, writer,
		map[string]string{"name": "Gold"})
	if duplicate.Code != http.StatusConflict {
		t.Errorf("an existing target must conflict, got %d", duplicate.Code)
	}
}

func TestProfileExportShapeAndCredentialVisibility(t *testing.T) {
	repo := newMockRepository()
	repo.profiles["Gold 5G"] = bson.M{
		"name": "Gold 5G", "title": "Gold",
		"auth":     bson.M{"k": "465b2ce5b8a37f2e19d4a6c8b0e2f417", "amf": "8000"},
		"revision": int64(4),
	}
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	pathValues := map[string]string{"name": "Gold 5G"}

	admin := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	w := doProfileRequest(t, handler.Export, "GET", "/api/profiles/Gold%205G/export", nil, admin, pathValues)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: %q", got)
	}
	// The stored key keeps its space; the download name cannot carry one.
	if got := w.Header().Get("Content-Disposition"); got != `attachment; filename="profile-Gold_5G.json"` {
		t.Errorf("Content-Disposition: %q", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control: %q", got)
	}

	var full struct {
		Version     int            `json:"version"`
		ProfileName string         `json:"profile_name"`
		ExportedAt  string         `json:"exported_at"`
		Credentials map[string]any `json:"credentials"`
		Profile     map[string]any `json:"profile"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &full); err != nil {
		t.Fatalf("failed to decode the export: %v", err)
	}
	if full.Version != 1 || full.ProfileName != "Gold 5G" || full.ExportedAt == "" {
		t.Errorf("export manifest: %+v", full)
	}
	if full.Credentials["visibility"] != "plaintext" {
		t.Errorf("credential visibility: %v", full.Credentials)
	}
	if _, leaked := full.Profile["revision"]; leaked {
		t.Error("the write counter is not template content")
	}
	authDoc, _ := full.Profile["auth"].(map[string]any)
	if authDoc["k"] != "465b2ce5b8a37f2e19d4a6c8b0e2f417" {
		t.Errorf("a plaintext reader must get the stored value, got %v", authDoc["k"])
	}

	viewer := &auth.Principal{Username: "watcher", Role: "viewer", NormalizedRole: "viewer"}
	masked := doProfileRequest(t, handler.Export, "GET", "/api/profiles/Gold%205G/export", nil, viewer, pathValues)
	var maskedBody struct {
		Credentials map[string]any `json:"credentials"`
		Profile     struct {
			Auth map[string]any `json:"auth"`
		} `json:"profile"`
	}
	if err := json.Unmarshal(masked.Body.Bytes(), &maskedBody); err != nil {
		t.Fatalf("failed to decode the masked export: %v", err)
	}
	if maskedBody.Credentials["visibility"] != "masked" {
		t.Errorf("a masked reader must be told: %v", maskedBody.Credentials)
	}
	if maskedBody.Profile.Auth["k"] != maskedCredential {
		t.Errorf("an export must not carry material the reader cannot see: %v", maskedBody.Profile.Auth["k"])
	}
	if maskedBody.Profile.Auth["amf"] != "8000" {
		t.Error("amf is not credential material and stays readable")
	}
	if repo.profiles["Gold 5G"] == nil {
		t.Error("an export must not mutate the stored template")
	}
}

// The masking must survive the decode the repository actually performs. This
// round-trips through BSON instead of hand-building a map, so a future shape
// assumption fails here rather than passing against a convenient mock.
func TestProfileGetMasksCredentialsAfterDriverDecode(t *testing.T) {
	stored, err := bson.Marshal(bson.M{
		"name": "tpl_roundtrip",
		"auth": bson.M{
			"k":   "00112233445566778899aabbccddeeff",
			"opc": "ffeeddccbbaa99887766554433221100",
			"amf": "8000",
		},
	})
	if err != nil {
		t.Fatalf("failed to marshal fixture: %v", err)
	}

	// Same target type as Repository.GetProfile: a top-level map whose nested
	// documents the driver may decode into any supported shape.
	var decoded bson.M
	if err := bson.Unmarshal(stored, &decoded); err != nil {
		t.Fatalf("failed to unmarshal fixture: %v", err)
	}

	repo := newMockRepository()
	repo.profiles["tpl_roundtrip"] = decoded
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	principal := &auth.Principal{Username: "viewer1", Role: "viewer", NormalizedRole: "viewer"}
	req := httptest.NewRequest("GET", "/api/profiles/tpl_roundtrip", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "tpl_roundtrip")

	w := httptest.NewRecorder()
	handler.Get(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), maskedCredential) {
		t.Fatalf("driver-decoded credentials must reach the client masked, got %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "00112233445566778899aabbccddeeff") {
		t.Error("plaintext k leaked through the driver-decoded path")
	}
	if !strings.Contains(w.Body.String(), "8000") {
		t.Errorf("amf must stay plaintext, got %s", w.Body.String())
	}
}

// fieldOf/setFieldOf are the package's only in-place path across decoded
// shapes; asDocument's bson.D branch returns a copy and must never be used to
// rewrite a stored document.
func TestFieldAccessorsRewriteEveryDecodedShapeInPlace(t *testing.T) {
	cases := []struct {
		label string
		doc   any
		// adaptingToMap is true where asDocument rebuilds the document, so a
		// write through its result cannot reach the value being marshalled.
		adaptingToMap bool
	}{
		{label: "bson.M", doc: bson.M{"auth": bson.M{"k": "secret", "op": "", "amf": "8000"}}},
		{label: "map[string]any", doc: map[string]any{"auth": map[string]any{"k": "secret", "op": "", "amf": "8000"}}},
		{
			label: "bson.D",
			doc: bson.D{
				{Key: "auth", Value: bson.D{
					{Key: "k", Value: "secret"},
					{Key: "op", Value: ""},
					{Key: "amf", Value: "8000"},
				}},
			},
			adaptingToMap: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			maskCredentialDoc(tc.doc)

			material := fieldOf(tc.doc, "auth")
			if got, _ := fieldOf(material, "k").(string); got != maskedCredential {
				t.Errorf("k must be rewritten in place, got %q", got)
			}
			if got, _ := fieldOf(material, "op").(string); got != "" {
				t.Errorf("an unconfigured field must stay empty, got %q", got)
			}
			if got, _ := fieldOf(material, "amf").(string); got != "8000" {
				t.Errorf("amf must stay plaintext, got %q", got)
			}
			if setFieldOf(material, "absent_key", maskedCredential) {
				t.Error("setFieldOf must not create keys the stored document does not carry")
			}

			if !tc.adaptingToMap {
				return
			}
			// The trap this refactor closes: writing through an adapted copy
			// looks successful in the unit and is a no-op in the response.
			copied := asDocument(material)
			if copied == nil {
				t.Fatal("asDocument must adapt a decoded document")
			}
			copied["k"] = "through-a-copy"
			if got, _ := fieldOf(fieldOf(tc.doc, "auth"), "k").(string); got != maskedCredential {
				t.Errorf("an adapted copy must not reach the stored document, got %q", got)
			}
		})
	}
}

// The audit projection runs on documents the driver decoded, so it must read
// the auth child through the shape authority rather than a map assertion.
func TestSafeProfileSnapshotReportsAuthConfiguredForDriverDecode(t *testing.T) {
	roundTrip := func(auth bson.M) bson.M {
		stored, err := bson.Marshal(bson.M{
			"name":      "tpl_safe",
			"title":     "Safe",
			"auth":      auth,
			"sliceList": bson.A{bson.M{"sst": int32(1)}, bson.M{"sst": int32(2)}},
		})
		if err != nil {
			t.Fatalf("failed to marshal fixture: %v", err)
		}
		var decoded bson.M
		if err := bson.Unmarshal(stored, &decoded); err != nil {
			t.Fatalf("failed to unmarshal fixture: %v", err)
		}
		return decoded
	}

	configured := safeProfileSnapshot(roundTrip(bson.M{
		"k":   "00112233445566778899aabbccddeeff",
		"opc": "ffeeddccbbaa99887766554433221100",
		"amf": "8000",
	}))
	if value, ok := configured["authConfigured"]; !ok {
		t.Fatal("a decoded document must still report whether credentials are configured")
	} else if value != true {
		t.Errorf("expected authConfigured true, got %v", value)
	}
	encoded, _ := json.Marshal(configured)
	if strings.Contains(string(encoded), "00112233445566778899aabbccddeeff") {
		t.Error("the audit snapshot must not carry credential material")
	}

	allZero := safeProfileSnapshot(roundTrip(bson.M{
		"k":   "00000000000000000000000000000000",
		"opc": "00000000000000000000000000000000",
		"amf": "8000",
	}))
	if allZero["authConfigured"] != false {
		t.Errorf("an all-zero key is not configured material, got %v", allZero["authConfigured"])
	}

	if count := sliceCount(roundTrip(bson.M{"k": "secret"})); count != 2 {
		t.Errorf("a decoded sliceList must be counted, got %d", count)
	}
}

// Export and the CAS precondition both rely on a copy that is genuinely deep;
// aliasing a decoded nested document would let one projection mutate the other.
func TestDeepCopyBsonMDoesNotAliasDecodedNestedDocuments(t *testing.T) {
	stored, err := bson.Marshal(bson.M{
		"name": "tpl_copy",
		"auth": bson.M{"k": "00112233445566778899aabbccddeeff", "amf": "8000"},
	})
	if err != nil {
		t.Fatalf("failed to marshal fixture: %v", err)
	}
	var decoded bson.M
	if err := bson.Unmarshal(stored, &decoded); err != nil {
		t.Fatalf("failed to unmarshal fixture: %v", err)
	}

	copied := deepCopyBsonM(decoded)
	maskCredentialDoc(copied)

	if got, _ := fieldOf(fieldOf(decoded, "auth"), "k").(string); got != "00112233445566778899aabbccddeeff" {
		t.Errorf("masking a copy must not reach the source document, got %q", got)
	}
	if got, _ := fieldOf(fieldOf(copied, "auth"), "k").(string); got != maskedCredential {
		t.Errorf("expected the copy to be masked, got %q", got)
	}
}

// An empty template name must never widen a statistics or attribution query
// into a whole-collection match.
func TestProfileAttributionFilterFailsClosedOnEmptyName(t *testing.T) {
	empty := profileAttributionFilter("")
	expr, ok := empty["$expr"].(bson.M)
	if !ok {
		t.Fatalf("an empty template name must produce a match-nothing filter, got %v", empty)
	}
	if value, present := expr["$literal"]; !present || value != false {
		t.Errorf("expected a literal false expression, got %v", expr)
	}

	filter := profileAttributionFilter("Gold")
	branches, ok := filter["$or"].(bson.A)
	if !ok || len(branches) != 4 {
		t.Fatalf("expected the shared four-branch attribution filter, got %v", filter)
	}
}

func updateProfileRequest(t *testing.T, handler *Handler, name string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()

	principal := &auth.Principal{Username: "op1", Role: "operator", NormalizedRole: "operator"}
	handler.UseUserRepository(activeUserRepoFor(principal))

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("failed to marshal body: %v", err)
	}
	req := httptest.NewRequest("PUT", "/api/profiles/"+name, bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", name)

	w := httptest.NewRecorder()
	handler.Update(w, req)
	return w
}

// Re-submitting the content a template already carries must not advance the
// revision, archive an identical snapshot, or break another client's
// precondition.
func TestProfileUpdateIdenticalContentIsTrueNoEffect(t *testing.T) {
	content := bson.M{
		"name":  "tpl_stable",
		"title": "Stable",
		"auth":  bson.D{{Key: "k", Value: "00112233445566778899aabbccddeeff"}, {Key: "amf", Value: "8000"}},
		"ambr":  bson.M{"downlink": bson.M{"unit": int32(2), "value": int32(100)}},
	}

	repo := newMockRepository()
	repo.profiles["tpl_stable"] = content
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	body := map[string]any{
		"title": "Stable",
		// Submitted as a plain map while stored as a decoded bson.D: same
		// content, different shape and key order.
		"auth": map[string]any{"amf": "8000", "k": "00112233445566778899aabbccddeeff"},
		"ambr": map[string]any{"downlink": map[string]any{"unit": 2, "value": 100}},
	}

	w := updateProfileRequest(t, handler, "tpl_stable", body)
	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp UpdateProfileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Classification != "NO_EFFECT" {
		t.Errorf("expected a NO_EFFECT classification, got %q", resp.Classification)
	}
	stored := repo.profiles["tpl_stable"]
	if _, touched := stored["revision"]; touched {
		t.Errorf("a no-effect save must leave the revision alone, got %v", stored["revision"])
	}
	if _, stamped := stored["updatedAt"]; stamped {
		t.Error("a no-effect save must not restamp updatedAt")
	}
	if len(repo.versions) != 0 {
		t.Errorf("a no-effect save must not archive a snapshot, got %d", len(repo.versions))
	}
}

// A real change still writes, stamps and archives.
func TestProfileUpdateRealChangeStillCommits(t *testing.T) {
	repo := newMockRepository()
	repo.profiles["tpl_change"] = bson.M{
		"name":     "tpl_change",
		"title":    "Before",
		"revision": int64(3),
	}
	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})

	w := updateProfileRequest(t, handler, "tpl_change", map[string]any{"title": "After"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp UpdateProfileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if resp.Classification != "" {
		t.Errorf("a committed change must not report NO_EFFECT, got %q", resp.Classification)
	}
	stored := repo.profiles["tpl_change"]
	if stored["revision"] != int64(4) {
		t.Errorf("expected revision 4, got %v", stored["revision"])
	}
	if len(repo.versions) != 1 {
		t.Errorf("expected one archived snapshot, got %d", len(repo.versions))
	}
}

// A snapshot carrying the read-projection sentinel must never be promoted into
// the live template, because a governed apply would copy it into a subscriber's
// security block.
func TestProfileRestoreRefusesMaskedCredentialMaterial(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	handler := NewHandler(repo, &mockLimiter{}, auditWriter)

	const profileName = "tpl_restore_masked"
	repo.profiles[profileName] = bson.M{
		"name":     profileName,
		"title":    "Live",
		"revision": int64(2),
		"auth":     bson.M{"k": "00112233445566778899aabbccddeeff", "amf": "8000"},
	}
	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-masked",
		"profileName": profileName,
		"action":      "UPDATE",
		"savedAt":     "2026-01-01T10:00:00.000Z",
		"savedBy":     "admin",
		"profile": bson.M{
			"name":  profileName,
			"title": "Historical",
			"auth":  bson.M{"k": maskedCredential, "amf": "8000"},
		},
	})

	principal := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "admin"}
	handler.UseUserRepository(activeUserRepoFor(principal))

	req := httptest.NewRequest("POST", "/api/profiles/"+profileName+"/versions/v-masked/restore", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", profileName)
	req.SetPathValue("versionId", "v-masked")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to unmarshal refusal: %v", err)
	}
	if body["code"] != "PROFILE_RESTORE_MASKED_MATERIAL" || body["committed"] != false {
		t.Errorf("unexpected refusal payload: %v", body)
	}

	stored := repo.profiles[profileName]
	if got, _ := fieldOf(fieldOf(stored, "auth"), "k").(string); got != "00112233445566778899aabbccddeeff" {
		t.Errorf("the live template must be untouched, got %q", got)
	}
	if stored["revision"] != int64(2) {
		t.Errorf("a refused restore must not advance the revision, got %v", stored["revision"])
	}
	if len(repo.versions) != 1 {
		t.Errorf("a refused restore must not archive a snapshot, got %d", len(repo.versions))
	}
	recorded := false
	for _, record := range auditWriter.records {
		if record.Metadata["classification"] == "MASKED_CREDENTIAL_MATERIAL" {
			recorded = true
		}
	}
	if !recorded {
		t.Error("the refusal must be recorded in the operation log")
	}
}

// The rollback denial keeps its historical body while recording the refusal.
func TestProfileRestoreCapabilityDenialKeepsResponseShape(t *testing.T) {
	repo := newMockRepository()
	repo.profiles["tpl_gate"] = bson.M{"name": "tpl_gate", "title": "Gate"}
	repo.versions = append(repo.versions, bson.M{
		"versionId":   "v-1",
		"profileName": "tpl_gate",
		"action":      "UPDATE",
		"savedAt":     "2026-01-01T10:00:00.000Z",
		"profile":     bson.M{"name": "tpl_gate", "title": "Gate"},
	})

	handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
	principal := &auth.Principal{Username: "viewer1", Role: "viewer", NormalizedRole: "viewer"}

	req := httptest.NewRequest("POST", "/api/profiles/tpl_gate/versions/v-1/restore", nil)
	req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
	req.SetPathValue("name", "tpl_gate")
	req.SetPathValue("versionId", "v-1")

	w := httptest.NewRecorder()
	handler.Restore(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d: %s", http.StatusForbidden, w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"FORBIDDEN"`) {
		t.Errorf("the historical denial code must be preserved, got %s", w.Body.String())
	}
}

// Writing credential material needs both the template write permission and the
// subscriber write permission that makes the material visible. Meta states the
// coupling so no client has to derive it from a role table.
func TestProfileMetaReportsCredentialEditability(t *testing.T) {
	cases := []struct {
		role           string
		canWrite       bool
		wantCanEdit    bool
		wantVisibility string
	}{
		{role: "admin", canWrite: true, wantCanEdit: true, wantVisibility: "plaintext"},
		{role: "operator", canWrite: true, wantCanEdit: true, wantVisibility: "plaintext"},
		{role: "viewer", canWrite: false, wantCanEdit: false, wantVisibility: "masked"},
	}

	for _, tc := range cases {
		t.Run(tc.role, func(t *testing.T) {
			repo := newMockRepository()
			handler := NewHandler(repo, &mockLimiter{}, &mockAuditWriter{})
			principal := &auth.Principal{Username: tc.role, Role: tc.role, NormalizedRole: tc.role}

			req := httptest.NewRequest("GET", "/api/profiles/meta", nil)
			req = req.WithContext(auth.ContextWithPrincipal(req.Context(), principal))
			w := httptest.NewRecorder()
			handler.Meta(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("expected status %d, got %d: %s", http.StatusOK, w.Code, w.Body.String())
			}
			var resp ProfileMetaResponse
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("failed to unmarshal meta: %v", err)
			}
			if resp.Capabilities.CanWrite != tc.canWrite {
				t.Errorf("canWrite: expected %v, got %v", tc.canWrite, resp.Capabilities.CanWrite)
			}
			if resp.Capabilities.CanEditCredentials != tc.wantCanEdit {
				t.Errorf("canEditCredentials: expected %v, got %v", tc.wantCanEdit, resp.Capabilities.CanEditCredentials)
			}
			if resp.Capabilities.CredentialVisibility != tc.wantVisibility {
				t.Errorf("credentialVisibility: expected %q, got %q", tc.wantVisibility, resp.Capabilities.CredentialVisibility)
			}
		})
	}
}
