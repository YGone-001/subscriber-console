package audit

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	redacted       = "[REDACTED]"
	truncated      = "[TRUNCATED]"
	circular       = "[CIRCULAR]"
	binaryOmit     = "[BINARY OMITTED]"
	unsupported    = "[UNSUPPORTED]"
	unserializable = "[UNSERIALIZABLE]"
	maxDepth       = 12
	maxItems       = 200
	maxNodes       = 3000
	maxText        = 64000
	maxString      = 4000
	maxString2x    = maxString * 2
)

// secretKeys contains normalized (lowercase, alphanumeric-only) key names
// that must always be redacted. Matches Node SECRET_KEYS exactly.
var secretKeys = map[string]bool{
	"password": true, "passwordhash": true, "passwd": true, "pwd": true,
	"token": true, "accesstoken": true, "refreshtoken": true,
	"idtoken": true, "jwt": true, "authorization": true, "proxyauthorization": true,
	"secret": true, "privatekey": true, "apikey": true,
	"cookie": true, "setcookie": true, "sessionid": true, "sessiontoken": true,
	"credential": true, "credentials": true,
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
func sanitizeAuditPayload(value interface{}) (result interface{}) {
	// Panic-safe: any unexpected structure → [UNSERIALIZABLE]
	defer func() {
		if r := recover(); r != nil {
			result = unserializable
		}
	}()

	state := &sanitizeState{
		textBudget: maxText,
		ancestors:  make(map[uintptr]bool),
	}
	return state.visit(value, 0)
}

type sanitizeState struct {
	nodes      int
	textBudget int
	ancestors  map[uintptr]bool // path-scoped: add before descend, delete after return
}

func (s *sanitizeState) visit(current interface{}, depth int) interface{} {
	s.nodes++
	if s.nodes > maxNodes || s.textBudget <= 0 || depth > maxDepth {
		return truncated
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
		return sanitizeFloat64(float64(v))
	case float64:
		return sanitizeFloat64(v)
	case string:
		return s.visitString(v, depth)
	case time.Time:
		if v.IsZero() {
			return nil
		}
		return v.UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.DateTime:
		if v == 0 {
			return nil
		}
		return v.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	case []byte:
		return binaryOmit
	case bson.Binary:
		return binaryOmit
	case bson.M:
		return s.visitMap(map[string]interface{}(v), depth)
	case bson.D:
		// Convert bson.D to map for uniform processing
		m := make(map[string]interface{}, len(v))
		for _, elem := range v {
			m[elem.Key] = elem.Value
		}
		return s.visitMap(m, depth)
	case map[string]interface{}:
		return s.visitMap(v, depth)
	case []interface{}:
		return s.visitSlice(v, depth)
	default:
		// Use reflection for pointer wrappers, struct types, etc.
		return s.visitReflect(current, depth)
	}
}

func (s *sanitizeState) visitString(v string, depth int) interface{} {
	// JSON-looking strings: attempt recursive sanitization (Node behavior)
	if len(v) > 0 && (v[0] == '{' || v[0] == '[') {
		if len(v) > maxString {
			return truncated
		}
		var parsed interface{}
		if err := json.Unmarshal([]byte(v), &parsed); err == nil {
			// Valid JSON — sanitize recursively
			return s.visit(parsed, depth+1)
		}
		// Invalid JSON — treat as ordinary text below
	}

	safe := sanitizeAuditText(v)
	if len(safe) > s.textBudget {
		safe = safe[:s.textBudget]
	}
	s.textBudget -= len(safe)
	return safe
}

// sanitizeFloat64 handles NaN, +Inf, -Inf → null (Node behavior).
func sanitizeFloat64(v float64) interface{} {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return v
}

func (s *sanitizeState) visitMap(m map[string]interface{}, depth int) interface{} {
	// Track this map for circular detection
	ptr := mapPointer(m)
	if s.ancestors[ptr] {
		return circular
	}
	s.ancestors[ptr] = true
	defer delete(s.ancestors, ptr)

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
		result = append(result, truncated)
	}
	return result
}

