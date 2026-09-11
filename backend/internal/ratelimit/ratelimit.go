// Package ratelimit provides MongoDB-backed fixed-window rate limiting
// compatible with the existing Node.js implementation.
//
// Uses the same xcloud_ops.app_rate_limits collection and key format.
package ratelimit

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// RateLimitDocument matches the existing MongoDB document structure.
type RateLimitDocument struct {
	Key       string    `bson:"key"`
	Count     int       `bson:"count"`
	ResetAt   time.Time `bson:"reset_at"`
	UpdatedAt time.Time `bson:"updated_at"`
}

// Result holds the rate limit check outcome.
type Result struct {
	Allowed    bool
	Limit      int
	Remaining  int
	RetryAfter int
	ResetAt    int64
}

// Limiter provides MongoDB-backed fixed-window rate limiting.
type Limiter struct {
	collection *mongo.Collection
}

// NewLimiter creates a Limiter for the given collection.
func NewLimiter(collection *mongo.Collection) *Limiter {
	return &Limiter{collection: collection}
}

// Check verifies the rate limit for the given identifier.
// It matches the Node.js implementation: incrementFixedWindow().
func (l *Limiter) Check(ctx context.Context, identifier string, limit int, windowSeconds int) (*Result, error) {
	nowSeconds := time.Now().Unix()
	currentWindow := nowSeconds / int64(windowSeconds)
	key := fmt.Sprintf("RATELIMIT:%s:%d", identifier, currentWindow)
	resetAt := (currentWindow + 1) * int64(windowSeconds)
	resetAtTime := time.Unix(resetAt, 0)
	now := time.Now()

	// Upsert and increment — same logic as Node
	filter := bson.M{"key": key}
	update := bson.M{
		"$inc": bson.M{"count": 1},
		"$set": bson.M{"updated_at": now},
		"$setOnInsert": bson.M{
			"key":      key,
			"reset_at": resetAtTime,
		},
	}
	opts := options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)

	var doc RateLimitDocument
	err := l.collection.FindOneAndUpdate(ctx, filter, update, opts).Decode(&doc)
	if err != nil {
		// Fail open — same as Node behavior
		return &Result{
			Allowed:    true,
			Limit:      limit,
			Remaining:  limit,
			RetryAfter: 0,
			ResetAt:    resetAt,
		}, nil
	}

	remaining := int(math.Max(0, float64(limit-doc.Count)))
	retryAfter := 0
	if doc.Count > limit {
		retryAfter = int(math.Max(1, float64(resetAt-nowSeconds)))
	}

	return &Result{
		Allowed:    doc.Count <= limit,
		Limit:      limit,
		Remaining:  remaining,
		RetryAfter: retryAfter,
		ResetAt:    resetAt,
	}, nil
}

// Enforce checks the rate limit and writes the 429 response if exceeded.
// Returns true if the request is allowed, false if it was rejected.
func (l *Limiter) Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool {
	result, err := l.Check(r.Context(), identifier, limit, windowSeconds)
	if err != nil {
		// Fail open
		return true
	}

	// Set rate limit headers (same as Node)
	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(result.Limit))
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(result.Remaining))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(result.ResetAt, 10))

	if !result.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(result.RetryAfter))
		http.Error(w, `{"error":"Too many requests","code":"RATE_LIMIT_EXCEEDED"}`, http.StatusTooManyRequests)
		return false
	}

	return true
}
