package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// GenerateToken creates a signed HS256 JWT for the given user.
// The claims include both legacy "sv" and new "sessionVersion" for full
// interoperability with existing Node.js jose-issued tokens.
func GenerateToken(username, role string, sessionVersion int64, secret []byte) (string, error) {
	now := time.Now().Unix()
	claims := map[string]any{
		"sub":            username,
		"username":       username,
		"role":           role,
		"sv":             sessionVersion,
		"sessionVersion": sessionVersion,
		"iat":            now,
		"exp":            now + 86400, // 24 hours
	}

	headerJSON, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		return "", fmt.Errorf("AUTH_TOKEN_GENERATION_FAILED: %w", err)
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("AUTH_TOKEN_GENERATION_FAILED: %w", err)
	}

	headerB64 := base64.RawURLEncoding.EncodeToString(headerJSON)
	claimsB64 := base64.RawURLEncoding.EncodeToString(claimsJSON)
	unsigned := headerB64 + "." + claimsB64

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(unsigned))
	sigB64 := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return unsigned + "." + sigB64, nil
}
