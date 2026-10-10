package nfhealth

import (
	"encoding/json"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestBSONTimeRoundTripsAsDate(t *testing.T) {
	want := time.Date(2026, 10, 10, 12, 30, 45, 123000000, time.UTC)
	v := NewBSONTime(want)

	raw, err := bson.Marshal(bson.M{"expiresAt": v})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var rawDoc bson.Raw
	if err := bson.Unmarshal(raw, &rawDoc); err != nil {
		t.Fatalf("raw unmarshal: %v", err)
	}
	rawVal, err := rawDoc.LookupErr("expiresAt")
	if err != nil {
		t.Fatalf("expiresAt missing: %v", err)
	}
	if rawVal.Type != bson.TypeDateTime {
		t.Fatalf("expected BSON Date (TypeDateTime), got %v", rawVal.Type)
	}

	var out struct {
		ExpiresAt BSONTime `bson:"expiresAt"`
	}
	if err := bson.Unmarshal(raw, &out); err != nil {
		t.Fatalf("typed unmarshal: %v", err)
	}
	if !out.ExpiresAt.Time.Equal(want) {
		t.Fatalf("round trip mismatch: got %v want %v", out.ExpiresAt.Time, want)
	}
}

func TestBSONTimeReadsLegacyStringValues(t *testing.T) {
	const legacy = "2026-10-03T12:30:45.123Z"
	raw, err := bson.Marshal(bson.M{"expiresAt": legacy})
	if err != nil {
		t.Fatalf("marshal legacy: %v", err)
	}

	var out struct {
		ExpiresAt BSONTime `bson:"expiresAt"`
	}
	if err := bson.Unmarshal(raw, &out); err != nil {
		t.Fatalf("legacy string must remain readable, got %v", err)
	}
	if out.ExpiresAt.IsZero() {
		t.Fatal("legacy string value produced a zero instant")
	}
	if got := out.ExpiresAt.FormatISO(); got == "" {
		t.Fatal("legacy string value did not project ISO 8601")
	}
}

func TestBSONTimeJSONIsISO8601(t *testing.T) {
	v := NewBSONTime(time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC))
	data, err := json.Marshal(map[string]any{"expiresAt": v})
	if err != nil {
		t.Fatalf("json marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json unmarshal: %v", err)
	}
	s, ok := decoded["expiresAt"].(string)
	if !ok {
		t.Fatalf("JSON projection must be an ISO 8601 string, got %T", decoded["expiresAt"])
	}
	if _, err := time.Parse(time.RFC3339Nano, s); err != nil {
		t.Fatalf("JSON projection is not ISO 8601: %v", err)
	}
}

func TestBSONTimeZeroSerializesNullJSON(t *testing.T) {
	var v BSONTime
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal zero: %v", err)
	}
	if string(data) != "null" {
		t.Fatalf("zero instant should be null, got %s", data)
	}
}

func TestSampleExpiryMatchesRetentionPolicy(t *testing.T) {
	started := time.Date(2026, 10, 10, 8, 0, 0, 0, time.UTC)
	expiry := NewBSONTime(started.AddDate(0, 0, DefaultRetentionDays))
	want := started.AddDate(0, 0, DefaultRetentionDays)
	if !expiry.Time.Equal(want) {
		t.Fatalf("expiry %v does not match retention policy %v", expiry.Time, want)
	}
	if DefaultRetentionDays != 7 {
		t.Fatalf("default retention must remain 7 days, got %d", DefaultRetentionDays)
	}
}
