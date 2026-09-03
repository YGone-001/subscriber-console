package audit

import (
	"net"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// PresentRecord converts a raw BSON audit document into a fully sanitized
// AuditLogRecord with source-IP access control applied.
//
// Canonical pipeline:
//
//	raw BSON → mapBSONToRecord → sanitizeRecord → applySourceIPAccess
//
// This is the single presentation function shared by all audit endpoints:
//   - GET /api/audit
//   - GET /api/audit/{id}
//   - GET /api/approvals/{id}/audit
func PresentRecord(doc bson.M, revealSourceIP bool) AuditLogRecord {
	rec := mapBSONToRecord(doc)
	sanitizeRecord(&rec)
	applySourceIPAccess(&rec, revealSourceIP)
	return rec
}

// PresentRecords is the batch version of PresentRecord.
func PresentRecords(docs []bson.M, revealSourceIP bool) []AuditLogRecord {
	result := make([]AuditLogRecord, 0, len(docs))
	for _, doc := range docs {
		result = append(result, PresentRecord(doc, revealSourceIP))
	}
	return result
}

// StripListProjection removes large payload fields from a record
// for list view responses (GET /api/audit). Presentation must happen
// BEFORE projection — call PresentRecord first, then StripListProjection.
// Matches Node listAuditLogs() which strips oldData/newData/metadata/error.
func StripListProjection(rec *AuditLogRecord) {
	rec.OldData = nil
	rec.NewData = nil
	rec.Metadata = nil
	rec.Error = nil
}

// sanitizeRecord applies audit text sanitization to all text fields
// and payload sanitization to oldData/newData/metadata/error.
// Matches Node sanitizeAuditRecord() exactly.
func sanitizeRecord(rec *AuditLogRecord) {
	rec.ID = sanitizeAuditText(rec.ID)
	rec.Action = sanitizeAuditText(rec.Action)
	rec.TargetID = sanitizeAuditText(rec.TargetID)
	rec.OperatorIP = sanitizeAuditText(rec.OperatorIP)
	rec.CorrelationID = optionalSanitizedText(rec.CorrelationID)
	rec.ApprovalID = optionalSanitizedText(rec.ApprovalID)
	rec.Reason = optionalSanitizedText(rec.Reason)
	rec.EventID = optionalSanitizedText(rec.EventID)
	rec.Module = optionalSanitizedText(rec.Module)

	// Actor: sanitize if string
	if s, ok := rec.Actor.(string); ok {
		rec.Actor = sanitizeAuditText(s)
	}

	// ActorContext: sanitize known fields
	if m, ok := rec.ActorContext.(map[string]interface{}); ok {
		cleaned := map[string]interface{}{}
		if v, ok := m["type"].(string); ok {
			cleaned["type"] = sanitizeAuditText(v)
		}
		if v, ok := m["userId"].(string); ok {
			cleaned["userId"] = sanitizeAuditText(v)
		}
		if v, ok := m["username"].(string); ok {
			cleaned["username"] = sanitizeAuditText(v)
		}
		if v, ok := m["displayName"].(string); ok {
			cleaned["displayName"] = sanitizeAuditText(v)
		}
		if v, ok := m["role"].(string); ok {
			cleaned["role"] = sanitizeAuditText(v)
		}
		rec.ActorContext = cleaned
	}

	// Resource: sanitize known fields
	if m, ok := rec.Resource.(map[string]interface{}); ok {
		cleaned := map[string]interface{}{}
		if v, ok := m["type"].(string); ok {
			cleaned["type"] = sanitizeAuditText(v)
		}
		if v, ok := m["id"].(string); ok {
			cleaned["id"] = sanitizeAuditText(v)
		}
		if v, ok := m["name"].(string); ok {
			cleaned["name"] = sanitizeAuditText(v)
		}
		rec.Resource = cleaned
	}

	// Source: sanitize known fields
	if rec.Source != nil {
		rec.Source = &SourceInfo{
			IP:        optionalSanitizedText(rec.Source.IP),
			UserAgent: optionalSanitizedText(rec.Source.UserAgent),
		}
	}

	// Request: sanitize known fields
	if m, ok := rec.Request.(map[string]interface{}); ok {
		cleaned := map[string]interface{}{}
		if v, ok := m["method"].(string); ok {
			cleaned["method"] = sanitizeAuditText(v)
		}
		if v, ok := m["path"].(string); ok {
			cleaned["path"] = sanitizeAuditText(v)
		}
		if v, ok := m["requestId"].(string); ok {
			cleaned["requestId"] = sanitizeAuditText(v)
		}
		if v, ok := m["correlationId"].(string); ok {
			cleaned["correlationId"] = sanitizeAuditText(v)
		}
		rec.Request = cleaned
	}

	// Error: sanitize known fields
	if m, ok := rec.Error.(map[string]interface{}); ok {
		cleaned := map[string]interface{}{}
		if v, ok := m["code"].(string); ok {
			cleaned["code"] = sanitizeAuditText(v)
		}
		if v, ok := m["message"].(string); ok {
			cleaned["message"] = sanitizeAuditText(v)
		}
		rec.Error = cleaned
	}

	// Payload fields: deep sanitize
	if rec.OldData != nil {
		rec.OldData = sanitizeAuditPayload(rec.OldData)
	}
	if rec.NewData != nil {
		rec.NewData = sanitizeAuditPayload(rec.NewData)
	}
	if rec.Metadata != nil {
		rec.Metadata = sanitizeAuditPayload(rec.Metadata)
	}
}

// applySourceIPAccess applies source-IP masking or reveals full IP.
// Matches Node applyAuditSourceIpAccess() exactly.
//
// Without audit.source-ip.read-full:
//   - IPv4: 10.20.30.40 → 10.20.30.***
//   - IPv6: first 4 hextets preserved, rest masked
//   - operatorIp: same masking
//   - source.userAgent: retained
//
// With audit.source-ip.read-full:
//   - Full sanitized IP for both operatorIp and source.ip
func applySourceIPAccess(rec *AuditLogRecord, revealSourceIP bool) {
	if revealSourceIP {
		// Full access: just sanitize, don't mask
		if rec.OperatorIP != "" {
			rec.OperatorIP = NormalizeIP(rec.OperatorIP)
		}
		if rec.Source != nil && rec.Source.IP != "" {
			rec.Source.IP = NormalizeIP(rec.Source.IP)
		}
		return
	}
	// Masked access
	if rec.OperatorIP != "" {
		rec.OperatorIP = MaskIP(rec.OperatorIP)
	}
	if rec.Source != nil {
		rec.Source = &SourceInfo{
			IP:        MaskIP(rec.Source.IP),
			UserAgent: rec.Source.UserAgent, // always retained
		}
	}
}

// MaskIP masks an IP address preserving network context.
// IPv4: 10.20.30.40 → 10.20.30.***
// IPv6: first 4 hextets preserved, rest masked → xxxx:xxxx:xxxx:xxxx:****:****:****:****
// Matches Node maskAuditSourceIp() exactly.
func MaskIP(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unknown"
	}
	// Already masked or unknown
	if strings.Contains(value, "*") || value == "unknown" {
		return sanitizeAuditText(value)
	}
	normalized := NormalizeIP(value)
	if normalized == "unknown" {
		return "unknown"
	}
	ip := net.ParseIP(normalized)
	if ip == nil {
		return "unknown"
	}
	if ip4 := ip.To4(); ip4 != nil {
		// IPv4: mask last octet
		parts := strings.Split(normalized, ".")
		if len(parts) == 4 {
			return parts[0] + "." + parts[1] + "." + parts[2] + ".***"
		}
	}
	// IPv6: preserve first 4 hextets
	if ip.To16() != nil {
		hextets := expandIPv6(normalized)
		if hextets != nil && len(hextets) >= 8 {
			return strings.Join(hextets[:4], ":") + ":****:****:****:****"
		}
	}
	return "unknown"
}