// visitReflect handles pointer wrappers, structs, and other Go types via reflection.
func (s *sanitizeState) visitReflect(current interface{}, depth int) interface{} {
	rv := reflect.ValueOf(current)

	// Track pointers for circular detection
	if rv.Kind() == reflect.Ptr || rv.Kind() == reflect.Interface {
		if rv.IsNil() {
			return nil
		}
		ptr := rv.Pointer()
		if s.ancestors[ptr] {
			return circular
		}
		s.ancestors[ptr] = true
		defer delete(s.ancestors, ptr)
		return s.visit(rv.Elem().Interface(), depth+1)
	}

	switch rv.Kind() {
	case reflect.Map:
		// Track map for circular detection
		ptr := rv.Pointer()
		if s.ancestors[ptr] {
			return circular
		}
		s.ancestors[ptr] = true
		defer delete(s.ancestors, ptr)

		// Generic map[K]V — convert keys to string
		result := make(map[string]interface{})
		iter := rv.MapRange()
		count := 0
		for iter.Next() {
			s.nodes++
			if s.nodes > maxNodes || s.textBudget <= 0 || count >= maxItems {
				break
			}
			key := fmt.Sprintf("%v", iter.Key().Interface())
			safeKey := sanitizeAuditText(key)
			if len(safeKey) > 200 {
				safeKey = safeKey[:200]
			}
			s.textBudget -= len(safeKey)
			if sensitiveKey(key) {
				result[safeKey] = redacted
			} else {
				result[safeKey] = s.visit(iter.Value().Interface(), depth+1)
			}
			count++
		}
		if rv.Len() > maxItems || s.nodes > maxNodes || s.textBudget <= 0 {
			result["_truncated"] = true
		}
		return result
	case reflect.Slice, reflect.Array:
		if rv.IsNil() {
			return nil
		}
		// Track slice pointer for circular detection
		if rv.Kind() == reflect.Slice && !rv.IsNil() {
			ptr := rv.Pointer()
			if s.ancestors[ptr] {
				return circular
			}
			s.ancestors[ptr] = true
			defer delete(s.ancestors, ptr)
		}
		result := make([]interface{}, 0, rv.Len())
		limit := rv.Len()
		if limit > maxItems {
			limit = maxItems
		}
		for i := 0; i < limit; i++ {
			result = append(result, s.visit(rv.Index(i).Interface(), depth+1))
			if s.nodes > maxNodes || s.textBudget <= 0 {
				break
			}
		}
		if limit < rv.Len() {
			result = append(result, truncated)
		}
		return result
	case reflect.Struct:
		return s.visitStruct(rv, depth)
	default:
		return unsupported
	}
}

// visitStruct handles Go structs via reflection, respecting json tags.
func (s *sanitizeState) visitStruct(rv reflect.Value, depth int) interface{} {
	rt := rv.Type()
	result := make(map[string]interface{})
	count := 0

	for i := 0; i < rt.NumField(); i++ {
		s.nodes++
		if s.nodes > maxNodes || s.textBudget <= 0 || count >= maxItems {
			break
		}

		field := rt.Field(i)
		fieldVal := rv.Field(i)

		// Skip unexported fields
		if !field.IsExported() {
			continue
		}

		// Get json tag
		jsonTag := field.Tag.Get("json")
		if jsonTag == "-" {
			continue
		}

		// Parse json tag for field name
		key := field.Name
		if jsonTag != "" {
			parts := strings.Split(jsonTag, ",")
			if parts[0] != "" {
				key = parts[0]
			}
		}

		// Check for omitempty (skip zero values)
		if strings.Contains(jsonTag, "omitempty") && fieldVal.IsZero() {
			continue
		}

		safeKey := sanitizeAuditText(key)
		if len(safeKey) > 200 {
			safeKey = safeKey[:200]
		}
		s.textBudget -= len(safeKey)

		// Check if field name is sensitive
		if sensitiveKey(key) {
			result[safeKey] = redacted
		} else {
			result[safeKey] = s.visit(fieldVal.Interface(), depth+1)
		}
		count++
	}

	if rt.NumField() > maxItems || s.nodes > maxNodes || s.textBudget <= 0 {
		result["_truncated"] = true
	}
	return result
}

// mapPointer returns a stable pointer identity for a map.
// Go maps don't have a stable address, so we use reflect.
func mapPointer(m map[string]interface{}) uintptr {
	return reflect.ValueOf(m).Pointer()
}

// SanitizePayload is a narrow exported wrapper for use by other packages
// (e.g., approval) that need audit-safe payload representation.
// Applies the same sanitization rules as the internal audit writer.
func SanitizePayload(value interface{}) interface{} {
	return sanitizeAuditPayload(value)
}

// SanitizeText is a narrow exported wrapper for text sanitization.
func SanitizeText(value string) string {
	return sanitizeAuditText(value)
}
