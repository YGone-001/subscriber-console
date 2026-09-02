package audit

import (
	"testing"
)

func TestSanitizeAuditText(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"plain text", "hello world", "hello world"},
		{"bearer token", "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "Authorization=[REDACTED]"},
		{"jwt in text", "token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6InRlc3QifQ.abc123 here", "token [REDACTED] here"},
		{"basic auth", "Basic dXNlcjpwYXNz", "[REDACTED]"},
		{"mongodb uri", "mongodb+srv://admin:secret123@cluster.mongodb.net/db", "mongodb+srv://[REDACTED]@cluster.mongodb.net/db"},
		{"password field", `password="hunter2"`, "password=[REDACTED]"},
		{"passwordHash field", `passwordHash: "$2b$10$abc"`, "passwordHash=[REDACTED]"},
		{"api key field", `api_key: "sk-12345"`, "api_key=[REDACTED]"},
		{"private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----", "[REDACTED]"},
		{"truncation", string(make([]byte, 10000)), ""}, // just check it doesn't panic
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeAuditText(tt.input)
			if tt.name == "truncation" {
				if len(got) > maxString {
					t.Errorf("sanitizeAuditText() length = %d, want <= %d", len(got), maxString)
				}
				return
			}
			if got != tt.want {
				t.Errorf("sanitizeAuditText() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSensitiveKey(t *testing.T) {
	tests := []struct {
		key  string
		want bool
	}{
		{"password", true},
		{"passwordHash", true},
		{"token", true},
		{"accessToken", true},
		{"refreshToken", true},
		{"apiKey", true},
		{"secret", true},
		{"privateKey", true},
		{"cookie", true},
		{"authorization", true},
		{"k", true},
		{"ki", true},
		{"op", true},
		{"opc", true},
		{"K", true},           // case-insensitive
		{"OPC", true},         // case-insensitive
		{"my.password", true}, // dot-separated
		{"data[k]", true},     // bracket-separated
		{"username", false},
		{"email", false},
		{"role", false},
		{"imsi", false},
		{"metadata", false},
	}

	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			got := sensitiveKey(tt.key)
			if got != tt.want {
				t.Errorf("sensitiveKey(%q) = %v, want %v", tt.key, got, tt.want)
			}
		})
	}
}

func TestSanitizeAuditPayload(t *testing.T) {
	t.Run("nil", func(t *testing.T) {
		got := sanitizeAuditPayload(nil)
		if got != nil {
			t.Errorf("sanitizeAuditPayload(nil) = %v, want nil", got)
		}
	})

	t.Run("string", func(t *testing.T) {
		got := sanitizeAuditPayload("hello")
		if got != "hello" {
			t.Errorf("sanitizeAuditPayload(\"hello\") = %v, want \"hello\"", got)
		}
	})

	t.Run("number", func(t *testing.T) {
		got := sanitizeAuditPayload(42)
		if got != 42 {
			t.Errorf("sanitizeAuditPayload(42) = %v, want 42", got)
		}
	})

	t.Run("bool", func(t *testing.T) {
		got := sanitizeAuditPayload(true)
		if got != true {
			t.Errorf("sanitizeAuditPayload(true) = %v, want true", got)
		}
	})

	t.Run("map with sensitive key", func(t *testing.T) {
		input := map[string]interface{}{
			"username": "alice",
			"password": "secret123",
			"role":     "admin",
		}
		got := sanitizeAuditPayload(input)
		m, ok := got.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map, got %T", got)
		}
		if m["username"] != "alice" {
			t.Errorf("username = %v, want alice", m["username"])
		}
		if m["password"] != redacted {
			t.Errorf("password = %v, want [REDACTED]", m["password"])
		}
		if m["role"] != "admin" {
			t.Errorf("role = %v, want admin", m["role"])
		}
	})

	t.Run("nested map", func(t *testing.T) {
		input := map[string]interface{}{
			"user": map[string]interface{}{
				"name":     "alice",
				"password": "secret",
			},
		}
		got := sanitizeAuditPayload(input)
		m, ok := got.(map[string]interface{})
		if !ok {
			t.Fatalf("expected map, got %T", got)
		}
		nested, ok := m["user"].(map[string]interface{})
		if !ok {
			t.Fatalf("expected nested map, got %T", m["user"])
		}
		if nested["name"] != "alice" {
			t.Errorf("nested name = %v, want alice", nested["name"])
		}
		if nested["password"] != redacted {
			t.Errorf("nested password = %v, want [REDACTED]", nested["password"])
		}
	})

	t.Run("array", func(t *testing.T) {
		input := []interface{}{"a", "b", "c"}
		got := sanitizeAuditPayload(input)
		arr, ok := got.([]interface{})
		if !ok {
			t.Fatalf("expected array, got %T", got)
		}
		if len(arr) != 3 {
			t.Errorf("len = %d, want 3", len(arr))
		}
	})

	t.Run("depth limit", func(t *testing.T) {
		// Build a deeply nested map
		var input interface{} = "leaf"
		for i := 0; i < maxDepth+5; i++ {
			input = map[string]interface{}{"child": input}
		}
		got := sanitizeAuditPayload(input)
		// Should not panic and should return something
		if got == nil {
			t.Error("expected non-nil result for deeply nested input")
		}
	})
}

func TestNormalizeIP(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", "unknown"},
		{"ipv4", "192.168.1.1", "192.168.1.1"},
		{"ipv4 with port", "192.168.1.1:8080", "192.168.1.1"},
		{"ipv6", "::1", "::1"},
		{"ipv6 brackets", "[::1]", "::1"},
		{"ipv6 zone", "fe80::1%eth0", "fe80::1"},
		{"invalid", "not-an-ip", "unknown"},
		{"whitespace", "  10.0.0.1  ", "10.0.0.1"},
		{"localhost", "127.0.0.1", "127.0.0.1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizeIP(tt.input)
			if got != tt.want {
				t.Errorf("NormalizeIP(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
