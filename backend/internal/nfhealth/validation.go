package nfhealth

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

// ErrValidation carries a stable error code for HTTP mapping.
type ErrValidation struct {
	Code    string
	Message string
}

func (e *ErrValidation) Error() string { return e.Message }

func validationError(code, message string) error {
	return &ErrValidation{Code: code, Message: message}
}

// Sentinel repository errors.
var (
	ErrNotFound         = errors.New("NF_HEALTH_TARGET_NOT_FOUND")
	ErrRevisionConflict = errors.New("NF_HEALTH_REVISION_CONFLICT")
	ErrDuplicate        = errors.New("NF_HEALTH_TARGET_CONFLICT")
	ErrRunNotFound      = errors.New("NF_HEALTH_RUN_NOT_FOUND")
	ErrSampleNotFound   = errors.New("NF_HEALTH_SAMPLE_NOT_FOUND")
	ErrInProgress       = errors.New("NF_HEALTH_COLLECTION_IN_PROGRESS")
	ErrRateLimited      = errors.New("NF_HEALTH_COLLECTION_RATE_LIMITED")
	ErrDisabled         = errors.New("NF_HEALTH_TARGET_DISABLED")
)

// ValidateUUIDv4 checks an identifier is a canonical UUID v4.
func ValidateUUIDv4(id string) error {
	if !uuidRegex.MatchString(id) {
		return validationError("INVALID_ID", "identifier must be a valid UUID v4")
	}
	return nil
}

// ValidateTargetName checks the operator-owned display label bounds.
func ValidateTargetName(name string) error {
	name = strings.TrimSpace(name)
	if len(name) < 1 || len(name) > 128 {
		return validationError("INVALID_TARGET_NAME", "name must be between 1 and 128 characters")
	}
	return nil
}

// ValidateCollectorProfile checks the collector profile is a server-owned type.
func ValidateCollectorProfile(profile string) error {
	for _, allowed := range CanonicalCollectorProfiles {
		if profile == allowed {
			return nil
		}
	}
	return validationError("INVALID_COLLECTOR_PROFILE", "collectorProfile is not supported")
}

// ValidateCollectionMode checks the collection mode.
func ValidateCollectionMode(mode string) error {
	for _, allowed := range CanonicalCollectionModes {
		if mode == allowed {
			return nil
		}
	}
	return validationError("INVALID_COLLECTION_MODE", "collectionMode must be manual or scheduled")
}

// ValidateServiceKind checks the process-inspection kind.
func ValidateServiceKind(kind string) error {
	switch kind {
	case "systemd", "process", "none":
		return nil
	}
	return validationError("INVALID_SERVICE_KIND", "serviceKind must be systemd, process, or none")
}

// ValidateIntervalSeconds bounds the collection interval.
func ValidateIntervalSeconds(v int) error {
	if v == 0 {
		return nil
	}
	if v < MinIntervalSeconds || v > MaxIntervalSeconds {
		return validationError("INVALID_INTERVAL", fmt.Sprintf("intervalSeconds must be between %d and %d", MinIntervalSeconds, MaxIntervalSeconds))
	}
	return nil
}

// ValidateMetricsEndpoint performs structural URL validation. Allowlist
// enforcement is a separate, server-owned step.
func ValidateMetricsEndpoint(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return validationError("INVALID_URL", "metricsEndpoint is malformed")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return validationError("INVALID_URL_SCHEME", "metricsEndpoint scheme must be http or https")
	}
	if u.User != nil {
		return validationError("INVALID_URL", "metricsEndpoint must not embed credentials")
	}
	if u.Fragment != "" {
		return validationError("INVALID_URL", "metricsEndpoint must not contain a fragment")
	}
	if u.Hostname() == "" {
		return validationError("INVALID_URL", "metricsEndpoint must contain a host")
	}
	if u.RawQuery != "" {
		return validationError("INVALID_URL", "metricsEndpoint must not contain a query string")
	}
	return nil
}

// ServiceUnitAllowlist is a server-owned set of approved local service units or
// process names. Default deny.
type ServiceUnitAllowlist struct {
	units map[string]struct{}
}

// NewServiceUnitAllowlist builds an allowlist from a comma-separated config value.
func NewServiceUnitAllowlist(raw string) *ServiceUnitAllowlist {
	m := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		m[part] = struct{}{}
		m[strings.TrimSuffix(part, ".service")] = struct{}{}
	}
	return &ServiceUnitAllowlist{units: m}
}

// Allows reports whether a unit or process name is approved.
func (s *ServiceUnitAllowlist) Allows(unit string) bool {
	if s == nil {
		return false
	}
	unit = strings.TrimSpace(unit)
	if unit == "" {
		return false
	}
	if _, ok := s.units[unit]; ok {
		return true
	}
	if _, ok := s.units[unit+".service"]; ok {
		return true
	}
	return false
}

// Size returns the number of configured unit entries.
func (s *ServiceUnitAllowlist) Size() int {
	if s == nil {
		return 0
	}
	return len(s.units)
}

// Entries returns the configured unit entries for metadata projection.
func (s *ServiceUnitAllowlist) Entries() []string {
	if s == nil {
		return []string{}
	}
	out := make([]string, 0, len(s.units))
	for k := range s.units {
		out = append(out, k)
	}
	return out
}

