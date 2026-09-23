package auth

import (
	"strings"
	"testing"
)

func TestValidateSecret(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantErr   bool
		errSubstr string
	}{
		{
			name:      "missing empty",
			input:     "",
			wantErr:   true,
			errSubstr: "required",
		},
		{
			name:      "whitespace only",
			input:     "   \t\n  ",
			wantErr:   true,
			errSubstr: "empty or whitespace",
		},
		{
			name:      "placeholder secret",
			input:     "secret",
			wantErr:   true,
			errSubstr: "unsafe placeholder",
		},
		{
			name:      "placeholder jwt_secret",
			input:     "jwt_secret",
			wantErr:   true,
			errSubstr: "unsafe placeholder",
		},
		{
			name:      "placeholder change-me",
			input:     "change-me",
			wantErr:   true,
			errSubstr: "unsafe placeholder",
		},
		{
			name:      "placeholder changeme",
			input:     "changeme",
			wantErr:   true,
			errSubstr: "unsafe placeholder",
		},
		{
			name:      "placeholder development",
			input:     "development",
			wantErr:   true,
			errSubstr: "unsafe placeholder",
		},
		{
			name:      "placeholder password",
			input:     "password",
			wantErr:   true,
			errSubstr: "unsafe placeholder",
		},
		{
			name:      "too short 31 bytes",
			input:     "1234567890123456789012345678901", // 31 bytes
			wantErr:   true,
			errSubstr: "at least 32 bytes",
		},
		{
			name:    "exactly 32 bytes valid",
			input:   "12345678901234567890123456789012", // 32 bytes
			wantErr: false,
		},
		{
			name:    "strong secret >32 bytes valid",
			input:   "this-is-a-very-strong-production-grade-jwt-secret-key-64-bytes-long",
			wantErr: false,
		},
		{
			name:    "valid secret with surrounding whitespace",
			input:   "   12345678901234567890123456789012   ",
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b, err := ValidateSecret(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateSecret() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				if tt.errSubstr != "" && !strings.Contains(err.Error(), tt.errSubstr) {
					t.Errorf("error = %q, want contains %q", err.Error(), tt.errSubstr)
				}
				// Verify secret value is never in error message
				if tt.input != "" && strings.Contains(err.Error(), tt.input) {
					t.Errorf("error leaked input secret: %q", err.Error())
				}
			} else {
				if len(b) < 32 {
					t.Errorf("returned bytes length = %d, want >= 32", len(b))
				}
			}
		})
	}
}
