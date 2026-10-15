package nfhealth

import (
	"fmt"
	"strings"
)

// ProcessBindingRegistry is the server-owned configuration that establishes a
// monitored Inventory resource corresponds to an approved local process or
// service on the collector host.
//
// The existing collector runs inside the xCloud Go backend, so local /proc
// evidence describes the backend host, not an arbitrary remote Inventory
// resource. For new process monitoring targets the binding must therefore be
// authorized server-side; a client-provided host claim is never authoritative.
// When no binding can be verified, target creation fails closed.
type ProcessBindingRegistry struct {
	// bindings maps Inventory resource IDs to the approved local unit or
	// process name on the collector host.
	bindings map[string]string
}

// NewProcessBindingRegistry builds the binding registry from a comma-separated
// server configuration value of "resourceId=unit" entries. Empty input yields
// an empty registry: process-only target creation then fails closed.
func NewProcessBindingRegistry(raw string) *ProcessBindingRegistry {
	registry := &ProcessBindingRegistry{bindings: map[string]string{}}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		eq := strings.IndexByte(part, '=')
		if eq <= 0 || eq == len(part)-1 {
			continue
		}
		resourceID := strings.TrimSpace(part[:eq])
		unit := normalizeUnitName(strings.TrimSpace(part[eq+1:]))
		if resourceID == "" || unit == "" {
			continue
		}
		registry.bindings[resourceID] = unit
	}
	return registry
}

// BoundUnit returns the approved local unit for an Inventory resource.
func (r *ProcessBindingRegistry) BoundUnit(resourceID string) (string, bool) {
	if r == nil {
		return "", false
	}
	unit, ok := r.bindings[strings.TrimSpace(resourceID)]
	return unit, ok
}

// Size returns the number of configured bindings.
func (r *ProcessBindingRegistry) Size() int {
	if r == nil {
		return 0
	}
	return len(r.bindings)
}

// CheckBinding verifies the requested local unit matches the server-authorized
// binding for the Inventory resource. Missing or mismatched bindings fail
// closed with deterministic validation errors.
func (r *ProcessBindingRegistry) CheckBinding(resourceID, unit string) error {
	bound, ok := r.BoundUnit(resourceID)
	if !ok {
		return validationError(
			"NF_HEALTH_PROCESS_BINDING_MISSING",
			fmt.Sprintf("no server-authorized local process binding exists for inventory resource %s", strings.TrimSpace(resourceID)),
		)
	}
	if normalizeUnitName(unit) != bound {
		return validationError(
			"NF_HEALTH_PROCESS_BINDING_MISMATCH",
			"serviceUnit does not match the server-authorized local process binding for this inventory resource",
		)
	}
	return nil
}

// normalizeUnitName strips the optional systemd unit suffix so "amfd.service"
// and "amfd" denote the same approved local identity.
func normalizeUnitName(unit string) string {
	return strings.TrimSuffix(strings.TrimSpace(unit), ".service")
}
