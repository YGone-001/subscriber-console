package ocs

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestNumericInt64(t *testing.T) {
	tests := []struct {
		name  string
		input any
		want  int64
	}{
		{"int32 zero", int32(0), 0},
		{"int32 one", int32(1), 1},
		{"int32 1024", int32(1024), 1024},
		{"int32 max", int32(2147483647), 2147483647},

		{"int64 zero", int64(0), 0},
		{"int64 one", int64(1), 1},
		{"int64 1024", int64(1024), 1024},
		{"int64 2147483648", int64(2147483648), 2147483648},
		{"int64 10737418240", int64(10737418240), 10737418240},
		{"int64 max safe JS", int64(9007199254740991), 9007199254740991},

		{"float64 zero", float64(0), 0},
		{"float64 one", float64(1), 1},
		{"float64 1024.5", float64(1024.5), 1024},
		{"float64 2147483648", float64(2147483648), 2147483648},

		{"Decimal128 zero", bson.NewDecimal128(0, 0), 0},
		{"Decimal128 one", bson.NewDecimal128(0, 1), 1},
		{"Decimal128 1024", bson.NewDecimal128(0, 1024), 1024},

		{"nil", nil, 0},
		{"string ignored", "12345", 0},
		{"bool ignored", true, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := numericInt64(tt.input)
			if got != tt.want {
				t.Errorf("numericInt64(%v) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

func TestNumericInt64WithDefault(t *testing.T) {
	tests := []struct {
		name     string
		doc      bson.M
		key      string
		fallback int64
		want     int64
	}{
		{"missing key", bson.M{}, "data_total", 100, 100},
		{"nil value", bson.M{"data_total": nil}, "data_total", 100, 100},
		{"int32 present", bson.M{"data_total": int32(500)}, "data_total", 100, 500},
		{"int64 present", bson.M{"data_total": int64(500)}, "data_total", 100, 500},
		{"zero with non-zero fallback", bson.M{"data_total": int32(0)}, "data_total", 100, 100},
		{"zero with zero fallback", bson.M{"data_total": int32(0)}, "data_total", 0, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := numericInt64WithDefault(tt.doc, tt.key, tt.fallback)
			if got != tt.want {
				t.Errorf("numericInt64WithDefault(%v, %q, %d) = %d, want %d", tt.doc, tt.key, tt.fallback, got, tt.want)
			}
		})
	}
}

func TestNumericFloat64(t *testing.T) {
	tests := []struct {
		name  string
		input any
		want  float64
	}{
		{"float64 zero", float64(0), 0},
		{"float64 3.14", float64(3.14), 3.14},
		{"int32", int32(100), 100.0},
		{"int64", int64(100), 100.0},
		{"nil", nil, 0},
		{"string", "123", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := numericFloat64(tt.input)
			if got != tt.want {
				t.Errorf("numericFloat64(%v) = %f, want %f", tt.input, got, tt.want)
			}
		})
	}
}

func TestMapBalanceZeroValues(t *testing.T) {
	doc := bson.M{
		"imsi":            "test-imsi",
		"data_total":      int64(0),
		"data_used":       int64(0),
		"data_reserved":   int64(0),
		"data_available":  int64(0),
		"voice_total":     int32(0),
		"voice_used":      int32(0),
		"voice_reserved":  int32(0),
		"voice_available": int32(0),
		"sms_total":       int32(0),
		"sms_used":        int32(0),
		"sms_available":   int32(0),
		"money_balance":   float64(0),
		"version":         int32(1),
	}

	subMap := map[string]bson.M{}
	record := mapBalance(doc, subMap)

	if record.DataTotal != 0 {
		t.Errorf("DataTotal = %d, want 0", record.DataTotal)
	}
	if record.DataUsed != 0 {
		t.Errorf("DataUsed = %d, want 0", record.DataUsed)
	}
	if record.DataReserved != 0 {
		t.Errorf("DataReserved = %d, want 0", record.DataReserved)
	}
	if record.DataAvailable != 0 {
		t.Errorf("DataAvailable = %d, want 0", record.DataAvailable)
	}
	if record.MoneyBalance != 0 {
		t.Errorf("MoneyBalance = %f, want 0", record.MoneyBalance)
	}
	if !record.InvariantOk {
		t.Error("InvariantOk should be true for all-zero balances")
	}
}

func TestMapBalanceNonZero(t *testing.T) {
	doc := bson.M{
		"imsi":           "test-imsi-2",
		"data_total":     int64(10737418240),
		"data_used":      int64(5368709120),
		"data_reserved":  int64(1073741824),
		"data_available": int64(4294967296),
		"money_balance":  float64(25.50),
		"version":        int32(3),
	}

	subMap := map[string]bson.M{}
	record := mapBalance(doc, subMap)

	if record.DataTotal != 10737418240 {
		t.Errorf("DataTotal = %d, want 10737418240", record.DataTotal)
	}
	if record.DataUsed != 5368709120 {
		t.Errorf("DataUsed = %d, want 5368709120", record.DataUsed)
	}
	if record.DataReserved != 1073741824 {
		t.Errorf("DataReserved = %d, want 1073741824", record.DataReserved)
	}
	if record.DataAvailable != 4294967296 {
		t.Errorf("DataAvailable = %d, want 4294967296", record.DataAvailable)
	}
	if record.MoneyBalance != 25.50 {
		t.Errorf("MoneyBalance = %f, want 25.50", record.MoneyBalance)
	}
	if !record.InvariantOk {
		t.Error("InvariantOk should be true: 10737418240 == 5368709120 + 1073741824 + 4294967296")
	}
}

func TestMapBalanceInvariantBroken(t *testing.T) {
	doc := bson.M{
		"imsi":           "test-imsi-3",
		"data_total":     int64(1000),
		"data_used":      int64(500),
		"data_reserved":  int64(200),
		"data_available": int64(200), // 500+200+200=900 != 1000
	}

	subMap := map[string]bson.M{}
	record := mapBalance(doc, subMap)

	if record.InvariantOk {
		t.Error("InvariantOk should be false: 1000 != 500+200+200")
	}
	if record.DataInvariantOk {
		t.Error("DataInvariantOk should be false")
	}
}

func TestMapBalanceMissingFields(t *testing.T) {
	doc := bson.M{
		"imsi": "test-imsi-4",
	}

	subMap := map[string]bson.M{}
	record := mapBalance(doc, subMap)

	// Missing numeric fields should get defaults
	if record.DataTotal != 0 {
		t.Errorf("DataTotal = %d, want 0 (missing)", record.DataTotal)
	}
	// voice_total defaults to 3600
	if record.VoiceTotal != 3600 {
		t.Errorf("VoiceTotal = %d, want 3600 (default)", record.VoiceTotal)
	}
	if record.VoiceAvailable != 3600 {
		t.Errorf("VoiceAvailable = %d, want 3600 (default)", record.VoiceAvailable)
	}
	// sms_total defaults to 100
	if record.SmsTotal != 100 {
		t.Errorf("SmsTotal = %d, want 100 (default)", record.SmsTotal)
	}
	if record.SmsAvailable != 100 {
		t.Errorf("SmsAvailable = %d, want 100 (default)", record.SmsAvailable)
	}
}

func TestMapBalanceBSONLongEquivalent(t *testing.T) {
	// Simulate BSON Long values that mongo-driver/v2 returns as int64
	doc := bson.M{
		"imsi":           "test-long",
		"data_total":     int64(9007199254740991), // Number.MAX_SAFE_INTEGER
		"data_used":      int64(4503599627370495),
		"data_reserved":  int64(2251799813685248),
		"data_available": int64(2251799813685248),
	}

	subMap := map[string]bson.M{}
	record := mapBalance(doc, subMap)

	if record.DataTotal != 9007199254740991 {
		t.Errorf("DataTotal = %d, want 9007199254740991", record.DataTotal)
	}
	if !record.InvariantOk {
		t.Error("InvariantOk should be true for MAX_SAFE_INTEGER balance")
	}
}
