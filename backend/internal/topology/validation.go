package topology

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var (
	// Label grammar: lowercase alphanumerics with underscores, slashes and
	// hyphens. Slash is permitted; dot is prohibited by the explicit check.
	labelKeyRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9_/-]{0,62}$`)
)

// Sentinel validation errors mapped to stable API error codes.
var (
	ErrInvalidRelationshipType = errors.New("INVALID_RELATIONSHIP_TYPE")
	ErrInvalidResourceID       = errors.New("INVALID_RESOURCE_ID")
	ErrSelfEdge                = errors.New("TOPOLOGY_SELF_EDGE")
	ErrInvalidMetadata         = errors.New("VALIDATION_FAILED")
)

// Sensitive key fragments rejected in attributes (case-insensitive, after
// removing underscores and hyphens so normalized variants are caught too).
var sensitiveKeyFragments = []string{
	"password",
	"passwd",
	"secret",
	"token",
	"apikey",
	"privatekey",
	"credential",
}

// Server-owned fields forbidden in any topology client request body.
var forbiddenServerFields = []string{
	"edgeId",
	"edge_id",
	"schemaVersion",
	"schema_version",
	"source",
	"revision",
	"lifecycleState",
	"lifecycle_state",
	"createdAt",
	"created_at",
	"createdBy",
	"created_by",
	"updatedAt",
	"updated_at",
	"updatedBy",
	"updated_by",
	"retiredAt",
	"retired_at",
	"retiredBy",
	"retired_by",
	"retireReason",
	"retire_reason",
}

// CheckForbiddenServerFields returns an error when any server-owned field is
// present in the raw JSON body. The nested "edge" object used by the update
// contract is inspected as well.
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
	if edgeRaw, exists := topLevel["edge"]; exists {
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(edgeRaw, &nested); err == nil && nested != nil {
			for _, forbidden := range forbiddenServerFields {
				if _, exists := nested[forbidden]; exists {
					return fmt.Errorf("server-owned field %q is forbidden in nested edge update", forbidden)
				}
			}
		}
	}
	return nil
}

// ValidateRelationshipType checks membership in the nine canonical types.
func ValidateRelationshipType(rel string) error {
	for _, r := range CanonicalRelationshipTypes {
		if r == rel {
			return nil
		}
	}
	return fmt.Errorf("%w: invalid relationshipType %q; must be one of the nine canonical directed relationship types", ErrInvalidRelationshipType, rel)
}

// ValidateLifecycleState checks membership in the two canonical states.
func ValidateLifecycleState(state string) error {
	for _, s := range CanonicalLifecycleStates {
		if s == state {
			return nil
		}
	}
	return fmt.Errorf("invalid lifecycleState %q; must be active or retired", state)
}

// ValidateDirection checks membership in the supported neighbor directions.
func ValidateDirection(direction string) error {
	for _, d := range CanonicalDirections {
		if d == direction {
			return nil
		}
	}
	return fmt.Errorf("invalid direction %q; must be inbound, outbound or both", direction)
}

// ValidateUUIDv4 checks the strict RFC 4122 version 4 form.
func ValidateUUIDv4(id string) error {
	if !uuidRegex.MatchString(id) {
		return fmt.Errorf("%w: identifier %q must be a valid RFC 4122 UUID v4", ErrInvalidResourceID, id)
	}
	return nil
}

// ValidateLabels checks label count, key grammar and value byte length.
func ValidateLabels(labels map[string]string) error {
	if len(labels) > 32 {
		return errors.New("labels must not exceed 32 items")
	}
	for k, v := range labels {
		if strings.Contains(k, ".") {
			return fmt.Errorf("label key %q must not contain '.'", k)
		}
		if strings.HasPrefix(k, "$") {
			return fmt.Errorf("label key %q must not start with '$'", k)
		}
		if !labelKeyRegex.MatchString(k) {
			return fmt.Errorf("label key %q does not match required grammar ^[a-z0-9][a-z0-9_/-]{0,62}$", k)
		}
		if len([]byte(v)) > 128 {
			return fmt.Errorf("label value for %q must not exceed 128 UTF-8 bytes", k)
		}
	}
	return nil
}

// ValidateAttributes recursively enforces size, depth, key count, array length,
// string length and the sensitive-key denylist.
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
				if strings.Contains(k, ".") {
					return fmt.Errorf("attribute key %q must not contain '.'", k)
				}
				if strings.HasPrefix(k, "$") {
					return fmt.Errorf("attribute key %q must not start with '$'", k)
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

// ValidateMetadata validates the mutable description/labels/attributes block.
func ValidateMetadata(description string, labels map[string]string, attributes map[string]any) error {
	if len(description) > 1024 {
		return fmt.Errorf("%w: description must not exceed 1024 characters", ErrInvalidMetadata)
	}
	if err := ValidateLabels(labels); err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidMetadata, err.Error())
	}
	if err := ValidateAttributes(attributes); err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidMetadata, err.Error())
	}
	return nil
}

// ValidateCreateRequest performs complete structural validation on an edge
// creation request.
func ValidateCreateRequest(req *CreateEdgeRequest) error {
	if err := ValidateRelationshipType(req.RelationshipType); err != nil {
		return err
	}
	if err := ValidateUUIDv4(req.FromResourceID); err != nil {
		return err
	}
	if err := ValidateUUIDv4(req.ToResourceID); err != nil {
		return err
	}
	if req.FromResourceID == req.ToResourceID {
		return fmt.Errorf("%w: fromResourceId and toResourceId must differ", ErrSelfEdge)
	}
	return ValidateMetadata(req.Description, req.Labels, req.Attributes)
}

// ValidateUpdateRequest performs complete structural validation on an edge
// update request.
func ValidateUpdateRequest(req *UpdateEdgeRequest) error {
	if req.ExpectedRevision <= 0 {
		return errors.New("expectedRevision must be a positive integer")
	}
	return ValidateMetadata(req.Edge.Description, req.Edge.Labels, req.Edge.Attributes)
}

// ValidateRetireRequest validates the revision binding and the bounded reason.
func ValidateRetireRequest(req *RetireEdgeRequest) error {
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
