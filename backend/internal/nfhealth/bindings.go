package nfhealth

import (
	"errors"
	"fmt"
	"strings"
	"sync"
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
//
// Two layers exist and keep a strict precedence:
//
//  1. Static bindings come from the server configuration value
//     NF_HEALTH_LOCAL_PROCESS_BINDINGS. They always win.
//  2. Dynamic bindings are installed by the approved runtime bootstrap and
//     persisted in MongoDB so they survive a restart. A dynamic binding may
//     never override, contradict or widen a static binding.
type ProcessBindingRegistry struct {
	mu sync.RWMutex
	// bindings maps Inventory resource IDs to the approved local unit or
	// process name from static configuration.
	bindings map[string]string
	// dynamic maps Inventory resource IDs to bindings installed by the approved
	// runtime bootstrap.
	dynamic map[string]string
}

// ErrBindingConflict reports a binding that contradicts an existing
// authorization.
var ErrBindingConflict = errors.New("NF_HEALTH_PROCESS_BINDING_CONFLICT")

// NewProcessBindingRegistry builds the binding registry from a comma-separated
// server configuration value of "resourceId=unit" entries. Empty input yields
// an empty registry: process-only target creation then fails closed.
func NewProcessBindingRegistry(raw string) *ProcessBindingRegistry {
	registry := &ProcessBindingRegistry{
		bindings: map[string]string{},
		dynamic:  map[string]string{},
	}
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

// BoundUnit returns the approved local unit for an Inventory resource. A static
// binding always takes precedence over a dynamic one.
func (r *ProcessBindingRegistry) BoundUnit(resourceID string) (string, bool) {
	if r == nil {
		return "", false
	}
	key := strings.TrimSpace(resourceID)
	r.mu.RLock()
	defer r.mu.RUnlock()
	if unit, ok := r.bindings[key]; ok {
		return unit, true
	}
	unit, ok := r.dynamic[key]
	return unit, ok
}

// StaticUnit returns the statically configured unit, when one exists.
func (r *ProcessBindingRegistry) StaticUnit(resourceID string) (string, bool) {
	if r == nil {
		return "", false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	unit, ok := r.bindings[strings.TrimSpace(resourceID)]
	return unit, ok
}

// Size returns the number of effective bindings.
func (r *ProcessBindingRegistry) Size() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.bindings) + len(r.dynamic)
}

// StaticSize returns the number of statically configured bindings.
func (r *ProcessBindingRegistry) StaticSize() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.bindings)
}

// DynamicSize returns the number of bootstrap-installed bindings.
func (r *ProcessBindingRegistry) DynamicSize() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.dynamic)
}

// InstallDynamic records a bootstrap-installed binding in memory.
//
// It fails closed when a static binding already exists for the resource with a
// different unit, and when a different unit was already installed dynamically.
// The caller persists the binding separately; this method only keeps the
// in-process authorization view consistent with storage.
func (r *ProcessBindingRegistry) InstallDynamic(resourceID, unit string) error {
	if r == nil {
		return ErrBindingConflict
	}
	key := strings.TrimSpace(resourceID)
	normalized := normalizeUnitName(unit)
	if key == "" || normalized == "" {
		return ErrBindingConflict
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.bindings[key]; ok {
		if existing != normalized {
			return fmt.Errorf("%w: a static binding already authorizes a different local unit", ErrBindingConflict)
		}
		// Identical static binding: nothing to add.
		return nil
	}
	if existing, ok := r.dynamic[key]; ok {
		if existing != normalized {
			return fmt.Errorf("%w: a different dynamic binding already exists", ErrBindingConflict)
		}
		return nil
	}
	r.dynamic[key] = normalized
	return nil
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
