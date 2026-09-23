package user

import (
	"context"
	"errors"
	"time"

	"subscriber/internal/auth"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Service errors for user management operations.
var (
	ErrUserNotFound   = errors.New("USER_NOT_FOUND")
	ErrUsernameTaken  = errors.New("USERNAME_ALREADY_EXISTS")
	ErrSelfDisable    = errors.New("SELF_OPERATION_FORBIDDEN")
	ErrSelfRoleChange = errors.New("SELF_ROLE_CHANGE_FORBIDDEN")
)

// Service handles user management business logic.
type Service struct {
	repo *Repository
}

// NewService creates a user management service.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo}
}

// CreateUser creates a new user account with bcrypt-hashed password.
// New accounts start with status=active and sessionVersion=1.
func (s *Service) CreateUser(ctx context.Context, req CreateUserRequest, actor *auth.Principal) (*SafeUser, error) {
	if err := ValidateCreateUser(req); err != nil {
		return nil, err
	}

	exists, err := s.repo.UsernameExists(ctx, req.Username)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, ErrUsernameTaken
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		return nil, err
	}

	role := req.Role
	if role == "" {
		role = "viewer"
	}

	now := time.Now().UTC()
	doc := bson.M{
		"username":     req.Username,
		"passwordHash": hash,
		"role":         role,
		"status":       "active",
		"createdAt":    now,
		"updatedAt":    now,
		"security": bson.M{
			"sessionVersion":      1,
			"failedLoginAttempts": 0,
		},
	}
	if req.DisplayName != "" {
		doc["displayName"] = req.DisplayName
	}
	if req.Email != "" {
		doc["email"] = req.Email
	}
	if actor != nil && actor.Username != "" {
		doc["createdBy"] = actor.Username
	}

	if err := s.repo.InsertUser(ctx, doc); err != nil {
		return nil, err
	}

	return s.repo.FindByUsername(ctx, req.Username)
}

// UpdateUser updates user fields. Increments sessionVersion on role or status change.
func (s *Service) UpdateUser(ctx context.Context, username string, req UpdateUserRequest, actor *auth.Principal) (*SafeUser, error) {
	if err := ValidateUpdateUser(req); err != nil {
		return nil, err
	}

	existing, err := s.repo.FindByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, ErrUserNotFound
	}

	if req.Role != nil && actor != nil && actor.Username == username {
		return nil, ErrSelfRoleChange
	}

	set := bson.M{"updatedAt": time.Now().UTC()}
	incrementSession := false

	if req.DisplayName != nil {
		set["displayName"] = *req.DisplayName
	}
	if req.Email != nil {
		set["email"] = *req.Email
	}
	if req.Role != nil {
		set["role"] = *req.Role
		incrementSession = true
	}
	if req.Status != nil {
		set["status"] = *req.Status
		incrementSession = true
	}

	update := bson.M{"$set": set}
	if incrementSession {
		update["$inc"] = bson.M{"security.sessionVersion": 1}
	}

	if err := s.repo.UpdateUserDoc(ctx, username, update); err != nil {
		return nil, err
	}

	return s.repo.FindByUsername(ctx, username)
}

// DisableUser sets status=disabled and increments sessionVersion.
func (s *Service) DisableUser(ctx context.Context, username string, actor *auth.Principal) (*SafeUser, error) {
	if actor != nil && actor.Username == username {
		return nil, ErrSelfDisable
	}

	existing, err := s.repo.FindByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, ErrUserNotFound
	}

	update := bson.M{
		"$set": bson.M{
			"status":    "disabled",
			"updatedAt": time.Now().UTC(),
		},
		"$inc": bson.M{"security.sessionVersion": 1},
	}

	if err := s.repo.UpdateUserDoc(ctx, username, update); err != nil {
		return nil, err
	}

	return s.repo.FindByUsername(ctx, username)
}

// ResetPassword updates the password hash and increments sessionVersion.
func (s *Service) ResetPassword(ctx context.Context, username string, req ResetPasswordRequest) error {
	if err := ValidateResetPassword(req); err != nil {
		return err
	}

	existing, err := s.repo.FindByUsername(ctx, username)
	if err != nil {
		return err
	}
	if existing == nil {
		return ErrUserNotFound
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	update := bson.M{
		"$set": bson.M{
			"passwordHash":                 hash,
			"updatedAt":                    now,
			"security.passwordChangedAt":   now,
			"security.failedLoginAttempts": 0,
		},
		"$inc": bson.M{"security.sessionVersion": 1},
	}

	return s.repo.UpdateUserDoc(ctx, username, update)
}
