package profile

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository provides read-only access to profile data.
type Repository struct {
	profiles    *mongo.Collection
	versions    *mongo.Collection
	subscribers *mongo.Collection
}

// NewRepository creates a new read-only profile Repository.
func NewRepository(profiles, versions, subscribers *mongo.Collection) *Repository {
	return &Repository{
		profiles:    profiles,
		versions:    versions,
		subscribers: subscribers,
	}
}

// ListProfiles returns all profiles with global summary.
func (r *Repository) ListProfiles(ctx context.Context) ([]ProfileListItem, ProfileSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cursor, err := r.profiles.Find(ctx, bson.M{}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, ProfileSummary{}, err
	}
	defer cursor.Close(ctx)

	var profiles []ProfileListItem
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		item := ProfileListItem{
			Name:        stringField(doc, "name"),
			Title:       stringField(doc, "title"),
			Description: stringField(doc, "description"),
			SliceCount:  sliceCount(doc),
			CreatedAt:   timeField(doc, "createdAt"),
			UpdatedAt:   timeField(doc, "updatedAt"),
			CreatedBy:   stringField(doc, "createdBy"),
			UpdatedBy:   stringField(doc, "updatedBy"),
		}
		profiles = append(profiles, item)
	}

	if profiles == nil {
		profiles = []ProfileListItem{}
	}

	// Global summary: count profiles and subscriber stats
	summary, err := r.computeSummary(ctx)
	if err != nil {
		return profiles, ProfileSummary{}, err
	}

	return profiles, summary, nil
}

// GetProfile returns a single profile by name, or nil if not found.
func (r *Repository) GetProfile(ctx context.Context, name string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := r.profiles.FindOne(ctx, bson.M{"name": name}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// Convert BSON to map, hiding _id
	delete(doc, "_id")
	return doc, nil
}

// GetProfileStats returns subscriber statistics for a profile.
// Queries xcloud.subscribers (cross-domain read, no writes).
func (r *Repository) GetProfileStats(ctx context.Context, profileName string) (ProfileStats, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	filter := bson.M{
		"$or": bson.A{
			bson.M{"webui_meta.profile_name": profileName},
			bson.M{"webui_meta.profile": profileName},
			bson.M{"profile_name": profileName},
			bson.M{"profile": profileName},
		},
	}

	// Count by status
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: filter}},
		{{Key: "$group", Value: bson.M{
			"_id":   nil,
			"total": bson.M{"$sum": 1},
			"active": bson.M{"$sum": bson.M{
				"$cond": bson.A{
					bson.M{"$or": bson.A{
						bson.M{"$eq": bson.A{"$access_restriction_data", 32}},
						bson.M{"$eq": bson.A{"$access_restriction_data", 0}},
						bson.M{"$not": bson.A{"$access_restriction_data"}},
						bson.M{"$eq": bson.A{"$access_restriction_data", nil}},
					}},
					1, 0,
				},
			}},
			"suspended": bson.M{"$sum": bson.M{
				"$cond": bson.A{
					bson.M{"$eq": bson.A{"$access_restriction_data", 255}},
					1, 0,
				},
			}},
			"restricted": bson.M{"$sum": bson.M{
				"$cond": bson.A{
					bson.M{"$and": bson.A{
						bson.M{"$gt": bson.A{"$access_restriction_data", 0}},
						bson.M{"$ne": bson.A{"$access_restriction_data", 32}},
						bson.M{"$ne": bson.A{"$access_restriction_data", 255}},
					}},
					1, 0,
				},
			}},
		}}},
	}

	cursor, err := r.subscribers.Aggregate(ctx, pipeline)
	if err != nil {
		return ProfileStats{ProfileName: profileName, SampleImsis: []string{}}, err
	}
	defer cursor.Close(ctx)

	stats := ProfileStats{
		ProfileName: profileName,
		SampleImsis: []string{},
	}

	if cursor.Next(ctx) {
		var agg struct {
			Total      int `bson:"total"`
			Active     int `bson:"active"`
			Suspended  int `bson:"suspended"`
			Restricted int `bson:"restricted"`
		}
		if err := cursor.Decode(&agg); err == nil {
			stats.TotalSubscribers = agg.Total
			stats.ActiveSubscribers = agg.Active
			stats.SuspendedSubscribers = agg.Suspended
			stats.RestrictedSubscribers = agg.Restricted
		}
	}

	// Sample IMSIs
	sampleCursor, err := r.subscribers.Find(ctx, filter,
		options.Find().SetSort(bson.D{{Key: "imsi", Value: 1}}).SetLimit(10).SetProjection(bson.M{"imsi": 1}))
	if err == nil {
		defer sampleCursor.Close(ctx)
		for sampleCursor.Next(ctx) {
			var doc bson.M
			if sampleCursor.Decode(&doc) == nil {
				if imsi, ok := doc["imsi"]; ok {
					stats.SampleImsis = append(stats.SampleImsis, stringify(imsi))
				}
			}
		}
	}

	return stats, nil
}

