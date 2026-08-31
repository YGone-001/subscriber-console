// Package response provides JSON response helpers matching the existing API error shape.
//
// Success:  { ... }  (caller-defined payload)
// Error:    { "error": "message", "code": "ERROR_CODE" }
package response

import (
	"encoding/json"
	"net/http"
)

// JSON writes a JSON response with the given status code.
func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if data != nil {
		json.NewEncoder(w).Encode(data)
	}
}

// Error writes a JSON error response matching the existing error shape.
func Error(w http.ResponseWriter, status int, message, code string) {
	JSON(w, status, map[string]string{
		"error": message,
		"code":  code,
	})
}

// BadRequest writes a 400 error response.
func BadRequest(w http.ResponseWriter, message, code string) {
	Error(w, http.StatusBadRequest, message, code)
}

// Unauthorized writes a 401 error response.
func Unauthorized(w http.ResponseWriter, message string) {
	Error(w, http.StatusUnauthorized, message, "UNAUTHORIZED")
}

// Forbidden writes a 403 error response.
func Forbidden(w http.ResponseWriter, message string) {
	Error(w, http.StatusForbidden, message, "FORBIDDEN")
}

// NotFound writes a 404 error response.
func NotFound(w http.ResponseWriter) {
	Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
}

// InternalError writes a 500 error response.
// The message is intentionally generic to avoid leaking internals.
func InternalError(w http.ResponseWriter) {
	Error(w, http.StatusInternalServerError, "Internal server error", "INTERNAL_ERROR")
}
