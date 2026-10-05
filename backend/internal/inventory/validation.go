package inventory

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
)

var (
	resourceNameRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	labelKeyRegex     = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,62}$`)
	fqdnRegex         = regexp.MustCompile(`^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$`)
)

// Sensitive key fragments rejected in attributes (case-insensitive).
var sensitiveKeyFragments = []string{
	"password",
	"passwd",
	"secret",
	"token",
	"apikey",
	"privatekey",
	"credential",
}

// Server-owned fields forbidden in client request bodies.
var forbiddenServerFields = []string{
	"resourceId",
	"resource_id",
	"schemaVersion",
	"schema_version",
	"source",
	"revision",
	"createdAt",
	"created_at",
	"createdBy",
	"created_by",
	"updatedAt",
	"updated_at",
	"updatedBy",
	"updated_by",
}

// CheckForbiddenServerFields returns an error if any server-owned field exists in raw JSON.
func CheckForbiddenServerFields(raw []byte) error {
	var topLevel map[string]json.RawMessage
	if err := json.Unmarshal(raw, &topLevel); err != nil {
		return fmt.Errorf("invalid JSON payload: %w", err)
	}
	for _, forbidden := range forbiddenServerFields {
		if _, exists := topLevel[forbidden]; exists {
			return fmt.Errorf("server-owned field %q is forbidden in client requests", forbidden)
		}
	}
	return nil
}

// ValidateKind checks if kind is one of the 20 canonical kinds.
func ValidateKind(kind string) error {
	for _, k := range CanonicalKinds {
		if k == kind {
			return nil
		}
	}
	return fmt.Errorf("invalid resource kind %q; must be one of allowed canonical kinds", kind)
}

// ValidateDomain checks if domain is one of the 10 canonical domains.
func ValidateDomain(domain string) error {
	for _, d := range CanonicalDomains {
		if d == domain {
			return nil
		}
	}
	return fmt.Errorf("invalid domain %q; must be one of allowed canonical domains", domain)
}

// ValidateLifecycleState checks if state is one of the 4 canonical states.
func ValidateLifecycleState(state string, allowRetired bool) error {
	if state == "" {
		return nil
	}
	if state == LifecycleRetired && !allowRetired {
		return errors.New("resources cannot be created or updated directly into retired state; use explicit retire operation")
	}
	for _, s := range CanonicalLifecycleStates {
		if s == state {
			return nil
		}
	}
	return fmt.Errorf("invalid lifecycle state %q; must be one of allowed canonical states", state)
}

// ValidateResourceName checks machine name length and grammar.
func ValidateResourceName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return errors.New("resource name is required")
	}
	if len(trimmed) > 128 {
		return errors.New("resource name must not exceed 128 characters")
	}
	if !resourceNameRegex.MatchString(trimmed) {
		return fmt.Errorf("resource name %q does not match required grammar ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", trimmed)
	}
	return nil
}

// ValidateSoftware checks software metadata bounds.
func ValidateSoftware(s *SoftwareMetadata) error {
	if s == nil {
		return nil
	}
	if len(s.Product) > 128 {
		return errors.New("software product must not exceed 128 characters")
	}
	if len(s.Version) > 128 {
		return errors.New("software version must not exceed 128 characters")
	}
	if len(s.Build) > 128 {
		return errors.New("software build must not exceed 128 characters")
	}
	return nil
}

// ValidateManagementEndpoints validates an array of endpoints.
func ValidateManagementEndpoints(endpoints []ManagementEndpoint) error {
	if len(endpoints) > 16 {
		return errors.New("management endpoints must not exceed 16 items")
	}

	seen := make(map[string]bool)
	for i, ep := range endpoints {
		if strings.TrimSpace(ep.Name) == "" {
			return fmt.Errorf("management endpoint [%d] name is required", i)
		}
		if len(ep.Name) > 64 {
			return fmt.Errorf("management endpoint [%d] name must not exceed 64 characters", i)
		}

		// Protocol
		validProto := false
		for _, p := range CanonicalProtocols {
			if p == ep.Protocol {
				validProto = true
				break
			}
		}
		if !validProto {
			return fmt.Errorf("management endpoint [%d] protocol %q is invalid", i, ep.Protocol)
		}

		// Port
		if ep.Port < 1 || ep.Port > 65535 {
			return fmt.Errorf("management endpoint [%d] port %d is invalid; must be 1..65535", i, ep.Port)
		}

		// Address Type & Address
		switch ep.AddressType {
		case AddressTypeIPv4:
			ip := net.ParseIP(ep.Address)
			if ip == nil || ip.To4() == nil || strings.Contains(ep.Address, ":") {
				return fmt.Errorf("management endpoint [%d] address %q is not a valid IPv4 address", i, ep.Address)
			}
		case AddressTypeIPv6:
			ip := net.ParseIP(ep.Address)
			if ip == nil || ip.To4() != nil || !strings.Contains(ep.Address, ":") {
				return fmt.Errorf("management endpoint [%d] address %q is not a valid IPv6 address", i, ep.Address)
			}
		case AddressTypeFQDN:
			if strings.Contains(ep.Address, "://") || strings.Contains(ep.Address, "@") || strings.Contains(ep.Address, ":") || strings.Contains(ep.Address, "/") {
				return fmt.Errorf("management endpoint [%d] FQDN %q must not contain scheme, userinfo, port, or path", i, ep.Address)
			}
			if !fqdnRegex.MatchString(ep.Address) {
				return fmt.Errorf("management endpoint [%d] address %q is not a valid FQDN", i, ep.Address)
			}
		default:
			return fmt.Errorf("management endpoint [%d] addressType %q is invalid; must be ipv4, ipv6, or fqdn", i, ep.AddressType)
		}

		// Path
		if ep.Path != "" {
			if len(ep.Path) > 512 {
				return fmt.Errorf("management endpoint [%d] path must not exceed 512 characters", i)
			}
			if !strings.HasPrefix(ep.Path, "/") {
				return fmt.Errorf("management endpoint [%d] path must start with '/'", i)
			}
		}

		// Deduplication by normalized tuple
		normKey := fmt.Sprintf("%s|%s|%s|%d|%s",
			strings.ToLower(ep.Protocol),
			strings.ToLower(ep.AddressType),
			strings.ToLower(ep.Address),
			ep.Port,
			ep.Path,
		)
		if seen[normKey] {
			return fmt.Errorf("duplicate management endpoint tuple detected: %s", normKey)
		}
		seen[normKey] = true
	}
	return nil
}

// NormalizeCapabilities trims, deduplicates, and sorts capabilities.
func NormalizeCapabilities(caps []string) ([]string, error) {
	if len(caps) > 64 {
		return nil, errors.New("capabilities must not exceed 64 items")
	}
	seen := make(map[string]bool)
	var result []string
	for _, c := range caps {
		trimmed := strings.TrimSpace(c)
		if trimmed == "" {
			continue
		}
		if len(trimmed) > 64 {
			return nil, fmt.Errorf("capability %q must not exceed 64 characters", trimmed)
		}
		if !seen[trimmed] {
			seen[trimmed] = true
			result = append(result, trimmed)
		}
	}
	sort.Strings(result)
	return result, nil
}

// ValidateLabels checks label count, key syntax, and value lengths.
func ValidateLabels(labels map[string]string) error {
	if len(labels) > 32 {
		return errors.New("labels must not exceed 32 items")
	}
	for k, v := range labels {
		if strings.Contains(k, ".") || strings.HasPrefix(k, "$") {
			return fmt.Errorf("label key %q must not contain '.' or start with '$'", k)
		}
		if !labelKeyRegex.MatchString(k) {
			return fmt.Errorf("label key %q does not match required grammar ^[a-z0-9][a-z0-9._/-]{0,62}$", k)
		}
		if len(v) > 128 {
			return fmt.Errorf("label value for %q must not exceed 128 characters", k)
		}
	}
	return nil
}

// ValidateAttributes recursively checks attribute limits, key syntax, and sensitive keys.
func ValidateAttributes(attrs map[string]any) error {
	if len(attrs) == 0 {
		return nil
	}

	raw, err := json.Marshal(attrs)
	if err != nil {
		return fmt.Errorf("failed to serialize attributes: %w", err)
	}
	if len(raw) > 32*1024 {
		return fmt.Errorf("serialized attributes size (%d bytes) exceeds maximum limit of 32 KiB", len(raw))
	}

	totalKeys := 0
	var checkVal func(val any, depth int) error
	checkVal = func(val any, depth int) error {
		if depth > 6 {
			return fmt.Errorf("attributes nesting depth exceeds maximum of 6 (depth: %d)", depth)
		}
		switch v := val.(type) {
		case map[string]any:
			for k, child := range v {
				totalKeys++
				if totalKeys > 128 {
					return errors.New("attributes aggregate keys exceed maximum limit of 128")
				}
				if strings.Contains(k, ".") || strings.HasPrefix(k, "$") {
					return fmt.Errorf("attribute key %q must not contain '.' or start with '$'", k)
				}
				normalizedKey := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(k, "_", ""), "-", ""))
				for _, frag := range sensitiveKeyFragments {
					if strings.Contains(normalizedKey, frag) {
						return fmt.Errorf("sensitive key %q is strictly forbidden in attributes", k)
					}
				}
				if err := checkVal(child, depth+1); err != nil {
					return err
				}
			}
		case []any:
			if len(v) > 128 {
				return errors.New("attribute array length exceeds maximum limit of 128")
			}
			for _, item := range v {
				if err := checkVal(item, depth+1); err != nil {
					return err
				}
			}
		case string:
			if len(v) > 2048 {
				return errors.New("attribute string value exceeds maximum limit of 2048 characters")
			}
		}
		return nil
	}

	return checkVal(attrs, 1)
}

// ValidateCreateRequest performs complete structural validation on a resource creation request.
func ValidateCreateRequest(req *CreateResourceRequest) error {
	if err := ValidateKind(req.Kind); err != nil {
		return err
	}
	if err := ValidateResourceName(req.Name); err != nil {
		return err
	}
	if err := ValidateDomain(req.Domain); err != nil {
		return err
	}
	if len(req.DisplayName) > 256 {
		return errors.New("displayName must not exceed 256 characters")
	}
	if len(req.Description) > 1024 {
		return errors.New("description must not exceed 1024 characters")
	}
	if len(req.Role) > 64 {
		return errors.New("role must not exceed 64 characters")
	}
	if req.LifecycleState != "" {
		if err := ValidateLifecycleState(req.LifecycleState, false); err != nil {
			return err
		}
	}
	if len(req.Vendor) > 128 {
		return errors.New("vendor must not exceed 128 characters")
	}
	if len(req.Model) > 128 {
		return errors.New("model must not exceed 128 characters")
	}
	if err := ValidateSoftware(req.Software); err != nil {
		return err
	}
	if err := ValidateManagementEndpoints(req.ManagementEndpoints); err != nil {
		return err
	}
	if err := ValidateLabels(req.Labels); err != nil {
		return err
	}
	if err := ValidateAttributes(req.Attributes); err != nil {
		return err
	}
	return nil
}

// ValidateUpdateRequest performs complete structural validation on a resource update request.
func ValidateUpdateRequest(req *UpdateResourceRequest) error {
	if req.ExpectedRevision <= 0 {
		return errors.New("expectedRevision must be a positive integer")
	}
	r := &req.Resource
	if err := ValidateKind(r.Kind); err != nil {
		return err
	}
	if err := ValidateResourceName(r.Name); err != nil {
		return err
	}
	if err := ValidateDomain(r.Domain); err != nil {
		return err
	}
	if len(r.DisplayName) > 256 {
		return errors.New("displayName must not exceed 256 characters")
	}
	if len(r.Description) > 1024 {
		return errors.New("description must not exceed 1024 characters")
	}
	if len(r.Role) > 64 {
		return errors.New("role must not exceed 64 characters")
	}
	if r.LifecycleState != "" {
		if err := ValidateLifecycleState(r.LifecycleState, false); err != nil {
			return err
		}
	}
	if len(r.Vendor) > 128 {
		return errors.New("vendor must not exceed 128 characters")
	}
	if len(r.Model) > 128 {
		return errors.New("model must not exceed 128 characters")
	}
	if err := ValidateSoftware(r.Software); err != nil {
		return err
	}
	if err := ValidateManagementEndpoints(r.ManagementEndpoints); err != nil {
		return err
	}
	if err := ValidateLabels(r.Labels); err != nil {
		return err
	}
	if err := ValidateAttributes(r.Attributes); err != nil {
		return err
	}
	return nil
}

// ValidateRetireRequest validates the retirement reason.
func ValidateRetireRequest(req *RetireResourceRequest) error {
	if req.ExpectedRevision <= 0 {
		return errors.New("expectedRevision must be a positive integer")
	}
	trimmed := strings.TrimSpace(req.Reason)
	if trimmed == "" {
		return errors.New("retirement reason is required")
	}
	if len(trimmed) > 512 {
		return errors.New("retirement reason must not exceed 512 characters")
	}
	return nil
}
