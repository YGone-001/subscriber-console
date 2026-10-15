package nfhealth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ProcessEvidence is the read-only L1 inspection result for one service unit
// or process name.
type ProcessEvidence struct {
	Outcome      string
	ActiveState  string
	SubState     string
	MainPID      int
	ExePath      string
	Found        bool
	ErrorMessage string
	EvidenceKind string
}

// UnitInspector performs read-only L1 inspection. It never starts, stops or
// reloads any service.
type UnitInspector struct {
	systemdBinary string
	timeout       time.Duration
	procRoot      string
	allowlist     *ServiceUnitAllowlist
	// runner is overridable for tests. Production uses exec of a fixed command.
	runner func(ctx context.Context, name string, args ...string) (string, error)
}

// NewUnitInspector constructs a read-only inspector.
func NewUnitInspector(allowlist *ServiceUnitAllowlist, systemdBinary string) *UnitInspector {
	if systemdBinary == "" {
		systemdBinary = "/usr/bin/systemctl"
	}
	return &UnitInspector{
		systemdBinary: systemdBinary,
		timeout:       3 * time.Second,
		procRoot:      "/proc",
		allowlist:     allowlist,
		runner:        runFixedCommand,
	}
}

// runFixedCommand executes a fixed argv with no shell interpolation. Only the
// read-only `show` verb is ever used in production.
func runFixedCommand(ctx context.Context, name string, args ...string) (string, error) {
	cmd := execCommandContext(ctx, name, args...)
	out, err := cmd.Output()
	if err != nil {
		if len(out) > 0 {
			return string(out), err
		}
		return "", err
	}
	return string(out), nil
}

// Inspect performs a read-only L1 inspection of a server-approved unit or
// process name.
func (u *UnitInspector) Inspect(ctx context.Context, serviceUnit, serviceKind string) ProcessEvidence {
	unit := strings.TrimSpace(serviceUnit)
	if unit == "" || serviceKind == "none" {
		return ProcessEvidence{
			Outcome:      ProcessNotConfigured,
			EvidenceKind: EvidenceNone,
		}
	}
	if u.allowlist != nil && !u.allowlist.Allows(unit) {
		return ProcessEvidence{
			Outcome:      ProcessPermission,
			EvidenceKind: EvidenceNone,
			ErrorMessage: "serviceUnit is not allowlisted",
		}
	}

	switch serviceKind {
	case "systemd":
		return u.inspectSystemd(ctx, unit)
	case "process":
		return u.inspectProcess(unit)
	default:
		return ProcessEvidence{
			Outcome:      ProcessNotConfigured,
			EvidenceKind: EvidenceNone,
		}
	}
}

// inspectSystemd uses a fixed `systemctl show` invocation. It never uses sudo
// and never accepts request-supplied arguments.
func (u *UnitInspector) inspectSystemd(ctx context.Context, unit string) ProcessEvidence {
	name := u.systemdBinary
	if name == "" {
		return ProcessEvidence{
			Outcome:      ProcessNotConfigured,
			EvidenceKind: EvidenceNone,
			ErrorMessage: "systemd inspection unavailable",
		}
	}
	if _, err := os.Stat(name); err != nil {
		return ProcessEvidence{
			Outcome:      ProcessNotConfigured,
			EvidenceKind: EvidenceNone,
			ErrorMessage: "systemd inspection unavailable",
		}
	}

	// Fixed argv: only the read-only `show` verb and a fixed property set.
	args := []string{"show", unit, "--property=ActiveState,SubState,MainPID,ActiveEnterTimestamp"}
	callCtx, cancel := context.WithTimeout(ctx, u.timeout)
	defer cancel()

	out, err := u.runner(callCtx, name, args...)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "permission") || strings.Contains(msg, "denied") {
			return ProcessEvidence{
				Outcome:      ProcessPermission,
				EvidenceKind: EvidenceSystemd,
				ErrorMessage: "systemd inspection permission denied",
			}
		}
		combined := strings.ToLower(out + " " + msg)
		if strings.Contains(combined, "not found") || strings.Contains(combined, "could not be found") || strings.Contains(combined, "no such") {
			return ProcessEvidence{
				Outcome:      ProcessUnitNotFound,
				EvidenceKind: EvidenceSystemd,
				ErrorMessage: "unit not found",
			}
		}
		return ProcessEvidence{
			Outcome:      ProcessFailed,
			EvidenceKind: EvidenceSystemd,
			ErrorMessage: "systemd inspection failed",
		}
	}

	props := parseSystemdShow(out)
	active := props["ActiveState"]
	sub := props["SubState"]
	pid, _ := strconv.Atoi(props["MainPID"])

	ev := ProcessEvidence{
		EvidenceKind: EvidenceSystemd,
		ActiveState:  active,
		SubState:     sub,
		MainPID:      pid,
		Found:        true,
	}

	switch active {
	case "active":
		ev.Outcome = ProcessActive
	case "inactive":
		ev.Outcome = ProcessInactive
	case "failed":
		ev.Outcome = ProcessFailed
	case "":
		ev.Outcome = ProcessUnitNotFound
		ev.Found = false
	default:
		ev.Outcome = ProcessInactive
	}
	return ev
}

