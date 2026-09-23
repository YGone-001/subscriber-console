package auth

import "context"

// AuthUser is the user credential document needed for authentication.
// Only fields required for login and session validation are included.
type AuthUser struct {
	Username       string `bson:"username"`
	PasswordHash   string `bson:"passwordHash"`
	Role           string `bson:"role"`
	Status         string `bson:"status"`
	Locked         bool   `bson:"locked"`
	SessionVersion int64  `bson:"sessionVersion"`
}

// LoginRequest is the POST /api/auth/login request body.
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// LoginResponse is the POST /api/auth/login success response.
type LoginResponse struct {
	Username string `json:"username"`
	Role     string `json:"role"`
	Message  string `json:"message"`
}

// LogoutResponse is the POST /api/auth/logout response.
type LogoutResponse struct {
	Message string `json:"message"`
}

// MeResponse is the GET /api/auth/me simplified auth response.
type MeResponse struct {
	Username string `json:"username"`
	Role     string `json:"role"`
	Status   string `json:"status"`
}

// UserLookup abstracts user credential lookup for authentication.
// Implemented by UserRepository. Use for testability.
type UserLookup interface {
	GetUserByUsername(ctx context.Context, username string) (*AuthUser, error)
}