// ListProfileVersions returns version history for a profile.
func (r *Repository) ListProfileVersions(ctx context.Context, profileName string, limit int) ([]ProfileVersionSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 20
	}

	// Match Node ordering: sorted by savedAt descending (most recent first)
	cursor, err := r.versions.Find(ctx,
		bson.M{"name": profileName},
		options.Find().SetSort(bson.D{{Key: "savedAt", Value: -1}}).SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var versions []ProfileVersionSummary
	for cursor.Next(ctx) {
		var doc bson.M
		if err := cursor.Decode(&doc); err != nil {
			continue
		}
		v := ProfileVersionSummary{
			VersionID: stringField(doc, "versionId"),
			Action:    stringField(doc, "action"),
			SavedAt:   timeField(doc, "savedAt"),
			SavedBy:   stringField(doc, "savedBy"),
			Title:     stringField(doc, "title"),
		}
		versions = append(versions, v)
	}

	if versions == nil {
		versions = []ProfileVersionSummary{}
	}

	return versions, nil
}

// computeSummary counts total profiles and aggregates subscriber stats.
func (r *Repository) computeSummary(ctx context.Context) (ProfileSummary, error) {
	totalProfiles, err := r.profiles.CountDocuments(ctx, bson.M{})
	if err != nil {
		return ProfileSummary{}, err
	}

	// Count total and active subscribers across all profiles
	pipeline := mongo.Pipeline{
		{{Key: "$group", Value: bson.M{
			"_id":   nil,
			"total": bson.M{"$sum": 1},
			"active": bson.M{"$sum": bson.M{
				"$cond": bson.A{
					bson.M{"$or": bson.A{
						bson.M{"$eq": bson.A{"$access_restriction_data", 32}},
						bson.M{"$eq": bson.A{"$access_restriction_data", 0}},
						bson.M{"$not": bson.A{"$access_restriction_data"}},
						bson.M{"$eq": bson.A{"$access_restriction_data", nil}},
					}},
					1, 0,
				},
			}},
		}}},
	}

	cursor, err := r.subscribers.Aggregate(ctx, pipeline)
	if err != nil {
		return ProfileSummary{TotalProfiles: int(totalProfiles)}, nil
	}
	defer cursor.Close(ctx)

	summary := ProfileSummary{TotalProfiles: int(totalProfiles)}
	if cursor.Next(ctx) {
		var agg struct {
			Total  int `bson:"total"`
			Active int `bson:"active"`
		}
		if err := cursor.Decode(&agg); err == nil {
			summary.TotalSubscribers = agg.Total
			summary.ActiveSubscribers = agg.Active
		}
	}

	return summary, nil
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func stringField(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func timeField(doc bson.M, key string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.DateTime:
		return t.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	default:
		return ""
	}
}

func sliceCount(doc bson.M) int {
	v, ok := doc["sliceList"]
	if !ok || v == nil {
		return 0
	}
	if arr, ok := v.(bson.A); ok {
		return len(arr)
	}
	return 0
}

func stringify(v any) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	default:
		return fmt.Sprintf("%v", v)
	}
}
