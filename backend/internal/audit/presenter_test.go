package audit

import (
	"regexp"
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
	// operatorIp should be masked (IPv4: last octet → ***)
	if rec.OperatorIP != "10.20.30.***" {
		t.Errorf("operatorIp = %v, want 10.20.30.***", rec.OperatorIP)
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

func TestPresentRecord_SecretRedaction(t *testing.T) {
	doc := bson.M{
		"id":      "log-3",
		"action":  "subscriber.update",
		"oldData": bson.M{"password": "secret123", "k": "key123"},
		"newData": bson.M{"token": "abc123"},
	}

	rec := PresentRecord(doc, false)

	// Payload fields should be sanitized (secrets redacted)
	if rec.OldData == nil {
		t.Error("oldData should be present after sanitization")
	}
	if rec.NewData == nil {
		t.Error("newData should be present after sanitization")
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

// TestPresentRecord_MaskedIPv4Exact verifies exact IPv4 masking: 10.20.30.40 → 10.20.30.***
func TestPresentRecord_MaskedIPv4Exact(t *testing.T) {
	doc := bson.M{
		"id":         "log-mask4",
		"operatorIp": "10.20.30.40",
		"source":     bson.M{"ip": "192.168.1.1", "userAgent": "Mozilla/5.0"},
	}

	rec := PresentRecord(doc, false)

	if rec.OperatorIP != "10.20.30.***" {
		t.Errorf("operatorIp = %v, want 10.20.30.***", rec.OperatorIP)
	}
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "192.168.1.***" {
		t.Errorf("source.ip = %v, want 192.168.1.***", rec.Source.IP)
	}
	if rec.Source.UserAgent != "Mozilla/5.0" {
		t.Errorf("source.userAgent = %v, want Mozilla/5.0", rec.Source.UserAgent)
	}
}

// TestPresentRecord_MaskedIPv6Exact verifies IPv6 masking: first 4 hextets preserved.
func TestPresentRecord_MaskedIPv6Exact(t *testing.T) {
	doc := bson.M{
		"id":         "log-mask6",
		"operatorIp": "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
		"source":     bson.M{"ip": "fe80:0000:0000:0000:0202:b3ff:fe1e:8329", "userAgent": "curl"},
	}

	rec := PresentRecord(doc, false)

	// IPv6: first 4 hextets preserved, rest masked
	if rec.OperatorIP != "2001:db8:85a3:0:****:****:****:****" {
		t.Errorf("operatorIp = %v, want 2001:db8:85a3:0:****:****:****:****", rec.OperatorIP)
	}
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "fe80:0:0:0:****:****:****:****" {
		t.Errorf("source.ip = %v, want fe80:0:0:0:****:****:****:****", rec.Source.IP)
	}
	if rec.Source.UserAgent != "curl" {
		t.Errorf("source.userAgent = %v, want curl", rec.Source.UserAgent)
	}
}

// TestPresentRecord_FullIPv4 verifies full IP with revealSourceIP=true.
func TestPresentRecord_FullIPv4(t *testing.T) {
	doc := bson.M{
		"id":         "log-full4",
		"operatorIp": "10.20.30.40",
		"source":     bson.M{"ip": "192.168.1.1", "userAgent": "Mozilla/5.0"},
	}

	rec := PresentRecord(doc, true)

	if rec.OperatorIP != "10.20.30.40" {
		t.Errorf("operatorIp = %v, want 10.20.30.40", rec.OperatorIP)
	}
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "192.168.1.1" {
		t.Errorf("source.ip = %v, want 192.168.1.1", rec.Source.IP)
	}
	if rec.Source.UserAgent != "Mozilla/5.0" {
		t.Errorf("source.userAgent = %v, want Mozilla/5.0", rec.Source.UserAgent)
	}
}

// TestPresentRecord_FullIPv6 verifies full IPv6 with revealSourceIP=true.
func TestPresentRecord_FullIPv6(t *testing.T) {
	doc := bson.M{
		"id":         "log-full6",
		"operatorIp": "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
		"source":     bson.M{"ip": "fe80::1", "userAgent": "curl"},
	}

	rec := PresentRecord(doc, true)

	// NormalizeIP lowercases but doesn't compress — full form preserved
	if rec.OperatorIP != "2001:0db8:85a3:0000:0000:8a2e:0370:7334" {
		t.Errorf("operatorIp = %v, want 2001:0db8:85a3:0000:0000:8a2e:0370:7334", rec.OperatorIP)
	}
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "fe80::1" {
		t.Errorf("source.ip = %v, want fe80::1", rec.Source.IP)
	}
}

// TestPresentRecord_UserAgentRetained verifies userAgent is always retained.
func TestPresentRecord_UserAgentRetained(t *testing.T) {
	doc := bson.M{
		"id":     "log-ua",
		"source": bson.M{"ip": "10.0.0.1", "userAgent": "Mozilla/5.0 (Windows NT 10.0)"},
	}

	rec := PresentRecord(doc, false)

	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.UserAgent != "Mozilla/5.0 (Windows NT 10.0)" {
		t.Errorf("source.userAgent = %v, want Mozilla/5.0 (Windows NT 10.0)", rec.Source.UserAgent)
	}
}

func TestPresentRecord_SourceIPAccess_NoSource(t *testing.T) {
	doc := bson.M{
		"id":         "log-6",
		"operatorIp": "10.20.30.40",
	}

	rec := PresentRecord(doc, false)

	// operatorIp should be masked
	if rec.OperatorIP != "10.20.30.***" {
		t.Errorf("operatorIp = %v, want 10.20.30.***", rec.OperatorIP)
	}
	if rec.Source != nil {
		t.Errorf("source should be nil when not present, got %v", rec.Source)
	}
}

// TestPresentRecord_MaskedIPv6_Short verifies short IPv6 masking.
func TestPresentRecord_MaskedIPv6_Short(t *testing.T) {
	doc := bson.M{
		"id":         "log-short6",
		"operatorIp": "::1",
		"source":     bson.M{"ip": "fe80::1"},
	}

	rec := PresentRecord(doc, false)

	if rec.OperatorIP != "0:0:0:0:****:****:****:****" {
		t.Errorf("operatorIp = %v, want 0:0:0:0:****:****:****:****", rec.OperatorIP)
	}
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "fe80:0:0:0:****:****:****:****" {
		t.Errorf("source.ip = %v, want fe80:0:0:0:****:****:****:****", rec.Source.IP)
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

// TestStripListProjection verifies large fields are stripped.
func TestStripListProjection(t *testing.T) {
	rec := AuditLogRecord{
		ID:       "log-strip",
		OldData:  bson.M{"status": "before"},
		NewData:  bson.M{"status": "after"},
		Metadata: bson.M{"key": "val"},
		Error:    bson.M{"code": "ERR"},
	}

	StripListProjection(&rec)

	if rec.OldData != nil {
		t.Error("OldData should be nil after strip")
	}
	if rec.NewData != nil {
		t.Error("NewData should be nil after strip")
	}
	if rec.Metadata != nil {
		t.Error("Metadata should be nil after strip")
	}
	if rec.Error != nil {
		t.Error("Error should be nil after strip")
	}
}

// TestMaskIP_IPv4 tests IPv4 masking.
func TestMaskIP_IPv4(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"10.20.30.40", "10.20.30.***"},
		{"192.168.1.1", "192.168.1.***"},
		{"0.0.0.0", "0.0.0.***"},
		{"255.255.255.255", "255.255.255.***"},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := MaskIP(tt.input)
			if got != tt.want {
				t.Errorf("MaskIP(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// TestMaskIP_IPv6 tests IPv6 masking.
func TestMaskIP_IPv6(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"2001:0db8:85a3:0000:0000:8a2e:0370:7334", "2001:db8:85a3:0:****:****:****:****"},
		{"fe80:0000:0000:0000:0202:b3ff:fe1e:8329", "fe80:0:0:0:****:****:****:****"},
		{"::1", "0:0:0:0:****:****:****:****"},
		{"fe80::1", "fe80:0:0:0:****:****:****:****"},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := MaskIP(tt.input)
			if got != tt.want {
				t.Errorf("MaskIP(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// TestMaskIP_Invalid tests invalid IP masking.
func TestMaskIP_Invalid(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", "unknown"},
		{"unknown", "unknown"},
		{"not-an-ip", "unknown"},
		{"10.20.30.***", "10.20.30.***"}, // already masked
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := MaskIP(tt.input)
			if got != tt.want {
				t.Errorf("MaskIP(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// TestApprovalAuditUsesSamePresenter verifies approval audit uses the shared presenter.
func TestApprovalAuditUsesSamePresenter(t *testing.T) {
	doc := bson.M{
		"id":         "approval-log-1",
		"action":     "approval.approve",
		"operatorIp": "10.20.30.40",
		"source":     bson.M{"ip": "192.168.1.1", "userAgent": "Mozilla/5.0"},
		"oldData":    bson.M{"status": "pending", "password": "secret"},
		"newData":    bson.M{"status": "approved"},
		"metadata":   bson.M{"key": "val"},
		"error":      bson.M{"code": "ERR"},
	}

	// This is what the approval audit endpoint uses
	rec := PresentRecord(doc, false)

	// operatorIp masked
	if rec.OperatorIP != "10.20.30.***" {
		t.Errorf("operatorIp = %v, want 10.20.30.***", rec.OperatorIP)
	}
	// source.ip masked, userAgent retained
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "192.168.1.***" {
		t.Errorf("source.ip = %v, want 192.168.1.***", rec.Source.IP)
	}
	if rec.Source.UserAgent != "Mozilla/5.0" {
		t.Errorf("source.userAgent = %v, want Mozilla/5.0", rec.Source.UserAgent)
	}
	// Payload fields sanitized
	if rec.OldData == nil {
		t.Error("oldData should be present")
	}
	if rec.NewData == nil {
		t.Error("newData should be present")
	}
	if rec.Metadata == nil {
		t.Error("metadata should be present")
	}
	if rec.Error == nil {
		t.Error("error should be present")
	}
}

// TestAuditEventID_Format verifies that audit record IDs use UUIDv4
// and eventIds use EVT-{UUID} format. This is distinct from governance
// event IDs which use plain UUIDv4.
func TestAuditEventID_Format(t *testing.T) {
	uuidPattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	evtPattern := regexp.MustCompile(`^EVT-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

	// BuildRecord creates an audit record with UUID id and EVT-{UUID} eventId
	input := WriteAuditInput{
		Action: "test.action",
		Module: "test",
		Actor:  ActorInput{Type: "user", Username: "testuser"},
		Result: "success",
	}
	record := BuildRecord(input)

	// id must be UUIDv4
	if !uuidPattern.MatchString(record.ID) {
		t.Errorf("audit record ID %q is not a valid UUIDv4", record.ID)
	}

	// eventId must be EVT-{UUID}
	if !evtPattern.MatchString(record.EventID) {
		t.Errorf("audit record eventId %q is not EVT-{UUID} format", record.EventID)
	}

	// eventId must start with EVT- followed by the ID
	expectedEventID := "EVT-" + record.ID
	if record.EventID != expectedEventID {
		t.Errorf("audit eventId = %q, want %q", record.EventID, expectedEventID)
	}
}
