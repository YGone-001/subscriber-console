package subscriber

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// TestBuildDefaultSubscriber_FixtureParity verifies that buildDefaultSubscriber()
// produces a document matching Node buildDefaultXcloudSubscriber() exactly.
// Focus: ARP priorities, PCC GBR/MBR, slice structure.
func TestBuildDefaultSubscriber_FixtureParity(t *testing.T) {
	doc := buildDefaultSubscriber("417001234567890", nil)

	// Top-level scalar fields
	assertInt(t, doc, "__v", 0)
	assertInt(t, doc, "schema_version", 1)
	assertStr(t, doc, "imsi", "417001234567890")
	assertStr(t, doc, "imeisv", "8672710677532401")
	assertInt(t, doc, "access_restriction_data", 32)
	assertInt(t, doc, "subscriber_status", 0)
	assertInt(t, doc, "network_access_mode", 0)
	assertInt(t, doc, "subscribed_rau_tau_timer", 12)
	assertBool(t, doc, "purge_flag", false)

	// Security
	sec := bsonMap(t, doc, "security")
	assertStr(t, sec, "k", "000102030405060708090A0B0C0D0E0F")
	assertStr(t, sec, "opc", "00000000000000000000000000000000")
	assertStr(t, sec, "amf", "8000")

	// AMBR
	ambr := bsonMap(t, doc, "ambr")
	dl := bsonMap(t, ambr, "downlink")
	assertInt(t, dl, "value", 1)
	assertInt(t, dl, "unit", 3)

	// Slice structure
	slices := bsonSlice(t, doc, "slice")
	if len(slices) != 1 {
		t.Fatalf("slice len = %d, want 1", len(slices))
	}
	slice := bsonMap(t, slices, 0)
	assertInt(t, slice, "sst", 1)
	assertBool(t, slice, "default_indicator", true)

	sessions := bsonSlice(t, slice, "session")
	if len(sessions) != 3 {
		t.Fatalf("session len = %d, want 3", len(sessions))
	}

	// Session 0: internet — ARP priority 9
	internet := bsonMap(t, sessions, 0)
	assertStr(t, internet, "name", "internet")
	assertInt(t, internet, "type", 1)
	internetQos := bsonMap(t, internet, "qos")
	internetArp := bsonMap(t, internetQos, "arp")
	assertInt(t, internetArp, "priority_level", 9)
	assertInt(t, internetArp, "pre_emption_capability", 1)
	assertInt(t, internetArp, "pre_emption_vulnerability", 1)

	// internet pcc_rule empty
	internetPcc := bsonSlice(t, internet, "pcc_rule")
	if len(internetPcc) != 0 {
		t.Errorf("internet pcc_rule len = %d, want 0", len(internetPcc))
	}

	// Session 1: mobile — ARP priority 9
	mobile := bsonMap(t, sessions, 1)
	assertStr(t, mobile, "name", "mobile")
	mobileQos := bsonMap(t, mobile, "qos")
	mobileArp := bsonMap(t, mobileQos, "arp")
	assertInt(t, mobileArp, "priority_level", 9)

	// Session 2: ims — ARP priority 1, QCI 5, with PCC rule
	ims := bsonMap(t, sessions, 2)
	assertStr(t, ims, "name", "ims")
	assertInt(t, ims, "type", 3)
	imsQos := bsonMap(t, ims, "qos")
	assertInt(t, imsQos, "index", 5)
	imsArp := bsonMap(t, imsQos, "arp")
	assertInt(t, imsArp, "priority_level", 1)

	// PCC rule: must have GBR and MBR
	pccRules := bsonSlice(t, ims, "pcc_rule")
	if len(pccRules) != 1 {
		t.Fatalf("pcc_rule len = %d, want 1", len(pccRules))
	}
	pcc := bsonMap(t, pccRules, 0)
	pccQos := bsonMap(t, pcc, "qos")
	assertInt(t, pccQos, "index", 1)

	// PCC ARP — pre_emption=2 matches Node PREEMPT/PREEMPTABLE
	pccArp := bsonMap(t, pccQos, "arp")
	assertInt(t, pccArp, "priority_level", 2)
	assertInt(t, pccArp, "pre_emption_capability", 2)
	assertInt(t, pccArp, "pre_emption_vulnerability", 2)

	// PCC GBR
	gbr := bsonMap(t, pccQos, "gbr")
	assertAmbrValues(t, gbr, "downlink", 128, 1)
	assertAmbrValues(t, gbr, "uplink", 128, 1)

	// PCC MBR
	mbr := bsonMap(t, pccQos, "mbr")
	assertAmbrValues(t, mbr, "downlink", 128, 1)
	assertAmbrValues(t, mbr, "uplink", 128, 1)
}

// TestBuildXcloudSubscriberFromLegacy_MsisdnPreserved verifies that when Sub4G
// is provided without msisdnList, the existing msisdn is preserved.
func TestBuildXcloudSubscriberFromLegacy_MsisdnPreserved(t *testing.T) {
	existing := deepCopyBsonM(buildDefaultSubscriber("417001234567890", []any{"1234567890"}))
	payload := UpdatePayload{
		Sub4G: map[string]any{
			"access_restriction_data": 0,
		},
	}
	next := buildXcloudSubscriberFromLegacy("417001234567890", payload, existing)

	msisdn := next["msisdn"]
	if msisdn == nil {
		t.Fatal("msisdn missing")
	}
	arr := toSlice(msisdn)
	if len(arr) != 1 || fmtStr(arr[0]) != "1234567890" {
		t.Errorf("msisdn = %v, want [1234567890]", arr)
	}
}

