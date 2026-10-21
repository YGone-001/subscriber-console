package knowledge

import (
	"fmt"
	"regexp"
	"strings"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

// IsValidID reports whether s is a canonical UUID v4 identifier.
func IsValidID(s string) bool {
	return uuidRegex.MatchString(s)
}

// normalizeTags trims, de-duplicates and bounds a tag list. Empty tags are
// dropped and the result is nil when no tag survives.
func normalizeTags(tags []string) ([]string, error) {
	if len(tags) == 0 {
		return nil, nil
	}
	if len(tags) > MaxTags {
		return nil, fmt.Errorf("tags must not exceed %d entries", MaxTags)
	}
	seen := make(map[string]struct{}, len(tags))
	out := make([]string, 0, len(tags))
	for _, raw := range tags {
		tag := strings.TrimSpace(raw)
		if tag == "" {
			continue
		}
		if len(tag) > MaxTagLength {
			return nil, fmt.Errorf("tag %q exceeds %d characters", tag, MaxTagLength)
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		out = append(out, tag)
	}
	return out, nil
}

// normalizeProtocol coerces an empty protocol to the General bucket and rejects
// values outside the canonical set, keeping the editor and the API in sync.
func normalizeProtocol(protocol string) (string, error) {
	p := strings.TrimSpace(protocol)
	if p == "" {
		return "General", nil
	}
	if len(p) > MaxProtocolLength {
		return "", fmt.Errorf("protocol must not exceed %d characters", MaxProtocolLength)
	}
	for _, canonical := range CanonicalProtocols {
		if p == canonical {
			return p, nil
		}
	}
	return "", fmt.Errorf("protocol %q is not one of the canonical protocols", p)
}

// validateCommon validates fields shared by create and update requests.
func validateCommon(title, phenomenon, rootCause, solution string, tags []string) (string, []string, error) {
	t := strings.TrimSpace(title)
	if t == "" {
		return "", nil, fmt.Errorf("title is required")
	}
	if len(t) > MaxTitleLength {
		return "", nil, fmt.Errorf("title must not exceed %d characters", MaxTitleLength)
	}
	if len(phenomenon) > MaxPhenomenonLength {
		return "", nil, fmt.Errorf("phenomenon must not exceed %d characters", MaxPhenomenonLength)
	}
	if len(rootCause) > MaxRootCauseLength {
		return "", nil, fmt.Errorf("rootCause must not exceed %d characters", MaxRootCauseLength)
	}
	if len(solution) > MaxSolutionLength {
		return "", nil, fmt.Errorf("solution must not exceed %d characters", MaxSolutionLength)
	}
	normalized, err := normalizeTags(tags)
	if err != nil {
		return "", nil, err
	}
	return t, normalized, nil
}

// validateAttachmentFileIDs ensures every referenced file id is a valid UUID and
// that the count stays inside the per-entry attachment budget.
func validateAttachmentFileIDs(ids []string) error {
	if len(ids) > MaxAttachments {
		return fmt.Errorf("an entry may reference at most %d attachments", MaxAttachments)
	}
	for _, id := range ids {
		if !IsValidID(id) {
			return fmt.Errorf("attachment file id %q is not a valid UUID", id)
		}
	}
	return nil
}

// ValidateCreateRequest validates a create payload and returns a normalized
// protocol and tag set.
func ValidateCreateRequest(req *CreateEntryRequest) (string, []string, error) {
	if req == nil {
		return "", nil, fmt.Errorf("request body is required")
	}
	title, tags, err := validateCommon(req.Title, req.Phenomenon, req.RootCause, req.Solution, req.Tags)
	if err != nil {
		return "", nil, err
	}
	req.Title = title
	protocol, err := normalizeProtocol(req.Protocol)
	if err != nil {
		return "", nil, err
	}
	if err := validateAttachmentFileIDs(req.AttachmentFileIDs); err != nil {
		return "", nil, err
	}
	return protocol, tags, nil
}

// ValidateUpdateRequest validates an update payload and returns a normalized
// protocol and tag set.
func ValidateUpdateRequest(req *UpdateEntryRequest) (string, []string, error) {
	if req == nil {
		return "", nil, fmt.Errorf("request body is required")
	}
	if req.ExpectedRevision <= 0 {
		return "", nil, fmt.Errorf("expectedRevision is required")
	}
	title, tags, err := validateCommon(req.Title, req.Phenomenon, req.RootCause, req.Solution, req.Tags)
	if err != nil {
		return "", nil, err
	}
	req.Title = title
	protocol, err := normalizeProtocol(req.Protocol)
	if err != nil {
		return "", nil, err
	}
	if err := validateAttachmentFileIDs(req.AttachmentFileIDs); err != nil {
		return "", nil, err
	}
	return protocol, tags, nil
}
