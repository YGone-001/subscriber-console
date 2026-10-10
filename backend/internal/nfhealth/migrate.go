package nfhealth

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MigrationScope bounds a sample expiration-type migration run. The migration
// is never executed automatically at service startup; it must be explicitly
// authorized by the operator through an invocation that supplies this scope.
type MigrationScope struct {
	// Limit is the maximum number of documents examined in one invocation.
	// Zero selects DefaultMigrationBatchLimit.
	Limit int
	// DryRun reports what would change without writing.
	DryRun bool
	// MaxAgeDays optionally restricts conversion to samples whose collectedAt
	// is no older than this many days. Zero means no age bound.
	MaxAgeDays int
}

// DefaultMigrationBatchLimit bounds one migration invocation.
const DefaultMigrationBatchLimit = 500

// MigrationResult reports the outcome of one bounded migration invocation.
type MigrationResult struct {
	Examined  int      `json:"examined"`
	Converted int      `json:"converted"`
	Skipped   int      `json:"skipped"`
	Invalid   int      `json:"invalid"`
	DryRun    bool     `json:"dryRun"`
	SampleIDs []string `json:"convertedSampleIds,omitempty"`
}

// MigrateSampleExpiresToBSONDate converts legacy string-typed expiresAt fields
// to BSON Date values so the MongoDB TTL index can consume them.
//
// Properties:
//   - explicitly invoked, never automatic at startup
//   - bounded by scope.Limit
//   - idempotent: already-converted documents are skipped
//   - dry-run capable: no writes when scope.DryRun is set
//   - preserves previously stored samples; it never deletes data
func (r *Repository) MigrateSampleExpiresToBSONDate(ctx context.Context, scope MigrationScope) (*MigrationResult, error) {
	limit := scope.Limit
	if limit <= 0 {
		limit = DefaultMigrationBatchLimit
	}
	if limit > MaxPageLimit*10 {
		limit = MaxPageLimit * 10
	}

	result := &MigrationResult{DryRun: scope.DryRun}

	// Only documents whose expiresAt is still a BSON string are candidates.
	// This keeps the migration idempotent and prevents re-conversion.
	filter := bson.M{"expiresAt": bson.M{"$type": "string"}}
	if scope.MaxAgeDays > 0 {
		cutoff := time.Now().UTC().AddDate(0, 0, -scope.MaxAgeDays).Format(time.RFC3339Nano)
		filter["collectedAt"] = bson.M{"$gte": cutoff}
	}

	opts := options.Find().
		SetLimit(int64(limit)).
		SetProjection(bson.M{"_id": 1, "expiresAt": 1})

	cursor, err := r.samples.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		SampleID  string `bson:"_id"`
		ExpiresAt bson.RawValue
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}

	for _, row := range rows {
		result.Examined++
		raw := row.ExpiresAt
		if raw.Type != bson.TypeString {
			result.Skipped++
			continue
		}
		text, ok := raw.StringValueOK()
		if !ok {
			result.Invalid++
			continue
		}
		parsed, perr := ParseBSONTime(text)
		if perr != nil || parsed.IsZero() {
			result.Invalid++
			continue
		}
		if scope.DryRun {
			result.Converted++
			if len(result.SampleIDs) < 32 {
				result.SampleIDs = append(result.SampleIDs, row.SampleID)
			}
			continue
		}
		_, uerr := r.samples.UpdateOne(ctx,
			bson.M{"_id": row.SampleID, "expiresAt": bson.M{"$type": "string"}},
			bson.M{"$set": bson.M{"expiresAt": parsed}},
		)
		if uerr != nil {
			if uerr == mongo.ErrNoDocuments {
				result.Skipped++
				continue
			}
			return nil, uerr
		}
		result.Converted++
		if len(result.SampleIDs) < 32 {
			result.SampleIDs = append(result.SampleIDs, row.SampleID)
		}
	}
	return result, nil
}
