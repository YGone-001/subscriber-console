package user

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// --- parseUserQueryStrict tests ---

func TestParseUserQueryStrictDefaults(t *testing.T) {
	q := map[string][]string{}
	uq, err := parseUserQueryStrict(q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
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

func TestParseUserQueryStrictUnknownKey(t *testing.T) {
	q := map[string][]string{"foo": {"bar"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for unknown key")
	}
}

func TestParseUserQueryStrictDuplicateKey(t *testing.T) {
	q := map[string][]string{"page": {"1", "2"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for duplicate key")
	}
}

func TestParseUserQueryStrictInvalidPage(t *testing.T) {
	tests := []string{"0", "-1", "abc", "1.5"}
	for _, v := range tests {
		q := map[string][]string{"page": {v}}
		_, err := parseUserQueryStrict(q)
		if err == nil {
			t.Errorf("expected error for page=%q", v)
		}
	}
}

func TestParseUserQueryStrictPageOverMax(t *testing.T) {
	q := map[string][]string{"page": {"100001"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for page=100001")
	}
}

func TestParseUserQueryStrictInvalidPageSize(t *testing.T) {
	tests := []string{"0", "-1", "abc", "101"}
	for _, v := range tests {
		q := map[string][]string{"pageSize": {v}}
		_, err := parseUserQueryStrict(q)
		if err == nil {
			t.Errorf("expected error for pageSize=%q", v)
		}
	}
}

func TestParseUserQueryStrictSearchOver100(t *testing.T) {
	long := ""
	for i := 0; i < 101; i++ {
		long += "a"
	}
	q := map[string][]string{"search": {long}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for search > 100 chars")
	}
}

func TestParseUserQueryStrictSearchAliases(t *testing.T) {
	// search takes precedence
	q1 := map[string][]string{"search": {"alice"}, "q": {"bob"}}
	uq1, err := parseUserQueryStrict(q1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if uq1.Search != "alice" {
		t.Errorf("Search = %q, want alice", uq1.Search)
	}

	// q as fallback
	q2 := map[string][]string{"q": {"charlie"}}
	uq2, err := parseUserQueryStrict(q2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if uq2.Search != "charlie" {
		t.Errorf("Search = %q, want charlie", uq2.Search)
	}
}

func TestParseUserQueryStrictInvalidRole(t *testing.T) {
	q := map[string][]string{"role": {"hacker"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for invalid role")
	}
}

func TestParseUserQueryStrictRootRole(t *testing.T) {
	q := map[string][]string{"role": {"root"}}
	uq, err := parseUserQueryStrict(q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if uq.Role != "root" {
		t.Errorf("Role = %q, want root", uq.Role)
	}
}

func TestParseUserQueryStrictInvalidStatus(t *testing.T) {
	q := map[string][]string{"status": {"banned"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for invalid status")
	}
}

func TestParseUserQueryStrictInvalidSort(t *testing.T) {
	q := map[string][]string{"sort": {"evilField"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for invalid sort")
	}
}

func TestParseUserQueryStrictOrderCaseSensitive(t *testing.T) {
	// "ASC" should fail — only lowercase accepted
	q := map[string][]string{"order": {"ASC"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for order=ASC (case-sensitive)")
	}
}

func TestParseUserQueryStrictOrderValid(t *testing.T) {
	for _, order := range []string{"asc", "desc"} {
		q := map[string][]string{"order": {order}}
		uq, err := parseUserQueryStrict(q)
		if err != nil {
			t.Errorf("unexpected error for order=%q: %v", order, err)
		}
		if uq.Order != order {
			t.Errorf("Order = %q, want %q", uq.Order, order)
		}
	}
}

func TestParseUserQueryStrictOrderInvalid(t *testing.T) {
	q := map[string][]string{"order": {"invalid"}}
	_, err := parseUserQueryStrict(q)
	if err == nil {
		t.Error("expected error for order=invalid")
	}
}

// --- buildUserFilter tests ---

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

func TestBuildUserFilterRoleRoot(t *testing.T) {
	// root should also expand to [root, super_admin]
	q := UserQuery{Role: "root"}
	f := buildUserFilter(q)
	roleFilter := f["role"].(bson.M)
	inArr := roleFilter["$in"].(bson.A)
	if len(inArr) != 2 {
		t.Fatalf("$in length = %d, want 2", len(inArr))
	}
}

func TestBuildUserFilterRoleOther(t *testing.T) {
	q := UserQuery{Role: "operator"}
	f := buildUserFilter(q)
	if f["role"] != "operator" {
		t.Errorf("role = %v, want operator", f["role"])
	}
}

func TestBuildUserFilterStatusLocked(t *testing.T) {
	q := UserQuery{Status: "locked"}
	f := buildUserFilter(q)
	orArr, ok := f["$or"].(bson.A)
	if !ok {
		t.Fatalf("$or is not bson.A: %T", f["$or"])
	}
	if len(orArr) != 2 {
		t.Errorf("$or length = %d, want 2", len(orArr))
	}
}

func TestBuildUserFilterStatusActive(t *testing.T) {
	q := UserQuery{Status: "active"}
	f := buildUserFilter(q)
	if f["status"] != "active" {
		t.Errorf("status = %v, want active", f["status"])
	}
	// Should have locked != true constraint
	lockedFilter, ok := f["locked"].(bson.M)
	if !ok {
		t.Fatalf("locked filter is not bson.M: %T", f["locked"])
	}
	if lockedFilter["$ne"] != true {
		t.Errorf("locked $ne = %v, want true", lockedFilter["$ne"])
	}
}

func TestBuildUserFilterSearch(t *testing.T) {
	q := UserQuery{Search: "test"}
	f := buildUserFilter(q)
	andArr, ok := f["$and"].(bson.A)
	if !ok {
		t.Fatalf("$and is not bson.A: %T", f["$and"])
	}
	if len(andArr) != 1 {
		t.Errorf("$and length = %d, want 1", len(andArr))
	}
}

func TestBuildUserFilterSearchEscapesRegex(t *testing.T) {
	q := UserQuery{Search: "test.+*"}
	f := buildUserFilter(q)
	andArr := f["$and"].(bson.A)
	orBlock := andArr[0].(bson.M)
	orArr := orBlock["$or"].(bson.A)
	usernameFilter := orArr[0].(bson.M)["username"].(bson.M)
	regex := usernameFilter["$regex"].(string)
	// The . + * should be escaped
	if regex != `test\.\+\*` {
		t.Errorf("regex = %q, want test\\.\\+\\*", regex)
	}
}

func TestBuildUserFilterEmpty(t *testing.T) {
	q := UserQuery{}
	f := buildUserFilter(q)
	if len(f) != 0 {
		t.Errorf("filter has %d keys, want 0 for empty query", len(f))
	}
}

// --- escapeUserSearch tests ---

func TestEscapeUserSearch(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello", "hello"},
		{"test.", `test\.`},
		{"a+b*c", `a\+b\*c`},
		{"[test]", `\[test\]`},
		{"(a|b)", `\(a\|b\)`},
		{"a?b", `a\?b`},
		{"{x}", `\{x\}`},
		{"a\\b", `a\\b`},
		{"^start", `\^start`},
		{"end$", `end\$`},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := escapeUserSearch(tt.input)
			if got != tt.want {
				t.Errorf("escapeUserSearch(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// --- toSafeUser tests ---

func TestToSafeUserStripsPasswordHash(t *testing.T) {
	doc := userDoc{
		Username:     "testuser",
		Role:         "operator",
		Status:       "active",
		PasswordHash: "THIS_SHOULD_NEVER_APPEAR",
	}
	su := toSafeUser(doc)
	if su.Username != "testuser" {
		t.Errorf("Username = %q, want testuser", su.Username)
	}
	// Verify by marshaling to JSON
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

func TestToSafeUserLockedFalsePreserved(t *testing.T) {
	locked := false
	doc := userDoc{
		Username: "testuser",
		Role:     "operator",
		Status:   "active",
		Locked:   &locked,
	}
	su := toSafeUser(doc)
	if su.Locked != false {
		t.Errorf("Locked = %v, want false", su.Locked)
	}
	// Verify locked field is present in JSON (not omitted)
	b, _ := bson.Marshal(su)
	var m bson.M
	bson.Unmarshal(b, &m)
	// locked should be present even when false
	if _, exists := m["locked"]; !exists {
		t.Error("locked field should be present even when false")
	}
}

func TestToSafeUserZeroValues(t *testing.T) {
	doc := userDoc{
		Username: "testuser",
		Role:     "operator",
		Status:   "active",
	}
	su := toSafeUser(doc)
	// Security should be nil when doc.Security is nil
	if su.Security != nil {
		t.Errorf("Security = %v, want nil", su.Security)
	}
	// DisplayName/Email should be nil (not empty string)
	if su.DisplayName != nil {
		t.Errorf("DisplayName = %v, want nil", su.DisplayName)
	}
	if su.Email != nil {
		t.Errorf("Email = %v, want nil", su.Email)
	}
}

// --- parseSecurity tests ---

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
		"lockedAt":            "2024-07-01",
		"lockReason":          "admin lock",
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
	if result.LockedAt != "2024-07-01" {
		t.Errorf("LockedAt = %q, want 2024-07-01", result.LockedAt)
	}
	if result.LockReason != "admin lock" {
		t.Errorf("LockReason = %q, want admin lock", result.LockReason)
	}
}

func TestParseSecurityZeroValues(t *testing.T) {
	sec := bson.M{
		"sessionVersion":      int64(0),
		"failedLoginAttempts": int64(0),
	}
	result := parseSecurity(sec)
	if result == nil {
		t.Fatal("parseSecurity returned nil")
	}
	// Zero values should be preserved
	if result.SessionVersion != 0 {
		t.Errorf("SessionVersion = %d, want 0", result.SessionVersion)
	}
	if result.FailedLoginAttempts != 0 {
		t.Errorf("FailedLoginAttempts = %d, want 0", result.FailedLoginAttempts)
	}
}

// --- Helper function tests ---

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
