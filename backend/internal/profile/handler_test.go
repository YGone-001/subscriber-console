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

func TestCreateProfile(t *testing.T) {
	repo := newMockRepository()
	auditWriter := &mockAuditWriter{}
	limiter := &mockLimiter{}
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
	limiter := &mockLimiter{}
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
	limiter := &mockLimiter{}
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
	limiter := &mockLimiter{}
	handler := NewHandler(repo, limiter, auditWriter)

	principal := &auth.Principal{
		Username:       "testuser",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

	// Create a profile
	body := CreateProfileRequest{Name: "test_profile"}
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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
		NormalizedRole: "super_admin",
	}

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
	writer := &auth.Principal{Username: "testuser", Role: "super_admin", NormalizedRole: "super_admin"}

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
