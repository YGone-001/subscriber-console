package runtimeinv

import (
	"context"
	"errors"
	"sync"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// StateStore persists the cross-restart memory of what was previously observed.
//
// Persistence is what lets a complete scan after a backend restart distinguish
// "previously observed but no longer running" from "never installed".
type StateStore interface {
	Load(ctx context.Context) (map[string]ComponentState, error)
	Save(ctx context.Context, states []ComponentState) error
}

// MemoryStateStore is the in-memory implementation used when no database is
// available and by tests.
type MemoryStateStore struct {
	mu     sync.Mutex
	states map[string]ComponentState
}

// NewMemoryStateStore constructs an empty in-memory store.
func NewMemoryStateStore() *MemoryStateStore {
	return &MemoryStateStore{states: map[string]ComponentState{}}
}

// Load returns a copy of the stored state.
func (s *MemoryStateStore) Load(ctx context.Context) (map[string]ComponentState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]ComponentState, len(s.states))
	for key, value := range s.states {
		out[key] = value
	}
	return out, nil
}

// Save replaces the stored entries.
func (s *MemoryStateStore) Save(ctx context.Context, states []ComponentState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, state := range states {
		s.states[state.StateID] = state
	}
	return nil
}

// MongoStateStore persists observation state in xcloud_ops.
type MongoStateStore struct {
	collection *mongo.Collection
}

// NewMongoStateStore constructs the MongoDB-backed state store.
func NewMongoStateStore(collection *mongo.Collection) *MongoStateStore {
	return &MongoStateStore{collection: collection}
}

// Load reads the bounded state set. At most one document per recognized
// component per host exists, so the read is naturally bounded.
func (s *MongoStateStore) Load(ctx context.Context) (map[string]ComponentState, error) {
	if s == nil || s.collection == nil {
		return map[string]ComponentState{}, nil
	}
	cursor, err := s.collection.Find(ctx, bson.M{})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := map[string]ComponentState{}
	for cursor.Next(ctx) {
		var state ComponentState
		if err := cursor.Decode(&state); err != nil {
			return nil, err
		}
		out[state.StateID] = state
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Save upserts the given state documents.
func (s *MongoStateStore) Save(ctx context.Context, states []ComponentState) error {
	if s == nil || s.collection == nil || len(states) == 0 {
		return nil
	}
	models := make([]mongo.WriteModel, 0, len(states))
	for _, state := range states {
		if state.StateID == "" {
			continue
		}
		models = append(models, mongo.NewReplaceOneModel().
			SetFilter(bson.M{"_id": state.StateID}).
			SetReplacement(state).
			SetUpsert(true))
	}
	if len(models) == 0 {
		return nil
	}
	_, err := s.collection.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
	if err != nil && !mongo.IsDuplicateKeyError(err) {
		return err
	}
	return nil
}

// ErrScannerDisabled reports that the background scanner is switched off.
var ErrScannerDisabled = errors.New("RUNTIME_SCANNER_DISABLED")

// ErrScanInProgress reports that a scan is already running.
var ErrScanInProgress = errors.New("RUNTIME_SCAN_IN_PROGRESS")

// ErrScanRateLimited reports that the manual rescan minimum interval has not
// elapsed.
var ErrScanRateLimited = errors.New("RUNTIME_SCAN_RATE_LIMITED")
