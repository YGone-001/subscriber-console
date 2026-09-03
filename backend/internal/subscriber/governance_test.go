package subscriber

import (
	"testing"

	"github.com/YGone-001/subscriber-console/backend/internal/governance"
)

func TestSubscriberGovernance_Create_Direct(t *testing.T) {
	roles := []string{"operator", "ops_admin", "super_admin", "root"}
	for _, role := range roles {
		t.Run(role+"/CREATE", func(t *testing.T) {
			r := EvaluateOperation(OpCreate, role)
			if r.Decision != governance.Direct {
				t.Errorf("%s + SUBSCRIBER_CREATE = %s, want DIRECT_GOVERNED", role, r.Decision)
			}
			if r.ApprovalRequired {
				t.Errorf("%s + SUBSCRIBER_CREATE: approvalRequired = true, want false", role)
			}
		})
	}
}

func TestSubscriberGovernance_Update_OperatorApproval(t *testing.T) {
	roles := []string{"operator", "ops_admin"}
	for _, role := range roles {
		t.Run(role+"/UPDATE", func(t *testing.T) {
			r := EvaluateOperation(OpUpdate, role)
			if r.Decision != governance.Approval {
				t.Errorf("%s + SUBSCRIBER_UPDATE = %s, want APPROVAL_GOVERNED", role, r.Decision)
			}
			if !r.ApprovalRequired {
				t.Errorf("%s + SUBSCRIBER_UPDATE: approvalRequired = false, want true", role)
			}
		})
	}
}

func TestSubscriberGovernance_Update_SuperAdminDirect(t *testing.T) {
	roles := []string{"super_admin", "root"}
	for _, role := range roles {
		t.Run(role+"/UPDATE", func(t *testing.T) {
			r := EvaluateOperation(OpUpdate, role)
			if r.Decision != governance.Direct {
				t.Errorf("%s + SUBSCRIBER_UPDATE = %s, want DIRECT_GOVERNED", role, r.Decision)
			}
			if r.ApprovalRequired {
				t.Errorf("%s + SUBSCRIBER_UPDATE: approvalRequired = true, want false", role)
			}
		})
	}
}

func TestSubscriberGovernance_Delete_OperatorApproval(t *testing.T) {
	roles := []string{"operator", "ops_admin"}
	for _, role := range roles {
		t.Run(role+"/DELETE", func(t *testing.T) {
			r := EvaluateOperation(OpDelete, role)
			if r.Decision != governance.Approval {
				t.Errorf("%s + SUBSCRIBER_DELETE = %s, want APPROVAL_GOVERNED", role, r.Decision)
			}
		})
	}
}

func TestSubscriberGovernance_Delete_SuperAdminDirect(t *testing.T) {
	roles := []string{"super_admin", "root"}
	for _, role := range roles {
		t.Run(role+"/DELETE", func(t *testing.T) {
			r := EvaluateOperation(OpDelete, role)
			if r.Decision != governance.Direct {
				t.Errorf("%s + SUBSCRIBER_DELETE = %s, want DIRECT_GOVERNED", role, r.Decision)
			}
		})
	}
}

func TestSubscriberGovernance_Unknown_FailClosed(t *testing.T) {
	r := EvaluateOperation("UNKNOWN_SUBSCRIBER_OP", "super_admin")
	if r.Decision != governance.Disabled {
		t.Errorf("unknown + super_admin = %s, want DISABLED", r.Decision)
	}
}

func TestLookupOperation_AllKnown(t *testing.T) {
	ops := []SubscriberOperation{OpCreate, OpUpdate, OpDelete, OpBatchCreate, OpBatchUpdate, OpBulkDelete, OpImport}
	for _, op := range ops {
		def, ok := LookupOperation(op)
		if !ok {
			t.Errorf("LookupOperation(%s) returned false", op)
		}
		if def.Operation != string(op) {
			t.Errorf("Operation = %q, want %q", def.Operation, op)
		}
	}
}

func TestLookupOperation_Unknown(t *testing.T) {
	def, ok := LookupOperation("NONEXISTENT")
	if ok {
		t.Error("LookupOperation should return false for unknown")
	}
	if def.BaseMode != governance.Disabled {
		t.Errorf("BaseMode = %s, want DISABLED", def.BaseMode)
	}
}
