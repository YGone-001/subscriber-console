package auth

import (
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// ValidateSessionMatch compares JWT claims against a user document and returns
// the Principal on success. Extracted from ValidateSession for testability.
//
// Error codes:
//   - ACCOUNT_NOT_FOUND: username mismatch
//   - ACCOUNT_LOCKED: account is locked
//   - ACCOUNT_DISABLED: account is not active
//   - SESSION_REVOKED: sessionVersion or role mismatch
func ValidateSessionMatch(claims *Claims, user *UserDocument) (*Principal, error) {
	if user.Username != claims.Username {
		return nil, fmt.Errorf("ACCOUNT_NOT_FOUND")
	}

	if user.Locked != nil && *user.Locked {
		return nil, fmt.Errorf("ACCOUNT_LOCKED")
	}
	if user.Status == "locked" {
		return nil, fmt.Errorf("ACCOUNT_LOCKED")
	}
	if user.Status != "active" {
		return nil, fmt.Errorf("ACCOUNT_DISABLED")
	}

	dbRole := normalizeGovernanceRole(user.Role)
	if dbRole == "" {
		return nil, fmt.Errorf("SESSION_REVOKED")
	}
	normalizedRole := normalizeGovernanceRole(claims.Role)
	if normalizedRole != dbRole {
		return nil, fmt.Errorf("SESSION_REVOKED")
	}

	var dbSV int64
	if user.Security != nil && user.Security.SessionVersion != nil {
		dbSV = *user.Security.SessionVersion
	}
	if claims.SV != dbSV {
		return nil, fmt.Errorf("SESSION_REVOKED")
	}

	userID := user.Username
	if user.MongoID != nil {
		switch v := user.MongoID.(type) {
		case string:
			if v != "" {
				userID = v
			}
		case bson.ObjectID:
			userID = v.Hex()
		default:
			if s := fmt.Sprintf("%v", v); s != "" && s != "<nil>" {
				userID = s
			}
		}
	}

	return &Principal{
		Username:       user.Username,
		Role:           claims.Role,
		NormalizedRole: normalizedRole,
		SessionVersion: claims.SV,
		UserID:         userID,
	}, nil
}
