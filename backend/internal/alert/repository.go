package alert

import (
	"context"
	"fmt"
	"os"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Repository handles database operations for alerts in xcloud_ops.app_alerts.
type Repository struct {
	collection *mongo.Collection
}

// NewRepository creates a new alerts Repository.
func NewRepository(collection *mongo.Collection) *Repository {
	return &Repository{collection: collection}
}

// ListAlerts retrieves alerts up to limit, sorted newest first, along with active counts.
func (r *Repository) ListAlerts(ctx context.Context, limit int64) (*ListAlertsResponse, error) {
	if os.Getenv("TEST_FAIL_PLATFORM_READS") == "1" {
		return nil, fmt.Errorf("alert repository query failure: connection refused")
	}
	findOpts := options.Find().
		SetSort(bson.D{{Key: "timestamp", Value: -1}}).
		SetLimit(limit)

	cursor, err := r.collection.Find(ctx, bson.M{}, findOpts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	alerts := make([]AlertDocument, 0)
	if err := cursor.All(ctx, &alerts); err != nil {
		return nil, err
	}

	critCount, err := r.collection.CountDocuments(ctx, bson.M{"is_acknowledged": false, "level": "CRITICAL"})
	if err != nil {
		return nil, err
	}

	warnCount, err := r.collection.CountDocuments(ctx, bson.M{"is_acknowledged": false, "level": "WARNING"})
	if err != nil {
		return nil, err
	}

	activeCount, err := r.collection.CountDocuments(ctx, bson.M{"is_acknowledged": false})
	if err != nil {
		return nil, err
	}

	return &ListAlertsResponse{
		Alerts:              alerts,
		ActiveCriticalCount: critCount,
		ActiveWarningCount:  warnCount,
		ActiveCount:         activeCount,
	}, nil
}
