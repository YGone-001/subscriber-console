package auth

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// UserRepository reads and updates user credentials in xcloud_ops.app_users.
type UserRepository struct {
	collection *mongo.Collection
}

// NewUserRepository creates a UserRepository from the app_users collection.
func NewUserRepository(collection *mongo.Collection) *UserRepository {
	return &UserRepository{collection: collection}
}

type rawAuthDoc struct {
	Username     string `bson:"username"`
	PasswordHash string `bson:"passwordHash"`
	Role         string `bson:"role"`
	Status       string `bson:"status"`
	Locked       *bool  `bson:"locked,omitempty"`
	Security     *struct {
		SessionVersion      *int64  `bson:"sessionVersion,omitempty"`
		FailedLoginAttempts *int    `bson:"failedLoginAttempts,omitempty"`
		LockedAt            *string `bson:"lockedAt,omitempty"`
		LockReason          *string `bson:"lockReason,omitempty"`
		LastLoginAt         *string `bson:"lastLoginAt,omitempty"`
		LastLoginIP         *string `bson:"lastLoginIp,omitempty"`
	} `bson:"security,omitempty"`
}

// GetUserByUsername returns the auth user document including passwordHash.
// Returns (nil, nil) when the user is not found.
func (r *UserRepository) GetUserByUsername(ctx context.Context, username string) (*AuthUser, error) {
	var doc rawAuthDoc
	err := r.collection.FindOne(ctx, bson.M{"username": username}).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("AUTH_UNAVAILABLE: %w", err)
	}

	user := &AuthUser{
		Username:     doc.Username,
		PasswordHash: doc.PasswordHash,
		Role:         doc.Role,
		Status:       doc.Status,
	}
	if doc.Locked != nil {
		user.Locked = *doc.Locked
	}
	if doc.Security != nil {
		if doc.Security.SessionVersion != nil {
			user.SessionVersion = *doc.Security.SessionVersion
		}
		if doc.Security.FailedLoginAttempts != nil {
			user.FailedLoginAttempts = *doc.Security.FailedLoginAttempts
		}
	}
	return user, nil
}

// RecordFailedLogin atomically increments failedLoginAttempts and transitions to locked at threshold 10.
// Matches Node recordFailedLogin() exactly.
func (r *UserRepository) RecordFailedLogin(ctx context.Context, username string) (bool, int, error) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	// 1. Atomically increment failedLoginAttempts for an active unlocked account
	incFilter := bson.M{
		"username": username,
		"status":   "active",
		"locked":   bson.M{"$ne": true},
	}
	incUpdate := bson.M{
		"$inc": bson.M{"security.failedLoginAttempts": 1},
		"$set": bson.M{"updatedAt": now},
	}
	incOpts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var incDoc rawAuthDoc
	err := r.collection.FindOneAndUpdate(ctx, incFilter, incUpdate, incOpts).Decode(&incDoc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return false, 0, nil
		}
		return false, 0, fmt.Errorf("RECORD_FAILED_LOGIN_ERROR: %w", err)
	}

	attempts := 1
	if incDoc.Security != nil && incDoc.Security.FailedLoginAttempts != nil {
		attempts = *incDoc.Security.FailedLoginAttempts
	}

	if attempts < 10 {
		return false, attempts, nil
	}

	// 2. Threshold (10) reached: preserve last active admin safety before locking
	if NormalizeRole(incDoc.Role) == "admin" {
		activeAdmins, err := r.CountActiveAdmins(ctx)
		if err != nil {
			return false, attempts, fmt.Errorf("COUNT_ACTIVE_ADMINS_ERROR: %w", err)
		}
		if activeAdmins <= 1 {
			return false, attempts, nil
		}
	}

	// 3. Atomically transition unlocked -> locked exactly once
	lockFilter := bson.M{
		"username":                     username,
		"status":                       "active",
		"locked":                       bson.M{"$ne": true},
		"security.failedLoginAttempts": bson.M{"$gte": 10},
	}
	lockUpdate := bson.M{
		"$set": bson.M{
			"status":              "locked",
			"locked":              true,
			"security.lockedAt":   now,
			"security.lockReason": "excessive_failed_logins",
			"updatedAt":           now,
		},
		"$inc": bson.M{"security.sessionVersion": 1},
	}
	lockOpts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var lockDoc rawAuthDoc
	err = r.collection.FindOneAndUpdate(ctx, lockFilter, lockUpdate, lockOpts).Decode(&lockDoc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return false, attempts, nil
		}
		return false, attempts, fmt.Errorf("LOCK_TRANSITION_ERROR: %w", err)
	}

	return true, attempts, nil
}

// RecordSuccessfulLogin atomically resets failedLoginAttempts and records login timestamp/IP.
// Enforces race-guard against state modification during bcrypt calculation.
// Matches Node recordSuccessfulLogin() exactly.
func (r *UserRepository) RecordSuccessfulLogin(ctx context.Context, user *AuthUser, ip string) (*AuthUser, error) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	filter := bson.M{
		"username":     user.Username,
		"passwordHash": user.PasswordHash,
		"role":         user.Role,
		"status":       "active",
		"locked":       bson.M{"$ne": true},
		"$expr": bson.M{
			"$eq": bson.A{
				bson.M{"$ifNull": bson.A{"$security.sessionVersion", 0}},
				user.SessionVersion,
			},
		},
	}
	update := bson.M{
		"$set": bson.M{
			"security.lastLoginAt":         now,
			"security.lastLoginIp":         ip,
			"security.failedLoginAttempts": 0,
		},
	}
	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)

	var doc rawAuthDoc
	err := r.collection.FindOneAndUpdate(ctx, filter, update, opts).Decode(&doc)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, fmt.Errorf("RECORD_SUCCESSFUL_LOGIN_ERROR: %w", err)
	}

	locked := false
	if doc.Locked != nil {
		locked = *doc.Locked
	}
	sv := user.SessionVersion
	if doc.Security != nil && doc.Security.SessionVersion != nil {
		sv = *doc.Security.SessionVersion
	}

	return &AuthUser{
		Username:            doc.Username,
		PasswordHash:        doc.PasswordHash,
		Role:                doc.Role,
		Status:              doc.Status,
		Locked:              locked,
		SessionVersion:      sv,
		FailedLoginAttempts: 0,
	}, nil
}

// CountActiveAdmins counts active, unlocked administrators across canonical and legacy roles.
func (r *UserRepository) CountActiveAdmins(ctx context.Context) (int64, error) {
	filter := bson.M{
		"role":   bson.M{"$in": []string{"admin", "root", "super_admin"}},
		"status": "active",
		"locked": bson.M{"$ne": true},
	}
	return r.collection.CountDocuments(ctx, filter)
}
