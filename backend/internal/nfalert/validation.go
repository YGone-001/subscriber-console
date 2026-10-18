package nfalert

import (
	"errors"
	"regexp"
	"strings"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ErrValidation carries a stable error code for HTTP mapping.
type ErrValidation struct {
	Code    string
	Message string
}

func (e *ErrValidation) Error() string { return e.Message }

func validationError(code, message string) error {
	return &ErrValidation{Code: code, Message: message}
}

// MapValidationError projects a validation error into its HTTP code/message.
func MapValidationError(err error) (string, string) {
	var ve *ErrValidation
	if errors.As(err, &ve) {
		return ve.Code, ve.Message
	}
	return "NF_ALERT_INVALID", "invalid request"
}

// Sentinel repository errors.
var (
	ErrNotFound         = errors.New("NF_ALERT_RULE_NOT_FOUND")
	ErrAlertNotFound    = errors.New("NF_ALERT_INSTANCE_NOT_FOUND")
	ErrRevisionConflict = errors.New("NF_ALERT_REVISION_CONFLICT")
	ErrAlertResolved    = errors.New("NF_ALERT_INSTANCE_RESOLVED")
)

// ValidateUUID checks an identifier is a canonical UUID (v4 or v7 shapes
// produced by the server generators).
func ValidateUUID(id string) error {
	if !uuidRegex.MatchString(id) {
		return validationError("INVALID_ID", "identifier must be a valid UUID")
	}
	return nil
}

// ValidateRuleName checks the operator-owned display label bounds.
func ValidateRuleName(name string) error {
	name = strings.TrimSpace(name)
	if len(name) < 1 || len(name) > 128 {
		return validationError("NF_ALERT_INVALID_RULE_NAME", "name must be between 1 and 128 characters")
	}
	return nil
}

// ValidateRuleFields validates the mutable surface of a rule. The condition
// payload requirement depends on the condition type, so both are validated
// together with the scope-specific allowed states.
func ValidateRuleFields(name, conditionType string, condition *RuleCondition, severity string, cooldown int) error {
	if err := ValidateRuleName(name); err != nil {
		return err
	}
	switch conditionType {
	case ConditionTypeState:
		if condition == nil {
			return validationError("NF_ALERT_INVALID_CONDITION", "state condition requires a condition payload")
		}
		scope := strings.TrimSpace(condition.Scope)
		if scope != ScopeOverall && scope != ScopeProcess && scope != ScopeInterface && scope != ScopeService {
			return validationError("NF_ALERT_INVALID_CONDITION", "condition scope must be overall, process, interface or service")
		}
		state := strings.TrimSpace(condition.State)
		if !StateSelectable(scope, state) {
			return validationError("NF_ALERT_INVALID_CONDITION", "condition state is not selectable for the scope")
		}
	case ConditionTypeRunFailed:
		// A failed-run condition carries no payload. A payload would be a
		// silent contract drift, so it is rejected instead of ignored.
		if condition != nil {
			return validationError("NF_ALERT_INVALID_CONDITION", "run_failed condition must not carry a condition payload")
		}
	default:
		return validationError("NF_ALERT_INVALID_CONDITION_TYPE", "conditionType must be state or run_failed")
	}
	switch severity {
	case SeverityCritical, SeverityWarning, SeverityInfo:
	default:
		return validationError("NF_ALERT_INVALID_SEVERITY", "severity must be critical, warning or info")
	}
	if cooldown == 0 {
		// Zero means "use the default"; validated by the caller before store.
		return nil
	}
	if cooldown < MinCooldownSeconds || cooldown > MaxCooldownSeconds {
		return validationError("NF_ALERT_INVALID_COOLDOWN", "cooldownSeconds must be between 60 and 86400")
	}
	return nil
}

// NormalizeCooldown clamps an absent or zero cooldown to the default and
// rejects out-of-bounds values.
func NormalizeCooldown(cooldown int) (int, error) {
	if cooldown == 0 {
		return DefaultCooldownSeconds, nil
	}
	if cooldown < MinCooldownSeconds || cooldown > MaxCooldownSeconds {
		return 0, validationError("NF_ALERT_INVALID_COOLDOWN", "cooldownSeconds must be between 60 and 86400")
	}
	return cooldown, nil
}

// ValidateTargetScope validates that exactly one matching dimension is used.
func ValidateTargetScope(targetID, resourceID string) error {
	targetID = strings.TrimSpace(targetID)
	resourceID = strings.TrimSpace(resourceID)
	if targetID != "" && resourceID != "" {
		return validationError("NF_ALERT_INVALID_TARGET_SCOPE", "targetId and resourceId cannot both be set")
	}
	if targetID != "" {
		if err := ValidateUUID(targetID); err != nil {
			return validationError("NF_ALERT_INVALID_TARGET_SCOPE", "targetId must be a valid UUID")
		}
	}
	if resourceID != "" {
		if err := ValidateUUID(resourceID); err != nil {
			return validationError("NF_ALERT_INVALID_TARGET_SCOPE", "resourceId must be a valid UUID")
		}
	}
	return nil
}

// ValidateLimit checks and defaults a page limit.
func ValidateLimit(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return DefaultPageLimit, nil
	}
	limit, err := parseInt(raw)
	if err != nil || limit < 1 {
		return 0, validationError("NF_ALERT_INVALID_LIMIT", "limit must be a positive integer")
	}
	if limit > MaxPageLimit {
		return 0, validationError("NF_ALERT_INVALID_LIMIT", "limit exceeds the maximum of 200")
	}
	return limit, nil
}

// ValidateAlertStateFilter checks the alert state filter vocabulary at the
// handler boundary. The repository repeats the check for defense in depth.
func ValidateAlertStateFilter(state string) error {
	switch state {
	case "", AlertStateActive, AlertStateAcknowledged, AlertStateResolved:
		return nil
	}
	return validationError("NF_ALERT_INVALID_STATE_FILTER", "state must be active, acknowledged or resolved")
}

// ValidateAlertSeverityFilter checks the severity filter vocabulary.
func ValidateAlertSeverityFilter(severity string) error {
	switch severity {
	case "", SeverityCritical, SeverityWarning, SeverityInfo:
		return nil
	}
	return validationError("NF_ALERT_INVALID_SEVERITY_FILTER", "severity must be critical, warning or info")
}

func parseInt(raw string) (int, error) {
	var v int
	if raw == "" {
		return 0, errors.New("empty")
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, errors.New("not a number")
		}
		v = v*10 + int(r-'0')
		if v > 1<<30 {
			return 0, errors.New("overflow")
		}
	}
	return v, nil
}
