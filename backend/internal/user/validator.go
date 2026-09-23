package user

import (
	"fmt"
	"regexp"
)

// canonicalWriteRoles are the only roles accepted in write requests.
var canonicalWriteRoles = map[string]bool{
	"admin": true, "operator": true, "viewer": true,
}

// validWriteStatuses are the only status values accepted in write requests.
var validWriteStatuses = map[string]bool{
	"active": true, "disabled": true, "locked": true,
}

// usernamePattern allows alphanumeric, underscore, dash, and dot (1-100 chars).
var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,100}$`)

// ValidateCreateUser validates a create user request.
func ValidateCreateUser(req CreateUserRequest) error {
	if req.Username == "" || len(req.Username) > 100 || !usernamePattern.MatchString(req.Username) {
		return fmt.Errorf("INVALID_USERNAME")
	}
	if len(req.Password) < 8 || len(req.Password) > 72 {
		return fmt.Errorf("INVALID_PASSWORD")
	}
	if req.Role != "" && !canonicalWriteRoles[req.Role] {
		return fmt.Errorf("INVALID_ROLE")
	}
	if len(req.Email) > 254 {
		return fmt.Errorf("INVALID_EMAIL")
	}
	if len(req.DisplayName) > 100 {
		return fmt.Errorf("INVALID_DISPLAY_NAME")
	}
	return nil
}

// ValidateUpdateUser validates an update user request.
func ValidateUpdateUser(req UpdateUserRequest) error {
	if req.Role != nil && !canonicalWriteRoles[*req.Role] {
		return fmt.Errorf("INVALID_ROLE")
	}
	if req.Status != nil && !validWriteStatuses[*req.Status] {
		return fmt.Errorf("INVALID_STATUS")
	}
	if req.Email != nil && len(*req.Email) > 254 {
		return fmt.Errorf("INVALID_EMAIL")
	}
	if req.DisplayName != nil && len(*req.DisplayName) > 100 {
		return fmt.Errorf("INVALID_DISPLAY_NAME")
	}
	return nil
}

// ValidateResetPassword validates a password reset request.
func ValidateResetPassword(req ResetPasswordRequest) error {
	if len(req.Password) < 8 || len(req.Password) > 72 {
		return fmt.Errorf("INVALID_PASSWORD")
	}
	return nil
}
