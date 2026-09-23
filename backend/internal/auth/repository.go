package auth

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// UserRepository reads user credentials from xcloud_ops.app_users.
// Read-only in this phase. No writes are performed.
type UserRepository struct {
	collection *mongo.Collection
}

// NewUserRepository creates a UserRepository from the app_users collection.
func NewUserRepository(collection *mongo.Collection) *UserRepository {
	return &UserRepository{collection: collection}
}

// GetUserByUsername returns the auth user document including passwordHash.
// Returns (nil, nil) when the user is not found.
func (r *UserRepository) GetUserByUsername(ctx context.Context, username string) (*AuthUser, error) {
	var doc struct {
		Username     string `bson:"username"`
		PasswordHash string `bson:"passwordHash"`
		Role         string `bson:"role"`
		Status       string `bson:"status"`
		Locked       *bool  `bson:"locked,omitempty"`
		Security     *struct {
			SessionVersion *int64 `bson:"sessionVersion,omitempty"`
		} `bson:"security,omitempty"`
	}
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
	if doc.Security != nil && doc.Security.SessionVersion != nil {
		user.SessionVersion = *doc.Security.SessionVersion
	}
	return user, nil
}
