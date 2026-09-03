package audit

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestPresentRecord_BasicFields(t *testing.T) {
	doc := bson.M{
		"id":         "log-1",
		"eventId":    "evt-1",
		"timestamp":  "2024-01-15T10:30:00.000Z",
		"action":     "subscriber.update",
		"result":     "success",
		"actor":      "admin",
		"targetId":   "imsi:123",
		"module":     "subscribers",
		"operatorIp": "10.20.30.40",
	}

	rec := PresentRecord(doc, false)

	if rec.ID != "log-1" {
		t.Errorf("ID = %v, want log-1", rec.ID)
	}
	if rec.EventID != "evt-1" {
		t.Errorf("EventID = %v, want evt-1", rec.EventID)
	}
	if rec.Timestamp != "2024-01-15T10:30:00.000Z" {
		t.Errorf("timestamp = %v, want 2024-01-15T10:30:00.000Z", rec.Timestamp)
	}
	if rec.Action != "subscriber.update" {
		t.Errorf("action = %v, want subscriber.update", rec.Action)
	}
	if rec.Actor != "admin" {
		t.Errorf("actor = %v, want admin", rec.Actor)
	}
	// operatorIp should be masked
	if rec.OperatorIP != "[MASKED]" {
		t.Errorf("operatorIp = %v, want [MASKED]", rec.OperatorIP)
	}
}

func TestPresentRecord_OldDataNewData(t *testing.T) {
	doc := bson.M{
		"id":      "log-2",
		"action":  "approval.transition",
		"oldData": bson.M{"status": "pending"},
		"newData": bson.M{"status": "approved"},
	}

	rec := PresentRecord(doc, false)

	if rec.OldData == nil {
		t.Error("oldData should be present")
	}
	if rec.NewData == nil {
		t.Error("newData should be present")
	}
}

func TestPresentRecord_TimestampNormalization(t *testing.T) {
	tests := []struct {
		name string
		doc  bson.M
		want string
	}{
		{
			name: "string timestamp passthrough",
			doc:  bson.M{"id": "1", "timestamp": "2024-01-15T10:30:00.000Z"},
			want: "2024-01-15T10:30:00.000Z",
		},
		{
			name: "bson.DateTime normalization",
			doc:  bson.M{"id": "2", "timestamp": bson.DateTime(1705314600000)}, // 2024-01-15T10:30:00Z
			want: "2024-01-15T10:30:00.000Z",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := PresentRecord(tt.doc, false)
			if rec.Timestamp != tt.want {
				t.Errorf("timestamp = %v, want %v", rec.Timestamp, tt.want)
			}
		})
	}
}

func TestPresentRecord_SourceIPAccess_RevealTrue(t *testing.T) {
	doc := bson.M{
		"id":         "log-4",
		"operatorIp": "10.20.30.40",
		"source":     bson.M{"ip": "192.168.1.1", "userAgent": "Mozilla/5.0"},
	}

	rec := PresentRecord(doc, true)

	// operatorIp is always masked
	if rec.OperatorIP != "[MASKED]" {
		t.Errorf("operatorIp should be masked, got %v", rec.OperatorIP)
	}
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "192.168.1.1" {
		t.Errorf("source.ip should be unmasked, got %v", rec.Source.IP)
	}
	if rec.Source.UserAgent != "Mozilla/5.0" {
		t.Errorf("source.userAgent should be preserved, got %v", rec.Source.UserAgent)
	}
}

func TestPresentRecord_SourceIPAccess_RevealFalse(t *testing.T) {
	doc := bson.M{
		"id":         "log-5",
		"operatorIp": "10.20.30.40",
		"source":     bson.M{"ip": "192.168.1.1", "userAgent": "Mozilla/5.0"},
	}

	rec := PresentRecord(doc, false)

	// operatorIp is always masked
	if rec.OperatorIP != "[MASKED]" {
		t.Errorf("operatorIp should be masked, got %v", rec.OperatorIP)
	}
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	// source.ip should be removed
	if rec.Source.IP != "" {
		t.Errorf("source.ip should be empty, got %v", rec.Source.IP)
	}
	// source.userAgent should be retained
	if rec.Source.UserAgent != "Mozilla/5.0" {
		t.Errorf("source.userAgent should be retained, got %v", rec.Source.UserAgent)
	}
}

func TestPresentRecord_SourceIPAccess_NoSource(t *testing.T) {
	doc := bson.M{
		"id":         "log-6",
		"operatorIp": "10.20.30.40",
	}

	rec := PresentRecord(doc, false)

	// operatorIp is always masked
	if rec.OperatorIP != "[MASKED]" {
		t.Errorf("operatorIp should be masked, got %v", rec.OperatorIP)
	}
	if rec.Source != nil {
		t.Errorf("source should be nil when not present, got %v", rec.Source)
	}
}

func TestMapBSONToRecord_IncludesAllFields(t *testing.T) {
	doc := bson.M{
		"id":            "log-11",
		"eventId":       "evt-11",
		"timestamp":     "2024-01-15T10:30:00.000Z",
		"level":         "info",
		"action":        "test.action",
		"targetId":      "target-1",
		"actor":         "admin",
		"operatorIp":    "10.0.0.1",
		"correlationId": "corr-1",
		"approvalId":    "appr-1",
		"reason":        "test reason",
		"actorContext":  bson.M{"username": "admin"},
		"module":        "test",
		"resource":      bson.M{"type": "subscriber"},
		"riskLevel":     "low",
		"result":        "success",
		"source":        bson.M{"ip": "192.168.1.1", "userAgent": "curl"},
		"request":       bson.M{"requestId": "req-1"},
		"oldData":       bson.M{"status": "before"},
		"newData":       bson.M{"status": "after"},
		"metadata":      bson.M{"key": "val"},
		"error":         bson.M{"code": "ERR"},
	}

	rec := mapBSONToRecord(doc)

	if rec.ID != "log-11" {
		t.Errorf("ID = %v, want log-11", rec.ID)
	}
	if rec.EventID != "evt-11" {
		t.Errorf("EventID = %v, want evt-11", rec.EventID)
	}
	if rec.OldData == nil {
		t.Error("OldData should be populated")
	}
	if rec.NewData == nil {
		t.Error("NewData should be populated")
	}
	if rec.Metadata == nil {
		t.Error("Metadata should be populated")
	}
	if rec.Error == nil {
		t.Error("Error should be populated")
	}
	if rec.Source == nil {
		t.Fatal("Source should be populated")
	}
	if rec.Source.IP != "192.168.1.1" {
		t.Errorf("Source.IP = %v, want 192.168.1.1", rec.Source.IP)
	}
	if rec.Source.UserAgent != "curl" {
		t.Errorf("Source.UserAgent = %v, want curl", rec.Source.UserAgent)
	}
}
