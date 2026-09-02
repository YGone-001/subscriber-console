package user

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestParseUserQueryDefaults(t *testing.T) {
	q := map[string][]string{}
	uq := parseUserQuery(q)
	if uq.Page != 1 {
		t.Errorf("Page = %d, want 1", uq.Page)
	}
	if uq.PageSize != 20 {
		t.Errorf("PageSize = %d, want 20", uq.PageSize)
	}
	if uq.Sort != "createdAt" {
		t.Errorf("Sort = %q, want createdAt", uq.Sort)
	}
	if uq.Order != "desc" {
		t.Errorf("Order = %q, want desc", uq.Order)
	}
	if uq.Search != "" {
		t.Errorf("Search = %q, want empty", uq.Search)
	}
}

func TestParseUserQuerySearchAliases(t *testing.T) {
	// "search" takes precedence
	q1 := map[string][]string{"search": {"alice"}, "q": {"bob"}}
	uq1 := parseUserQuery(q1)
	if uq1.Search != "alice" {
		t.Errorf("Search = %q, want alice (search takes precedence)", uq1.Search)
	}

	// "q" as fallback
	q2 := map[string][]string{"q": {"charlie"}}
	uq2 := parseUserQuery(q2)
	if uq2.Search != "charlie" {
		t.Errorf("Search = %q, want charlie (q fallback)", uq2.Search)
	}
}

func TestParseUserQueryPageSizeBounds(t *testing.T) {
	// Over 100 should not be applied
	q := map[string][]string{"pageSize": {"500"}}
	uq := parseUserQuery(q)
	if uq.PageSize != 20 {
		t.Errorf("PageSize = %d, want 20 (500 rejected)", uq.PageSize)
	}

	// Valid value
	q2 := map[string][]string{"pageSize": {"50"}}
	uq2 := parseUserQuery(q2)
	if uq2.PageSize != 50 {
		t.Errorf("PageSize = %d, want 50", uq2.PageSize)
	}
}

func TestParseUserQuerySortAllowlist(t *testing.T) {
	// Allowed
	q1 := map[string][]string{"sort": {"username"}}
	uq1 := parseUserQuery(q1)
	if uq1.Sort != "username" {
		t.Errorf("Sort = %q, want username", uq1.Sort)
	}

	// Not allowed — falls back to default
	q2 := map[string][]string{"sort": {"evilField"}}
	uq2 := parseUserQuery(q2)
	if uq2.Sort != "createdAt" {
		t.Errorf("Sort = %q, want createdAt (evilField rejected)", uq2.Sort)
	}
}

func TestParseUserQueryOrder(t *testing.T) {
	q := map[string][]string{"order": {"ASC"}}
	uq := parseUserQuery(q)
	if uq.Order != "asc" {
		t.Errorf("Order = %q, want asc", uq.Order)
	}
}

func TestBuildUserFilterRoleSuperAdmin(t *testing.T) {
	q := UserQuery{Role: "super_admin"}
	f := buildUserFilter(q)
	roleFilter, ok := f["role"].(bson.M)
	if !ok {
		t.Fatalf("role filter is not bson.M: %T", f["role"])
	}
	inArr, ok := roleFilter["$in"].(bson.A)
	if !ok {
		t.Fatalf("$in is not bson.A: %T", roleFilter["$in"])
	}
	if len(inArr) != 2 {
		t.Fatalf("$in length = %d, want 2", len(inArr))
	}
	// Should contain both "root" and "super_admin"
	hasRoot := false
	hasSuperAdmin := false
	for _, v := range inArr {
		if v == "root" {
			hasRoot = true
		}
		if v == "super_admin" {
			hasSuperAdmin = true
		}
	}
	if !hasRoot || !hasSuperAdmin {
		t.Errorf("$in = %v, want [root super_admin]", inArr)
	}
}

func TestBuildUserFilterRoleOther(t *testing.T) {
	q := UserQuery{Role: "operator"}
	f := buildUserFilter(q)
	if f["role"] != "operator" {
		t.Errorf("role = %v, want operator", f["role"])
	}
}

func TestBuildUserFilterSearch(t *testing.T) {
	q := UserQuery{Search: "test"}
	f := buildUserFilter(q)
	orArr, ok := f["$or"].(bson.A)
	if !ok {
		t.Fatalf("$or is not bson.A: %T", f["$or"])
	}
	if len(orArr) != 3 {
		t.Errorf("$or length = %d, want 3 (username, displayName, email)", len(orArr))
	}
}

func TestBuildUserFilterEmpty(t *testing.T) {
	q := UserQuery{}
	f := buildUserFilter(q)
	if len(f) != 0 {
		t.Errorf("filter has %d keys, want 0 for empty query", len(f))
	}
}

func TestToSafeUserStripsPasswordHash(t *testing.T) {
	doc := userDoc{
		Username:     "testuser",
		DisplayName:  "Test User",
		Email:        "test@example.com",
		Role:         "operator",
		Status:       "active",
		PasswordHash: "THIS_SHOULD_NEVER_APPEAR",
		CreatedAt:    "2024-01-01T00:00:00Z",
	}
	su := toSafeUser(doc)
	if su.Username != "testuser" {
		t.Errorf("Username = %q, want testuser", su.Username)
	}
	// SafeUser should not have PasswordHash field at all (not exported)
	// Verify by marshaling to JSON and checking
	b, err := bson.Marshal(su)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var m bson.M
	if err := bson.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if _, exists := m["passwordHash"]; exists {
		t.Error("passwordHash should not be present in SafeUser")
	}
	if _, exists := m["password"]; exists {
		t.Error("password should not be present in SafeUser")
	}
}

func TestParseSecurityNil(t *testing.T) {
	if result := parseSecurity(nil); result != nil {
		t.Errorf("parseSecurity(nil) = %v, want nil", result)
	}
}

func TestParseSecurityValid(t *testing.T) {
	sec := bson.M{
		"sessionVersion":      int64(3),
		"failedLoginAttempts": int64(0),
		"passwordChangedAt":   "2024-01-01",
		"lastLoginAt":         "2024-06-01",
	}
	result := parseSecurity(sec)
	if result == nil {
		t.Fatal("parseSecurity returned nil for valid input")
	}
	if result.SessionVersion != 3 {
		t.Errorf("SessionVersion = %d, want 3", result.SessionVersion)
	}
	if result.FailedLoginAttempts != 0 {
		t.Errorf("FailedLoginAttempts = %d, want 0", result.FailedLoginAttempts)
	}
	if result.PasswordChangedAt != "2024-01-01" {
		t.Errorf("PasswordChangedAt = %q, want 2024-01-01", result.PasswordChangedAt)
	}
	if result.LastLoginAt != "2024-06-01" {
		t.Errorf("LastLoginAt = %q, want 2024-06-01", result.LastLoginAt)
	}
}

func TestNumericInt64Types(t *testing.T) {
	tests := []struct {
		name string
		in   interface{}
		want int64
	}{
		{"int", int(42), 42},
		{"int32", int32(42), 42},
		{"int64", int64(42), 42},
		{"float64", float64(42), 42},
		{"string", "42", 0},
		{"nil", nil, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := numericInt64(tt.in)
			if got != tt.want {
				t.Errorf("numericInt64(%v) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestStringFieldTypes(t *testing.T) {
	if got := stringField("hello"); got != "hello" {
		t.Errorf("stringField(string) = %q, want hello", got)
	}
	if got := stringField(123); got != "" {
		t.Errorf("stringField(int) = %q, want empty", got)
	}
	if got := stringField(nil); got != "" {
		t.Errorf("stringField(nil) = %q, want empty", got)
	}
}
