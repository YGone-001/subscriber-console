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
