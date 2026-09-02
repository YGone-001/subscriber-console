package audit

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/auth"
)

// DenialMetadata holds additional context for an authorization denial audit record.
type DenialMetadata struct {
	Capability       string `json:"capability,omitempty"`
	Decision         string `json:"decision,omitempty"`
	Permission       string `json:"permission,omitempty"`
	RequiresApproval bool   `json:"requiresApproval,omitempty"`
}

// RecordPermissionDenied schedules an authorization.denied audit record
// in BestEffort mode. This matches Node recordPermissionDenied() from src/lib/authz.ts.
//
// The record is enqueued asynchronously — failure does not alter the HTTP response.
// Called by capability and permission guards after they determine a denial response.
func RecordPermissionDenied(w *Writer, r *http.Request, p *auth.Principal, meta DenialMetadata) {
	if w == nil || r == nil || p == nil {
		return
	}

	source, request, reason := AuditRequestContext(r)

	metadata := make(map[string]interface{})
	if meta.Capability != "" {
		metadata["capability"] = meta.Capability
	}
	if meta.Decision != "" {
		metadata["decision"] = meta.Decision
	}
	if meta.Permission != "" {
		metadata["permission"] = meta.Permission
	}
	if meta.RequiresApproval {
		metadata["requiresApproval"] = true
	}

	input := WriteAuditInput{
		Action: "authorization.denied",
		Module: "security",
		Actor: ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Resource: &ResourceInput{
			Type: "api",
			ID:   r.URL.Path,
		},
		Result:    "denied",
		RiskLevel: "medium",
		Source:    source,
		Request:   request,
		Reason:    reason,
		Metadata:  metadata,
	}

	// BestEffort: failure must not alter the 403 response.
	w.Write(input, BestEffort)
}

// RequireCapabilityWithAudit checks capability and schedules denial audit if denied.
// Returns true if the capability is granted, false if denied (response already written).
// Matches Node requireCapability() + recordPermissionDenied() semantics.
func RequireCapabilityWithAudit(w http.ResponseWriter, r *http.Request, p *auth.Principal, capability string, writer *Writer) bool {
	if p == nil {
		return false
	}

	decision, allowed := auth.CapabilityDecision(p, capability)
	if allowed {
		return true
	}

	// Determine if this capability requires approval (for the metadata)
	requiresApproval := decision == "approval"

	// Schedule audit evidence
	RecordPermissionDenied(writer, r, p, DenialMetadata{
		Capability:       capability,
		Decision:         decision,
		RequiresApproval: requiresApproval,
	})

	// Write 403 response matching Node shape
	resp := map[string]interface{}{
		"error":            "Forbidden: Insufficient permissions",
		"code":             "PERMISSION_DENIED",
		"capability":       capability,
		"decision":         decision,
		"requiresApproval": requiresApproval,
	}
	// Suppress requiresApproval=false in response to match Node behavior
	if !requiresApproval {
		delete(resp, "requiresApproval")
	}

	writeDenialJSON(w, http.StatusForbidden, resp)
	return false
}

// RequirePermissionWithAudit checks permission and schedules denial audit if denied.
// Returns true if the permission is granted, false if denied (response already written).
// Matches Node requirePermission() + recordPermissionDenied() semantics.
func RequirePermissionWithAudit(w http.ResponseWriter, r *http.Request, p *auth.Principal, permission string, writer *Writer) bool {
	if p == nil {
		return false
	}

	if auth.HasPermission(p, permission) {
		return true
	}

	// Schedule audit evidence
	RecordPermissionDenied(writer, r, p, DenialMetadata{
		Permission: permission,
	})

	// Write 403 response matching Node shape
	writeDenialJSON(w, http.StatusForbidden, map[string]interface{}{
		"error":      "Forbidden: Insufficient permissions",
		"code":       "PERMISSION_DENIED",
		"permission": permission,
	})
	return false
}

// writeDenialJSON writes a JSON response for authorization denial.
// Uses encoding/json directly to avoid import cycles with the response package.
func writeDenialJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("failed to write denial response", "error", err)
	}
}
