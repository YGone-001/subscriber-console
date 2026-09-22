package balance

import (
	"testing"

	"subscriber/internal/governance"
)

func TestCheckInvariants(t *testing.T) {
	rec := BalanceRecord{
		DataTotal:      1000,
		DataUsed:       200,
		DataReserved:   300,
		DataAvailable:  500,
		VoiceTotal:     3600,
		VoiceUsed:      600,
		VoiceReserved:  0,
		VoiceAvailable: 3000,
		SmsTotal:       100,
		SmsUsed:        10,
		SmsAvailable:   90,
	}
	rec.CheckInvariants()
	if !rec.InvariantOk || !rec.DataInvariantOk || !rec.VoiceInvariantOk || !rec.SmsInvariantOk {
		t.Errorf("expected all invariants to hold, got %+v", rec)
	}

	// Broken data invariant
	recBroken := rec
	recBroken.DataAvailable = 400
	recBroken.CheckInvariants()
	if recBroken.InvariantOk || recBroken.DataInvariantOk {
		t.Errorf("expected broken data invariant, got %+v", recBroken)
	}
}

func TestFingerprint(t *testing.T) {
	rec := BalanceRecord{
		IMSI:           "417010000000001",
		DataAvailable:  1073741824,
		VoiceAvailable: 3600,
		SmsAvailable:   100,
		Version:        3,
	}
	fp := rec.Fingerprint()
	if fp.IMSI != "417010000000001" || fp.DataBalance != 1073741824 || fp.VoiceBalance != 3600 || fp.SmsBalance != 100 || fp.Version != 3 {
		t.Errorf("unexpected fingerprint: %+v", fp)
	}
}

func TestEvaluateOperation_GovernanceRoles(t *testing.T) {
	// Adjust: super_admin / root -> DIRECT
	resRoot := EvaluateOperation(OpAdjust, "root")
	if resRoot.Decision != governance.Direct {
		t.Errorf("expected root to get DIRECT, got %+v", resRoot)
	}

	resSuperAdmin := EvaluateOperation(OpAdjust, "super_admin")
	if resSuperAdmin.Decision != governance.Direct {
		t.Errorf("expected super_admin to get DIRECT, got %+v", resSuperAdmin)
	}

	// Adjust: operator / ops_admin -> DIRECT (Phase 5.7-A)
	resOperator := EvaluateOperation(OpAdjust, "operator")
	if resOperator.Decision != governance.Direct {
		t.Errorf("expected operator to get DIRECT, got %+v", resOperator)
	}

	resOpsAdmin := EvaluateOperation(OpAdjust, "ops_admin")
	if resOpsAdmin.Decision != governance.Direct {
		t.Errorf("expected ops_admin to get DIRECT, got %+v", resOpsAdmin)
	}

	// Reset: always DISABLED, even for super_admin
	resResetRoot := EvaluateOperation(OpReset, "root")
	if resResetRoot.Decision != governance.Disabled {
		t.Errorf("expected reset to be DISABLED for root, got %+v", resResetRoot)
	}

	resResetAdmin := EvaluateOperation(OpReset, "super_admin")
	if resResetAdmin.Decision != governance.Disabled {
		t.Errorf("expected reset to be DISABLED for super_admin, got %+v", resResetAdmin)
	}

	resResetOp := EvaluateOperation(OpReset, "operator")
	if resResetOp.Decision != governance.Disabled {
		t.Errorf("expected reset to be DISABLED for operator, got %+v", resResetOp)
	}
}
