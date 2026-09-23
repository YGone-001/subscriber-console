package user

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"subscriber/internal/auth"
)

// --- test helpers ---

type recorder struct {
	*httptest.ResponseRecorder
	code int
	body string
}

func newRecorder() *recorder {
	return &recorder{ResponseRecorder: httptest.NewRecorder()}
}

func (r *recorder) WriteHeader(code int) {
	r.code = code
	r.ResponseRecorder.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.body += string(b)
	return r.ResponseRecorder.Write(b)
}

func decodeJSON(body string, v interface{}) error {
	return json.Unmarshal([]byte(body), v)
}

// --- validator tests ---

func TestValidateCreateUserValid(t *testing.T) {
	req := CreateUserRequest{
		Username:    "alice",
		Password:    "correct-horse-battery",
		DisplayName: "Alice",
		Email:       "alice@example.com",
		Role:        "operator",
	}
	if err := ValidateCreateUser(req); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateCreateUserEmptyUsername(t *testing.T) {
	req := CreateUserRequest{Username: "", Password: "password123"}
	if err := ValidateCreateUser(req); err == nil || err.Error() != "INVALID_USERNAME" {
		t.Fatalf("err = %v, want INVALID_USERNAME", err)
	}
}

func TestValidateCreateUserBadUsernameChars(t *testing.T) {
	req := CreateUserRequest{Username: "bad user!", Password: "password123"}
	if err := ValidateCreateUser(req); err == nil || err.Error() != "INVALID_USERNAME" {
		t.Fatalf("err = %v, want INVALID_USERNAME", err)
	}
}

func TestValidateCreateUserShortPassword(t *testing.T) {
	req := CreateUserRequest{Username: "alice", Password: "short"}
	if err := ValidateCreateUser(req); err == nil || err.Error() != "INVALID_PASSWORD" {
		t.Fatalf("err = %v, want INVALID_PASSWORD", err)
	}
}

func TestValidateCreateUserLongPassword(t *testing.T) {
	req := CreateUserRequest{Username: "alice", Password: strings.Repeat("a", 73)}
	if err := ValidateCreateUser(req); err == nil || err.Error() != "INVALID_PASSWORD" {
		t.Fatalf("err = %v, want INVALID_PASSWORD", err)
	}
}

func TestValidateCreateUserInvalidRole(t *testing.T) {
	req := CreateUserRequest{Username: "alice", Password: "password123", Role: "super_admin"}
	if err := ValidateCreateUser(req); err == nil || err.Error() != "INVALID_ROLE" {
		t.Fatalf("err = %v, want INVALID_ROLE", err)
	}
}

func TestValidateCreateUserEmptyRoleAllowed(t *testing.T) {
	req := CreateUserRequest{Username: "alice", Password: "password123"}
	if err := ValidateCreateUser(req); err != nil {
		t.Fatalf("empty role should be valid, got %v", err)
	}
}

func TestValidateUpdateUserValid(t *testing.T) {
	role := "admin"
	status := "disabled"
	dn := "Alice"
	email := "alice@example.com"
	req := UpdateUserRequest{DisplayName: &dn, Email: &email, Role: &role, Status: &status}
	if err := ValidateUpdateUser(req); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateUpdateUserInvalidRole(t *testing.T) {
	bad := "root"
	req := UpdateUserRequest{Role: &bad}
	if err := ValidateUpdateUser(req); err == nil || err.Error() != "INVALID_ROLE" {
		t.Fatalf("err = %v, want INVALID_ROLE", err)
	}
}

func TestValidateUpdateUserInvalidStatus(t *testing.T) {
	bad := "deleted"
	req := UpdateUserRequest{Status: &bad}
	if err := ValidateUpdateUser(req); err == nil || err.Error() != "INVALID_STATUS" {
		t.Fatalf("err = %v, want INVALID_STATUS", err)
	}
}

func TestValidateResetPasswordValid(t *testing.T) {
	if err := ValidateResetPassword(ResetPasswordRequest{Password: "new-password-1"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateResetPasswordShort(t *testing.T) {
	if err := ValidateResetPassword(ResetPasswordRequest{Password: "abc"}); err == nil || err.Error() != "INVALID_PASSWORD" {
		t.Fatalf("err = %v, want INVALID_PASSWORD", err)
	}
}

// --- service logic tests (no Mongo; test error paths and validation short-circuit) ---

func TestCreateUserValidationRejectsBadRole(t *testing.T) {
	svc := NewService(nil)
	req := CreateUserRequest{Username: "alice", Password: "password123", Role: "hacker"}
	_, err := svc.CreateUser(context.Background(), req, nil)
	if err == nil || err.Error() != "INVALID_ROLE" {
		t.Fatalf("err = %v, want INVALID_ROLE", err)
	}
}

func TestUpdateUserSelfRoleChangeRejected(t *testing.T) {
	// Use a fake repo that returns an existing user.
	// Since we cannot easily mock *Repository without Mongo, we test
	// the self-role-change guard by calling with a matching actor username.
	// The guard fires before any repo call when actor.Username == username.
	// However, the current Service calls FindByUsername first. For a unit test
	// without Mongo we verify the guard logic directly via canPerformOperation.
	// Self role change is disallowed by policy_view.go.
	ok := canPerformOperation("admin", "operator", "alice", "alice", opRoleChange)
	if ok {
		t.Error("self role change must be rejected by policy")
	}
}

func TestDisableSelfRejectedByPolicy(t *testing.T) {
	ok := canPerformOperation("admin", "admin", "alice", "alice", opDisable)
	if ok {
		t.Error("self disable must be rejected by policy")
	}
}

// --- extractUsernameFromAction tests ---

func TestExtractUsernameFromActionDisable(t *testing.T) {
	got := extractUsernameFromAction("/api/users/alice/disable", "/disable")
	if got != "alice" {
		t.Errorf("got %q, want alice", got)
	}
}

func TestExtractUsernameFromActionPasswordReset(t *testing.T) {
	got := extractUsernameFromAction("/api/users/bob/password-reset", "/password-reset")
	if got != "bob" {
		t.Errorf("got %q, want bob", got)
	}
}

func TestExtractUsernameFromActionNoAction(t *testing.T) {
	got := extractUsernameFromAction("/api/users/alice", "/disable")
	if got != "alice" {
		t.Errorf("got %q, want alice", got)
	}
}

// --- writeServiceError mapping tests ---

func TestWriteServiceErrorUserNotFound(t *testing.T) {
	rec := newRecorder()
	writeServiceError(rec, ErrUserNotFound)
	if rec.code != 404 {
		t.Errorf("code = %d, want 404", rec.code)
	}
	if !strings.Contains(rec.body, "USER_NOT_FOUND") {
		t.Errorf("body = %q, want USER_NOT_FOUND", rec.body)
	}
}

func TestWriteServiceErrorUsernameTaken(t *testing.T) {
	rec := newRecorder()
	writeServiceError(rec, ErrUsernameTaken)
	if rec.code != 409 {
		t.Errorf("code = %d, want 409", rec.code)
	}
}

func TestWriteServiceErrorSelfDisable(t *testing.T) {
	rec := newRecorder()
	writeServiceError(rec, ErrSelfDisable)
	if rec.code != 400 {
		t.Errorf("code = %d, want 400", rec.code)
	}
}

func TestWriteServiceErrorSelfRoleChange(t *testing.T) {
	rec := newRecorder()
	writeServiceError(rec, ErrSelfRoleChange)
	if rec.code != 400 {
		t.Errorf("code = %d, want 400", rec.code)
	}
}

// --- request model decoding tests ---

func TestCreateUserRequestDecode(t *testing.T) {
	var req CreateUserRequest
	body := `{"username":"alice","password":"password123","displayName":"Alice","email":"a@b.com","role":"admin"}`
	if err := decodeJSON(body, &req); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if req.Username != "alice" || req.Password != "password123" || req.Role != "admin" {
		t.Errorf("decoded = %+v", req)
	}
}

func TestUpdateUserRequestPartial(t *testing.T) {
	var req UpdateUserRequest
	body := `{"role":"viewer"}`
	if err := decodeJSON(body, &req); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if req.Role == nil || *req.Role != "viewer" {
		t.Errorf("Role = %v, want viewer", req.Role)
	}
	if req.DisplayName != nil || req.Email != nil || req.Status != nil {
		t.Error("unset fields must remain nil")
	}
}

func TestResetPasswordRequestDecode(t *testing.T) {
	var req ResetPasswordRequest
	body := `{"password":"new-pass-123"}`
	if err := decodeJSON(body, &req); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if req.Password != "new-pass-123" {
		t.Errorf("Password = %q", req.Password)
	}
}

// --- principal check for admin-only authorization ---

func TestAdminOnlyPermissionMap(t *testing.T) {
	// users.create, users.update, users.disable, users.reset-password must be admin-only.
	perms := []string{"users.create", "users.update", "users.disable", "users.reset-password"}
	for _, perm := range perms {
		admin := &auth.Principal{NormalizedRole: "admin"}
		operator := &auth.Principal{NormalizedRole: "operator"}
		viewer := &auth.Principal{NormalizedRole: "viewer"}
		if !auth.HasPermission(admin, perm) {
			t.Errorf("admin must have %s", perm)
		}
		if auth.HasPermission(operator, perm) {
			t.Errorf("operator must NOT have %s", perm)
		}
		if auth.HasPermission(viewer, perm) {
			t.Errorf("viewer must NOT have %s", perm)
		}
	}
}
