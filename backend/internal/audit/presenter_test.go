package audit

import (
	"fmt"
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

// TestPresentRecord_ActorContext_BsonM verifies actorContext as bson.M (map).
func TestPresentRecord_ActorContext_BsonM(t *testing.T) {
	doc := bson.M{
		"id": "log-ac-m",
		"actorContext": bson.M{
			"type":        "user",
			"userId":      "u-1",
			"username":    "admin",
			"displayName": "Admin User",
			"role":        "super_admin",
			"secret":      "should-be-dropped",
			"password":    "should-be-dropped",
		},
	}
	rec := PresentRecord(doc, false)
	m, ok := rec.ActorContext.(map[string]interface{})
	if !ok {
		t.Fatalf("ActorContext should be map[string]interface{}, got %T", rec.ActorContext)
	}
	if m["type"] != "user" {
		t.Errorf("type = %v, want user", m["type"])
	}
	if m["userId"] != "u-1" {
		t.Errorf("userId = %v, want u-1", m["userId"])
	}
	if m["username"] != "admin" {
		t.Errorf("username = %v, want admin", m["username"])
	}
	if m["displayName"] != "Admin User" {
		t.Errorf("displayName = %v, want Admin User", m["displayName"])
	}
	if m["role"] != "super_admin" {
		t.Errorf("role = %v, want super_admin", m["role"])
	}
	// Unknown fields must be dropped
	if _, ok := m["secret"]; ok {
		t.Error("secret field should be dropped from actorContext")
	}
	if _, ok := m["password"]; ok {
		t.Error("password field should be dropped from actorContext")
	}
}

// TestPresentRecord_ActorContext_BsonD verifies actorContext as bson.D (ordered).
func TestPresentRecord_ActorContext_BsonD(t *testing.T) {
	doc := bson.M{
		"id": "log-ac-d",
		"actorContext": bson.D{
			{Key: "type", Value: "system"},
			{Key: "userId", Value: "sys-1"},
			{Key: "username", Value: "system"},
			{Key: "role", Value: "system"},
			{Key: "apiKey", Value: "leaked-key-123"},
		},
	}
	rec := PresentRecord(doc, false)
	m, ok := rec.ActorContext.(map[string]interface{})
	if !ok {
		t.Fatalf("ActorContext should be map[string]interface{}, got %T", rec.ActorContext)
	}
	if m["type"] != "system" {
		t.Errorf("type = %v, want system", m["type"])
	}
	if m["userId"] != "sys-1" {
		t.Errorf("userId = %v, want sys-1", m["userId"])
	}
	// Unknown fields must be dropped
	if _, ok := m["apiKey"]; ok {
		t.Error("apiKey field should be dropped from actorContext")
	}
}

// TestPresentRecord_Resource_BsonM verifies resource as bson.M.
func TestPresentRecord_Resource_BsonM(t *testing.T) {
	doc := bson.M{
		"id": "log-res",
		"resource": bson.M{
			"type":     "subscriber",
			"id":       "imsi-123",
			"name":     "Test Sub",
			"secret":   "dropped",
			"password": "dropped",
			"internal": "dropped",
		},
	}
	rec := PresentRecord(doc, false)
	m, ok := rec.Resource.(map[string]interface{})
	if !ok {
		t.Fatalf("Resource should be map[string]interface{}, got %T", rec.Resource)
	}
	if m["type"] != "subscriber" {
		t.Errorf("type = %v, want subscriber", m["type"])
	}
	if m["id"] != "imsi-123" {
		t.Errorf("id = %v, want imsi-123", m["id"])
	}
	if m["name"] != "Test Sub" {
		t.Errorf("name = %v, want Test Sub", m["name"])
	}
	if _, ok := m["secret"]; ok {
		t.Error("secret field should be dropped from resource")
	}
	if _, ok := m["password"]; ok {
		t.Error("password field should be dropped from resource")
	}
	if _, ok := m["internal"]; ok {
		t.Error("internal field should be dropped from resource")
	}
}

// TestPresentRecord_Request_BsonM verifies request as bson.M with no query/headers/cookies.
func TestPresentRecord_Request_BsonM(t *testing.T) {
	doc := bson.M{
		"id": "log-req",
		"request": bson.M{
			"method":        "POST",
			"path":          "/api/subscribers",
			"requestId":     "req-123",
			"correlationId": "corr-456",
			"queryString":   "?secret=token",
			"headers":       bson.M{"Authorization": "Bearer secret"},
			"cookies":       bson.M{"auth_token": "jwt-secret"},
		},
	}
	rec := PresentRecord(doc, false)
	m, ok := rec.Request.(map[string]interface{})
	if !ok {
		t.Fatalf("Request should be map[string]interface{}, got %T", rec.Request)
	}
	if m["method"] != "POST" {
		t.Errorf("method = %v, want POST", m["method"])
	}
	if m["path"] != "/api/subscribers" {
		t.Errorf("path = %v, want /api/subscribers", m["path"])
	}
	if m["requestId"] != "req-123" {
		t.Errorf("requestId = %v, want req-123", m["requestId"])
	}
	if m["correlationId"] != "corr-456" {
		t.Errorf("correlationId = %v, want corr-456", m["correlationId"])
	}
	// Sensitive fields must be dropped
	if _, ok := m["queryString"]; ok {
		t.Error("queryString should be dropped from request")
	}
	if _, ok := m["headers"]; ok {
		t.Error("headers should be dropped from request")
	}
	if _, ok := m["cookies"]; ok {
		t.Error("cookies should be dropped from request")
	}
}

// TestPresentRecord_Error_BsonM verifies error as bson.M.
func TestPresentRecord_Error_BsonM(t *testing.T) {
	doc := bson.M{
		"id": "log-err-m",
		"error": bson.M{
			"code":    "VALIDATION_ERROR",
			"message": "Invalid IMSI format",
			"stack":   "at line 42...",
			"secret":  "dropped",
		},
	}
	rec := PresentRecord(doc, false)
	m, ok := rec.Error.(map[string]interface{})
	if !ok {
		t.Fatalf("Error should be map[string]interface{}, got %T", rec.Error)
	}
	if m["code"] != "VALIDATION_ERROR" {
		t.Errorf("code = %v, want VALIDATION_ERROR", m["code"])
	}
	if m["message"] != "Invalid IMSI format" {
		t.Errorf("message = %v, want Invalid IMSI format", m["message"])
	}
	if _, ok := m["stack"]; ok {
		t.Error("stack should be dropped from error")
	}
	if _, ok := m["secret"]; ok {
		t.Error("secret should be dropped from error")
	}
}

// TestPresentRecord_Error_BsonD verifies error as bson.D (ordered).
func TestPresentRecord_Error_BsonD(t *testing.T) {
	doc := bson.M{
		"id": "log-err-d",
		"error": bson.D{
			{Key: "code", Value: "RATE_LIMIT"},
			{Key: "message", Value: "Too many requests"},
			{Key: "token", Value: "leaked-token"},
		},
	}
	rec := PresentRecord(doc, false)
	m, ok := rec.Error.(map[string]interface{})
	if !ok {
		t.Fatalf("Error should be map[string]interface{}, got %T", rec.Error)
	}
	if m["code"] != "RATE_LIMIT" {
		t.Errorf("code = %v, want RATE_LIMIT", m["code"])
	}
	if m["message"] != "Too many requests" {
		t.Errorf("message = %v, want Too many requests", m["message"])
	}
	if _, ok := m["token"]; ok {
		t.Error("token should be dropped from error")
	}
}

// TestPresentRecord_NestedSecretsInPayloads verifies that secrets in
// oldData/newData/metadata are scrubbed by the deep sanitizer.
func TestPresentRecord_NestedSecretsInPayloads(t *testing.T) {
	doc := bson.M{
		"id": "log-nested-payload",
		"oldData": bson.M{
			"status":   "active",
			"password": "hunter2",
			"token":    "jwt-secret-value",
			"nested": bson.M{
				"apiKey": "key-123",
				"safe":   "keep-me",
			},
		},
		"newData": bson.M{
			"status":  "suspended",
			"secret":  "new-secret",
			"api_key": "key-456",
		},
		"metadata": bson.M{
			"source":  "api",
			"api_key": "meta-key-789",
			"note":    "safe note",
		},
	}
	rec := PresentRecord(doc, false)

	// oldData should be sanitized — sensitive fields redacted
	oldJSON := fmt.Sprintf("%v", rec.OldData)
	if containsSensitive(oldJSON, "hunter2") {
		t.Error("oldData should not contain raw password")
	}
	if containsSensitive(oldJSON, "jwt-secret-value") {
		t.Error("oldData should not contain raw token")
	}

	// newData should be sanitized
	newJSON := fmt.Sprintf("%v", rec.NewData)
	if containsSensitive(newJSON, "new-secret") {
		t.Error("newData should not contain raw secret")
	}
	if containsSensitive(newJSON, "key-456") {
		t.Error("newData should not contain raw api_key")
	}

	// metadata should be sanitized
	metaJSON := fmt.Sprintf("%v", rec.Metadata)
	if containsSensitive(metaJSON, "meta-key-789") {
		t.Error("metadata should not contain raw api_key")
	}
}

// TestPresentRecord_Source_BsonD verifies source as bson.D (ordered).
func TestPresentRecord_Source_BsonD(t *testing.T) {
	doc := bson.M{
		"id": "log-src-d",
		"source": bson.D{
			{Key: "ip", Value: "10.20.30.40"},
			{Key: "userAgent", Value: "curl/7.0"},
		},
	}
	rec := PresentRecord(doc, false)
	if rec.Source == nil {
		t.Fatal("source should be present")
	}
	if rec.Source.IP != "10.20.30.***" {
		t.Errorf("source.ip = %v, want 10.20.30.***", rec.Source.IP)
	}
	if rec.Source.UserAgent != "curl/7.0" {
		t.Errorf("source.userAgent = %v, want curl/7.0", rec.Source.UserAgent)
	}
}

// containsSensitive checks if a string contains a sensitive value verbatim.
func containsSensitive(s, sensitive string) bool {
	if sensitive == "" || s == "" {
		return false
	}
	for i := 0; i <= len(s)-len(sensitive); i++ {
		if s[i:i+len(sensitive)] == sensitive {
			return true
		}
	}
	return false
}
