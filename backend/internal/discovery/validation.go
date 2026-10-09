package discovery

import (
	"errors"
	"fmt"
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

// ValidateUUIDv4 checks an identifier is a canonical UUID v4.
func ValidateUUIDv4(id string) error {
	if !uuidRegex.MatchString(id) {
		return validationError("INVALID_ID", "identifier must be a valid UUID v4")
	}
	return nil
}

// ValidateAdapterType checks the adapter type is an implemented vendor adapter.
func ValidateAdapterType(t string) error {
	for _, allowed := range CanonicalAdapterTypes {
		if t == allowed {
			return nil
		}
	}
	return validationError("INVALID_ADAPTER_TYPE", "adapterType is not supported")
}

// ValidateTransportMode checks the transport mode is supported.
func ValidateTransportMode(m string) error {
	for _, allowed := range CanonicalTransportModes {
		if m == allowed {
			return nil
		}
	}
	return validationError("INVALID_TRANSPORT_MODE", "transportMode must be h2c or h2_tls")
}

// ValidateSourceName checks source display name bounds.
func ValidateSourceName(name string) error {
	name = strings.TrimSpace(name)
	if len(name) < 1 || len(name) > 128 {
		return validationError("INVALID_SOURCE_NAME", "name must be between 1 and 128 characters")
	}
	return nil
}

// ValidateBaseURL performs structural URL validation. Allowlist enforcement is
// a separate, server-owned step.
func ValidateBaseURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return validationError("INVALID_URL", "baseUrl is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return validationError("INVALID_URL", "baseUrl is malformed")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return validationError("INVALID_URL_SCHEME", "baseUrl scheme must be http or https")
	}
	if u.User != nil {
		return validationError("INVALID_URL", "baseUrl must not embed credentials")
	}
	if u.Fragment != "" {
		return validationError("INVALID_URL", "baseUrl must not contain a fragment")
	}
	if u.Hostname() == "" {
		return validationError("INVALID_URL", "baseUrl must contain a host")
	}
	if u.RawQuery != "" {
		return validationError("INVALID_URL", "baseUrl must not contain a query string")
	}
	return nil
}

// ValidateCreateSourceRequest validates POST /api/discovery/sources.
func ValidateCreateSourceRequest(req *CreateSourceRequest, allowlist *DestinationAllowlist) error {
	if err := ValidateSourceName(req.Name); err != nil {
		return err
	}
	if err := ValidateAdapterType(req.AdapterType); err != nil {
		return err
	}
	if err := ValidateTransportMode(req.TransportMode); err != nil {
		return err
	}
	if err := ValidateBaseURL(req.BaseURL); err != nil {
		return err
	}
	if err := MustAllowlistURL(req.BaseURL, allowlist); err != nil {
		return validationError("DISCOVERY_TARGET_NOT_ALLOWED", "baseUrl destination is not allowlisted")
	}
	return nil
}

// ValidateUpdateSourceRequest validates PUT /api/discovery/sources/{sourceId}.
func ValidateUpdateSourceRequest(req *UpdateSourceRequest, allowlist *DestinationAllowlist) error {
	if req.ExpectedRevision < 1 {
		return validationError("INVALID_REVISION", "expectedRevision must be a positive integer")
	}
	if err := ValidateSourceName(req.Source.Name); err != nil {
		return err
	}
	if err := ValidateTransportMode(req.Source.TransportMode); err != nil {
		return err
	}
	if err := ValidateBaseURL(req.Source.BaseURL); err != nil {
		return err
	}
	if err := MustAllowlistURL(req.Source.BaseURL, allowlist); err != nil {
		return validationError("DISCOVERY_TARGET_NOT_ALLOWED", "baseUrl destination is not allowlisted")
	}
	return nil
}

// ValidateLinkRequest validates POST /api/discovery/candidates/{candidateId}/link.
func ValidateLinkRequest(req *LinkCandidateRequest) error {
	if req.ExpectedRevision < 1 {
		return validationError("INVALID_REVISION", "expectedRevision must be a positive integer")
	}
	if err := ValidateUUIDv4(req.ResourceID); err != nil {
		return validationError("INVALID_RESOURCE_ID", "resourceId must be a valid UUID v4")
	}
	return nil
}

// ValidateUnlinkRequest validates POST /api/discovery/candidates/{candidateId}/unlink.
func ValidateUnlinkRequest(req *UnlinkCandidateRequest) error {
	if req.ExpectedRevision < 1 {
		return validationError("INVALID_REVISION", "expectedRevision must be a positive integer")
	}
	return nil
}

// ErrNotFound is returned when a discovery entity does not exist.
var ErrNotFound = errors.New("discovery entity not found")

// ErrConflict is returned on CAS revision mismatch.
var ErrConflict = errors.New("discovery revision conflict")

// ErrScanInProgress is returned when a scan is already running for a source.
var ErrScanInProgress = errors.New("discovery scan in progress")

// ErrScanRateLimited is returned when scans are requested too frequently.
var ErrScanRateLimited = errors.New("discovery scan rate limited")

// ErrLinkConflict is returned when an inventory link is not permitted.
var ErrLinkConflict = errors.New("discovery inventory link conflict")

// MapValidationError maps a validation error to a stable code.
func MapValidationError(err error) (code string, message string) {
	var ve *ErrValidation
	if errors.As(err, &ve) {
		return ve.Code, ve.Message
	}
	return "INVALID_REQUEST", err.Error()
}

// SanitizeSummary shortens free-form error text for bounded run records.
func SanitizeSummary(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 256 {
		s = s[:256]
	}
	return s
}

// ValidateNfTypeFilter validates an optional nfType query filter.
func ValidateNfTypeFilter(v string) error {
	if v == "" {
		return nil
	}
	if len(v) > 32 {
		return validationError("INVALID_NF_TYPE", "nfType filter is too long")
	}
	return nil
}

// ValidateObservationStateFilter validates an observationState filter.
func ValidateObservationStateFilter(v string) error {
	if v == "" {
		return nil
	}
	for _, allowed := range CanonicalObservationStates {
		if v == allowed {
			return nil
		}
	}
	return validationError("INVALID_OBSERVATION_STATE", "observationState filter is not supported")
}

// ValidateRunStatusFilter validates a run status filter.
func ValidateRunStatusFilter(v string) error {
	if v == "" {
		return nil
	}
	for _, allowed := range CanonicalRunStatuses {
		if v == allowed {
			return nil
		}
	}
	return validationError("INVALID_RUN_STATUS", "status filter is not supported")
}

// ValidateLimit parses a bounded pagination limit.
func ValidateLimit(raw string) (int, error) {
	if raw == "" {
		return DefaultPageLimit, nil
	}
	var n int
	if _, err := fmt.Sscanf(raw, "%d", &n); err != nil {
		return 0, validationError("INVALID_LIMIT", "limit must be an integer between 1 and 200")
	}
	if n < 1 || n > MaxPageLimit {
		return 0, validationError("INVALID_LIMIT", "limit must be an integer between 1 and 200")
	}
	return n, nil
}
