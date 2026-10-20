package ueinfo

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// Sources is the server-owned allowlist of UE data endpoints.
type Sources struct {
	MME string
	AMF string
	SMF string
}

// ParseSources parses UE_INFO_SOURCES=mme=host:port,amf=host:port,smf=host:port.
// Unknown roles, duplicate roles, schemes, paths and malformed ports are rejected.
func ParseSources(raw string) (Sources, error) {
	var sources Sources
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return sources, nil
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return Sources{}, fmt.Errorf("ue-info: empty source entry")
		}
		role, value, ok := strings.Cut(part, "=")
		if !ok {
			return Sources{}, fmt.Errorf("ue-info: source entry must be role=host:port")
		}
		role = strings.ToLower(strings.TrimSpace(role))
		value = strings.TrimSpace(value)
		if seen[role] {
			return Sources{}, fmt.Errorf("ue-info: duplicate source role %q", role)
		}
		if err := validateHostPort(value); err != nil {
			return Sources{}, fmt.Errorf("ue-info: %s source: %w", role, err)
		}
		switch role {
		case "mme":
			sources.MME = value
		case "amf":
			sources.AMF = value
		case "smf":
			sources.SMF = value
		default:
			return Sources{}, fmt.Errorf("ue-info: unsupported source role %q", role)
		}
		seen[role] = true
	}
	return sources, nil
}

func validateHostPort(value string) error {
	if value == "" {
		return fmt.Errorf("empty host:port")
	}
	if strings.ContainsAny(value, "/?#@") || strings.Contains(value, "://") {
		return fmt.Errorf("only host:port is accepted")
	}
	host, portText, err := net.SplitHostPort(value)
	if err != nil || strings.TrimSpace(host) == "" {
		return fmt.Errorf("invalid host:port")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("invalid port")
	}
	return nil
}

// Configured reports whether at least one UE source is present.
func (s Sources) Configured() bool {
	return s.MME != "" || s.AMF != "" || s.SMF != ""
}
