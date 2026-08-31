package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// VerifyJWT verifies a HS256 JWT token and returns the claims.
// It rejects: alg=none, non-HS256 algorithms, expired tokens, bad signatures.
func VerifyJWT(tokenStr string, secret []byte) (*Claims, error) {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: invalid token format")
	}

	// Decode header to verify algorithm
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: invalid header encoding")
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: invalid header JSON")
	}
	if header.Alg != "HS256" {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: unsupported algorithm %q", header.Alg)
	}

	// Verify signature
	unsigned := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(unsigned))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSig)) {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: invalid signature")
	}

	// Decode claims
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: invalid payload encoding")
	}
	var claims Claims
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: invalid claims JSON")
	}

	// Validate required fields
	if claims.Username == "" {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: missing username")
	}
	if claims.Role == "" {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: missing role")
	}
	if claims.Exp == 0 {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: missing exp")
	}

	// Check expiry
	if time.Now().Unix() > claims.Exp {
		return nil, fmt.Errorf("AUTH_INVALID_TOKEN: token expired")
	}

	return &claims, nil
}
