package nfhealth

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// makeProcEntry writes a fake /proc/<pid> directory with the given comm value
// and optional executable symlink target. A dangling target still yields a
// readable link; an absent exe entry simulates an unverifiable identity.
func makeProcEntry(t *testing.T, root string, pid int, comm string, exeTarget *string) {
	t.Helper()
	dir := filepath.Join(root, itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir proc entry: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o644); err != nil {
		t.Fatalf("write comm: %v", err)
	}
	if exeTarget != nil {
		if err := os.Symlink(*exeTarget, filepath.Join(dir, "exe")); err != nil {
			t.Fatalf("symlink exe: %v", err)
		}
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var digits []byte
	for v > 0 {
		digits = append([]byte{byte('0' + v%10)}, digits...)
		v /= 10
	}
	return string(digits)
}

func newTestInspector(t *testing.T, procRoot string) *UnitInspector {
	t.Helper()
	inspector := NewUnitInspector(NewServiceUnitAllowlist("amfd,pcscfd,mmed,sgwcd.service,icscfd"), "")
	inspector.procRoot = procRoot
	return inspector
}

func TestInspectProcessRequiresExactNameAndExecutableIdentity(t *testing.T) {
	root := t.TempDir()
	makeProcEntry(t, root, 101, "amfd", strPtr("/usr/bin/amfd"))
	makeProcEntry(t, root, 102, "unrelatedd", strPtr("/usr/bin/unrelatedd"))
	inspector := newTestInspector(t, root)

	ev := inspector.Inspect(context.Background(), "amfd", "process")
	if ev.Outcome != ProcessRunning || ev.MainPID != 101 {
		t.Fatalf("expected verified running amfd on pid 101, got %+v", ev)
	}
	if ev.ExePath != "/usr/bin/amfd" {
		t.Fatalf("expected recorded exe path, got %q", ev.ExePath)
	}
	if MapProcessEvidenceToState(ev) != StateHealthy {
		t.Fatal("verified running process must map to healthy")
	}
}

func TestInspectProcessRejectsPrefixAndSuffixVariants(t *testing.T) {
	root := t.TempDir()
	makeProcEntry(t, root, 201, "pcscfd-test", strPtr("/usr/bin/pcscfd-test"))
	makeProcEntry(t, root, 202, "pcscfd-old", strPtr("/usr/bin/pcscfd-old"))
	makeProcEntry(t, root, 203, "pcscfd2", strPtr("/usr/bin/pcscfd2"))
	makeProcEntry(t, root, 204, "mmed-helper", strPtr("/usr/bin/mmed-helper"))
	makeProcEntry(t, root, 205, "amfd-debug", strPtr("/usr/bin/amfd-debug"))
	inspector := newTestInspector(t, root)

	for _, unit := range []string{"pcscfd", "mmed", "amfd"} {
		ev := inspector.Inspect(context.Background(), unit, "process")
		if ev.Outcome != ProcessNotRunning {
			t.Fatalf("unit %s must not match a prefix/suffix variant, got %+v", unit, ev)
		}
		if MapProcessEvidenceToState(ev) == StateHealthy {
			t.Fatalf("unit %s must never classify a variant as healthy", unit)
		}
	}
}

func TestInspectProcessRejectsMasqueradingExecutable(t *testing.T) {
	root := t.TempDir()
	// comm claims the approved identity, but the executable is unrelated.
	makeProcEntry(t, root, 301, "mmed", strPtr("/tmp/evil-worker"))
	inspector := newTestInspector(t, root)

	ev := inspector.Inspect(context.Background(), "mmed", "process")
	if ev.Outcome != ProcessNotRunning {
		t.Fatalf("masquerading executable must not match, got %+v", ev)
	}
}

func TestInspectProcessReportsUnverifiedIdentityAsUnknown(t *testing.T) {
	root := t.TempDir()
	// Name matches but the executable link cannot be read.
	makeProcEntry(t, root, 401, "amfd", nil)
	inspector := newTestInspector(t, root)

	ev := inspector.Inspect(context.Background(), "amfd", "process")
	if ev.Outcome != ProcessUnverified {
		t.Fatalf("expected unverified outcome, got %+v", ev)
	}
	if MapProcessEvidenceToState(ev) != StateUnknown {
		t.Fatal("unverifiable identity must never be healthy")
	}
}

func TestInspectProcessPrefersVerifiedMatchOverUnverified(t *testing.T) {
	root := t.TempDir()
	makeProcEntry(t, root, 501, "amfd", nil)
	makeProcEntry(t, root, 502, "amfd", strPtr("/usr/bin/amfd"))
	inspector := newTestInspector(t, root)

	ev := inspector.Inspect(context.Background(), "amfd", "process")
	if ev.Outcome != ProcessRunning || ev.MainPID != 502 {
		t.Fatalf("expected verified pid 502, got %+v", ev)
	}
}

func TestInspectProcessAcceptsSystemdSuffixForAllowlistedUnit(t *testing.T) {
	root := t.TempDir()
	makeProcEntry(t, root, 601, "sgwcd", strPtr("/usr/bin/sgwcd"))
	inspector := newTestInspector(t, root)

	ev := inspector.Inspect(context.Background(), "sgwcd.service", "process")
	if ev.Outcome != ProcessRunning || ev.MainPID != 601 {
		t.Fatalf("expected verified running sgwcd, got %+v", ev)
	}
}

func TestInspectProcessDeniesUnapprovedUnit(t *testing.T) {
	root := t.TempDir()
	makeProcEntry(t, root, 701, "amfd", strPtr("/usr/bin/amfd"))
	inspector := NewUnitInspector(NewServiceUnitAllowlist("otherd"), "")
	inspector.procRoot = root

	ev := inspector.Inspect(context.Background(), "amfd", "process")
	if ev.Outcome != ProcessPermission {
		t.Fatalf("unapproved unit must be denied, got %+v", ev)
	}
}

func TestInspectProcessNotConfiguredForNoneKind(t *testing.T) {
	inspector := newTestInspector(t, t.TempDir())
	ev := inspector.Inspect(context.Background(), "amfd", "none")
	if ev.Outcome != ProcessNotConfigured {
		t.Fatalf("expected not_configured, got %+v", ev)
	}
}

func strPtr(s string) *string { return &s }
