package approval

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/YGone-001/subscriber-console/backend/internal/audit"
	"github.com/YGone-001/subscriber-console/backend/internal/auth"
	"github.com/YGone-001/subscriber-console/backend/internal/user"
)

// Workflow orchestrates approval decision transitions.
type Workflow struct {
	repo   DecisionStore
	users  IdentityReader
	writer StrictAuditWriter
}

// NewWorkflow creates a new approval Workflow.
func NewWorkflow(repo *Repository, users *user.Repository, writer *audit.Writer) *Workflow {
	return &Workflow{repo: repo, users: users, writer: writer}
}

// NewWorkflowWithDeps creates a Workflow with abstract dependencies for testing.
func NewWorkflowWithDeps(repo DecisionStore, users IdentityReader, writer StrictAuditWriter) *Workflow {
	return &Workflow{repo: repo, users: users, writer: writer}
}

// cleanOptionalText validates and trims optional text input.
// Returns the trimmed text or empty string. Throws APPROVAL_TEXT_TOO_LONG if over max.
// Matches Node cleanOptionalText() exactly.
func cleanOptionalText(value string, max int) (string, error) {
	text := strings.TrimSpace(value)
	if len(text) > max {
		return "", &ApprovalWorkflowError{Code: "APPROVAL_TEXT_TOO_LONG", Status: http.StatusBadRequest}
	}
	return text, nil
}

// currentActor revalidates the actor against app_users.
// Returns a GovernanceActor with userId (Mongo _id or username fallback),
// username, role from the database.
// Matches Node: userId = String(account._id ?? account.username)
func (w *Workflow) currentActor(ctx context.Context, p *auth.Principal) (*GovernanceActor, error) {
	identity, err := w.users.FindByUsernameIdentity(ctx, p.Username)
	if err != nil {
		return nil, &ApprovalWorkflowError{Code: "AUTH_INVALID_TOKEN", Status: http.StatusUnauthorized}
	}
	if identity == nil {
		return nil, &ApprovalWorkflowError{Code: "ACCOUNT_NOT_FOUND", Status: http.StatusUnauthorized}
	}
	su := &identity.SafeUser
	if su.Locked || su.Status == "locked" {
		return nil, &ApprovalWorkflowError{Code: "ACCOUNT_LOCKED", Status: http.StatusUnauthorized}
	}
	if su.Status != "active" {
		return nil, &ApprovalWorkflowError{Code: "ACCOUNT_DISABLED", Status: http.StatusUnauthorized}
	}
	// Validate session version and role consistency
	dbSV := 0
	if su.Security != nil {
		dbSV = su.Security.SessionVersion
	}
	if int64(dbSV) != p.SessionVersion {
		return nil, &ApprovalWorkflowError{Code: "SESSION_REVOKED", Status: http.StatusUnauthorized}
	}
	dbRole := auth.NormalizeRole(su.Role)
	if dbRole == "" || dbRole != p.NormalizedRole {
		return nil, &ApprovalWorkflowError{Code: "SESSION_REVOKED", Status: http.StatusUnauthorized}
	}

	return &GovernanceActor{
		Type:     "user",
		UserID:   identity.MongoID,
		Username: su.Username,
		Role:     su.Role,
	}, nil
}

// loadPending loads an approval and handles expiry.
// If the approval is pending and past expiresAt, CAS to expired.
// Matches Node loadPending() exactly.
func (w *Workflow) loadPending(ctx context.Context, id string) (*ApprovalDocument, error) {
	approval, err := w.repo.GetApproval(ctx, id)
	if err != nil {
		return nil, err
	}
	if approval == nil {
		return nil, &ApprovalWorkflowError{Code: "APPROVAL_NOT_FOUND", Status: http.StatusNotFound}
	}

	// Check expiry for pending approvals
	if approval.Status == StatusPending && approval.ExpiresAt != "" {
		expiry, parseErr := parseTimestamp(approval.ExpiresAt)
		if parseErr == nil && !expiry.IsZero() && expiry.Before(nowUTC()) {
			// CAS pending → expired
			result, casErr := w.repo.TransitionApproval(ctx, TransitionInput{
				ID:             id,
				ExpectedStatus: StatusPending,
				NextStatus:     StatusExpired,
				Actor:          "system",
				EventType:      "expired",
				EventMessage:   "Approval expired before a decision",
			})
			if casErr != nil {
				return nil, casErr
			}
			if result.OK {
				return nil, &ApprovalWorkflowError{Code: "APPROVAL_EXPIRED", Status: http.StatusConflict, Approval: result.Approval}
			}
			// CAS failed — another actor transitioned it; reload
			if result.Approval != nil {
				return result.Approval, nil
			}
		}
	}

	return approval, nil
}

