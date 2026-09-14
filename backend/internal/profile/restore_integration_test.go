package profile

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"subscriber/internal/auth"
)

// ─── Restore Integration Tests ───
// These tests use real MongoDB (same CI convention as TestProfileVersionRetention).

func TestRestoreIntegration_ExistingCAS(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, cleanup := profileTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	profileName := "int_restore_existing"

	// Insert current profile
	current := bson.M{
		"name":        profileName,
		"title":       "Current Title",
		"description": "Current description",
		"createdAt":   "2024-01-01T00:00:00.000Z",
		"createdBy":   "original_user",
		"updatedAt":   "2024-07-01T00:00:00.000Z",
		"updatedBy":   "current_user",
	}
	if err := repo.InsertProfileCreateOnly(ctx, current); err != nil {
		t.Fatalf("insert current: %v", err)
	}

	// Insert historical version
	versionDoc := bson.M{
		"versionId":   "v-restore-001",
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
	}
	if _, err := repo.versions.InsertOne(ctx, versionDoc); err != nil {
		t.Fatalf("insert version: %v", err)
	}

	// Build intent (simulating assertFrozenRestoreV2)
	currentProfile, err := repo.GetProfile(ctx, profileName)
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}
	if currentProfile == nil {
		t.Fatal("expected current profile to exist")
	}

	restored := bson.M{
		"name":        profileName,
		"title":       "Old Title",
		"description": "Old description",
		"createdAt":   "2024-01-01T00:00:00.000Z",
		"createdBy":   "original_user",
		"updatedAt":   "2024-06-01T10:00:00.000Z",
		"updatedBy":   "admin",
	}

	intent := &RestoreIntent{
		Version:               "profile-restore-v2",
		ProfileName:           profileName,
		VersionId:             "v-restore-001",
		SourceVersionHash:     "hash1",
		CurrentState:          "present",
		CurrentProfileHash:    strPtr("hash2"),
		EffectiveRestoredHash: "hash3",
		OperationFingerprint:  "hash4",
		CurrentProfile:        currentProfile,
		EffectiveRestored:     restored,
		VersionDoc:            versionDoc,
	}

	p := &auth.Principal{
		Username:       "test_admin",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Execute restore
	result, err := repo.executeRestore(ctx, p, profileName, intent)
	if err != nil {
		t.Fatalf("execute restore: %v", err)
	}

	// Assert restored profile
	if result["title"] != "Old Title" {
		t.Errorf("expected title 'Old Title', got '%v'", result["title"])
	}
	if result["updatedBy"] != "admin" {
		t.Errorf("expected updatedBy 'admin', got '%v'", result["updatedBy"])
	}

	// Assert RESTORE version was written (1 before-version)
	count, err := repo.versions.CountDocuments(ctx, bson.M{
		"profileName": profileName,
		"action":      "RESTORE",
	})
	if err != nil {
		t.Fatalf("count versions: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 RESTORE version, got %d", count)
	}

	// Assert profile was actually updated in DB
	dbProfile, err := repo.GetProfile(ctx, profileName)
	if err != nil {
		t.Fatalf("get profile after restore: %v", err)
	}
	if dbProfile["title"] != "Old Title" {
		t.Errorf("expected DB title 'Old Title', got '%v'", dbProfile["title"])
	}
}

func TestRestoreIntegration_StaleCAS(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, cleanup := profileTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	profileName := "int_restore_stale"

	// Insert original profile
	original := bson.M{
		"name":        profileName,
		"title":       "Original Title",
		"description": "Original",
		"createdAt":   "2024-01-01T00:00:00.000Z",
		"createdBy":   "original_user",
		"updatedAt":   "2024-01-01T00:00:00.000Z",
		"updatedBy":   "original_user",
	}
	if err := repo.InsertProfileCreateOnly(ctx, original); err != nil {
		t.Fatalf("insert original: %v", err)
	}

	// Read current (snapshot for CAS)
	currentProfile, err := repo.GetProfile(ctx, profileName)
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}

	// Mutate DB current (simulating concurrent write)
	_, err = repo.profiles.UpdateOne(ctx,
		bson.M{"name": profileName},
		bson.M{"$set": bson.M{"title": "Mutated Title", "updatedAt": "2024-08-01T00:00:00.000Z"}},
	)
	if err != nil {
		t.Fatalf("mutate profile: %v", err)
	}

	// Build restore intent with stale currentProfile
	restored := bson.M{
		"name":        profileName,
		"title":       "Old Title",
		"description": "Old",
		"createdAt":   "2024-01-01T00:00:00.000Z",
		"createdBy":   "original_user",
		"updatedAt":   "2024-06-01T00:00:00.000Z",
		"updatedBy":   "admin",
	}

	intent := &RestoreIntent{
		Version:           "profile-restore-v2",
		ProfileName:       profileName,
		VersionId:         "v-001",
		CurrentState:      "present",
		CurrentProfile:    currentProfile,
		EffectiveRestored: restored,
	}

	p := &auth.Principal{
		Username:       "test_admin",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Execute restore — should fail with precondition changed
	_, err = repo.executeRestore(ctx, p, profileName, intent)
	if err != ErrProfilePreconditionChanged {
		t.Fatalf("expected ErrProfilePreconditionChanged, got %v", err)
	}

	// Assert newer DB document untouched
	dbProfile, err := repo.GetProfile(ctx, profileName)
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}
	if dbProfile["title"] != "Mutated Title" {
		t.Errorf("expected DB title 'Mutated Title', got '%v'", dbProfile["title"])
	}

	// Assert RESTORE version writes = 0
	count, err := repo.versions.CountDocuments(ctx, bson.M{
		"profileName": profileName,
		"action":      "RESTORE",
	})
	if err != nil {
		t.Fatalf("count versions: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 RESTORE versions, got %d", count)
	}
}

