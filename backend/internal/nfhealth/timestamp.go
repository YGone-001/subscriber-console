package nfhealth

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// BSONTime is a UTC instant persisted as a BSON Date and projected as an
// ISO 8601 string in JSON. Legacy string-typed documents remain readable so
// previously stored samples are never lost.
//
// MongoDB TTL indexes with expireAfterSeconds: 0 consume the indexed field
// directly and therefore require a BSON Date value.
type BSONTime struct {
	time.Time
}

// NewBSONTime wraps a time.Time as a UTC BSON Time value.
func NewBSONTime(t time.Time) BSONTime {
	return BSONTime{Time: t.UTC()}
}

// ParseBSONTime parses an RFC3339 / ISO 8601 timestamp.
func ParseBSONTime(raw string) (BSONTime, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return BSONTime{}, fmt.Errorf("empty timestamp")
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			return BSONTime{}, fmt.Errorf("invalid timestamp: %w", err)
		}
	}
	return NewBSONTime(t), nil
}

// IsZero reports whether the instant is unset.
func (v BSONTime) IsZero() bool {
	return v.Time.IsZero()
}

// FormatISO returns the canonical ISO 8601 JSON projection.
func (v BSONTime) FormatISO() string {
	if v.IsZero() {
		return ""
	}
	return v.UTC().Format(time.RFC3339Nano)
}

// MarshalJSON projects the instant as an ISO 8601 string. An unset instant
// serializes as null so callers can distinguish missing from present.
func (v BSONTime) MarshalJSON() ([]byte, error) {
	if v.IsZero() {
		return []byte("null"), nil
	}
	return json.Marshal(v.FormatISO())
}

// UnmarshalJSON accepts an ISO 8601 string or null.
func (v *BSONTime) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		v.Time = time.Time{}
		return nil
	}
	var raw string
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	parsed, err := ParseBSONTime(raw)
	if err != nil {
		return err
	}
	*v = parsed
	return nil
}

// MarshalBSONValue stores the instant as a BSON Date so the MongoDB TTL
// index can expire documents from this field.
func (v BSONTime) MarshalBSONValue() (byte, []byte, error) {
	if v.IsZero() {
		return byte(bson.TypeNull), nil, nil
	}
	typ, data, err := bson.MarshalValue(v.UTC())
	if err != nil {
		return 0, nil, err
	}
	return byte(typ), data, nil
}

// UnmarshalBSONValue accepts both BSON Date (current) and BSON String (legacy)
// so previously stored samples remain readable without mutation.
func (v *BSONTime) UnmarshalBSONValue(typ byte, data []byte) error {
	switch bson.Type(typ) {
	case bson.TypeDateTime:
		var t time.Time
		if err := bson.UnmarshalValue(bson.TypeDateTime, data, &t); err != nil {
			return err
		}
		v.Time = t.UTC()
		return nil
	case bson.TypeString:
		var s string
		if err := bson.UnmarshalValue(bson.TypeString, data, &s); err != nil {
			return err
		}
		parsed, err := ParseBSONTime(s)
		if err != nil {
			return err
		}
		*v = parsed
		return nil
	case bson.TypeNull, bson.TypeUndefined:
		v.Time = time.Time{}
		return nil
	case bson.TypeInt64:
		var ms int64
		if err := bson.UnmarshalValue(bson.TypeInt64, data, &ms); err != nil {
			return err
		}
		v.Time = time.UnixMilli(ms).UTC()
		return nil
	default:
		return fmt.Errorf("unsupported timestamp bson type %d", typ)
	}
}
