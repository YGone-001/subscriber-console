package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

// makeJWT creates a HS256 JWT matching the Node.js jose library output.
// This is used to test Node → Go interoperability.
func makeJWT(secret []byte, claims Claims) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claimsJSON, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(claimsJSON)
	unsigned := header + "." + payload
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(unsigned))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return unsigned + "." + sig
}

func TestVerifyJWT_ValidToken(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	claims := Claims{
		Username: "admin",
		Role:     "root",
		SV:       5,
		Exp:      time.Now().Add(time.Hour).Unix(),
	}
	token := makeJWT(secret, claims)

	result, err := VerifyJWT(token, secret)
	if err != nil {
		t.Fatalf("VerifyJWT() error: %v", err)
	}
	if result.Username != "admin" {
		t.Errorf("Username = %q, want %q", result.Username, "admin")
	}
	if result.Role != "root" {
		t.Errorf("Role = %q, want %q", result.Role, "root")
	}
	if result.SV != 5 {
		t.Errorf("SV = %d, want 5", result.SV)
	}
}

func TestVerifyJWT_ExpiredToken(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	claims := Claims{
		Username: "admin",
		Role:     "root",
		SV:       0,
		Exp:      time.Now().Add(-time.Hour).Unix(), // expired
	}
	token := makeJWT(secret, claims)

	_, err := VerifyJWT(token, secret)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
	if !contains(err.Error(), "expired") {
		t.Errorf("error = %q, want contains 'expired'", err.Error())
	}
}

func TestVerifyJWT_BadSignature(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	wrongSecret := []byte("wrong-secret-at-least-32-bytes-long!")
	claims := Claims{
		Username: "admin",
		Role:     "root",
		SV:       0,
		Exp:      time.Now().Add(time.Hour).Unix(),
	}
	token := makeJWT(secret, claims)

	_, err := VerifyJWT(token, wrongSecret)
	if err == nil {
		t.Fatal("expected error for bad signature")
	}
	if !contains(err.Error(), "signature") {
		t.Errorf("error = %q, want contains 'signature'", err.Error())
	}
}

func TestVerifyJWT_WrongAlgorithm(t *testing.T) {
	// Create a token with alg=none
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	claimsJSON, _ := json.Marshal(Claims{Username: "admin", Role: "root", Exp: time.Now().Add(time.Hour).Unix()})
	payload := base64.RawURLEncoding.EncodeToString(claimsJSON)
	token := header + "." + payload + "."

	secret := []byte("test-secret-at-least-32-bytes-long!!")
	_, err := VerifyJWT(token, secret)
	if err == nil {
		t.Fatal("expected error for alg=none")
	}
	if !contains(err.Error(), "algorithm") {
		t.Errorf("error = %q, want contains 'algorithm'", err.Error())
	}
}

func TestVerifyJWT_MissingUsername(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	claims := Claims{
		Username: "", // missing
		Role:     "root",
		Exp:      time.Now().Add(time.Hour).Unix(),
	}
	token := makeJWT(secret, claims)

	_, err := VerifyJWT(token, secret)
	if err == nil {
		t.Fatal("expected error for missing username")
	}
	if !contains(err.Error(), "username") {
		t.Errorf("error = %q, want contains 'username'", err.Error())
	}
}

func TestVerifyJWT_MissingRole(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	claims := Claims{
		Username: "admin",
		Role:     "", // missing
		Exp:      time.Now().Add(time.Hour).Unix(),
	}
	token := makeJWT(secret, claims)

	_, err := VerifyJWT(token, secret)
	if err == nil {
		t.Fatal("expected error for missing role")
	}
	if !contains(err.Error(), "role") {
		t.Errorf("error = %q, want contains 'role'", err.Error())
	}
}

func TestVerifyJWT_MissingExp(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	claims := Claims{
		Username: "admin",
		Role:     "root",
		Exp:      0, // missing
	}
	token := makeJWT(secret, claims)

	_, err := VerifyJWT(token, secret)
	if err == nil {
		t.Fatal("expected error for missing exp")
	}
	if !contains(err.Error(), "exp") {
		t.Errorf("error = %q, want contains 'exp'", err.Error())
	}
}

func TestVerifyJWT_InvalidFormat(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	_, err := VerifyJWT("not-a-jwt", secret)
	if err == nil {
		t.Fatal("expected error for invalid format")
	}
}

func TestVerifyJWT_LegacySVZero(t *testing.T) {
	secret := []byte("test-secret-at-least-32-bytes-long!!")
	claims := Claims{
		Username: "legacy_user",
		Role:     "operator",
		SV:       0, // legacy tokens may have sv=0
		Exp:      time.Now().Add(time.Hour).Unix(),
	}
	token := makeJWT(secret, claims)

	result, err := VerifyJWT(token, secret)
	if err != nil {
		t.Fatalf("VerifyJWT() error: %v", err)
	}
	if result.SV != 0 {
		t.Errorf("SV = %d, want 0", result.SV)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstr(s, substr))
}

func containsSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
