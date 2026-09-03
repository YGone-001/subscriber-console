package approval

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// TransitionInput holds the parameters for a CAS status transition.
type TransitionInput struct {
	ID             string
	ExpectedStatus ApprovalStatus
	NextStatus     ApprovalStatus
	Actor          string
	EventType      string
	EventMessage   string
	ExpectedExecID string // only set for execute transitions
	Patch          map[string]interface{}
}

// TransitionResult holds the outcome of a CAS transition attempt.
type TransitionResult struct {
	OK       bool
	Approval *ApprovalDocument
	Reason   string // "not_found" or "conflict" when OK is false
}

// TransitionApproval is the only approval status writer.
// Uses FindOneAndUpdate for atomic CAS: filter by id + expectedStatus,
// $set status + updatedAt + patch, $push event.
// Matches Node transitionApproval() exactly.
func (r *Repository) TransitionApproval(ctx context.Context, input TransitionInput) (*TransitionResult, error) {
	if !CanTransition(input.ExpectedStatus, input.NextStatus) {
		return nil, fmt.Errorf("APPROVAL_TRANSITION_NOT_ALLOWED:%s:%s", input.ExpectedStatus, input.NextStatus)
	}

	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")

	// Build filter: id + expectedStatus (+ optional execution.id)
	filter := bson.M{
		"id":     input.ID,
		"status": string(input.ExpectedStatus),
	}
	if input.ExpectedExecID != "" {
		filter["execution.id"] = input.ExpectedExecID
	}

	// Build update: $set + $push event
	setFields := bson.M{
		"status":    string(input.NextStatus),
		"updatedAt": now,
	}
	for k, v := range input.Patch {
		setFields[k] = v
	}

	eventID := generateEventID()
	event := bson.M{
		"id":        eventID,
		"timestamp": now,
		"type":      input.EventType,
		"actor":     input.Actor,
		"message":   input.EventMessage,
	}

	update := bson.M{
		"$set":  setFields,
		"$push": bson.M{"events": event},
	}

	opts := options.FindOneAndUpdate().SetReturnDocument(options.After)
	var result bson.M
	err := r.approvals.FindOneAndUpdate(ctx, filter, update, opts).Decode(&result)

	if err == nil {
		approval := normalizeApproval(result)
		return &TransitionResult{OK: true, Approval: approval}, nil
	}

	if err == mongo.ErrNoDocuments {
		// Could be not_found or conflict — check current state
		var current bson.M
		findErr := r.approvals.FindOne(ctx, bson.M{"id": input.ID}, options.FindOne().SetProjection(bson.M{"_id": 0})).Decode(&current)
		if findErr == mongo.ErrNoDocuments {
			return &TransitionResult{OK: false, Reason: "not_found"}, nil
		}
		if findErr != nil {
			return nil, fmt.Errorf("approval find after CAS miss: %w", findErr)
		}
		approval := normalizeApproval(current)
		return &TransitionResult{OK: false, Reason: "conflict", Approval: approval}, nil
	}

	return nil, fmt.Errorf("approval CAS: %w", err)
}

// generateEventID creates a UUIDv4 for approval lifecycle events.
// Matches Node crypto.randomUUID() exactly.
// Distinct from audit eventId which uses EVT-{UUID} format.
func generateEventID() string {
	return audit.GenerateUUID()
}

// AuditTransition writes a strict audit log for an approval transition.
// Receives the full HTTP request to capture source IP, user-agent,
// request method/path, requestId, correlationId, and x-operation-reason.
// On audit failure, sets committed=true (the in-document event is already durable).
// Never attempts rollback. Matches Node auditTransition() exactly.
func AuditTransition(r *http.Request, writer StrictAuditWriter, action string, before, after *ApprovalDocument, actor GovernanceActor, reason string) error {
	afterEvent := interface{}(nil)
	if len(after.Events) > 0 {
		afterEvent = after.Events[len(after.Events)-1]
	}

	// Extract request context for audit (source IP, user-agent, method, path, IDs)
	source, request, reqReason := audit.AuditRequestContext(r)

	// Reason fallback: explicit reason, then x-operation-reason header
	effectiveReason := reason
	if effectiveReason == "" {
		effectiveReason = reqReason
	}

	input := audit.WriteAuditInput{
		Action: action,
		Module: "approvals",
		Actor: audit.ActorInput{
			Type:     actor.Type,
			UserID:   actor.UserID,
			Username: actor.Username,
			Role:     actor.Role,
		},
		Resource: &audit.ResourceInput{
			Type: "approval",
			ID:   after.ID,
			Name: after.ChangeID,
		},
		TargetID:   "approval:" + after.ID,
		Source:     source,
		Request:    request,
		ApprovalID: after.ID,
		RiskLevel:  string(after.RiskLevel),
		Result:     "success",
		Before:     map[string]interface{}{"status": string(before.Status)},
		After:      map[string]interface{}{"status": string(after.Status), "event": afterEvent},
		Reason:     effectiveReason,
	}

	err := writer.WriteStrict(r.Context(), input)
	if err != nil {
		// The in-document event is already durable. Never rollback.
		return &ApprovalWorkflowError{
			Code:      "AUDIT_UNAVAILABLE",
			Status:    503,
			Approval:  after,
			Committed: true,
		}
	}
	return nil
}
