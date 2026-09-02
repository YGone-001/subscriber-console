package approval

import (
	"strings"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// normalizeApproval converts a raw BSON document into an ApprovalDocument.
// Handles legacy status normalization, missing field defaults, and payload sanitization.
// Matches Node normalizeApproval() exactly.
func normalizeApproval(doc bson.M) *ApprovalDocument {
	if doc == nil {
		return nil
	}

	approval := &ApprovalDocument{}

	// Core fields
	approval.ID = bsonString(doc, "id")
	approval.ChangeID = bsonString(doc, "changeId")
	approval.Action = bsonString(doc, "action")
	approval.TargetID = bsonString(doc, "targetId")
	approval.Summary = bsonString(doc, "summary")
	approval.Requester = bsonString(doc, "requester")
	approval.Reviewer = bsonString(doc, "reviewer")
	approval.Reason = bsonString(doc, "reason")
	approval.Note = bsonString(doc, "note")
	approval.TicketID = bsonString(doc, "ticketId")
	approval.OperationFingerprint = bsonString(doc, "operationFingerprint")
	approval.Error = bsonString(doc, "error")
	approval.CreatedAt = bsonString(doc, "createdAt")
	approval.UpdatedAt = bsonString(doc, "updatedAt")
	approval.ReviewedAt = bsonString(doc, "reviewedAt")
	approval.ExecutedAt = bsonString(doc, "executedAt")
	approval.ExpiresAt = bsonString(doc, "expiresAt")
	approval.Description = bsonString(doc, "description")

	// Title fallback: title || summary
	approval.Title = bsonString(doc, "title")
	if approval.Title == "" {
		approval.Title = approval.Summary
	}

	// Status with legacy "executed" normalization
	rawStatus := bsonString(doc, "status")
	if rawStatus == "executed" {
		approval.Status = StatusCompleted
		approval.LegacyStatus = "executed"
	} else {
		approval.Status = ApprovalStatus(rawStatus)
		approval.LegacyStatus = bsonString(doc, "legacyStatus")
	}

	// Risk assessment — derive if missing
	if ra, ok := doc["riskAssessment"].(bson.M); ok {
		approval.RiskAssessment = RiskAssessment{
			Level:    RiskLevel(bsonString(ra, "level")),
			PolicyID: bsonString(ra, "policyId"),
		}
		if reasons, ok := ra["reasons"].(bson.A); ok {
			for _, r := range reasons {
				if s, ok := r.(string); ok {
					approval.RiskAssessment.Reasons = append(approval.RiskAssessment.Reasons, s)
				}
			}
		}
	} else {
		approval.RiskAssessment = AssessApprovalRisk(approval.Action)
	}

	// Risk level fallback
	approval.RiskLevel = RiskLevel(bsonString(doc, "riskLevel"))
	if approval.RiskLevel == "" {
		approval.RiskLevel = approval.RiskAssessment.Level
	}

	// Operation — derive from targetId if missing
	if op, ok := doc["operation"].(bson.M); ok {
		approval.Operation = ApprovalOperation{
			ResourceType: bsonString(op, "resourceType"),
			ResourceID:   bsonString(op, "resourceId"),
		}
	} else {
		approval.Operation = ApprovalOperation{
			ResourceType: resourceTypeFromTarget(approval.TargetID),
			ResourceID:   approval.TargetID,
		}
	}

	// RequesterContext
	if rc, ok := doc["requesterContext"].(bson.M); ok {
		approval.RequesterContext = mapBSONToActor(rc)
	}

	// ReviewerContext
	if rc, ok := doc["reviewerContext"].(bson.M); ok {
		approval.ReviewerContext = mapBSONToActor(rc)
	}

	// Decision
	if d, ok := doc["decision"].(bson.M); ok {
		approval.Decision = &ApprovalDecision{
			Outcome:   bsonString(d, "outcome"),
			Comment:   bsonString(d, "comment"),
			DecidedAt: bsonString(d, "decidedAt"),
		}
	}

	// Execution
	if e, ok := doc["execution"].(bson.M); ok {
		exec := &ApprovalExecution{
			ID:          bsonString(e, "id"),
			StartedAt:   bsonString(e, "startedAt"),
			CompletedAt: bsonString(e, "completedAt"),
		}
		if success, ok := e["success"].(bool); ok {
			exec.Success = &success
		}
		if errDoc, ok := e["error"].(bson.M); ok {
			exec.Error = &ExecutionError{
				Code:    bsonString(errDoc, "code"),
				Message: bsonString(errDoc, "message"),
			}
		}
		approval.Execution = exec
	}

	// Events — empty array, never null
	events, ok := doc["events"].(bson.A)
	if !ok || len(events) == 0 {
		approval.Events = []GovernanceEvent{}
	} else {
		approval.Events = make([]GovernanceEvent, 0, len(events))
		for _, ev := range events {
			if evDoc, ok := ev.(bson.M); ok {
				approval.Events = append(approval.Events, GovernanceEvent{
					ID:        bsonString(evDoc, "id"),
					Timestamp: bsonString(evDoc, "timestamp"),
					Type:      bsonString(evDoc, "type"),
					Actor:     bsonString(evDoc, "actor"),
					Message:   bsonString(evDoc, "message"),
				})
			}
		}
	}

	// Payload — sanitized
	if p, ok := doc["payload"].(bson.M); ok {
		approval.Payload = toSanitizedMap(p)
	} else {
		approval.Payload = map[string]interface{}{}
	}

	// Before/After — sanitized if present
	if b, ok := doc["before"]; ok && b != nil {
		approval.Before = audit.SanitizePayload(b)
	}
	if a, ok := doc["after"]; ok && a != nil {
		approval.After = audit.SanitizePayload(a)
	}

	// Result — sanitized if present
	if r, ok := doc["result"]; ok && r != nil {
		approval.Result = audit.SanitizePayload(r)
	}

	return approval
}

// toSanitizedMap converts a bson.M to a sanitized map[string]interface{}.
func toSanitizedMap(m bson.M) map[string]interface{} {
	sanitized := audit.SanitizePayload(m)
	if result, ok := sanitized.(map[string]interface{}); ok {
		return result
	}
	return map[string]interface{}{}
}

// mapBSONToActor converts a bson.M to a GovernanceActor.
func mapBSONToActor(m bson.M) *GovernanceActor {
	if m == nil {
		return nil
	}
	return &GovernanceActor{
		Type:        bsonString(m, "type"),
		UserID:      bsonString(m, "userId"),
		Username:    bsonString(m, "username"),
		DisplayName: bsonString(m, "displayName"),
		Role:        bsonString(m, "role"),
	}
}

// resourceTypeFromTarget derives a resourceType from a targetId.
// Matches Node resourceType() exactly.
func resourceTypeFromTarget(targetID string) string {
	parts := strings.SplitN(targetID, ":", 2)
	if len(parts) > 0 && parts[0] != "" && parts[0] != targetID {
		return parts[0]
	}
	return "approval-target"
}

// bsonString extracts a string from a bson.M.
func bsonString(m bson.M, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// mapBSONToApprovalAuditRecord converts a raw BSON audit log document
// for the approval audit trail view.
func mapBSONToApprovalAuditRecord(doc bson.M) map[string]interface{} {
	rec := map[string]interface{}{}

	if v, ok := doc["id"].(string); ok {
		rec["id"] = v
	}
	if v, ok := doc["timestamp"].(string); ok {
		rec["timestamp"] = v
	} else if v, ok := doc["timestamp"].(bson.DateTime); ok {
		rec["timestamp"] = v.Time().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if v, ok := doc["action"].(string); ok {
		rec["action"] = v
	}
	if v, ok := doc["result"].(string); ok {
		rec["result"] = v
	}
	if v, ok := doc["actor"].(string); ok {
		rec["actor"] = v
	}
	if v, ok := doc["targetId"].(string); ok {
		rec["targetId"] = v
	}
	if v, ok := doc["module"].(string); ok {
		rec["module"] = v
	}
	if v, ok := doc["approvalId"].(string); ok {
		rec["approvalId"] = v
	}
	if v, ok := doc["riskLevel"].(string); ok {
		rec["riskLevel"] = v
	}
	if v, ok := doc["reason"].(string); ok {
		rec["reason"] = v
	}
	rec["resource"] = doc["resource"]
	rec["actorContext"] = doc["actorContext"]

	return rec
}
