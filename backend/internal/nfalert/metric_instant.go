package nfalert

import (
	"fmt"
	"go.mongodb.org/mongo-driver/v2/bson"
	"time"
)

// These controller clocks are not TTL fields. BSON Date truncates nanoseconds,
// which can otherwise duplicate an observation or satisfy a duration too early.
// Legacy Date watermarks are rounded UP conservatively to their millisecond end.
type metricInstant struct{ time.Time }

func (v metricInstant) MarshalBSONValue() (byte, []byte, error) {
	if v.IsZero() {
		return byte(bson.TypeNull), nil, nil
	}
	typ, data, err := bson.MarshalValue(v.UTC().Format(time.RFC3339Nano))
	return byte(typ), data, err
}
func (v *metricInstant) UnmarshalBSONValue(typ byte, data []byte) error {
	switch bson.Type(typ) {
	case bson.TypeNull, bson.TypeUndefined:
		v.Time = time.Time{}
		return nil
	case bson.TypeString:
		var raw string
		if err := bson.UnmarshalValue(bson.TypeString, data, &raw); err != nil {
			return err
		}
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return err
		}
		v.Time = t.UTC()
		return nil
	case bson.TypeDateTime:
		var t time.Time
		if err := bson.UnmarshalValue(bson.TypeDateTime, data, &t); err != nil {
			return err
		}
		if !t.IsZero() {
			t = t.Add(time.Millisecond - time.Nanosecond)
		}
		v.Time = t.UTC()
		return nil
	default:
		return fmt.Errorf("unsupported metric instant type")
	}
}
