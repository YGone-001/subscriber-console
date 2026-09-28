package remediation

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"subscriber/internal/auth"
)

func TestIsJSTruthy(t *testing.T) {
	tests := []struct {
		name     string
		input    any
		expected bool
	}{
		{"nil", nil, false},
		{"empty string", "", false},
		{"valid string", "test", true},
		{"whitespace string", " ", true},
		{"zero int", 0, false},
		{"non-zero int", 123, true},
		{"zero float", float64(0), false},
		{"non-zero float", float64(123), true},
		{"false bool", false, false},
		{"true bool", true, true},
		{"empty map", map[string]any{}, true},
		{"empty slice", []any{}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isJSTruthy(tt.input)
			if got != tt.expected {
				t.Errorf("isJSTruthy(%v) = %v; want %v", tt.input, got, tt.expected)
			}
		})
	}
}

func TestFormatJSString(t *testing.T) {
	tests := []struct {
		name     string
		input    any
		expected string
	}{
		{"nil", nil, ""},
		{"string", "123456789012345", "123456789012345"},
		{"float integer", float64(123456789012345), "123456789012345"},
		{"int", 12345, "12345"},
		{"int64", int64(12345), "12345"},
		{"float decimal", float64(12.34), "12.34"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatJSString(tt.input)
			if got != tt.expected {
				t.Errorf("formatJSString(%v) = %q; want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestHealValidation(t *testing.T) {
	h := NewHandler(nil, nil, nil)

	tests := []struct {
		name           string
		body           string
		expectedStatus int
		expectedError  string
	}{
		{
			name:           "malformed JSON",
			body:           "invalid-json",
			expectedStatus: http.StatusInternalServerError,
			expectedError:  "Self-healing execution failed",
		},
		{
			name:           "empty object",
			body:           "{}",
			expectedStatus: http.StatusBadRequest,
			expectedError:  "imsi and type are required",
		},
		{
			name:           "missing imsi",
			body:           `{"type":"missing_config"}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "imsi and type are required",
		},
		{
			name:           "missing type",
			body:           `{"imsi":"123456789012345"}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "imsi and type are required",
		},
		{
			name:           "14 digit imsi",
			body:           `{"imsi":"12345678901234","type":"missing_config"}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "IMSI must be exactly 15 digits or UNKNOWN",
		},
		{
			name:           "16 digit imsi",
			body:           `{"imsi":"1234567890123456","type":"missing_config"}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "IMSI must be exactly 15 digits or UNKNOWN",
		},
		{
			name:           "whitespace imsi",
			body:           `{"imsi":" 123456789012345 ","type":"missing_config"}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "IMSI must be exactly 15 digits or UNKNOWN",
		},
		{
			name:           "lowercase unknown",
			body:           `{"imsi":"unknown","type":"missing_config"}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "IMSI must be exactly 15 digits or UNKNOWN",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/system/audit/heal", bytes.NewBufferString(tt.body))
			ctx := auth.ContextWithPrincipal(req.Context(), &auth.Principal{
				Username:       "admin",
				Role:           "admin",
				NormalizedRole: "admin",
			})
			req = req.WithContext(ctx)

			rec := httptest.NewRecorder()
			h.Heal(rec, req)

			if rec.Code != tt.expectedStatus {
				t.Fatalf("expected status %d, got %d. Body: %s", tt.expectedStatus, rec.Code, rec.Body.String())
			}

			var resp map[string]string
			if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp["error"] != tt.expectedError {
				t.Errorf("expected error %q, got %q", tt.expectedError, resp["error"])
			}
		})
	}
}

func TestBatchHealValidation(t *testing.T) {
	h := NewHandler(nil, nil, nil)

	tests := []struct {
		name           string
		body           string
		expectedStatus int
		expectedError  string
	}{
		{
			name:           "malformed JSON",
			body:           "not-json",
			expectedStatus: http.StatusInternalServerError,
			expectedError:  "Batch self-healing execution failed",
		},
		{
			name:           "missing anomalies",
			body:           "{}",
			expectedStatus: http.StatusBadRequest,
			expectedError:  "anomalies list is required and cannot be empty",
		},
		{
			name:           "null anomalies",
			body:           `{"anomalies":null}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "anomalies list is required and cannot be empty",
		},
		{
			name:           "empty anomalies array",
			body:           `{"anomalies":[]}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "anomalies list is required and cannot be empty",
		},
		{
			name:           "object anomalies",
			body:           `{"anomalies":{}}`,
			expectedStatus: http.StatusBadRequest,
			expectedError:  "anomalies list is required and cannot be empty",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/system/audit/batch-heal", bytes.NewBufferString(tt.body))
			ctx := auth.ContextWithPrincipal(req.Context(), &auth.Principal{
				Username:       "admin",
				Role:           "admin",
				NormalizedRole: "admin",
			})
			req = req.WithContext(ctx)

			rec := httptest.NewRecorder()
			h.BatchHeal(rec, req)

			if rec.Code != tt.expectedStatus {
				t.Fatalf("expected status %d, got %d. Body: %s", tt.expectedStatus, rec.Code, rec.Body.String())
			}

			var resp map[string]string
			if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp["error"] != tt.expectedError {
				t.Errorf("expected error %q, got %q", tt.expectedError, resp["error"])
			}
		})
	}
}

func TestAuthorizationDenial(t *testing.T) {
	h := NewHandler(nil, nil, nil)

	// Viewer role has system_heal capability denied
	req := httptest.NewRequest(http.MethodPost, "/api/system/audit/heal", bytes.NewBufferString(`{"imsi":"123456789012345","type":"missing_config"}`))
	ctx := auth.ContextWithPrincipal(req.Context(), &auth.Principal{
		Username:       "viewer",
		Role:           "viewer",
		NormalizedRole: "viewer",
	})
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	h.Heal(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", rec.Code)
	}

	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["code"] != "PERMISSION_DENIED" {
		t.Errorf("expected code PERMISSION_DENIED, got %v", resp["code"])
	}
}
