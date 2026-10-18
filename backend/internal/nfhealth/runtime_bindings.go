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

// DynamicBinding is one bootstrap-installed local process binding.
//
// A dynamic binding is created only by the approved runtime bootstrap, after a
// verified runtime observation has been associated with a canonical Inventory
// resource. It is persisted so scheduled L1 collection keeps working across a
// backend restart.
type DynamicBinding struct {
	ResourceID  string `json:"resourceId" bson:"_id"`
	Unit        string `json:"unit" bson:"unit"`
	ProcessName string `json:"processName" bson:"processName"`
	Domain      string `json:"domain" bson:"domain"`
	NFType      string `json:"nfType" bson:"nfType"`
	HostID      string `json:"hostId" bson:"hostId"`
	// BindingKey is unique per (host, process identity, NF type) so two
	// Inventory resources can never claim the same local process.
	BindingKey string `json:"bindingKey" bson:"bindingKey"`
	Source     string `json:"source" bson:"source"`
	CreatedAt  string `json:"createdAt" bson:"createdAt"`
	CreatedBy  string `json:"createdBy" bson:"createdBy"`
	Revision   int64  `json:"revision" bson:"revision"`
}

// BindingStore persists bootstrap-installed bindings in xcloud_ops.
type BindingStore struct {
	collection *mongo.Collection
}

// NewBindingStore constructs the binding store.
func NewBindingStore(collection *mongo.Collection) *BindingStore {
	return &BindingStore{collection: collection}
}

// MaxLoadedBindings bounds the startup load so a corrupt collection can never
// turn into an unbounded read.
const MaxLoadedBindings = 500

// LoadAll reads the bounded binding set.
func (s *BindingStore) LoadAll(ctx context.Context) ([]DynamicBinding, error) {
	if s == nil || s.collection == nil {
		return []DynamicBinding{}, nil
	}
	opts := options.Find().SetLimit(MaxLoadedBindings).SetSort(bson.D{{Key: "_id", Value: 1}})
	cursor, err := s.collection.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]DynamicBinding, 0, 16)
	for cursor.Next(ctx) {
		var binding DynamicBinding
		if err := cursor.Decode(&binding); err != nil {
			return nil, err
		}
		out = append(out, binding)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Get returns the binding for one Inventory resource.
func (s *BindingStore) Get(ctx context.Context, resourceID string) (*DynamicBinding, error) {
	if s == nil || s.collection == nil {
		return nil, ErrNotFound
	}
	var binding DynamicBinding
	err := s.collection.FindOne(ctx, bson.M{"_id": strings.TrimSpace(resourceID)}).Decode(&binding)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &binding, nil
}

// FindByKey returns the binding claiming one (host, process, NF type) identity.
func (s *BindingStore) FindByKey(ctx context.Context, key string) (*DynamicBinding, error) {
	if s == nil || s.collection == nil {
		return nil, ErrNotFound
	}
	var binding DynamicBinding
	err := s.collection.FindOne(ctx, bson.M{"bindingKey": strings.TrimSpace(key)}).Decode(&binding)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &binding, nil
}

// Insert persists one binding.
//
// Uniqueness is enforced by the database: one binding per Inventory resource
// (document _id) and one binding per (host, process identity, NF type)
// (bindingKey). A repeated identical insert is idempotent; any contradiction
// fails closed with ErrBindingConflict.
func (s *BindingStore) Insert(ctx context.Context, binding *DynamicBinding) (bool, error) {
	if s == nil || s.collection == nil {
		return false, ErrBindingConflict
	}
	if binding == nil || strings.TrimSpace(binding.ResourceID) == "" {
		return false, ErrBindingConflict
	}
	if binding.CreatedAt == "" {
		binding.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if binding.Revision == 0 {
		binding.Revision = 1
	}
	_, err := s.collection.InsertOne(ctx, binding)
	if err == nil {
		return true, nil
	}
	if !mongo.IsDuplicateKeyError(err) {
		return false, err
	}
	if existing, gerr := s.Get(ctx, binding.ResourceID); gerr == nil && existing != nil {
		if normalizeUnitName(existing.Unit) == normalizeUnitName(binding.Unit) {
			return false, nil
		}
		return false, ErrBindingConflict
	}
	if other, kerr := s.FindByKey(ctx, binding.BindingKey); kerr == nil && other != nil {
		if other.ResourceID != binding.ResourceID {
			return false, ErrBindingConflict
		}
		return false, nil
	}
	return false, ErrBindingConflict
}
