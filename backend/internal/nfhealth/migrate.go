package nfhealth

import (
	"context"
	"errors"
	"strings"
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

// LegacyLinkMigrationScope bounds one legacy target-to-resource backfill
// invocation. The backfill is never executed automatically at service
// startup; it must be explicitly invoked with this scope.
type LegacyLinkMigrationScope struct {
	// Limit is the maximum number of target documents examined in one
	// invocation. Zero selects DefaultMigrationBatchLimit.
	Limit int
	// DryRun reports what would change without writing.
	DryRun bool
}

// LegacyLinkMigrationResult reports the outcome of one bounded backfill.
type LegacyLinkMigrationResult struct {
	Examined        int      `json:"examined"`
	Resolved        int      `json:"resolved"`
	Unmatched       int      `json:"unmatched"`
	Invalid         int      `json:"invalid"`
	Skipped         int      `json:"skipped"`
	DryRun          bool     `json:"dryRun"`
	ResolvedTargets []string `json:"resolvedTargetIds,omitempty"`
}

// MigrateLegacyTargetResourceLinks backfills the canonical Inventory
// association for legacy candidate-only targets whose Discovery candidate
// carries an explicitly linked, valid Inventory resource.
//
// Properties:
//   - explicitly invoked, never automatic at startup
//   - bounded by scope.Limit (default 500, hard cap MaxPageLimit*10)
//   - dry-run capable: no writes when scope.DryRun is set
//   - idempotent: already-associated targets are excluded by the filter
//   - non-destructive: unmatched targets are reported and never deleted
//   - never fabricates an Inventory resource and never rewrites unrelated
//     Inventory or Discovery documents
//   - revision-safe: the operator revision counter is preserved so in-flight
//     CAS edits are not disturbed
func MigrateLegacyTargetResourceLinks(
	ctx context.Context,
	targets *mongo.Collection,
	observations *mongo.Collection,
	resources *mongo.Collection,
	scope LegacyLinkMigrationScope,
) (*LegacyLinkMigrationResult, error) {
	if targets == nil || observations == nil || resources == nil {
		return nil, errors.New("legacy link migration requires target, observation and resource collections")
	}
	limit := scope.Limit
	if limit <= 0 {
		limit = DefaultMigrationBatchLimit
	}
	if limit > MaxPageLimit*10 {
		limit = MaxPageLimit * 10
	}

	result := &LegacyLinkMigrationResult{DryRun: scope.DryRun}

	// Only candidate-only targets without an Inventory association are
	// candidates. This keeps the backfill idempotent.
	filter := bson.M{
		"$and": []bson.M{
			{"$or": []bson.M{
				{"resourceId": bson.M{"$exists": false}},
				{"resourceId": ""},
			}},
			{"candidateId": bson.M{"$type": "string"}},
			{"candidateId": bson.M{"$ne": ""}},
		},
	}

	opts := options.Find().
		SetLimit(int64(limit)).
		SetSort(bson.D{{Key: "createdAt", Value: 1}}).
		SetProjection(bson.M{"_id": 1, "candidateId": 1})

	cursor, err := targets.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		TargetID    string `bson:"_id"`
		CandidateID string `bson:"candidateId"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}

	for _, row := range rows {
		result.Examined++
		if strings.TrimSpace(row.CandidateID) == "" {
			result.Skipped++
			continue
		}

		var observation struct {
			LinkedResourceID *string `bson:"linkedResourceId"`
			NFType           string  `bson:"nfType"`
		}
		err := observations.FindOne(ctx, bson.M{"_id": row.CandidateID}).Decode(&observation)
		if err != nil {
			if err == mongo.ErrNoDocuments {
				result.Unmatched++
				continue
			}
			return nil, err
		}
		if observation.LinkedResourceID == nil || strings.TrimSpace(*observation.LinkedResourceID) == "" {
			result.Unmatched++
			continue
		}
		linked := strings.TrimSpace(*observation.LinkedResourceID)

		var resource ResourceProjectionDoc
		rerr := resources.FindOne(ctx, bson.M{"_id": linked}).Decode(&resource)
		if rerr != nil {
			if rerr == mongo.ErrNoDocuments {
				result.Unmatched++
				continue
			}
			return nil, rerr
		}
		identity, ierr := resolveResourceProjection(resource)
		if ierr != nil {
			result.Invalid++
			continue
		}

		if scope.DryRun {
			result.Resolved++
			if len(result.ResolvedTargets) < 32 {
				result.ResolvedTargets = append(result.ResolvedTargets, row.TargetID)
			}
			continue
		}
		_, uerr := targets.UpdateOne(ctx,
			bson.M{"_id": row.TargetID, "$or": []bson.M{
				{"resourceId": bson.M{"$exists": false}},
				{"resourceId": ""},
			}},
			bson.M{"$set": bson.M{
				"resourceId":    identity.ResourceID,
				"domain":        identity.Domain,
				"nfType":        identity.NFType,
				"identityState": IdentityInventoryAuthoritative,
			}},
		)
		if uerr != nil {
			if uerr == mongo.ErrNoDocuments {
				result.Skipped++
				continue
			}
			return nil, uerr
		}
		result.Resolved++
		if len(result.ResolvedTargets) < 32 {
			result.ResolvedTargets = append(result.ResolvedTargets, row.TargetID)
		}
	}
	return result, nil
}

// ResourceProjectionDoc is the legacy migration read projection of an
// Inventory resource document. Unknown fields are ignored.
type ResourceProjectionDoc struct {
	ResourceID     string `bson:"_id"`
	Kind           string `bson:"kind"`
	Domain         string `bson:"domain"`
	Role           string `bson:"role"`
	LifecycleState string `bson:"lifecycleState"`
}

// resolveResourceProjection applies the same monitored-kind, lifecycle,
// domain and NF type rules as target creation.
func resolveResourceProjection(doc ResourceProjectionDoc) (*ResolvedIdentity, error) {
	if !isMonitoredResourceKind(doc.Kind) {
		return nil, validationError("NF_HEALTH_RESOURCE_KIND_UNSUPPORTED", "inventory resource kind does not support monitoring association")
	}
	if doc.LifecycleState == "retired" {
		return nil, validationError("NF_HEALTH_RESOURCE_RETIRED", "inventory resource is retired")
	}
	if !isSupportedResourceDomain(doc.Domain) {
		return nil, validationError("NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED", "inventory resource domain does not support monitoring association")
	}
	nfType, ok := ResolveNFTypeFromRole(doc.Role)
	if !ok {
		return nil, validationError("NF_HEALTH_NF_TYPE_UNRESOLVED", "inventory resource role must declare an explicit supported network function type")
	}
	if !NFTypePermittedInDomain(nfType, doc.Domain) {
		return nil, validationError("NF_HEALTH_DOMAIN_TYPE_MISMATCH", "resolved network function type is not valid for the inventory resource domain")
	}
	return &ResolvedIdentity{
		ResourceID:    doc.ResourceID,
		Domain:        doc.Domain,
		NFType:        nfType,
		IdentityState: IdentityInventoryAuthoritative,
	}, nil
}