func TestRestoreIntegration_MissingInsertOne(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, cleanup := profileTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	profileName := "int_restore_missing"

	// Insert historical version only (no current profile)
	versionDoc := bson.M{
		"versionId":   "v-001",
		"profileName": profileName,
		"action":      "CREATE",
		"savedAt":     "2024-06-01T10:00:00.000Z",
		"savedBy":     "admin",
		"title":       "New Profile",
		"profile": bson.M{
			"name":      profileName,
			"title":     "New Profile",
			"createdAt": "2024-06-01T10:00:00.000Z",
			"createdBy": "admin",
			"updatedAt": "2024-06-01T10:00:00.000Z",
			"updatedBy": "admin",
		},
	}
	if _, err := repo.versions.InsertOne(ctx, versionDoc); err != nil {
		t.Fatalf("insert version: %v", err)
	}

	restored := bson.M{
		"name":      profileName,
		"title":     "New Profile",
		"createdAt": "2024-06-01T10:00:00.000Z",
		"createdBy": "admin",
		"updatedAt": "2024-06-01T10:00:00.000Z",
		"updatedBy": "admin",
	}

	intent := &RestoreIntent{
		Version:           "profile-restore-v2",
		ProfileName:       profileName,
		VersionId:         "v-001",
		CurrentState:      "absent",
		CurrentProfile:    nil,
		EffectiveRestored: restored,
		VersionDoc:        versionDoc,
	}

	p := &auth.Principal{
		Username:       "test_admin",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Execute restore
	result, err := repo.executeRestore(ctx, p, profileName, intent)
	if err != nil {
		t.Fatalf("execute restore: %v", err)
	}

	if result["title"] != "New Profile" {
		t.Errorf("expected title 'New Profile', got '%v'", result["title"])
	}

	// Assert RESTORE before-version writes = 0 (no previous current)
	count, err := repo.versions.CountDocuments(ctx, bson.M{
		"profileName": profileName,
		"action":      "RESTORE",
	})
	if err != nil {
		t.Fatalf("count versions: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 RESTORE versions for missing profile, got %d", count)
	}
}

func TestRestoreIntegration_ConcurrentMissing(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, cleanup := profileTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	profileName := "int_restore_concurrent"

	// Create unique index on name to enforce single-insert constraint
	_, err := repo.profiles.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "name", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		t.Fatalf("create index: %v", err)
	}

	restored := bson.M{
		"name":      profileName,
		"title":     "New Profile",
		"createdAt": "2024-06-01T10:00:00.000Z",
		"createdBy": "admin",
		"updatedAt": "2024-06-01T10:00:00.000Z",
		"updatedBy": "admin",
	}

	// Run two concurrent contenders
	var wg sync.WaitGroup
	results := make([]error, 2)

	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			intent := &RestoreIntent{
				Version:           "profile-restore-v2",
				ProfileName:       profileName,
				VersionId:         "v-001",
				CurrentState:      "absent",
				CurrentProfile:    nil,
				EffectiveRestored: restored,
			}
			p := &auth.Principal{
				Username:       "admin",
				Role:           "super_admin",
				NormalizedRole: "super_admin",
			}
			_, err := repo.executeRestore(ctx, p, profileName, intent)
			results[idx] = err
		}(i)
	}

	wg.Wait()

	// Exactly 1 success, exactly 1 precondition conflict
	successes := 0
	conflicts := 0
	for _, err := range results {
		if err == nil {
			successes++
		} else if err == ErrProfilePreconditionChanged {
			conflicts++
		} else {
			t.Errorf("unexpected error: %v", err)
		}
	}
	if successes != 1 {
		t.Errorf("expected 1 success, got %d", successes)
	}
	if conflicts != 1 {
		t.Errorf("expected 1 conflict, got %d", conflicts)
	}

	// Winner document remains intact
	dbProfile, err := repo.GetProfile(ctx, profileName)
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}
	if dbProfile == nil {
		t.Fatal("expected profile to exist")
	}
	if dbProfile["title"] != "New Profile" {
		t.Errorf("expected title 'New Profile', got '%v'", dbProfile["title"])
	}
}

