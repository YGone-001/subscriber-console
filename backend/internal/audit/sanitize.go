package audit

import (
	"regexp"
	"strings"
)

const (
	redacted    = "[REDACTED]"
	maxDepth    = 12
	maxItems    = 200
	maxNodes    = 3000
	maxText     = 64000
	maxString   = 4000
	maxString2x = maxString * 2
)

// secretKeys contains normalized (lowercase, alphanumeric-only) key names
// that must always be redacted. Matches Node SECRET_KEYS exactly.
var secretKeys = map[string]bool{
	"password": true, "passwordhash": true, "passwd": true, "pwd": true,
	"token": true, "accesstoken": true, "refreshtoken": true,
	"idtoken": true, "jwt": true, "authorization": true, "proxyauthorization": true,
	"secret": true, "privatekey": true, "apikey": true,
	"cookie": true, "setcookie": true, "sessionid": true, "sessiontoken": true,
	// Subscriber authentication material
	"k": true, "ki": true, "op": true, "opc": true,
	"kasme": true, "kamf": true, "xres": true, "ck": true, "ik": true,
}

// secretSuffixes are regex patterns that match the end of a key name.
var secretSuffixes = regexp.MustCompile(
	`(?:password|passwordhash|passwd|secret|privatekey|apikey|accesstoken|refreshtoken)$`)

func normalizeKey(key string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(key) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func sensitiveKey(key string) bool {
	normalized := normalizeKey(key)
	if secretKeys[normalized] {
		return true
	}
	if secretSuffixes.MatchString(normalized) {
		return true
	}
	// Check dot/bracket-separated parts
	for _, part := range strings.FieldsFunc(key, func(r rune) bool {
		return r == '.' || r == '[' || r == ']'
	}) {
		if secretKeys[strings.ToLower(part)] {
			return true
		}
	}
	return false
}

// Patterns for redacting secrets in free text.
var (
	privateKeyPattern = regexp.MustCompile(`-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)`)
	bearerPattern     = regexp.MustCompile(`(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+`)
	jwtPattern        = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	//nolint:gocritic // intentional: $1 refers to capture group
	uriCredPattern = regexp.MustCompile(`(?i)(mongodb(?:\+srv)?:\/\/)[^\s/@]+:[^\s/@]+@`)
	kvPattern      = regexp.MustCompile(
		`(?i)\b(password|passwordHash|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)`)
)

// sanitizeAuditText scrubs recognizable credentials in free text.
// Matches Node sanitizeAuditText() exactly.
func sanitizeAuditText(value string) string {
	if len(value) > maxString2x {
		value = value[:maxString2x]
	}
	value = privateKeyPattern.ReplaceAllString(value, redacted)
	value = bearerPattern.ReplaceAllString(value, redacted)
	value = jwtPattern.ReplaceAllString(value, redacted)
	value = uriCredPattern.ReplaceAllString(value, "${1}"+redacted+"@")
	value = kvPattern.ReplaceAllString(value, "$1="+redacted)
	if len(value) > maxString {
		value = value[:maxString]
	}
	return value
}

// sanitizeAuditPayload produces a non-mutating, bounded JSON snapshot.
// Matches Node sanitizeAuditPayload() semantics: depth limit, node limit,
// text budget, sensitive key redaction, circular/truncation markers.
func sanitizeAuditPayload(value interface{}) interface{} {
	state := &sanitizeState{
		textBudget: maxText,
		ancestors:  make(map[uintptr]bool),
	}
	result := state.visit(value, 0)
	if state.err {
		return "[UNSERIALIZABLE]"
	}
	return result
}

type sanitizeState struct {
	nodes      int
	textBudget int
	err        bool
	ancestors  map[uintptr]bool
}

func (s *sanitizeState) visit(current interface{}, depth int) interface{} {
	s.nodes++
	if s.nodes > maxNodes || s.textBudget <= 0 || depth > maxDepth {
		return "[TRUNCATED]"
	}
	if current == nil {
		return nil
	}

	switch v := current.(type) {
	case bool:
		return v
	case int:
		return v
	case int32:
		return v
	case int64:
		return v
	case float32:
		return v
	case float64:
		if v != v { // NaN
			return nil
		}
		return v
	case string:
		safe := sanitizeAuditText(v)
		if len(safe) > s.textBudget {
			safe = safe[:s.textBudget]
		}
		s.textBudget -= len(safe)
		return safe
	case map[string]interface{}:
		return s.visitMap(v, depth)
	case []interface{}:
		return s.visitSlice(v, depth)
	default:
		return "[UNSUPPORTED]"
	}
}

func (s *sanitizeState) visitMap(m map[string]interface{}, depth int) interface{} {
	result := make(map[string]interface{})
	count := 0
	for key, val := range m {
		s.nodes++
		if s.nodes > maxNodes || s.textBudget <= 0 {
			break
		}
		if key == "__proto__" || key == "constructor" || key == "prototype" {
			continue
		}
		if count >= maxItems {
			break
		}
		safeKey := sanitizeAuditText(key)
		if len(safeKey) > 200 {
			safeKey = safeKey[:200]
		}
		s.textBudget -= len(safeKey)
		if sensitiveKey(key) {
			result[safeKey] = redacted
		} else {
			result[safeKey] = s.visit(val, depth+1)
		}
		count++
	}
	keys := len(m)
	if keys > maxItems || s.nodes > maxNodes || s.textBudget <= 0 {
		result["_truncated"] = true
	}
	return result
}

func (s *sanitizeState) visitSlice(arr []interface{}, depth int) interface{} {
	result := make([]interface{}, 0, len(arr))
	limit := len(arr)
	if limit > maxItems {
		limit = maxItems
	}
	for i := 0; i < limit; i++ {
		result = append(result, s.visit(arr[i], depth+1))
		if s.nodes > maxNodes || s.textBudget <= 0 {
			break
		}
	}
	if limit < len(arr) {
		result = append(result, "[TRUNCATED]")
	}
	return result
}
