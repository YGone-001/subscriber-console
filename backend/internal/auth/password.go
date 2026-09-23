package auth

import "golang.org/x/crypto/bcrypt"

// HashPassword creates a bcrypt hash of the plaintext password using cost 10.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// VerifyPassword checks a plaintext password against a bcrypt hash.
// Returns true on match, false otherwise.
func VerifyPassword(hashedPassword, password string) bool {
	if hashedPassword == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hashedPassword), []byte(password)) == nil
}