// inspectProcess performs a bounded read-only /proc scan for an approved
// process name. It never signals or terminates any process.
//
// Identity is strict: the /proc/<pid>/comm value must equal the approved
// process name exactly, and the executable identity behind /proc/<pid>/exe
// must resolve to the same approved name. Prefix or suffix variants such as
// "pcscfd-test", "pcscfd2" or "mmed-helper" never match, and an unrelated
// executable masquerading under the approved process name is never classified
// as a healthy match. When executable identity cannot be verified, the outcome
// is explicitly unavailable rather than a manufactured positive match.
func (u *UnitInspector) inspectProcess(name string) ProcessEvidence {
	procRoot := u.procRoot
	if procRoot == "" {
		procRoot = "/proc"
	}
	want := strings.TrimSuffix(strings.TrimSpace(name), ".service")
	if want == "" {
		return ProcessEvidence{
			Outcome:      ProcessNotConfigured,
			EvidenceKind: EvidenceNone,
		}
	}

	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return ProcessEvidence{
			Outcome:      ProcessNotConfigured,
			EvidenceKind: EvidenceNone,
			ErrorMessage: "process inspection unavailable",
		}
	}

	unverifiedPID := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		commPath := filepath.Join(procRoot, entry.Name(), "comm")
		raw, err := os.ReadFile(commPath)
		if err != nil {
			continue
		}
		comm := strings.TrimSpace(string(raw))
		if comm != want {
			// Prefix or suffix variants are never identity matches.
			continue
		}
		exePath, exeErr := os.Readlink(filepath.Join(procRoot, entry.Name(), "exe"))
		if exeErr != nil {
			// The process name matched, but executable identity could not be
			// verified. Keep scanning for a verifiable match; if none exists
			// the outcome stays explicitly unavailable.
			if unverifiedPID == 0 {
				unverifiedPID = pid
			}
			continue
		}
		if filepath.Base(exePath) != want {
			// An unrelated executable masquerading under the approved name.
			continue
		}
		return ProcessEvidence{
			Outcome:      ProcessRunning,
			EvidenceKind: EvidenceProcess,
			MainPID:      pid,
			ExePath:      exePath,
			Found:        true,
		}
	}
	if unverifiedPID > 0 {
		return ProcessEvidence{
			Outcome:      ProcessUnverified,
			EvidenceKind: EvidenceProcess,
			MainPID:      unverifiedPID,
			Found:        true,
			ErrorMessage: "process executable identity could not be verified",
		}
	}
	return ProcessEvidence{
		Outcome:      ProcessNotRunning,
		EvidenceKind: EvidenceProcess,
		Found:        false,
	}
}

// parseSystemdShow parses `Key=Value` lines from `systemctl show`.
func parseSystemdShow(out string) map[string]string {
	props := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		props[line[:eq]] = line[eq+1:]
	}
	return props
}

// MapProcessEvidenceToState converts a process outcome into a layer state.
//
// An unverifiable process identity is never definitively healthy: it maps to
// the unknown state.
func MapProcessEvidenceToState(ev ProcessEvidence) string {
	switch ev.Outcome {
	case ProcessActive, ProcessRunning:
		return StateHealthy
	case ProcessInactive, ProcessNotRunning:
		return StateUnhealthy
	case ProcessFailed:
		return StateUnhealthy
	case ProcessUnitNotFound, ProcessNotConfigured:
		return StateNotConfigured
	case ProcessPermission, ProcessUnverified:
		return StateUnknown
	default:
		return StateUnknown
	}
}

// ErrInspectionUnavailable indicates L1 inspection cannot run in this environment.
var ErrInspectionUnavailable = errors.New("process inspection unavailable")
