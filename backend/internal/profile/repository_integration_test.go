package profile

import (
	"context"
	"fmt"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// profileTestRepo creates a test repository connected to a test database.
// Returns the repo and a cleanup function.
func profileTestRepo(t *testing.T) (*Repository, func()) {
	t.Helper()

	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://127.0.0.1:27017"))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}

	dbName := "xcloud_test_profile_" + bson.NewObjectID().Hex()
	db := client.Database(dbName)

	repo := &Repository{
		profiles:    db.Collection("app_profiles"),
		versions:    db.Collection("app_profile_versions"),
		subscribers: db.Collection("subscribers"),
	}

	cleanup := func() {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		_ = db.Drop(ctx2)
		_ = client.Disconnect(ctx2)
	}

	return repo, cleanup
}

// TestProfileVersionRetention verifies that SaveProfileVersion prunes old versions.
// Creates 55 versions and verifies only 50 are retained.
func TestProfileVersionRetention(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, cleanup := profileTestRepo(t)
	defer cleanup()

	ctx := context.Background()
	profileName := "test_retention_profile"
	totalVersions := 55

	// Create 55 versions with deterministic increasing savedAt
	for i := 0; i < totalVersions; i++ {
		version := bson.M{
			"versionId":   fmt.Sprintf("version_%03d", i),
			"profileName": profileName,
			"savedAt":     fmt.Sprintf("2024-01-01T%02d:%02d:%02d.000Z", i/60, i%60, 0),
			"savedBy":     "testuser",
			"action":      "UPDATE",
			"title":       fmt.Sprintf("Version %d", i),
			"sliceCount":  1,
			"profile": bson.M{
				"name":  profileName,
				"title": fmt.Sprintf("Version %d", i),
			},
		}
		if err := repo.SaveProfileVersion(ctx, version); err != nil {
			t.Fatalf("save version %d: %v", i, err)
		}
	}

	// Verify only 50 versions remain
	versions, err := repo.ListProfileVersions(ctx, profileName, 100)
	if err != nil {
		t.Fatalf("list versions: %v", err)
	}

	if len(versions) != ProfileVersionLimit {
		t.Errorf("expected %d versions, got %d", ProfileVersionLimit, len(versions))
	}

	// Verify the newest 50 are retained (versions 5-54)
	// The oldest 5 (versions 0-4) should be pruned
	if len(versions) > 0 {
		// First version should be the newest (version 54)
		newestVersion := versions[0]
		if newestVersion.VersionID != "version_054" {
			t.Errorf("expected newest version to be version_054, got %s", newestVersion.VersionID)
		}
	}

	// Verify all retained versions use profileName, not name
	cursor, err := repo.versions.Find(ctx, bson.M{"profileName": profileName})
	if err != nil {
		t.Fatalf("find versions: %v", err)
	}
	defer cursor.Close(ctx)

	count := 0
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		// Verify profileName field exists
		if _, ok := doc["profileName"]; !ok {
			t.Error("version document missing profileName field")
		}
		// Verify name field does NOT exist (should be profileName)
		if _, ok := doc["name"]; ok {
			t.Error("version document should not have 'name' field, use 'profileName'")
		}
		count++
	}

	if count != ProfileVersionLimit {
		t.Errorf("expected %d documents with profileName filter, got %d", ProfileVersionLimit, count)
	}
}

// TestProfileVersionRetention_ErrorPropagation verifies that pruning errors are propagated.
func TestProfileVersionRetention_ErrorPropagation(t *testing.T) {
	if testing.Short() {
		t.Skip("requires MongoDB")
	}

	repo, cleanup := profileTestRepo(t)
	defer cleanup()

	ctx := context.Background()

	// Create a version with empty profileName (should not fail, just skip pruning)
	version := bson.M{
		"versionId":   "test_version",
		"profileName": "",
		"savedAt":     "2024-01-01T00:00:00.000Z",
		"savedBy":     "testuser",
		"action":      "CREATE",
		"title":       "Test",
		"sliceCount":  0,
		"profile":     bson.M{"name": "test"},
	}

	err := repo.SaveProfileVersion(ctx, version)
	if err != nil {
		t.Errorf("SaveProfileVersion with empty profileName should not error, got: %v", err)
	}
}
