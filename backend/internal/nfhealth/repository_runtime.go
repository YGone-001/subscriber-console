package nfhealth

import (
	"context"
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// repository_runtime.go adds the bounded lookups required by the runtime
// discovery bootstrap. The existing target creation path is unchanged.

// GetTargetByResourceID returns the monitoring target associated with one
// canonical Inventory resource, when one exists.
func (r *Repository) GetTargetByResourceID(ctx context.Context, resourceID string) (*HealthTarget, error) {
	trimmed := strings.TrimSpace(resourceID)
	if trimmed == "" {
		return nil, ErrNotFound
	}
	var doc HealthTarget
	err := r.targets.FindOne(ctx, bson.M{"resourceId": trimmed}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	ProjectIdentityState(&doc)
	return &doc, nil
}

// ListTargetsByResourceIDs is the bounded batch association lookup used by the
// runtime read projection: one indexed query for a bounded identifier set, never
// one query per resource.
func (r *Repository) ListTargetsByResourceIDs(ctx context.Context, resourceIDs []string) (map[string]string, error) {
	out := map[string]string{}
	if len(resourceIDs) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(resourceIDs))
	seen := make(map[string]struct{}, len(resourceIDs))
	for _, id := range resourceIDs {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" {
			continue
		}
		if _, duplicate := seen[trimmed]; duplicate {
			continue
		}
		seen[trimmed] = struct{}{}
		ids = append(ids, trimmed)
	}
	if len(ids) == 0 {
		return out, nil
	}
	cursor, err := r.targets.Find(ctx, bson.M{"resourceId": bson.M{"$in": ids}})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var doc struct {
			TargetID   string `bson:"_id"`
			ResourceID string `bson:"resourceId"`
		}
		if err := cursor.Decode(&doc); err != nil {
			return nil, err
		}
		if doc.ResourceID != "" {
			out[doc.ResourceID] = doc.TargetID
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
