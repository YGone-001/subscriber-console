// Package processevidence exchanges bounded, read-only local process evidence.
// It never executes commands, signals processes, or opens network connections.
package processevidence

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	MaxBytes       = 1 << 20
	MaxProcesses   = 4096
	MaxProcEntries = 65536
	MaxAge         = 60 * time.Second
)

var processName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,14}$`)

type Policy struct {
	Names []string `json:"names"`
}

type Process struct {
	Name       string `json:"name"`
	PID        int    `json:"pid"`
	StartTicks string `json:"startTicks"`
	Executable string `json:"executable"`
}

type Snapshot struct {
	Version    int       `json:"version"`
	BootID     string    `json:"bootId"`
	ObservedAt time.Time `json:"observedAt"`
	Processes  []Process `json:"processes"`
}

func ValidatePolicy(policy Policy) error {
	if len(policy.Names) == 0 || len(policy.Names) > 64 {
		return errors.New("policy must contain 1 to 64 approved process names")
	}
	seen := map[string]bool{}
	for _, name := range policy.Names {
		if !processName.MatchString(name) || seen[name] {
			return errors.New("policy contains an invalid or duplicate process name")
		}
		seen[name] = true
	}
	return nil
}

func decode[T any](reader io.Reader, into *T) error {
	raw, err := io.ReadAll(io.LimitReader(reader, MaxBytes+1))
	if err != nil || len(raw) > MaxBytes {
		return errors.New("evidence input is unavailable or oversized")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("trailing evidence input")
	}
	return nil
}

func LoadPolicy(path string) (Policy, error) {
	file, err := openTrusted(path, 0)
	if err != nil {
		return Policy{}, err
	}
	defer file.Close()
	var policy Policy
	if err := decode(file, &policy); err != nil {
		return Policy{}, err
	}
	return policy, ValidatePolicy(policy)
}

func startTicks(procRoot string, pid int) (string, error) {
	raw, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", err
	}
	// comm may contain spaces and parentheses. Field 22 is field 20 after comm.
	end := strings.LastIndex(string(raw), ") ")
	if end < 0 {
		return "", errors.New("invalid process stat")
	}
	fields := strings.Fields(string(raw[end+2:]))
	if len(fields) < 20 {
		return "", errors.New("incomplete process stat")
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return "", err
	}
	return fields[19], nil
}

func bootID(procRoot string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(procRoot, "sys/kernel/random/boot_id"))
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(raw))
	if len(id) != 36 {
		return "", errors.New("invalid boot identity")
	}
	return id, nil
}

// Collect scans only procfs. Only positively verified approved names are emitted;
// absence from the snapshot never establishes that a process is stopped.
func Collect(procRoot string, policy Policy, now time.Time) (Snapshot, error) {
	if err := ValidatePolicy(policy); err != nil {
		return Snapshot{}, err
	}
	boot, err := bootID(procRoot)
	if err != nil {
		return Snapshot{}, err
	}
	dir, err := os.Open(procRoot)
	if err != nil {
		return Snapshot{}, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(MaxProcEntries + 1)
	if err != nil && err != io.EOF {
		return Snapshot{}, err
	}
	if len(entries) > MaxProcEntries {
		return Snapshot{}, errors.New("procfs scan limit exceeded")
	}
	approved := map[string]bool{}
	for _, name := range policy.Names {
		approved[name] = true
	}
	result := Snapshot{Version: 1, BootID: boot, ObservedAt: now.UTC(), Processes: []Process{}}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 || !entry.IsDir() {
			continue
		}
		path := filepath.Join(procRoot, entry.Name())
		comm, err := os.ReadFile(filepath.Join(path, "comm"))
		name := strings.TrimSpace(string(comm))
		if err != nil || !approved[name] {
			continue
		}
		before, err := startTicks(procRoot, pid)
		if err != nil {
			continue
		}
		exe, err := os.Readlink(filepath.Join(path, "exe"))
		if err != nil || !filepath.IsAbs(exe) || filepath.Base(exe) != name {
			continue
		}
		after, err := startTicks(procRoot, pid)
		commAfter, commErr := os.ReadFile(filepath.Join(path, "comm"))
		if err != nil || commErr != nil || before != after || strings.TrimSpace(string(commAfter)) != name {
			continue
		}
		result.Processes = append(result.Processes, Process{Name: name, PID: pid, StartTicks: before, Executable: exe})
		if len(result.Processes) > MaxProcesses {
			return Snapshot{}, errors.New("process evidence limit exceeded")
		}
	}
	return result, nil
}

// Write atomically publishes one complete file in a trusted root-owned directory.
func Write(path string, snapshot Snapshot) error {
	if err := trustedDirectory(filepath.Dir(path), 0); err != nil {
		return err
	}
	raw, err := json.Marshal(snapshot)
	if err != nil || len(raw) > MaxBytes {
		return errors.New("invalid snapshot size")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".snapshot-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(0o644); err != nil {
		return err
	}
	if _, err := file.Write(raw); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

type Reader struct {
	Path     string
	ProcRoot string
	openFile func(string, uint32) (*os.File, error)
}

// Verify rechecks boot identity, age and live PID start time. A stale snapshot,
// PID reuse, process exit or insecure file cannot manufacture a healthy result.
func (r Reader) Verify(name string, pid int, now time.Time) (Process, time.Time, error) {
	open := r.openFile
	if open == nil {
		open = openTrusted
	}
	file, err := open(r.Path, 0)
	if err != nil {
		return Process{}, time.Time{}, err
	}
	defer file.Close()
	var snapshot Snapshot
	if err := decode(file, &snapshot); err != nil {
		return Process{}, time.Time{}, err
	}
	if snapshot.Version != 1 || len(snapshot.Processes) > MaxProcesses || snapshot.ObservedAt.IsZero() || snapshot.ObservedAt.After(now) || now.Sub(snapshot.ObservedAt) > MaxAge {
		return Process{}, time.Time{}, errors.New("invalid or expired process snapshot")
	}
	root := r.ProcRoot
	if root == "" {
		root = "/proc"
	}
	boot, err := bootID(root)
	if err != nil || boot != snapshot.BootID {
		return Process{}, time.Time{}, errors.New("boot identity changed")
	}
	for _, process := range snapshot.Processes {
		if process.Name != name || process.PID != pid {
			continue
		}
		comm, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "comm"))
		ticks, ticksErr := startTicks(root, pid)
		if err != nil || ticksErr != nil || ticks != process.StartTicks || strings.TrimSpace(string(comm)) != name || !filepath.IsAbs(process.Executable) || filepath.Base(process.Executable) != name {
			return Process{}, time.Time{}, errors.New("process identity changed")
		}
		return process, snapshot.ObservedAt, nil
	}
	return Process{}, time.Time{}, fmt.Errorf("no verified evidence for approved process")
}
