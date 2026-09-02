package user

import (
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// toSafeUser converts a raw userDoc to SafeUser, stripping passwordHash.
// Matches Node stripPassword() exactly.
func toSafeUser(doc userDoc) SafeUser {
	locked := false
	if doc.Locked != nil {
		locked = *doc.Locked
	}
	u := SafeUser{
		Username:    doc.Username,
		DisplayName: doc.DisplayName,
		Email:       doc.Email,
		Role:        doc.Role,
		Status:      doc.Status,
		CreatedAt:   toStringP(doc.CreatedAt),
		CreatedBy:   doc.CreatedBy,
		UpdatedAt:   toStringP(doc.UpdatedAt),
		Locked:      locked,
	}
	if sec := parseSecurity(doc.Security); sec != nil {
		u.Security = sec
	}
	return u
}

// parseSecurity extracts non-sensitive security fields from the BSON document.
func parseSecurity(v interface{}) *UserSecurity {
	if v == nil {
		return nil
	}
	var sec bson.M
	switch s := v.(type) {
	case bson.M:
		sec = s
	case bson.D:
		sec = bson.M{}
		for _, elem := range s {
			sec[elem.Key] = elem.Value
		}
	case map[string]interface{}:
		sec = s
	default:
		return nil
	}
	return &UserSecurity{
		SessionVersion:      int(numericInt64(sec["sessionVersion"])),
		FailedLoginAttempts: int(numericInt64(sec["failedLoginAttempts"])),
		PasswordChangedAt:   toString(sec["passwordChangedAt"]),
		LastLoginAt:         toString(sec["lastLoginAt"]),
		LastLoginIP:         stringField(sec["lastLoginIp"]),
		LockedAt:            toString(sec["lockedAt"]),
		LockReason:          stringField(sec["lockReason"]),
	}
}

// numericInt64 converts various numeric types to int64.
func numericInt64(v interface{}) int64 {
	switch n := v.(type) {
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case int:
		return int64(n)
	default:
		return 0
	}
}

// stringField safely extracts a string from an interface{}.
func stringField(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// toAuditLog converts a raw auditLogDoc to AuditLog.
// Uses the `id` field (not _id) to match Node contract.
func toAuditLog(doc auditLogDoc) AuditLog {
	id := ""
	if doc.ID != nil {
		id = fmt.Sprintf("%v", doc.ID)
	}
	return AuditLog{
		ID:        id,
		Timestamp: toString(doc.Timestamp),
		Action:    doc.Action,
		Result:    doc.Result,
		Actor:     actorToString(doc.Actor),
		TargetID:  doc.TargetID,
	}
}
