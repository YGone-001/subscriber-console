package auth

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// UserDocument represents the app_users collection structure for session validation.
type UserDocument struct {
	Username string `bson:"username"`
	Role     string `bson:"role"`
	Status   string `bson:"status"`
	Locked   *bool  `bson:"locked,omitempty"`
	Security *struct {
		SessionVersion *int64 `bson:"sessionVersion,omitempty"`
	} `bson:"security,omitempty"`
}

// SessionValidator validates JWT claims against the app_users collection.
type SessionValidator struct {
	collection *mongo.Collection
}

// NewSessionValidator creates a SessionValidator for the given collection.
func NewSessionValidator(collection *mongo.Collection) *SessionValidator {
	return &SessionValidator{collection: collection}
}

// ValidateSession queries MongoDB to verify the user account is valid and the session matches.
// Returns the Principal on success, or an error with a specific code.
//
// Error codes match the existing Node.js behavior:
//   - AUTH_INVALID_TOKEN: malformed claims
//   - ACCOUNT_NOT_FOUND: user doesn't exist
//   - ACCOUNT_LOCKED: account is locked
//   - ACCOUNT_DISABLED: account is not active
//   - SESSION_REVOKED: sessionVersion mismatch or role mismatch
func (sv *SessionValidator) ValidateSession(ctx context.Context, claims *Claims) (*Principal, error) {
	if claims.Username == "" || len(claims.Username) > 100 {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN")
	}

	normalizedRole := normalizeGovernanceRole(claims.Role)
	if normalizedRole == "" {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN")
	}

	// Legacy tokens may not have sv; treat missing as 0
	svValue := claims.SV

	var user UserDocument
	err := sv.collection.FindOne(ctx, bson.M{"username": claims.Username}).Decode(&user)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, fmt.Errorf("ACCOUNT_NOT_FOUND")
		}
		return nil, fmt.Errorf("AUTH_UNAVAILABLE: %w", err)
	}

	if user.Username != claims.Username {
		return nil, fmt.Errorf("ACCOUNT_NOT_FOUND")
	}

	// Check locked status
	if user.Locked != nil && *user.Locked {
		return nil, fmt.Errorf("ACCOUNT_LOCKED")
	}
	if user.Status == "locked" {
		return nil, fmt.Errorf("ACCOUNT_LOCKED")
	}

	// Check active status
	if user.Status != "active" {
		return nil, fmt.Errorf("ACCOUNT_DISABLED")
	}

	// Normalize the DB role and compare
	dbRole := normalizeGovernanceRole(user.Role)
	if dbRole == "" {
		return nil, fmt.Errorf("SESSION_REVOKED")
	}

	// Get session version from DB
	var dbSV int64
	if user.Security != nil && user.Security.SessionVersion != nil {
		dbSV = *user.Security.SessionVersion
	}

	// Session version and role must match
	if svValue != dbSV || normalizedRole != dbRole {
		return nil, fmt.Errorf("SESSION_REVOKED")
	}

	return &Principal{
		Username:       user.Username,
		Role:           claims.Role,
		NormalizedRole: normalizedRole,
		SessionVersion: svValue,
		UserID:         user.Username, // Will be replaced with actual _id if needed
	}, nil
}

// normalizeGovernanceRole maps legacy roles to governance roles.
// Must match the TypeScript normalizeGovernanceRole() exactly.
func normalizeGovernanceRole(role string) string {
	switch role {
	case "root":
		return "super_admin"
	case "super_admin", "ops_admin", "operator", "auditor", "viewer":
		return role
	default:
		return ""
	}
}

// NormalizeRole is the exported version of normalizeGovernanceRole.
// Maps legacy roles to governance roles. Returns empty string for unknown roles.
func NormalizeRole(role string) string {
	return normalizeGovernanceRole(role)
}