// ApproveChange executes the approve workflow.
// Receives the canonical comment field (already extracted by handler with nullish semantics).
// The workflow does NOT know about legacy "note" fallback.
// Matches Node approveChange() exactly.
func (w *Workflow) ApproveChange(r *http.Request, id string, p *auth.Principal, comment string) (*ApprovalDocument, error) {
	approval, err := w.loadPending(r.Context(), id)
	if err != nil {
		return nil, err
	}

	eligibility := ComputeActionEligibility(*approval, p.Username, p.NormalizedRole)
	if !eligibility.CanApprove {
		code := "APPROVAL_STATE_CONFLICT"
		status := http.StatusConflict
		if approval.Status == StatusPending {
			code = "MAKER_CHECKER_VIOLATION"
			status = http.StatusForbidden
		}
		return nil, &ApprovalWorkflowError{Code: code, Status: status, Approval: approval}
	}

	actor, err := w.currentActor(r.Context(), p)
	if err != nil {
		return nil, err
	}

	comment, err = cleanOptionalText(comment, 1000)
	if err != nil {
		return nil, err
	}

	now := nowUTC().Format("2006-01-02T15:04:05.000Z")
	patch := map[string]interface{}{
		"reviewer":        p.Username,
		"reviewerContext": actor,
		"reviewedAt":      now,
		"note":            comment,
		"decision": map[string]interface{}{
			"outcome":   "approved",
			"comment":   comment,
			"decidedAt": now,
		},
	}

	eventMessage := "Change approved"
	if comment != "" {
		eventMessage = "Change approved: " + comment
	}

	result, err := w.repo.TransitionApproval(r.Context(), TransitionInput{
		ID:             id,
		ExpectedStatus: StatusPending,
		NextStatus:     StatusApproved,
		Actor:          p.Username,
		EventType:      "approved",
		EventMessage:   eventMessage,
		Patch:          patch,
	})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		code := "APPROVAL_STATE_CONFLICT"
		status := http.StatusConflict
		if result.Reason == "not_found" {
			code = "APPROVAL_NOT_FOUND"
			status = http.StatusNotFound
		}
		return nil, &ApprovalWorkflowError{Code: code, Status: status, Approval: result.Approval}
	}

	// Strict audit — committed=true on failure
	if auditErr := AuditTransition(r, w.writer, "approval.approve", approval, result.Approval, *actor, comment); auditErr != nil {
		return result.Approval, auditErr
	}

	return result.Approval, nil
}

