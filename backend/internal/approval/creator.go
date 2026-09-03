package approval

import (
	"context"
	"fmt"
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
)

// ApprovalCreateStore abstracts approval persistence for creator testing.
// Production: *Repository satisfies this.
type ApprovalCreateStore interface {
	CreateApprovalRequest(ctx context.Context, input CreateApprovalInput) (*ApprovalDocument, error)
}

// ApprovalCreator is a reusable service for creating approval requests.
// It delegates to the repository for persistence and writes a strict audit log.
// This service will later be reused by Subscriber/OCS governance routes.
type ApprovalCreator struct {
	repo   ApprovalCreateStore
	writer StrictAuditWriter
}

// NewApprovalCreator creates a new ApprovalCreator.
func NewApprovalCreator(repo *Repository, writer *audit.Writer) *ApprovalCreator {
	return &ApprovalCreator{repo: repo, writer: writer}
}

// NewApprovalCreatorWithDeps creates an ApprovalCreator with abstract dependencies for testing.
func NewApprovalCreatorWithDeps(repo ApprovalCreateStore, writer StrictAuditWriter) *ApprovalCreator {
	return &ApprovalCreator{repo: repo, writer: writer}
}

// Create creates an approval request and writes a strict audit log.
// Uses a fresh GovernanceActor for audit authority (not a possibly stale Principal).
// If the audit write fails, returns AUDIT_UNAVAILABLE with committed=true.
// Never rolls back the approval insert.
func (c *ApprovalCreator) Create(r *http.Request, actor GovernanceActor, input CreateApprovalInput) (*ApprovalDocument, error) {
	approval, err := c.repo.CreateApprovalRequest(r.Context(), input)
	if err != nil {
		return nil, err
	}

	// Strict audit — committed=true on failure
	source, request, reqReason := audit.AuditRequestContext(r)
	effectiveReason := ""
	if input.Reason != nil {
		effectiveReason = *input.Reason
	}
	if effectiveReason == "" {
		effectiveReason = reqReason
	}

	auditInput := audit.WriteAuditInput{
		Action: "approval.create",
		Module: "approvals",
		Actor: audit.ActorInput{
			Type:     actor.Type,
			UserID:   actor.UserID,
			Username: actor.Username,
			Role:     actor.Role,
		},
		Resource: &audit.ResourceInput{
			Type: "approval",
			ID:   approval.ID,
			Name: approval.ChangeID,
		},
		TargetID:   fmt.Sprintf("approval:%s", approval.ID),
		Source:     source,
		Request:    request,
		ApprovalID: approval.ID,
		RiskLevel:  string(approval.RiskLevel),
		Result:     "success",
		Before:     nil,
		After:      approvalToAuditSnapshot(approval),
		Reason:     effectiveReason,
	}

	if auditErr := c.writer.WriteStrict(r.Context(), auditInput); auditErr != nil {
		return approval, &ApprovalWorkflowError{
			Code:      "AUDIT_UNAVAILABLE",
			Status:    http.StatusServiceUnavailable,
			Approval:  approval,
			Committed: true,
		}
	}

	return approval, nil
}

// approvalToAuditSnapshot builds a safe audit snapshot of the full approval document.
// Includes all non-secret fields. Subject to existing sanitizer.
func approvalToAuditSnapshot(a *ApprovalDocument) map[string]interface{} {
	snapshot := map[string]interface{}{
		"id":                   a.ID,
		"changeId":             a.ChangeID,
		"title":                a.Title,
		"action":               a.Action,
		"status":               string(a.Status),
		"operation":            a.Operation,
		"operationFingerprint": a.OperationFingerprint,
		"riskLevel":            string(a.RiskLevel),
		"riskAssessment":       a.RiskAssessment,
		"requester":            a.Requester,
		"requesterContext":     a.RequesterContext,
		"targetId":             a.TargetID,
		"summary":              a.Summary,
		"reason":               a.Reason,
		"before":               a.Before,
		"after":                a.After,
		"payload":              a.Payload,
		"events":               a.Events,
		"createdAt":            a.CreatedAt,
		"updatedAt":            a.UpdatedAt,
		"expiresAt":            a.ExpiresAt,
	}
	if a.Description != "" {
		snapshot["description"] = a.Description
	}
	if a.TicketID != "" {
		snapshot["ticketId"] = a.TicketID
	}
	if a.MaintenanceWindow != nil {
		snapshot["maintenanceWindow"] = a.MaintenanceWindow
	}
	return audit.SanitizePayload(snapshot).(map[string]interface{})
}
