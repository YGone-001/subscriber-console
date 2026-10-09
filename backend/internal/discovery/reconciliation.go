package discovery

import (
	"context"
	"errors"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// InventoryResolver reads authoritative Inventory resources without mutating them.
type InventoryResolver interface {
	// ExistsAndLinkable reports whether a resource exists, is not retired, and is
	// a compatible network function or function instance.
	ExistsAndLinkable(ctx context.Context, resourceID string) (exists bool, linkable bool, err error)
}

// MongoInventoryResolver resolves Inventory resources from the authoritative
// xcloud_ops.app_inventory_resources collection. It performs reads only.
type MongoInventoryResolver struct {
	collection *mongo.Collection
}

// NewMongoInventoryResolver builds a read-only Inventory resolver.
func NewMongoInventoryResolver(collection *mongo.Collection) *MongoInventoryResolver {
	return &MongoInventoryResolver{collection: collection}
}

// ExistsAndLinkable implements InventoryResolver.
func (r *MongoInventoryResolver) ExistsAndLinkable(ctx context.Context, resourceID string) (bool, bool, error) {
	var doc struct {
		Kind           string `bson:"kind"`
		LifecycleState string `bson:"lifecycleState"`
	}
	err := r.collection.FindOne(ctx, bson.M{"_id": resourceID}).Decode(&doc)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return false, false, nil
		}
		return false, false, err
	}
	if doc.LifecycleState == "retired" {
		return true, false, nil
	}
	switch doc.Kind {
	case "network_function", "network_function_instance":
		return true, true, nil
	default:
		return true, false, nil
	}
}

// LinkState is the reconciliation projection of a candidate against Inventory.
type LinkState struct {
	State      string  `json:"state"`
	ResourceID *string `json:"resourceId,omitempty"`
}

// ReconcileLinkState classifies a candidate's Inventory association.
// Discovery never creates or updates Inventory resources; it only records
// operator-authored associations in discovery metadata.
func ReconcileLinkState(candidate *NFObservation, resolver InventoryResolver, ctx context.Context) (LinkState, error) {
	if candidate == nil || candidate.LinkedResourceID == nil || *candidate.LinkedResourceID == "" {
		return LinkState{State: "unmatched"}, nil
	}
	exists, linkable, err := resolver.ExistsAndLinkable(ctx, *candidate.LinkedResourceID)
	if err != nil {
		return LinkState{}, err
	}
	switch {
	case !exists:
		return LinkState{State: "missing_resource", ResourceID: candidate.LinkedResourceID}, nil
	case !linkable:
		return LinkState{State: "retired_or_incompatible", ResourceID: candidate.LinkedResourceID}, nil
	default:
		return LinkState{State: "linked", ResourceID: candidate.LinkedResourceID}, nil
	}
}
