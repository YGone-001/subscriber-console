package approval

import (
	"fmt"
	"net/http"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
)

// CreatorResult holds the outcome of an approval creation attempt.
type CreatorResult struct {
	Approval *ApprovalDocument
	Error    error
}

// ApprovalCreator is a reusable service for creating approval requests.
// It delegates to the repository for persistence and writes a strict audit log.
// This service will later be reused by Subscriber/OCS governance routes.
type ApprovalCreator struct {
	repo   *Repository
	writer *audit.Writer
}

// NewApprovalCreator creates a new ApprovalCreator.
func NewApprovalCreator(repo *Repository, writer *audit.Writer) *ApprovalCreator {
	return &ApprovalCreator{repo: repo, writer: writer}
}

// Create creates an approval request and writes a strict audit log.
// If the audit write fails, returns AUDIT_UNAVAILABLE with committed=true.
// Never rolls back the approval insert.
func (c *ApprovalCreator) Create(r *http.Request, p *auth.Principal, input CreateApprovalInput) (*ApprovalDocument, error) {
	approval, err := c.repo.CreateApprovalRequest(r.Context(), input)
	if err != nil {
		return nil, err
	}

	// Strict audit — committed=true on failure
	source, request, reqReason := audit.AuditRequestContext(r)
	effectiveReason := input.Reason
	if effectiveReason == "" {
		effectiveReason = reqReason
	}

	auditInput := audit.WriteAuditInput{
		Action: "approval.create",
		Module: "approvals",
		Actor: audit.ActorInput{
			Type:     "user",
			UserID:   p.UserID,
			Username: p.Username,
			Role:     p.NormalizedRole,
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
		After:      map[string]interface{}{"status": string(approval.Status)},
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
