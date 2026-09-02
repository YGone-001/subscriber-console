package approval

import "testing"

func TestComputeActionEligibility_MakerChecker_HighRisk_SameRequester(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusPending,
		RiskLevel: RiskHigh,
		Requester: "alice",
	}

	// Same requester with approvals.approve permission (super_admin has it)
	actions := ComputeActionEligibility(approval, "alice", "super_admin")

	if actions.CanApprove {
		t.Error("high risk, same requester: expected canApprove=false")
	}
	if actions.ApproveReason != "Independent reviewer required" {
		t.Errorf("expected 'Independent reviewer required', got '%s'", actions.ApproveReason)
	}
	if actions.CanReject {
		t.Error("high risk, same requester: expected canReject=false")
	}
	if actions.RejectReason != "Independent reviewer required" {
		t.Errorf("expected 'Independent reviewer required', got '%s'", actions.RejectReason)
	}
}

func TestComputeActionEligibility_MakerChecker_CriticalRisk_DifferentReviewer(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusPending,
		RiskLevel: RiskCritical,
		Requester: "alice",
	}

	// Different reviewer with approvals.approve permission (ops_admin)
	actions := ComputeActionEligibility(approval, "bob", "ops_admin")

	if !actions.CanApprove {
		t.Error("critical risk, different reviewer: expected canApprove=true")
	}
	if actions.ApproveReason != "" {
		t.Errorf("expected empty approve reason, got '%s'", actions.ApproveReason)
	}
	if !actions.CanReject {
		t.Error("critical risk, different reviewer: expected canReject=true")
	}
}

func TestComputeActionEligibility_MakerChecker_MediumRisk_SelfReview(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusPending,
		RiskLevel: RiskMedium,
		Requester: "alice",
	}

	// Same requester with approvals.approve permission (super_admin has it)
	actions := ComputeActionEligibility(approval, "alice", "super_admin")

	// Medium risk allows self-review
	if !actions.CanApprove {
		t.Error("medium risk, self review: expected canApprove=true")
	}
	if !actions.CanReject {
		t.Error("medium risk, self review: expected canReject=true")
	}
}

func TestComputeActionEligibility_Cancel_Requester(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusPending,
		RiskLevel: RiskLow,
		Requester: "alice",
	}

	actions := ComputeActionEligibility(approval, "alice", "operator")

	if !actions.CanCancel {
		t.Error("pending, requester actor: expected canCancel=true")
	}
	if actions.CancelReason != "" {
		t.Errorf("expected empty cancel reason, got '%s'", actions.CancelReason)
	}
}

func TestComputeActionEligibility_Cancel_DifferentActor(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusPending,
		RiskLevel: RiskLow,
		Requester: "alice",
	}

	actions := ComputeActionEligibility(approval, "bob", "operator")

	if actions.CanCancel {
		t.Error("different actor: expected canCancel=false")
	}
	if actions.CancelReason != "Only the requester can cancel this request" {
		t.Errorf("expected 'Only the requester can cancel this request', got '%s'", actions.CancelReason)
	}
}

func TestComputeActionEligibility_Execute_Approved(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusApproved,
		RiskLevel: RiskHigh,
		Requester: "alice",
	}

	// ops_admin has approvals.execute
	actions := ComputeActionEligibility(approval, "bob", "ops_admin")

	if !actions.CanExecute {
		t.Error("approved + approvals.execute: expected canExecute=true")
	}
	if actions.ExecuteReason != "" {
		t.Errorf("expected empty execute reason, got '%s'", actions.ExecuteReason)
	}
}

func TestComputeActionEligibility_Execute_Pending(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusPending,
		RiskLevel: RiskHigh,
		Requester: "alice",
	}

	actions := ComputeActionEligibility(approval, "bob", "ops_admin")

	if actions.CanExecute {
		t.Error("pending: expected canExecute=false")
	}
	if actions.ExecuteReason != "Only approved changes can be executed" {
		t.Errorf("expected 'Only approved changes can be executed', got '%s'", actions.ExecuteReason)
	}
}

func TestComputeActionEligibility_Execute_Completed(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusCompleted,
		RiskLevel: RiskHigh,
		Requester: "alice",
	}

	actions := ComputeActionEligibility(approval, "bob", "ops_admin")

	if actions.CanExecute {
		t.Error("completed: expected canExecute=false")
	}
	if actions.ExecuteReason != "Only approved changes can be executed" {
		t.Errorf("expected 'Only approved changes can be executed', got '%s'", actions.ExecuteReason)
	}
}

func TestComputeActionEligibility_MissingPermission(t *testing.T) {
	approval := ApprovalDocument{
		Status:    StatusPending,
		RiskLevel: RiskLow,
		Requester: "alice",
	}

	// viewer does not have approvals.approve
	actions := ComputeActionEligibility(approval, "bob", "viewer")

	if actions.CanApprove {
		t.Error("viewer: expected canApprove=false")
	}
	if actions.ApproveReason != "Missing approvals.approve permission" {
		t.Errorf("expected 'Missing approvals.approve permission', got '%s'", actions.ApproveReason)
	}
}

func TestComputeActionEligibility_AllReasonParity(t *testing.T) {
	// Verify reason strings match Node exactly for all deny paths
	tests := []struct {
		name           string
		approval       ApprovalDocument
		actorUser      string
		actorRole      string
		wantApprReason string
		wantRejReason  string
		wantCancReason string
		wantExecReason string
	}{
		{
			name:           "not pending",
			approval:       ApprovalDocument{Status: StatusCompleted, RiskLevel: RiskLow, Requester: "a"},
			actorUser:      "a",
			actorRole:      "operator",
			wantApprReason: "Approval is not pending",
			wantRejReason:  "Approval is not pending",
			wantCancReason: "Only pending requests can be cancelled",
			wantExecReason: "Only approved changes can be executed",
		},
		{
			name:           "missing permission",
			approval:       ApprovalDocument{Status: StatusPending, RiskLevel: RiskLow, Requester: "a"},
			actorUser:      "b",
			actorRole:      "viewer",
			wantApprReason: "Missing approvals.approve permission",
			wantRejReason:  "Missing approvals.reject permission",
			wantCancReason: "Missing approvals.cancel permission",
			wantExecReason: "Only approved changes can be executed", // status check comes first
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actions := ComputeActionEligibility(tt.approval, tt.actorUser, tt.actorRole)
			if actions.ApproveReason != tt.wantApprReason {
				t.Errorf("approveReason: got %q, want %q", actions.ApproveReason, tt.wantApprReason)
			}
			if actions.RejectReason != tt.wantRejReason {
				t.Errorf("rejectReason: got %q, want %q", actions.RejectReason, tt.wantRejReason)
			}
			if actions.CancelReason != tt.wantCancReason {
				t.Errorf("cancelReason: got %q, want %q", actions.CancelReason, tt.wantCancReason)
			}
			if actions.ExecuteReason != tt.wantExecReason {
				t.Errorf("executeReason: got %q, want %q", actions.ExecuteReason, tt.wantExecReason)
			}
		})
	}
}