// RejectChange executes the reject workflow.
// Receives the canonical reason field (already extracted by handler with nullish semantics).
// The workflow does NOT know about legacy "note" fallback.
// Matches Node rejectChange() exactly.
func (w *Workflow) RejectChange(r *http.Request, id string, p *auth.Principal, reason string) (*ApprovalDocument, error) {
	reason, err := cleanOptionalText(reason, 1000)
	if err != nil {
		return nil, err
	}
	if reason == "" || len(reason) < 3 {
		return nil, &ApprovalWorkflowError{Code: "REJECTION_REASON_REQUIRED", Status: http.StatusBadRequest}
	}

	approval, err := w.loadPending(r.Context(), id)
	if err != nil {
		return nil, err
	}

	eligibility := ComputeActionEligibility(*approval, p.Username, p.NormalizedRole)
	if !eligibility.CanReject {
		code := "APPROVAL_STATE_CONFLICT"
		status := http.StatusConflict
		if approval.Status == StatusPending {
			code = "MAKER_CHECKER_VIOLATION"
			status = http.StatusForbidden
		}
		return nil, &ApprovalWorkflowError{Code: code, Status: status, Approval: approval}
	}

	actor, err := w.currentActor(r.Context(), p)
	if err != nil {
		return nil, err
	}

	now := nowUTC().Format("2006-01-02T15:04:05.000Z")
	patch := map[string]interface{}{
		"reviewer":        p.Username,
		"reviewerContext": actor,
		"reviewedAt":      now,
		"note":            reason,
		"decision": map[string]interface{}{
			"outcome":   "rejected",
			"comment":   reason,
			"decidedAt": now,
		},
	}

	result, err := w.repo.TransitionApproval(r.Context(), TransitionInput{
		ID:             id,
		ExpectedStatus: StatusPending,
		NextStatus:     StatusRejected,
		Actor:          p.Username,
		EventType:      "rejected",
		EventMessage:   "Change rejected: " + reason,
		Patch:          patch,
	})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		code := "APPROVAL_STATE_CONFLICT"
		status := http.StatusConflict
		if result.Reason == "not_found" {
			code = "APPROVAL_NOT_FOUND"
			status = http.StatusNotFound
		}
		return nil, &ApprovalWorkflowError{Code: code, Status: status, Approval: result.Approval}
	}

	// Strict audit — committed=true on failure
	if auditErr := AuditTransition(r, w.writer, "approval.reject", approval, result.Approval, *actor, reason); auditErr != nil {
		return result.Approval, auditErr
	}

	return result.Approval, nil
}

// CancelChange executes the cancel workflow.
// Receives the canonical reason field (already extracted by handler with nullish semantics).
// The workflow does NOT know about legacy "note" fallback.
// Matches Node cancelChange() exactly.
func (w *Workflow) CancelChange(r *http.Request, id string, p *auth.Principal, reason string) (*ApprovalDocument, error) {
	approval, err := w.loadPending(r.Context(), id)
	if err != nil {
		return nil, err
	}

	eligibility := ComputeActionEligibility(*approval, p.Username, p.NormalizedRole)
	if !eligibility.CanCancel {
		code := "APPROVAL_STATE_CONFLICT"
		status := http.StatusConflict
		if approval.Status == StatusPending {
			code = "APPROVAL_CANCEL_FORBIDDEN"
			status = http.StatusForbidden
		}
		return nil, &ApprovalWorkflowError{Code: code, Status: status, Approval: approval}
	}

	actor, err := w.currentActor(r.Context(), p)
	if err != nil {
		return nil, err
	}

	reason, err = cleanOptionalText(reason, 1000)
	if err != nil {
		return nil, err
	}

	eventMessage := "Change cancelled by requester"
	if reason != "" {
		eventMessage = "Change cancelled: " + reason
	}

	patch := map[string]interface{}{}
	if reason != "" {
		patch["note"] = reason
	}

	result, err := w.repo.TransitionApproval(r.Context(), TransitionInput{
		ID:             id,
		ExpectedStatus: StatusPending,
		NextStatus:     StatusCancelled,
		Actor:          p.Username,
		EventType:      "cancelled",
		EventMessage:   eventMessage,
		Patch:          patch,
	})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		code := "APPROVAL_STATE_CONFLICT"
		status := http.StatusConflict
		if result.Reason == "not_found" {
			code = "APPROVAL_NOT_FOUND"
			status = http.StatusNotFound
		}
		return nil, &ApprovalWorkflowError{Code: code, Status: status, Approval: result.Approval}
	}

	// Strict audit — committed=true on failure
	if auditErr := AuditTransition(r, w.writer, "approval.cancel", approval, result.Approval, *actor, reason); auditErr != nil {
		return result.Approval, auditErr
	}

	return result.Approval, nil
}

// parseTimestamp parses an ISO 8601 timestamp string.
func parseTimestamp(s string) (time.Time, error) {
	formats := []string{
		"2006-01-02T15:04:05.000Z",
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05.000",
		"2006-01-02T15:04:05",
		time.RFC3339,
		time.RFC3339Nano,
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unparseable timestamp: %s", s)
}

func nowUTC() time.Time {
	return time.Now().UTC()
}