// TestBuildXcloudSubscriberFromLegacy_MsisdnUpdated verifies that when Sub4G
// provides msisdnList, it replaces the existing msisdn.
func TestBuildXcloudSubscriberFromLegacy_MsisdnUpdated(t *testing.T) {
	existing := deepCopyBsonM(buildDefaultSubscriber("417001234567890", []any{"1234567890"}))
	payload := UpdatePayload{
		Sub4G: map[string]any{
			"msisdnList": []any{
				map[string]any{"msisdn": "9876543210"},
			},
		},
	}
	next := buildXcloudSubscriberFromLegacy("417001234567890", payload, existing)

	msisdn := next["msisdn"]
	if msisdn == nil {
		t.Fatal("msisdn missing")
	}
	arr := toSlice(msisdn)
	if len(arr) != 1 || fmtStr(arr[0]) != "9876543210" {
		t.Errorf("msisdn = %v, want [9876543210]", arr)
	}
}

// TestExtractPrimaryMsisdn verifies extractPrimaryMsisdn matches Node getPrimaryMsisdn.
func TestExtractPrimaryMsisdn(t *testing.T) {
	tests := []struct {
		name  string
		sub4G map[string]any
		want  string
	}{
		{"nil", nil, ""},
		{"empty", map[string]any{}, ""},
		{"no msisdnList", map[string]any{"foo": "bar"}, ""},
		{"empty list", map[string]any{"msisdnList": []any{}}, ""},
		{"first has no msisdn", map[string]any{"msisdnList": []any{map[string]any{}}}, ""},
		{"first msisdn nil", map[string]any{"msisdnList": []any{map[string]any{"msisdn": nil}}}, ""},
		{"valid", map[string]any{"msisdnList": []any{map[string]any{"msisdn": "12345"}}}, "12345"},
		{"first of many", map[string]any{"msisdnList": []any{map[string]any{"msisdn": "111"}, map[string]any{"msisdn": "222"}}}, "111"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractPrimaryMsisdn(tt.sub4G)
			if got != tt.want {
				t.Errorf("extractPrimaryMsisdn(%v) = %q, want %q", tt.sub4G, got, tt.want)
			}
		})
	}
}

// --- test helpers ---

// bsonMap extracts a bson.M from a document by key, or from a slice by index.
func bsonMap(t *testing.T, parent any, key any) bson.M {
	t.Helper()
	var v any
	switch p := parent.(type) {
	case bson.M:
		var ok bool
		v, ok = p[key.(string)]
		if !ok {
			t.Fatalf("missing key %q", key)
		}
	case bson.A:
		idx := key.(int)
		if idx >= len(p) {
			t.Fatalf("index %d out of range (len=%d)", idx, len(p))
		}
		v = p[idx]
	case []any:
		idx := key.(int)
		if idx >= len(p) {
			t.Fatalf("index %d out of range (len=%d)", idx, len(p))
		}
		v = p[idx]
	default:
		t.Fatalf("unsupported parent type %T", parent)
	}
	switch m := v.(type) {
	case bson.M:
		return m
	case map[string]any:
		return bson.M(m)
	default:
		t.Fatalf("key %v: type %T, want bson.M or map[string]any", key, v)
		return nil
	}
}

// bsonSlice extracts a slice from a document by key.
func bsonSlice(t *testing.T, parent any, key any) bson.A {
	t.Helper()
	var v any
	switch p := parent.(type) {
	case bson.M:
		var ok bool
		v, ok = p[key.(string)]
		if !ok {
			t.Fatalf("missing key %q", key)
		}
	default:
		t.Fatalf("unsupported parent type %T for bsonSlice", parent)
	}
	return toSlice(v)
}

func toSlice(v any) bson.A {
	switch a := v.(type) {
	case bson.A:
		return a
	case []any:
		return bson.A(a)
	default:
		return nil
	}
}

func fmtStr(v any) string {
	switch s := v.(type) {
	case string:
		return s
	default:
		return ""
	}
}

func assertStr(t *testing.T, doc bson.M, key, expected string) {
	t.Helper()
	v, ok := doc[key]
	if !ok {
		t.Errorf("missing field %q", key)
		return
	}
	if v != expected {
		t.Errorf("field %q = %v (%T), want %q", key, v, v, expected)
	}
}

func assertInt(t *testing.T, doc bson.M, key string, expected int) {
	t.Helper()
	v, ok := doc[key]
	if !ok {
		t.Errorf("missing field %q", key)
		return
	}
	switch n := v.(type) {
	case int:
		if n != expected {
			t.Errorf("field %q = %d, want %d", key, n, expected)
		}
	case int32:
		if int(n) != expected {
			t.Errorf("field %q = %d, want %d", key, n, expected)
		}
	case int64:
		if int(n) != expected {
			t.Errorf("field %q = %d, want %d", key, n, expected)
		}
	default:
		t.Errorf("field %q type = %T, want int", key, v)
	}
}

func assertBool(t *testing.T, doc bson.M, key string, expected bool) {
	t.Helper()
	v, ok := doc[key]
	if !ok {
		t.Errorf("missing field %q", key)
		return
	}
	if v != expected {
		t.Errorf("field %q = %v, want %v", key, v, expected)
	}
}

func assertAmbrValues(t *testing.T, doc bson.M, key string, value, unit int) {
	t.Helper()
	ambr := bsonMap(t, doc, key)
	assertInt(t, ambr, "value", value)
	assertInt(t, ambr, "unit", unit)
}