func TestRestoreIntegration_VersionPartialWrite(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, cleanup := profileTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	profileName := "int_restore_partial"

	// Insert current profile
	current := bson.M{
		"name":        profileName,
		"title":       "Current Title",
		"description": "Current description",
		"createdAt":   "2024-01-01T00:00:00.000Z",
		"createdBy":   "original_user",
		"updatedAt":   "2024-07-01T00:00:00.000Z",
		"updatedBy":   "current_user",
	}
	if err := repo.InsertProfileCreateOnly(ctx, current); err != nil {
		t.Fatalf("insert current: %v", err)
	}

	// Insert historical version
	versionDoc := bson.M{
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
	}
	if _, err := repo.versions.InsertOne(ctx, versionDoc); err != nil {
		t.Fatalf("insert version: %v", err)
	}

	currentProfile, err := repo.GetProfile(ctx, profileName)
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}

	restored := bson.M{
		"name":        profileName,
		"title":       "Old Title",
		"description": "Old description",
		"createdAt":   "2024-01-01T00:00:00.000Z",
		"createdBy":   "original_user",
		"updatedAt":   "2024-06-01T10:00:00.000Z",
		"updatedBy":   "admin",
	}

	// Create unique index on (profileName, action) to force version save failure
	// when a RESTORE action already exists
	_, err = repo.versions.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "profileName", Value: 1}, {Key: "action", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		t.Fatalf("create index: %v", err)
	}

	// Pre-insert a RESTORE version so the second insert will fail with duplicate key
	_, err = repo.versions.InsertOne(ctx, bson.M{
		"versionId":   "existing-restore",
		"profileName": profileName,
		"action":      "RESTORE",
		"savedAt":     "2024-05-01T00:00:00.000Z",
		"savedBy":     "previous_admin",
	})
	if err != nil {
		t.Fatalf("insert existing restore: %v", err)
	}

	intent := &RestoreIntent{
		Version:           "profile-restore-v2",
		ProfileName:       profileName,
		VersionId:         "v-001",
		CurrentState:      "present",
		CurrentProfile:    currentProfile,
		EffectiveRestored: restored,
		VersionDoc:        versionDoc,
	}

	p := &auth.Principal{
		Username:       "test_admin",
		Role:           "super_admin",
		NormalizedRole: "super_admin",
	}

	// Execute restore — CAS should succeed but version save should fail (duplicate key)
	_, err = repo.executeRestore(ctx, p, profileName, intent)
	if err != ErrRestorePartialWrite {
		t.Fatalf("expected ErrRestorePartialWrite, got %v", err)
	}

	// Assert profile was actually restored (CAS succeeded)
	dbProfile, err := repo.GetProfile(ctx, profileName)
	if err != nil {
		t.Fatalf("get profile: %v", err)
	}
	if dbProfile["title"] != "Old Title" {
		t.Errorf("expected DB title 'Old Title' (CAS succeeded), got '%v'", dbProfile["title"])
	}
}

// ─── Helper ───

func strPtr(s string) *string {
	return &s
}

// executeRestore is a test helper that mirrors the handler's executeFrozenRestoreV2 logic.
func (r *Repository) executeRestore(ctx context.Context, p *auth.Principal, name string, intent *RestoreIntent) (bson.M, error) {
	now := time.Now().UTC()

	if intent.CurrentState == "present" {
		if err := r.ReplaceProfileCAS(ctx, name, intent.CurrentProfile, intent.EffectiveRestored); err != nil {
			return nil, err
		}
	} else {
		if err := r.InsertProfileCreateOnly(ctx, intent.EffectiveRestored); err != nil {
			if err == ErrProfileExists {
				return nil, ErrProfilePreconditionChanged
			}
			return nil, err
		}
	}

	// Save RESTORE version (pre-restore current profile)
	if intent.CurrentProfile != nil && r.versions != nil {
		versionRecord := bson.M{
			"versionId":   bson.NewObjectID().Hex(),
			"profileName": name,
			"profile":     intent.CurrentProfile,
			"action":      "RESTORE",
			"savedAt":     now,
			"savedBy":     p.Username,
			"title":       intent.CurrentProfile["title"],
		}
		if _, err := r.versions.InsertOne(ctx, versionRecord); err != nil {
			return nil, ErrRestorePartialWrite
		}
	}

	return intent.EffectiveRestored, nil
}
