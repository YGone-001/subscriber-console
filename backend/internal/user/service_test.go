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
	if err := ValidateResetPassword(ResetPasswordRequest{Password: "new-password-1"}, "alice"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateResetPasswordShort(t *testing.T) {
	if err := ValidateResetPassword(ResetPasswordRequest{Password: "abc"}, "alice"); err == nil || err.Error() != "INVALID_PASSWORD" {
		t.Fatalf("err = %v, want INVALID_PASSWORD", err)
	}
}

func TestValidatePasswordPolicyMatrix(t *testing.T) {
	tests := []struct {
		name     string
		password string
		username string
		wantErr  bool
	}{
		{
			name:     "valid password",
			password: "ValidPass123!",
			username: "alice",
			wantErr:  false,
		},
		{
			name:     "trimmed length below 8",
			password: "  abc  ",
			username: "alice",
			wantErr:  true,
		},
		{
			name:     "whitespace only",
			password: "        ",
			username: "alice",
			wantErr:  true,
		},
		{
			name:     "contains username exact case",
			password: "alice-password-123",
			username: "alice",
			wantErr:  true,
		},
		{
			name:     "contains username different case",
			password: "XXALICEXX123",
			username: "alice",
			wantErr:  true,
		},
		{
			name:     "exactly 72 UTF-8 bytes",
			password: strings.Repeat("a", 72),
			username: "alice",
			wantErr:  false,
		},
		{
			name:     "73 UTF-8 bytes",
			password: strings.Repeat("a", 73),
			username: "alice",
			wantErr:  true,
		},
		{
			name:     "multibyte under 72 bytes",
			password: "测试密码安全加固验证", // 10 runes, 30 bytes
			username: "alice",
			wantErr:  false,
		},
		{
			name:     "multibyte over 72 bytes",
			password: strings.Repeat("密", 25), // 25 runes * 3 bytes = 75 bytes
			username: "alice",
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePassword(tt.password, tt.username)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidatePassword(%q, %q) err = %v, wantErr %v", tt.password, tt.username, err, tt.wantErr)
			}
			if err != nil && err.Error() != "INVALID_PASSWORD" {
				t.Fatalf("ValidatePassword error = %v, want INVALID_PASSWORD", err)
			}

			// Verify CreateUser consumes this policy
			createReq := CreateUserRequest{
				Username: tt.username,
				Password: tt.password,
			}
			createErr := ValidateCreateUser(createReq)
			if (createErr != nil) != tt.wantErr {
				t.Fatalf("ValidateCreateUser(%q, %q) err = %v, wantErr %v", tt.password, tt.username, createErr, tt.wantErr)
			}

			// Verify Password Reset consumes this policy against target username
			resetReq := ResetPasswordRequest{
				Password: tt.password,
			}
			resetErr := ValidateResetPassword(resetReq, tt.username)
			if (resetErr != nil) != tt.wantErr {
				t.Fatalf("ValidateResetPassword(%q, %q) err = %v, wantErr %v", tt.password, tt.username, resetErr, tt.wantErr)
			}
		})
	}
}

func TestResetPasswordValidatesAgainstTargetUsername(t *testing.T) {
	// target is "subscriber_admin"
	// new password contains target username -> must be rejected
	req := ResetPasswordRequest{Password: "subscriber_admin-123"}
	if err := ValidateResetPassword(req, "subscriber_admin"); err == nil || err.Error() != "INVALID_PASSWORD" {
		t.Fatalf("expected INVALID_PASSWORD for target username match, got %v", err)
	}

	// new password contains actor username "admin_actor" but target is "subscriber_admin" -> allowed
	req2 := ResetPasswordRequest{Password: "admin_actor-123"}
	if err := ValidateResetPassword(req2, "subscriber_admin"); err != nil {
		t.Fatalf("unexpected error when password contains actor instead of target: %v", err)
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
