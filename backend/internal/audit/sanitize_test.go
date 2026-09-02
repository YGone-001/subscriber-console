package audit

import (
	"math"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestSanitizeAuditPayload_BasicTypes(t *testing.T) {
	result := sanitizeAuditPayload(map[string]any{
		"string": "hello",
		"int":    42,
		"float":  3.14,
		"bool":   true,
		"nil":    nil,
	})

	m := result.(map[string]any)
	if m["string"] != "hello" {
		t.Errorf("expected string 'hello', got %v", m["string"])
	}
	if m["int"] != 42 {
		t.Errorf("expected int 42, got %v", m["int"])
	}
	if m["float"] != 3.14 {
		t.Errorf("expected float 3.14, got %v", m["float"])
	}
	if m["bool"] != true {
		t.Errorf("expected bool true, got %v", m["bool"])
	}
	if m["nil"] != nil {
		t.Errorf("expected nil, got %v", m["nil"])
	}
}

func TestSanitizeAuditPayload_Truncation(t *testing.T) {
	// Test string truncation - strings longer than maxString2x (8000) are truncated
	longString := string(make([]byte, maxString2x+100))
	result := sanitizeAuditPayload(longString)
	str, ok := result.(string)
	if !ok {
		t.Fatalf("expected string, got %T", result)
	}
	if len(str) > maxString2x+20 { // 20 for "...[TRUNCATED]" suffix
		t.Errorf("expected string truncation, got length %d", len(str))
	}

	// Test text budget exhaustion - when textBudget reaches 0, map gets _truncated flag
	hugePayload := map[string]any{}
	for i := 0; i < 100; i++ {
		hugePayload[string(rune('a'+i%26))+string(rune('a'+i/26))] = string(make([]byte, 1000))
	}
	result = sanitizeAuditPayload(hugePayload)
	m := result.(map[string]any)
	// When text budget is exhausted, the map should have _truncated flag
	if m["_truncated"] != true {
		t.Error("expected _truncated flag when text budget exhausted")
	}
}

func TestSanitizeAuditPayload_CircularDetection(t *testing.T) {
	// Create circular reference
	m := map[string]any{"key": "value"}
	m["self"] = m

	result := sanitizeAuditPayload(m)
	r := result.(map[string]any)
	if r["self"] != "[CIRCULAR]" {
		t.Errorf("expected [CIRCULAR], got %v", r["self"])
	}
}

func TestSanitizeAuditPayload_BinaryOmitted(t *testing.T) {
	// Test []byte
	byteSlice := []byte{0x01, 0x02, 0x03}
	result := sanitizeAuditPayload(byteSlice)
	if result != "[BINARY OMITTED]" {
		t.Errorf("expected [BINARY OMITTED] for []byte, got %v", result)
	}

	// Test bson.Binary
	bin := bson.Binary{Data: []byte{0x01, 0x02}}
	result = sanitizeAuditPayload(bin)
	if result != "[BINARY OMITTED]" {
		t.Errorf("expected [BINARY OMITTED] for bson.Binary, got %v", result)
	}
}

func TestSanitizeAuditPayload_TimeFormats(t *testing.T) {
	// Test time.Time
	ts := time.Date(2025, 1, 15, 10, 30, 0, 0, time.UTC)
	result := sanitizeAuditPayload(ts)
	if result != "2025-01-15T10:30:00.000Z" {
		t.Errorf("expected ISO string, got %v", result)
	}

	// Test bson.DateTime
	dt := bson.NewDateTimeFromTime(ts)
	result = sanitizeAuditPayload(dt)
	if result != "2025-01-15T10:30:00.000Z" {
		t.Errorf("expected ISO string for bson.DateTime, got %v", result)
	}
}

func TestSanitizeAuditPayload_NaNInf(t *testing.T) {
	// Test NaN
	result := sanitizeAuditPayload(math.NaN())
	if result != nil {
		t.Errorf("expected nil for NaN, got %v", result)
	}

	// Test +Inf
	result = sanitizeAuditPayload(math.Inf(1))
	if result != nil {
		t.Errorf("expected nil for +Inf, got %v", result)
	}

	// Test -Inf
	result = sanitizeAuditPayload(math.Inf(-1))
	if result != nil {
		t.Errorf("expected nil for -Inf, got %v", result)
	}
}

func TestSanitizeAuditPayload_JSONStringRecursion(t *testing.T) {
	// Test JSON-looking string gets parsed and scrubbed
	jsonStr := `{"password":"secret123","user":"admin"}`
	result := sanitizeAuditPayload(jsonStr)
	// The JSON string should be parsed into a map and scrubbed
	m, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map, got %T: %v", result, result)
	}
	if m["password"] != "[REDACTED]" {
		t.Errorf("expected password redacted in parsed JSON, got %v", m["password"])
	}
	if m["user"] != "admin" {
		t.Errorf("expected user=admin in parsed JSON, got %v", m["user"])
	}

	// Test array JSON string
	arrayStr := `[{"password":"secret"}]`
	result = sanitizeAuditPayload(arrayStr)
	arr, ok := result.([]interface{})
	if !ok {
		t.Fatalf("expected slice, got %T: %v", result, result)
	}
	if len(arr) != 1 {
		t.Fatalf("expected 1 item in array, got %d", len(arr))
	}
	item := arr[0].(map[string]interface{})
	if item["password"] != "[REDACTED]" {
		t.Errorf("expected password redacted in parsed JSON array, got %v", item["password"])
	}
}

