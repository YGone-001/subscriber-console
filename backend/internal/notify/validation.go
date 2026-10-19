package notify

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"subscriber/internal/nfalert"
)

type validationError struct {
	code    string
	message string
}

func (e *validationError) Error() string { return e.message }

func invalid(code, message string) error { return &validationError{code: code, message: message} }

// ValidateChannel validates the channel payload before a write.
func ValidateChannel(name, kind, rawURL, secret string) error {
	if strings.TrimSpace(name) == "" {
		return invalid("NOTIFY_CHANNEL_NAME_REQUIRED", "name is required")
	}
	if len(name) > MaxDeliveryNameBytes {
		return invalid("NOTIFY_CHANNEL_NAME_TOO_LONG", "name is too long")
	}
	if kind != ChannelKindWebhook {
		return invalid("NOTIFY_CHANNEL_KIND_UNSUPPORTED", "kind must be webhook")
	}
	if err := ValidateWebhookURL(rawURL); err != nil {
		return err
	}
	if len(secret) > MaxDeliverySecretBytes {
		return invalid("NOTIFY_CHANNEL_SECRET_TOO_LONG", "secret is too long")
	}
	return nil
}

// ValidateWebhookURL restricts a webhook to an HTTPS (or localhost HTTP) URL
// without embedded credentials or a fragment.
func ValidateWebhookURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return invalid("NOTIFY_CHANNEL_URL_REQUIRED", "url is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return invalid("NOTIFY_CHANNEL_URL_MALFORMED", "url is malformed")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return invalid("NOTIFY_CHANNEL_URL_SCHEME", "url scheme must be http or https")
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return invalid("NOTIFY_CHANNEL_URL_SCHEME", "http is only allowed for loopback destinations")
	}
	if parsed.User != nil {
		return invalid("NOTIFY_CHANNEL_URL_CREDENTIALS", "url must not embed credentials")
	}
	if parsed.Fragment != "" {
		return invalid("NOTIFY_CHANNEL_URL_FRAGMENT", "url must not contain a fragment")
	}
	if parsed.Hostname() == "" {
		return invalid("NOTIFY_CHANNEL_URL_HOST", "url must contain a host")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(host)
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// ValidateEscalation validates an escalation rule payload.
func ValidateEscalation(req CreateEscalationRequest) error {
	if strings.TrimSpace(req.Name) == "" {
		return invalid("NOTIFY_ESCALATION_NAME_REQUIRED", "name is required")
	}
	if len(req.Name) > MaxDeliveryNameBytes {
		return invalid("NOTIFY_ESCALATION_NAME_TOO_LONG", "name is too long")
	}
	if len(req.Severities) == 0 {
		return invalid("NOTIFY_ESCALATION_SEVERITIES_REQUIRED", "at least one severity is required")
	}
	for _, severity := range req.Severities {
		switch severity {
		case nfalert.SeverityCritical, nfalert.SeverityWarning, nfalert.SeverityInfo:
		default:
			return invalid("NOTIFY_ESCALATION_SEVERITY_UNSUPPORTED", "severity must be critical, warning or info")
		}
	}
	if len(req.ChannelIDs) == 0 {
		return invalid("NOTIFY_ESCALATION_CHANNELS_REQUIRED", "at least one channel is required")
	}
	if req.EscalateAfterSeconds < 0 || req.EscalateAfterSeconds > 86400*7 {
		return invalid("NOTIFY_ESCALATION_DELAY_RANGE", "escalateAfterSeconds must be between 0 and 7 days")
	}
	if req.EscalateAfterSeconds > 0 && len(req.EscalateChannelIDs) == 0 {
		return invalid("NOTIFY_ESCALATION_CHANNELS_REQUIRED", "an escalation delay requires escalateChannelIds")
	}
	return nil
}

// AsMapValidationError converts a validation error into its stable code.
func AsMapValidationError(err error) (string, string) {
	var ve *validationError
	if errors.As(err, &ve) {
		return ve.code, ve.message
	}
	return "NOTIFY_INVALID_REQUEST", err.Error()
}

// Revision conflict and not-found sentinels shared with the handler.
var (
	errRevisionConflict = fmt.Errorf("revision conflict")
	errNotFound         = fmt.Errorf("not found")
	errDuplicate        = fmt.Errorf("duplicate name")
)
