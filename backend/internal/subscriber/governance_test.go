package subscriber

import (
	"testing"

	"subscriber/internal/governance"
)

func TestSubscriberGovernance_Create_Direct(t *testing.T) {
	roles := []string{"operator", "ops_admin", "super_admin", "root", "admin"}
	for _, role := range roles {
		t.Run(role+"/CREATE", func(t *testing.T) {
			r := EvaluateOperation(OpCreate, role)
			if r.Decision != governance.Direct {
				t.Errorf("%s + SUBSCRIBER_CREATE = %s, want DIRECT_GOVERNED", role, r.Decision)
			}
		})
	}
}

func TestSubscriberGovernance_Update_Direct(t *testing.T) {
	roles := []string{"operator", "ops_admin", "super_admin", "root", "admin"}
	for _, role := range roles {
		t.Run(role+"/UPDATE", func(t *testing.T) {
			r := EvaluateOperation(OpUpdate, role)
			if r.Decision != governance.Direct {
				t.Errorf("%s + SUBSCRIBER_UPDATE = %s, want DIRECT_GOVERNED", role, r.Decision)
			}
		})
	}
}

func TestSubscriberGovernance_Delete_Direct(t *testing.T) {
	roles := []string{"operator", "ops_admin", "super_admin", "root", "admin"}
	for _, role := range roles {
		t.Run(role+"/DELETE", func(t *testing.T) {
			r := EvaluateOperation(OpDelete, role)
			if r.Decision != governance.Direct {
				t.Errorf("%s + SUBSCRIBER_DELETE = %s, want DIRECT_GOVERNED", role, r.Decision)
			}
		})
	}
}

func TestSubscriberGovernance_BatchOps_Direct(t *testing.T) {
	ops := []SubscriberOperation{OpBatchCreate, OpBatchUpdate, OpBulkDelete, OpImport, OpProfileApply}
	roles := []string{"operator", "admin"}
	for _, op := range ops {
		for _, role := range roles {
			t.Run(role+"/"+string(op), func(t *testing.T) {
				r := EvaluateOperation(op, role)
				if r.Decision != governance.Direct {
					t.Errorf("%s + %s = %s, want DIRECT_GOVERNED", role, op, r.Decision)
				}
			})
		}
	}
}

func TestSubscriberGovernance_Unknown_FailClosed(t *testing.T) {
	r := EvaluateOperation("UNKNOWN_SUBSCRIBER_OP", "admin")
	if r.Decision != governance.Disabled {
		t.Errorf("unknown + admin = %s, want DISABLED", r.Decision)
	}
}

func TestLookupOperation_AllKnown(t *testing.T) {
	ops := []SubscriberOperation{OpCreate, OpUpdate, OpDelete, OpBatchCreate, OpBatchUpdate, OpBulkDelete, OpImport, OpProfileApply}
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
