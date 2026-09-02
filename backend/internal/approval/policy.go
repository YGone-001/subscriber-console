package approval

import "github.com/YGone-001/subscriber-console/backend/internal/auth"

// ApprovalActionEligibilityInput is the context needed to compute action eligibility.
type ApprovalActionEligibilityInput struct {
	Status    ApprovalStatus
	RiskLevel RiskLevel
	Requester string
	ActorUser string
	ActorRole string
}

// ComputeActionEligibility determines what actions the actor can perform on an approval.
// Matches Node approvalActionEligibility() exactly.
//
// This is a READ POLICY VIEW — it is not authority to mutate.
func ComputeActionEligibility(approval ApprovalDocument, actorUser, actorRole string) ApprovalActionEligibility {
	pending := approval.Status == StatusPending
	independent := RequiresIndependentReviewer(approval.RiskLevel)
	selfReviewBlocked := independent && approval.Requester == actorUser

	canApprove := pending && hasPermission(actorRole, "approvals.approve") && !selfReviewBlocked
	canReject := pending && hasPermission(actorRole, "approvals.reject") && !selfReviewBlocked
	canCancel := pending && hasPermission(actorRole, "approvals.cancel") && approval.Requester == actorUser
	canExecute := approval.Status == StatusApproved && hasPermission(actorRole, "approvals.execute")

	return ApprovalActionEligibility{
		CanApprove:    canApprove,
		ApproveReason: approveReason(approval.Status, pending, actorRole, selfReviewBlocked),
		CanReject:     canReject,
		RejectReason:  rejectReason(approval.Status, pending, actorRole, selfReviewBlocked),
		CanCancel:     canCancel,
		CancelReason:  cancelReason(approval.Status, pending, approval.Requester, actorUser, actorRole),
		CanExecute:    canExecute,
		ExecuteReason: executeReason(approval.Status, actorRole),
	}
}

func hasPermission(role, permission string) bool {
	// Use the auth package's permission check
	p := &auth.Principal{NormalizedRole: role}
	return auth.HasPermission(p, permission)
}

func approveReason(status ApprovalStatus, pending bool, role string, selfReviewBlocked bool) string {
	if !pending {
		return "Approval is not pending"
	}
	if !hasPermission(role, "approvals.approve") {
		return "Missing approvals.approve permission"
	}
	if selfReviewBlocked {
		return "Independent reviewer required"
	}
	return ""
}

func rejectReason(status ApprovalStatus, pending bool, role string, selfReviewBlocked bool) string {
	if !pending {
		return "Approval is not pending"
	}
	if !hasPermission(role, "approvals.reject") {
		return "Missing approvals.reject permission"
	}
	if selfReviewBlocked {
		return "Independent reviewer required"
	}
	return ""
}

func cancelReason(status ApprovalStatus, pending bool, requester, actor, role string) string {
	if !pending {
		return "Only pending requests can be cancelled"
	}
	if !hasPermission(role, "approvals.cancel") {
		return "Missing approvals.cancel permission"
	}
	if requester != actor {
		return "Only the requester can cancel this request"
	}
	return ""
}

func executeReason(status ApprovalStatus, role string) string {
	if status != StatusApproved {
		return "Only approved changes can be executed"
	}
	if !hasPermission(role, "approvals.execute") {
		return "Missing approvals.execute permission"
	}
	return ""
}