// DestinationAllowlist is a server-owned set of approved metrics destinations.
// Default deny.
type DestinationAllowlist struct {
	hosts map[string]struct{}
}

// NewDestinationAllowlist builds an allowlist from comma-separated host:port entries.
func NewDestinationAllowlist(raw string) *DestinationAllowlist {
	m := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		m[strings.ToLower(part)] = struct{}{}
	}
	return &DestinationAllowlist{hosts: m}
}

// Allows reports whether a host:port destination is approved.
func (d *DestinationAllowlist) Allows(hostport string) bool {
	if d == nil {
		return false
	}
	_, ok := d.hosts[strings.ToLower(strings.TrimSpace(hostport))]
	return ok
}

// Size returns the number of configured destinations.
func (d *DestinationAllowlist) Size() int {
	if d == nil {
		return 0
	}
	return len(d.hosts)
}

// Entries returns the configured destination entries for metadata projection.
func (d *DestinationAllowlist) Entries() []string {
	if d == nil {
		return []string{}
	}
	out := make([]string, 0, len(d.hosts))
	for k := range d.hosts {
		out = append(out, k)
	}
	return out
}

// MustAllowlistEndpoint enforces the metrics destination allowlist.
func MustAllowlistEndpoint(raw string, allowlist *DestinationAllowlist) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "metricsEndpoint destination is not allowlisted")
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if allowlist == nil || !allowlist.Allows(net.JoinHostPort(host, port)) {
		return validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "metricsEndpoint destination is not allowlisted")
	}
	return nil
}

// MustAllowlistServiceUnit enforces the service-unit allowlist.
func MustAllowlistServiceUnit(unit string, allowlist *ServiceUnitAllowlist) error {
	unit = strings.TrimSpace(unit)
	if unit == "" {
		return nil
	}
	if allowlist == nil || !allowlist.Allows(unit) {
		return validationError("NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED", "serviceUnit is not allowlisted")
	}
	return nil
}

// ValidateCreateTargetRequest validates POST /api/nf-health/targets.
func ValidateCreateTargetRequest(req *CreateTargetRequest, dest *DestinationAllowlist, units *ServiceUnitAllowlist) error {
	if err := ValidateUUIDv4(req.CandidateID); err != nil {
		return err
	}
	if err := ValidateTargetName(req.Name); err != nil {
		return err
	}
	if err := ValidateCollectorProfile(req.CollectorProfile); err != nil {
		return err
	}
	if err := ValidateServiceKind(req.ServiceKind); err != nil {
		return err
	}
	if err := ValidateCollectionMode(req.CollectionMode); err != nil {
		return err
	}
	if err := ValidateIntervalSeconds(req.IntervalSeconds); err != nil {
		return err
	}
	if err := ValidateMetricsEndpoint(req.MetricsEndpoint); err != nil {
		return err
	}
	if err := MustAllowlistEndpoint(req.MetricsEndpoint, dest); err != nil {
		return err
	}
	if err := MustAllowlistServiceUnit(req.ServiceUnit, units); err != nil {
		return err
	}
	if req.CollectorProfile == CollectorHTTPMetrics && strings.TrimSpace(req.MetricsEndpoint) == "" {
		return validationError("INVALID_TARGET", "metricsEndpoint is required for the http_metrics collector profile")
	}
	return nil
}

// ValidateUpdateTargetRequest validates PUT /api/nf-health/targets/{targetId}.
func ValidateUpdateTargetRequest(req *UpdateTargetRequest, dest *DestinationAllowlist, units *ServiceUnitAllowlist) error {
	if req.ExpectedRevision < 1 {
		return validationError("INVALID_REVISION", "expectedRevision must be a positive integer")
	}
	if err := ValidateTargetName(req.Target.Name); err != nil {
		return err
	}
	if err := ValidateServiceKind(req.Target.ServiceKind); err != nil {
		return err
	}
	if err := ValidateCollectionMode(req.Target.CollectionMode); err != nil {
		return err
	}
	if err := ValidateIntervalSeconds(req.Target.IntervalSeconds); err != nil {
		return err
	}
	if err := ValidateMetricsEndpoint(req.Target.MetricsEndpoint); err != nil {
		return err
	}
	if err := MustAllowlistEndpoint(req.Target.MetricsEndpoint, dest); err != nil {
		return err
	}
	if err := MustAllowlistServiceUnit(req.Target.ServiceUnit, units); err != nil {
		return err
	}
	return nil
}

// ValidateLimit bounds a pagination limit query value.
func ValidateLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultPageLimit, nil
	}
	var n int
	if _, err := fmt.Sscanf(raw, "%d", &n); err != nil {
		return 0, validationError("INVALID_LIMIT", "limit must be an integer")
	}
	if n < 1 || n > MaxPageLimit {
		return 0, validationError("INVALID_LIMIT", fmt.Sprintf("limit must be between 1 and %d", MaxPageLimit))
	}
	return n, nil
}

// MapValidationError maps validation errors to stable error codes.
func MapValidationError(err error) (string, string) {
	var ve *ErrValidation
	if errors.As(err, &ve) {
		return ve.Code, ve.Message
	}
	return "INVALID_REQUEST", err.Error()
}
