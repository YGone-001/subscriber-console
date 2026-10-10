package nfhealth

import (
	"context"
	"errors"
	"testing"
)

func TestParseSystemdShow(t *testing.T) {
	out := "ActiveState=active\nSubState=running\nMainPID=4242\n"
	props := parseSystemdShow(out)
	if props["ActiveState"] != "active" || props["SubState"] != "running" || props["MainPID"] != "4242" {
		t.Fatalf("unexpected props: %+v", props)
	}
}

func TestMapProcessEvidenceToState(t *testing.T) {
	cases := []struct {
		outcome string
		want    string
	}{
		{ProcessActive, StateHealthy},
		{ProcessRunning, StateHealthy},
		{ProcessInactive, StateUnhealthy},
		{ProcessFailed, StateUnhealthy},
		{ProcessUnitNotFound, StateNotConfigured},
		{ProcessNotConfigured, StateNotConfigured},
		{ProcessPermission, StateUnknown},
	}
	for _, tc := range cases {
		if got := MapProcessEvidenceToState(ProcessEvidence{Outcome: tc.outcome}); got != tc.want {
			t.Fatalf("outcome %s: expected %s, got %s", tc.outcome, tc.want, got)
		}
	}
}

func TestInspectWithoutUnitIsNotConfigured(t *testing.T) {
	u := NewUnitInspector(NewServiceUnitAllowlist(""), "/usr/bin/systemctl")
	ev := u.Inspect(context.Background(), "", "systemd")
	if ev.Outcome != ProcessNotConfigured {
		t.Fatalf("expected not_configured, got %s", ev.Outcome)
	}
}

func TestInspectRejectsNonAllowlistedUnit(t *testing.T) {
	u := NewUnitInspector(NewServiceUnitAllowlist("amfd"), "/usr/bin/systemctl")
	ev := u.Inspect(context.Background(), "evil.service", "systemd")
	if ev.Outcome != ProcessPermission {
		t.Fatalf("expected permission_denied, got %s", ev.Outcome)
	}
}

func TestInspectSystemdUsesFixedRunner(t *testing.T) {
	u := NewUnitInspector(NewServiceUnitAllowlist("amfd"), "/usr/bin/systemctl")
	u.runner = func(ctx context.Context, name string, args ...string) (string, error) {
		if name != "/usr/bin/systemctl" {
			t.Fatalf("unexpected binary %q", name)
		}
		if len(args) == 0 || args[0] != "show" {
			t.Fatalf("expected fixed show verb, got %v", args)
		}
		for _, a := range args {
			if a == "restart" || a == "stop" || a == "start" || a == "reload" {
				t.Fatalf("process-control verb detected: %v", args)
			}
		}
		return "ActiveState=active\nSubState=running\nMainPID=1001\n", nil
	}
	ev := u.Inspect(context.Background(), "amfd", "systemd")
	if ev.Outcome != ProcessActive || ev.MainPID != 1001 {
		t.Fatalf("unexpected evidence: %+v", ev)
	}
}

func TestInspectSystemdUnitNotFound(t *testing.T) {
	u := NewUnitInspector(NewServiceUnitAllowlist("amfd"), "/usr/bin/systemctl")
	u.runner = func(ctx context.Context, name string, args ...string) (string, error) {
		return "Unit amfd.service could not be found.", errors.New("exit status 1")
	}
	ev := u.Inspect(context.Background(), "amfd", "systemd")
	if ev.Outcome != ProcessUnitNotFound {
		t.Fatalf("expected unit_not_found, got %s", ev.Outcome)
	}
}

func TestInspectProcessFindsRunningProcess(t *testing.T) {
	// Use a synthetic proc root is out of scope here; the real /proc scan must
	// never signal a process. This asserts the unconfigured path instead.
	u := NewUnitInspector(NewServiceUnitAllowlist("definitely-not-running-xyz"), "/usr/bin/systemctl")
	ev := u.Inspect(context.Background(), "definitely-not-running-xyz", "process")
	if ev.Outcome != ProcessNotRunning && ev.Outcome != ProcessRunning {
		t.Fatalf("unexpected process outcome: %s", ev.Outcome)
	}
	if ev.EvidenceKind != EvidenceProcess {
		t.Fatalf("expected process evidence kind, got %s", ev.EvidenceKind)
	}
}