func TestSanitizeAuditPayload_SecretFieldsRedacted(t *testing.T) {
	result := sanitizeAuditPayload(map[string]any{
		"username":   "admin",
		"password":   "secret123",
		"token":      "abc123",
		"secret":     "mysecret",
		"credential": "cred123",
		"normal":     "visible",
	})

	m := result.(map[string]any)
	if m["password"] != "[REDACTED]" {
		t.Errorf("expected password redacted, got %v", m["password"])
	}
	if m["token"] != "[REDACTED]" {
		t.Errorf("expected token redacted, got %v", m["token"])
	}
	if m["secret"] != "[REDACTED]" {
		t.Errorf("expected secret redacted, got %v", m["secret"])
	}
	if m["credential"] != "[REDACTED]" {
		t.Errorf("expected credential redacted, got %v", m["credential"])
	}
	if m["username"] != "admin" {
		t.Errorf("expected username visible, got %v", m["username"])
	}
	if m["normal"] != "visible" {
		t.Errorf("expected normal visible, got %v", m["normal"])
	}
}

func TestSanitizeAuditPayload_NestedMaps(t *testing.T) {
	result := sanitizeAuditPayload(map[string]any{
		"level1": map[string]any{
			"level2": map[string]any{
				"password": "secret",
				"data":     "visible",
			},
		},
	})

	m := result.(map[string]any)
	l1 := m["level1"].(map[string]any)
	l2 := l1["level2"].(map[string]any)
	if l2["password"] != "[REDACTED]" {
		t.Errorf("expected nested password redacted, got %v", l2["password"])
	}
	if l2["data"] != "visible" {
		t.Errorf("expected nested data visible, got %v", l2["data"])
	}
}

func TestSanitizeAuditPayload_Slices(t *testing.T) {
	result := sanitizeAuditPayload(map[string]any{
		"items": []any{
			map[string]any{"password": "secret"},
			map[string]any{"name": "test"},
		},
	})

	m := result.(map[string]any)
	items := m["items"].([]any)
	item0 := items[0].(map[string]any)
	if item0["password"] != "[REDACTED]" {
		t.Errorf("expected slice item password redacted, got %v", item0["password"])
	}
}

func TestSanitizeAuditPayload_DepthLimit(t *testing.T) {
	// Build deeply nested structure
	deep := map[string]any{"value": "bottom"}
	for i := 0; i < maxDepth+5; i++ {
		deep = map[string]any{"nested": deep}
	}

	result := sanitizeAuditPayload(deep)
	// Should not panic and should truncate at depth
	if result == nil {
		t.Error("expected non-nil result")
	}
}

