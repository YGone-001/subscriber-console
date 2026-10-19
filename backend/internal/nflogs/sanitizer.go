package nflogs

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

/*
 * The single output sanitizer.
 *
 * Log lines can carry subscriber and network identifiers. Every line - tailed
 * or followed - passes through SanitizeLine before it is serialized, so no
 * endpoint can bypass the policy by accident. The masks are deliberately
 * explicit rather than "remove anything that looks like a number": an operator
 * still needs to correlate the rest of the line.
 */

var (
	// ANSI colour/control sequences are removed entirely.
	ansiPattern = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
	// IMPI is an IMSI followed by a realm; mask the whole identity first.
	impiPattern = regexp.MustCompile(`\b\d{15}@[A-Za-z0-9.-]+\b`)
	// MSISDN: Chinese mobile numbers with an optional country code.
	msisdnPattern = regexp.MustCompile(`\+?86?1[3-9]\d{9}\b`)
	// IMSI: exactly 15 digits.
	imsiPattern = regexp.MustCompile(`\b\d{15}\b`)
	// IPv4: keep the network part, mask the host part.
	ipv4Pattern = regexp.MustCompile(`\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b`)
	// key=value / key: value pairs that look like credentials.
	credentialPattern = regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|authorization|api[_-]?key)(\s*[=:]\s*)(\S+)`)
	// Level tokens are matched in the head of a line only.
	levelHeadPattern = regexp.MustCompile(`(?i)^\s*\[?(fatal|critical|crit|error|err|warning|warn|notice|info|debug|trace)\]?\b`)
	// A level after one or two leading tokens (a timestamp, a component name).
	levelPrefixPattern = regexp.MustCompile(`(?i)^\s*\S+(?:\s+\S+)?\s+\[?(fatal|critical|crit|error|err|warning|warn|notice|info|debug|trace)\]?\b`)
	levelKVPattern     = regexp.MustCompile(`(?i)\blevel=("?)([a-z]+)("?)`)
)

const (
	maskedIMPI   = "[impi]"
	maskedMSISDN = "[msisdn]"
	maskedIMSI   = "[imsi]"
	maskedCred   = "${1}${2}[redacted]"
	truncatedTag = " ...[truncated]"
)

// SanitizeLine applies the full output policy to one line.
func SanitizeLine(line string) string {
	// ANSI sequences are removed before control stripping: stripping the ESC
	// byte first would leave the bare "[31m" fragment behind.
	cleaned := ansiPattern.ReplaceAllString(line, "")
	cleaned = stripControl(cleaned)
	cleaned = impiPattern.ReplaceAllString(cleaned, maskedIMPI)
	// The 15-digit identity is masked before the shorter mobile-number rule can
	// see a fragment of it.
	cleaned = imsiPattern.ReplaceAllString(cleaned, maskedIMSI)
	cleaned = msisdnPattern.ReplaceAllString(cleaned, maskedMSISDN)
	cleaned = ipv4Pattern.ReplaceAllString(cleaned, "${1}.*.*")
	cleaned = credentialPattern.ReplaceAllString(cleaned, maskedCred)
	return truncateBytes(cleaned, MaxLineBytes)
}

// stripControl removes control characters except the tab. Carriage returns and
// NUL bytes have no place in a rendered log line.
func stripControl(line string) string {
	if !strings.ContainsFunc(line, func(r rune) bool {
		return (r < 0x20 && r != '\t') || r == 0x7f
	}) {
		return line
	}
	var builder strings.Builder
	builder.Grow(len(line))
	for _, r := range line {
		if (r < 0x20 && r != '\t') || r == 0x7f {
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func truncateBytes(line string, max int) string {
	if len(line) <= max {
		return line
	}
	trimmed := line[:max]
	for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	return trimmed + truncatedTag
}

// DetectLevel reads the severity a line declares about itself. An unlabelled
// line is information, never an error: the filter must not invent severity.
func DetectLevel(line string) string {
	head := line
	if len(head) > 160 {
		head = head[:160]
	}
	if match := levelKVPattern.FindStringSubmatch(head); len(match) > 2 {
		return normalizeLevel(match[2])
	}
	if match := levelHeadPattern.FindStringSubmatch(head); len(match) > 1 {
		return normalizeLevel(match[1])
	}
	if match := levelPrefixPattern.FindStringSubmatch(head); len(match) > 1 {
		return normalizeLevel(match[1])
	}
	return LevelInfo
}

func normalizeLevel(token string) string {
	switch strings.ToLower(token) {
	case "fatal", "critical", "crit", "error", "err":
		return LevelError
	case "warning", "warn":
		return LevelWarn
	case "debug", "trace":
		return LevelDebug
	default:
		return LevelInfo
	}
}

func levelRank(level string) int {
	switch level {
	case LevelError:
		return 3
	case LevelWarn:
		return 2
	case LevelInfo:
		return 1
	case LevelDebug:
		return 0
	default:
		return -1
	}
}

// LevelAllowed reports whether a line at actual severity meets the requested
// minimum. An empty filter admits everything.
func LevelAllowed(minimum, actual string) bool {
	if minimum == "" {
		return true
	}
	actualRank := levelRank(actual)
	if actualRank < 0 {
		return false
	}
	return actualRank >= levelRank(minimum)
}

// MatchesKeyword applies the literal substring filter. Matching is
// case-insensitive and never compiled into a pattern.
func MatchesKeyword(keyword, line string) bool {
	if keyword == "" {
		return true
	}
	return strings.Contains(strings.ToLower(line), strings.ToLower(keyword))
}
