package subscriber

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// FindSubscriberByImsi loads a single subscriber document by IMSI.
// Returns nil if not found.
func (r *Repository) FindSubscriberByImsi(ctx context.Context, imsi string) (bson.M, error) {
	var doc bson.M
	err := r.subscribers.FindOne(ctx, bson.M{"imsi": imsi}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("find subscriber %s: %w", imsi, err)
	}
	return doc, nil
}

// UpdateSubscriberFromLegacy applies a payload to an existing subscriber document.
// Returns the updated document.
func (r *Repository) UpdateSubscriberFromLegacy(ctx context.Context, imsi string, payload UpdatePayload, current bson.M) (bson.M, error) {
	update := buildUpdateBSON(payload)
	if len(update) == 0 {
		return current, nil
	}

	update["updated_at"] = time.Now().UTC()

	result, err := r.subscribers.UpdateOne(
		ctx,
		bson.M{"imsi": imsi},
		bson.M{"$set": update},
	)
	if err != nil {
		return nil, fmt.Errorf("update subscriber %s: %w", imsi, err)
	}
	if result.MatchedCount == 0 {
		return nil, &SubscriberGovernanceError{Code: "SUBSCRIBER_UPDATE_PRECONDITION_CHANGED"}
	}

	// Reload the document to get the full updated state
	return r.FindSubscriberByImsi(ctx, imsi)
}

// DeleteSubscriber removes a subscriber document by IMSI.
// Returns true if a document was deleted.
func (r *Repository) DeleteSubscriber(ctx context.Context, imsi string) (bool, error) {
	result, err := r.subscribers.DeleteOne(ctx, bson.M{"imsi": imsi})
	if err != nil {
		return false, fmt.Errorf("delete subscriber %s: %w", imsi, err)
	}
	return result.DeletedCount > 0, nil
}

// buildUpdateBSON constructs a $set document from the payload.
// Only includes fields that are actually present in the payload.
func buildUpdateBSON(payload UpdatePayload) bson.M {
	set := bson.M{}

	if payload.Sub4G != nil {
		for k, v := range payload.Sub4G {
			switch k {
			case "ambr":
				set["ambr"] = v
			case "sliceList":
				set["slice"] = v
			case "msisdnList":
				set["msisdn"] = v
			default:
				set[k] = v
			}
		}
	}

	if payload.OcsTraffic != nil {
		for k, v := range payload.OcsTraffic {
			set["ocs_sub."+k] = v
		}
	}

	return set
}
