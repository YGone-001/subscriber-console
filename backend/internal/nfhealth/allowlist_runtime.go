package nfhealth

import "strings"

// allowlist_runtime.go adds the server-owned registry identities to the local
// service-unit allowlist.
//
// The allowlist exists to deny client-supplied units by default. The values
// added here are compile-time constants from the runtime recognition registry,
// never client input, so adding them does not widen the client-controlled
// surface. Authorization for a specific Inventory resource still requires a
// server-owned process binding, which this method does not create.

// AddServerOwned adds compile-time process identities to the allowlist.
func (s *ServiceUnitAllowlist) AddServerOwned(names ...string) {
	if s == nil {
		return
	}
	if s.units == nil {
		s.units = map[string]struct{}{}
	}
	for _, name := range names {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			continue
		}
		s.units[trimmed] = struct{}{}
		s.units[strings.TrimSuffix(trimmed, ".service")] = struct{}{}
	}
}
