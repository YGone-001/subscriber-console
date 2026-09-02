package user

import "time"

// SafeUser is the user document without sensitive fields.
type SafeUser struct {
	Username    string        `json:"username"`
	DisplayName string        `json:"displayName,omitempty"`
	Email       string        `json:"email,omitempty"`
	Role        string        `json:"role"`
	Status      string        `json:"status"`
	CreatedAt   string        `json:"createdAt,omitempty"`
	CreatedBy   string        `json:"createdBy,omitempty"`
	UpdatedAt   string        `json:"updatedAt,omitempty"`
	Locked      bool          `json:"locked,omitempty"`
	Security    *UserSecurity `json:"security,omitempty"`
}

// UserSecurity contains non-sensitive security metadata.
type UserSecurity struct {
	SessionVersion      int    `json:"sessionVersion,omitempty"`
	FailedLoginAttempts int    `json:"failedLoginAttempts,omitempty"`
	PasswordChangedAt   string `json:"passwordChangedAt,omitempty"`
	LastLoginAt         string `json:"lastLoginAt,omitempty"`
	LastLoginIP         string `json:"lastLoginIp,omitempty"`
}

// AuthMeResponse is the GET /api/auth/me response.
type AuthMeResponse struct {
	Username       string   `json:"username"`
	Role           string   `json:"role"`
	DatabaseRole   string   `json:"databaseRole"`
	NormalizedRole string   `json:"normalizedRole"`
	Permissions    []string `json:"permissions"`
	CreatedAt      string   `json:"createdAt,omitempty"`
	Status         string   `json:"status"`
}

// AuthPermissionsResponse is the GET /api/auth/permissions response.
type AuthPermissionsResponse struct {
	Username       string            `json:"username"`
	Role           string            `json:"role"`
	DatabaseRole   string            `json:"databaseRole"`
	NormalizedRole string            `json:"normalizedRole"`
	Capabilities   map[string]string `json:"capabilities"`
	GovernanceRole string            `json:"governanceRole"`
	Permissions    []string          `json:"permissions"`
}

// UserListResponse is the user list response.
type UserListResponse struct {
	Users           []SafeUser  `json:"users,omitempty"`
	Items           []SafeUser  `json:"items,omitempty"`
	Pagination      *Pagination `json:"pagination,omitempty"`
	Stats           *UserStats  `json:"stats,omitempty"`
	AssignableRoles []string    `json:"assignableRoles"`
}

// Pagination contains pagination metadata.
type Pagination struct {
	Page       int `json:"page"`
	PageSize   int `json:"pageSize"`
	Total      int `json:"total"`
	TotalPages int `json:"totalPages"`
}

// UserStats contains aggregate user statistics.
type UserStats struct {
	Total          int `json:"total"`
	Active         int `json:"active"`
	Administrators int `json:"administrators"`
	Locked         int `json:"locked"`
}

// UserDetailResponse is the GET /api/auth/users/:username response.
type UserDetailResponse struct {
	User            SafeUser   `json:"user"`
	NormalizedRole  string     `json:"normalizedRole"`
	Permissions     []string   `json:"permissions"`
	Actions         []string   `json:"actions"`
	AssignableRoles []string   `json:"assignableRoles"`
	Activity        []AuditLog `json:"activity"`
}

// AuditLog is a simplified audit log entry for user activity.
type AuditLog struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Action    string `json:"action"`
	Result    string `json:"result"`
	Actor     string `json:"actor"`
	TargetID  string `json:"targetId,omitempty"`
}

// userDoc is the raw MongoDB document from app_users.
type userDoc struct {
	Username     string      `bson:"username"`
	DisplayName  string      `bson:"displayName,omitempty"`
	Email        string      `bson:"email,omitempty"`
	Role         string      `bson:"role"`
	Status       string      `bson:"status"`
	CreatedAt    interface{} `bson:"createdAt,omitempty"`
	CreatedBy    string      `bson:"createdBy,omitempty"`
	UpdatedAt    interface{} `bson:"updatedAt,omitempty"`
	Locked       bool        `bson:"locked,omitempty"`
	PasswordHash string      `bson:"passwordHash"`
	Security     interface{} `bson:"security,omitempty"`
}

// auditLogDoc is the raw MongoDB document from app_audit_logs.
type auditLogDoc struct {
	ID        interface{} `bson:"_id"`
	Timestamp interface{} `bson:"timestamp"`
	Action    string      `bson:"action"`
	Result    string      `bson:"result"`
	Actor     interface{} `bson:"actor"`
	TargetID  string      `bson:"targetId,omitempty"`
}

// toTime converts various timestamp formats to time.Time.
func toTime(v interface{}) time.Time {
	switch t := v.(type) {
	case time.Time:
		return t
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, t)
		if err != nil {
			return time.Time{}
		}
		return parsed
	default:
		return time.Time{}
	}
}

// toString converts various timestamp formats to string.
func toString(v interface{}) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	case string:
		return t
	default:
		return ""
	}
}

// actorToString extracts actor as string from various formats.
func actorToString(v interface{}) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	if m, ok := v.(map[string]interface{}); ok {
		if username, ok := m["username"].(string); ok {
			return username
		}
	}
	return ""
}
