package auth

import (
	"fmt"
	"strings"
)

var commonSecretPlaceholders = map[string]bool{
	"secret":      true,
	"jwt_secret":  true,
	"change-me":   true,
	"changeme":    true,
	"development": true,
	"password":    true,
}

// ValidateSecret validates that the JWT secret is present, not a common placeholder,
// and at least 32 UTF-8 bytes in length. It never exposes the secret value.
func ValidateSecret(secret string) ([]byte, error) {
	if secret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}

	trimmed := strings.TrimSpace(secret)
	if trimmed == "" {
		return nil, fmt.Errorf("JWT_SECRET must not be empty or whitespace only")
	}

	if commonSecretPlaceholders[strings.ToLower(trimmed)] {
		return nil, fmt.Errorf("JWT_SECRET uses an unsafe placeholder value")
	}

	bytes := []byte(trimmed)
	if len(bytes) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 32 bytes (got %d)", len(bytes))
	}

	return bytes, nil
}