// expandIPv6 expands an IPv6 address to 8 hextets.
func expandIPv6(addr string) []string {
	// Handle embedded IPv4
	// net.ParseIP already normalizes, so we can work with the hex form
	ip := net.ParseIP(addr)
	if ip == nil {
		return nil
	}
	// Use the 16-byte form to extract hextets
	b := ip.To16()
	if b == nil {
		return nil
	}
	hextets := make([]string, 8)
	for i := 0; i < 8; i++ {
		hextets[i] = strings.TrimLeft(
			strings.ToLower(
				string([]byte{
					hexChar(b[i*2] >> 4),
					hexChar(b[i*2] & 0x0f),
					hexChar(b[i*2+1] >> 4),
					hexChar(b[i*2+1] & 0x0f),
				}),
			),
			"0",
		)
		if hextets[i] == "" {
			hextets[i] = "0"
		}
	}
	return hextets
}

func hexChar(b byte) byte {
	if b < 10 {
		return '0' + b
	}
	return 'a' + b - 10
}

// optionalSanitizedText sanitizes a string and returns empty string if result is empty.
func optionalSanitizedText(value string) string {
	if value == "" {
		return ""
	}
	return sanitizeAuditText(value)
}

// mapBSONToRecord converts a raw BSON document into an AuditLogRecord.
// This is the first stage of the presentation pipeline.
func mapBSONToRecord(doc bson.M) AuditLogRecord {
	rec := AuditLogRecord{}
	if v, ok := doc["id"].(string); ok {
		rec.ID = v
	}
	if v, ok := doc["eventId"].(string); ok {
		rec.EventID = v
	}
	if v, ok := doc["timestamp"].(string); ok {
		rec.Timestamp = v
	} else if v, ok := doc["timestamp"].(bson.DateTime); ok {
		rec.Timestamp = v.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if v, ok := doc["level"].(string); ok {
		rec.Level = v
	}
	if v, ok := doc["action"].(string); ok {
		rec.Action = v
	}
	if v, ok := doc["targetId"].(string); ok {
		rec.TargetID = v
	}
	rec.Actor = doc["actor"]
	if v, ok := doc["operatorIp"].(string); ok {
		rec.OperatorIP = v
	}
	if v, ok := doc["correlationId"].(string); ok {
		rec.CorrelationID = v
	}
	if v, ok := doc["approvalId"].(string); ok {
		rec.ApprovalID = v
	}
	if v, ok := doc["reason"].(string); ok {
		rec.Reason = v
	}
	rec.ActorContext = doc["actorContext"]
	if v, ok := doc["module"].(string); ok {
		rec.Module = v
	}
	rec.Resource = doc["resource"]
	if v, ok := doc["riskLevel"].(string); ok {
		rec.RiskLevel = v
	}
	if v, ok := doc["result"].(string); ok {
		rec.Result = v
	}
	if src, ok := doc["source"].(bson.M); ok {
		si := &SourceInfo{}
		if ip, ok := src["ip"].(string); ok {
			si.IP = ip
		}
		if ua, ok := src["userAgent"].(string); ok {
			si.UserAgent = ua
		}
		if si.IP != "" || si.UserAgent != "" {
			rec.Source = si
		}
	}
	rec.Request = doc["request"]
	rec.Metadata = doc["metadata"]
	rec.Error = doc["error"]
	rec.OldData = doc["oldData"]
	rec.NewData = doc["newData"]
	return rec
}