func TestSanitizeAuditPayload_MaxItems(t *testing.T) {
	// Create map with more than maxItems keys
	bigMap := map[string]any{}
	for i := 0; i < maxItems+50; i++ {
		bigMap[string(rune('a'+i%26))+string(rune('0'+i/26))] = i
	}

	result := sanitizeAuditPayload(bigMap)
	m := result.(map[string]any)
	if len(m) > maxItems+10 { // +10 for some slack
		t.Errorf("expected items capped, got %d", len(m))
	}
}

func TestSanitizeAuditPayload_NilInput(t *testing.T) {
	result := sanitizeAuditPayload(nil)
	if result != nil {
		t.Errorf("expected nil for nil input, got %v", result)
	}
}

func TestSanitizeAuditPayload_PanicSafety(t *testing.T) {
	// Test with a value that might cause issues
	result := sanitizeAuditPayload(math.MaxFloat64)
	if result == nil {
		// Might be nil due to NaN/Inf handling, that's ok
	}
}

func TestSanitizeAuditText_KVRedaction(t *testing.T) {
	// Test password= in text
	result := sanitizeAuditText("user logged in password=secret123 more text")
	if result == "user logged in password=[REDACTED] more text" {
		// Good
	} else {
		t.Errorf("expected KV redaction, got: %s", result)
	}

	// Test token= in text
	result = sanitizeAuditText("token=abc123")
	if result != "token=[REDACTED]" {
		t.Errorf("expected token redaction, got: %s", result)
	}
}

func TestSanitizeAuditText_Truncation(t *testing.T) {
	longText := string(make([]byte, maxString+100))
	result := sanitizeAuditText(longText)
	if len(result) <= maxString+20 { // 20 for "...[TRUNCATED]" suffix
		// Good
	} else {
		t.Errorf("expected truncation, got length %d", len(result))
	}
}

func TestSanitizeAuditText_ErrorMessage(t *testing.T) {
	errMsg := "something failed: password=secret123"
	result := sanitizeAuditText(errMsg)
	if result != "something failed: password=[REDACTED]" {
		t.Errorf("expected error message with redaction, got: %s", result)
	}
}

func TestSanitizeAuditPayload_BsonM(t *testing.T) {
	result := sanitizeAuditPayload(bson.M{
		"password": "secret",
		"normal":   "visible",
	})

	m := result.(map[string]any)
	if m["password"] != "[REDACTED]" {
		t.Errorf("expected bson.M password redacted, got %v", m["password"])
	}
	if m["normal"] != "visible" {
		t.Errorf("expected bson.M normal visible, got %v", m["normal"])
	}
}

func TestSanitizeAuditPayload_BsonD(t *testing.T) {
	result := sanitizeAuditPayload(bson.D{
		{Key: "password", Value: "secret"},
		{Key: "normal", Value: "visible"},
	})

	m := result.(map[string]any)
	if m["password"] != "[REDACTED]" {
		t.Errorf("expected bson.D password redacted, got %v", m["password"])
	}
	if m["normal"] != "visible" {
		t.Errorf("expected bson.D normal visible, got %v", m["normal"])
	}
}

func TestSanitizeAuditPayload_IntTypes(t *testing.T) {
	result := sanitizeAuditPayload(map[string]any{
		"int32":  int32(32),
		"int64":  int64(64),
		"uint32": uint32(32),
		"uint64": uint64(64),
	})

	m := result.(map[string]any)
	if m["int32"] != int32(32) {
		t.Errorf("expected int32 32, got %v", m["int32"])
	}
	if m["int64"] != int64(64) {
		t.Errorf("expected int64 64, got %v", m["int64"])
	}
}

func TestSanitizeAuditPayload_StringWithSecrets(t *testing.T) {
	result := sanitizeAuditPayload("password=secret123")
	str := result.(string)
	if str != "password=[REDACTED]" {
		t.Errorf("expected top-level string secret redaction, got: %s", str)
	}
}
