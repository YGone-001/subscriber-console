package subscriber

import (
	"encoding/json"
	"os"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// loadFixture loads a JSON fixture file from testdata/.
func loadFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("load fixture %s: %v", name, err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
	return result
}

// normalizeForComparison removes nondeterministic fields and normalizes types
// for comparison between Node JSON and Go bson.M.
// Normalizes: ObjectID (remove concrete _id), mme_timestamp (remove wall-clock),
// Long JSON representation vs Go int64.
func normalizeForComparison(t *testing.T, doc map[string]any, isSlice bool) map[string]any {
	t.Helper()
	result := make(map[string]any)
	for k, v := range doc {
		// Skip nondeterministic fields
		if k == "_id" || k == "mme_timestamp" || k == "created_at" || k == "updated_at" {
			continue
		}
		result[k] = normalizeValue(t, v)
	}
	return result
}

func normalizeValue(t *testing.T, v any) any {
	t.Helper()
	switch val := v.(type) {
	case map[string]any:
		return normalizeForComparison(t, val, false)
	case []any:
		result := make([]any, len(val))
		for i, item := range val {
			result[i] = normalizeValue(t, item)
		}
		return result
	case float64:
		// JSON numbers are float64; convert to int64 if whole number
		if val == float64(int64(val)) {
			return int64(val)
		}
		return val
	case json.Number:
		if i, err := val.Int64(); err == nil {
			return i
		}
		if f, err := val.Float64(); err == nil {
			return f
		}
		return val.String()
	default:
		return val
	}
}

// bsonToMap converts a bson.M to a plain map for comparison,
// handling bson.D → map conversion and bson.A → []any conversion.
func bsonToMap(t *testing.T, doc bson.M) map[string]any {
	t.Helper()
	result := make(map[string]any)
	for k, v := range doc {
		result[k] = bsonValueToAny(t, v)
	}
	return result
}

func bsonValueToAny(t *testing.T, v any) any {
	t.Helper()
	switch val := v.(type) {
	case bson.M:
		return bsonToMap(t, val)
	case bson.D:
		m := bson.M{}
		for _, elem := range val {
			m[elem.Key] = elem.Value
		}
		return bsonToMap(t, m)
	case bson.A:
		result := make([]any, len(val))
		for i, item := range val {
			result[i] = bsonValueToAny(t, item)
		}
		return result
	case []any:
		result := make([]any, len(val))
		for i, item := range val {
			result[i] = bsonValueToAny(t, item)
		}
		return result
	case int32:
		return int64(val)
	case int64:
		return val
	case int:
		return int64(val)
	default:
		return val
	}
}

// TestFixtureDefaultSubscriber verifies that Go buildDefaultSubscriber()
// matches the Node production fixture exactly (after normalization).
func TestFixtureDefaultSubscriber(t *testing.T) {
	fixture := loadFixture(t, "fixture_node_default_subscriber.json")
	goDoc := buildDefaultSubscriber("417001234567890", nil)

	// Normalize both sides
	expected := normalizeForComparison(t, fixture, false)
	actual := bsonToMap(t, goDoc)
	actual = normalizeForComparison(t, actual, false)

	// Compare key by key
	compareMaps(t, expected, actual, "")
}

// TestFixtureLegacyUpdate verifies that Go buildXcloudSubscriberFromLegacy()
// matches the Node production fixture exactly (after normalization).
func TestFixtureLegacyUpdate(t *testing.T) {
	fixture := loadFixture(t, "fixture_node_legacy_update.json")

	inputRaw, ok := fixture["input"]
	if !ok {
		t.Fatal("fixture missing 'input'")
	}
	expectedRaw, ok := fixture["expected"]
	if !ok {
		t.Fatal("fixture missing 'expected'")
	}

	inputData, err := json.Marshal(inputRaw)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	var input struct {
		Sub4G map[string]any `json:"sub4G"`
	}
	if err := json.Unmarshal(inputData, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}

	// Build existing (base) document
	existing := deepCopyBsonM(buildDefaultSubscriber("417001234567890", nil))

	// Build payload
	payload := UpdatePayload{
		Sub4G: input.Sub4G,
	}

	// Build next
	next := buildXcloudSubscriberFromLegacy("417001234567890", payload, existing)

	// Normalize both sides
	expectedMap, ok := expectedRaw.(map[string]any)
	if !ok {
		t.Fatalf("expected type = %T, want map", expectedRaw)
	}
	expected := normalizeForComparison(t, expectedMap, false)
	actual := bsonToMap(t, next)
	actual = normalizeForComparison(t, actual, false)

	compareMaps(t, expected, actual, "")
}

// compareMaps recursively compares two maps, reporting differences.
func compareMaps(t *testing.T, expected, actual map[string]any, path string) {
	t.Helper()
	for key, expectedVal := range expected {
		fullPath := path + "." + key
		if path == "" {
			fullPath = key
		}
		actualVal, ok := actual[key]
		if !ok {
			t.Errorf("missing key %q in actual", fullPath)
			continue
		}
		compareValues(t, expectedVal, actualVal, fullPath)
	}
	for key := range actual {
		fullPath := path + "." + key
		if path == "" {
			fullPath = key
		}
		if _, ok := expected[key]; !ok {
			t.Errorf("unexpected key %q in actual", fullPath)
		}
	}
}

func compareValues(t *testing.T, expected, actual any, path string) {
	t.Helper()
	switch exp := expected.(type) {
	case map[string]any:
		actMap, ok := actual.(map[string]any)
		if !ok {
			t.Errorf("%s: type mismatch: expected map, got %T", path, actual)
			return
		}
		compareMaps(t, exp, actMap, path)
	case []any:
		actSlice, ok := actual.([]any)
		if !ok {
			t.Errorf("%s: type mismatch: expected slice, got %T", path, actual)
			return
		}
		if len(exp) != len(actSlice) {
			t.Errorf("%s: length mismatch: expected %d, got %d", path, len(exp), len(actSlice))
			return
		}
		for i := range exp {
			compareValues(t, exp[i], actSlice[i], path+"["+jsonNumber(i)+"]")
		}
	case int64:
		switch act := actual.(type) {
		case int64:
			if exp != act {
				t.Errorf("%s: expected %d, got %d", path, exp, act)
			}
		case float64:
			if exp != int64(act) {
				t.Errorf("%s: expected %d, got %f", path, exp, act)
			}
		default:
			t.Errorf("%s: type mismatch: expected int64, got %T (%v)", path, actual, actual)
		}
	case float64:
		switch act := actual.(type) {
		case int64:
			if int64(exp) != act {
				t.Errorf("%s: expected %f, got %d", path, exp, act)
			}
		case float64:
			if exp != act {
				t.Errorf("%s: expected %f, got %f", path, exp, act)
			}
		default:
			t.Errorf("%s: type mismatch: expected float64, got %T (%v)", path, actual, actual)
		}
	case string:
		if actual.(string) != exp {
			t.Errorf("%s: expected %q, got %q", path, exp, actual)
		}
	case bool:
		if actual.(bool) != exp {
			t.Errorf("%s: expected %v, got %v", path, exp, actual)
		}
	case nil:
		if actual != nil {
			t.Errorf("%s: expected nil, got %v", path, actual)
		}
	default:
		t.Errorf("%s: unsupported comparison type %T", path, expected)
	}
}

func jsonNumber(n int) string {
	return string(rune('0' + n))
}
