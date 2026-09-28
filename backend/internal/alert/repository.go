package alert

import (
	"context"
	"time"

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

// AcknowledgeAlerts marks alerts as acknowledged if they are currently unacknowledged.
// Returns the number of modified documents.
func (r *Repository) AcknowledgeAlerts(ctx context.Context, ids []string) (int64, error) {
	filter := bson.M{
		"id":              bson.M{"$in": ids},
		"is_acknowledged": false,
	}
	update := bson.M{
		"$set": bson.M{"is_acknowledged": true},
	}
	result, err := r.collection.UpdateMany(ctx, filter, update)
	if err != nil {
		return 0, err
	}
	return result.ModifiedCount, nil
}

// UpdateWorkflow updates alert workflow fields for a given alert id.
func (r *Repository) UpdateWorkflow(ctx context.Context, id string, update AlertWorkflowUpdate) (*WorkflowResponse, error) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	setDoc := bson.M{
		"workflow_status":     update.Status,
		"workflow_updated_at": now,
	}

	if update.AssignedTo != nil {
		setDoc["assigned_to"] = *update.AssignedTo
	}

	if update.Note != nil {
		setDoc["handling_note"] = *update.Note
	}

	if update.Status == string(WorkflowStatusResolved) {
		setDoc["is_acknowledged"] = true
	}

	filter := bson.M{"id": id}
	updateDoc := bson.M{"$set": setDoc}

	result, err := r.collection.UpdateOne(ctx, filter, updateDoc)
	if err != nil {
		return nil, err
	}

	return &WorkflowResponse{
		Success:  true,
		Matched:  result.MatchedCount,
		Modified: result.ModifiedCount,
	}, nil
}
