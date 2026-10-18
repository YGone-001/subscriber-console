package runtimeinv

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Bounds for the read-only /proc inspection. Every bound is explicit so a
// hostile or degraded host can never turn one scan into unbounded work.
const (
	// commMaxBytes is the Linux task-comm limit. A configured process name
	// longer than this can never match comm and must be verified through the
	// executable basename instead.
	commMaxBytes = 15
	// maxCmdlineBytes bounds the command-line projection used for identity
	// matching. The raw value is never persisted or returned.
	maxCmdlineBytes = 4096
	// maxCmdlineArgs bounds the number of argv elements inspected.
	maxCmdlineArgs = 64
	// maxScanProcesses bounds the number of /proc entries one scan may inspect.
	maxScanProcesses = 8192
)

// errProcUnavailable indicates that the process namespace itself is not
// readable. It is a permission or environment failure, never an absence proof.
var errProcUnavailable = errors.New("proc filesystem unavailable")

// procStat is the bounded projection of /proc/<pid>/stat used by the scanner.
type procStat struct {
	PPID       int
	StartTicks uint64
	CPUTicks   uint64
}

// procFS performs read-only access to a procfs tree. The root is injectable so
// tests can use a fixture tree without touching the host.
type procFS struct {
	root string
	// readlink resolves an executable target. It is injectable because creating
	// real symlinks is not possible on every development platform; production
	// always uses os.Readlink.
	readlink func(string) (string, error)
}

func newProcFS(root string) *procFS {
	if strings.TrimSpace(root) == "" {
		root = "/proc"
	}
	return &procFS{root: root, readlink: os.Readlink}
}

// listPIDs returns the numeric process identifiers in ascending order. Sorting
// makes scan output deterministic regardless of directory order.
func (p *procFS) listPIDs() ([]int, error) {
	entries, err := os.ReadDir(p.root)
	if err != nil {
		return nil, errProcUnavailable
	}
	pids := make([]int, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, convErr := strconv.Atoi(entry.Name())
		if convErr != nil || pid <= 0 {
			continue
		}
		pids = append(pids, pid)
		if len(pids) >= maxScanProcesses {
			break
		}
	}
	sort.Ints(pids)
	return pids, nil
}

// readComm returns the kernel task name.
func (p *procFS) readComm(pid int) (string, error) {
	raw, err := os.ReadFile(filepath.Join(p.root, strconv.Itoa(pid), "comm"))
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(raw), "\r\n"), nil
}

// readStat parses the fields needed for identity and CPU accounting.
//
// The comm field may contain spaces and parentheses, so parsing starts after
// the final closing parenthesis rather than splitting the whole line.
func (p *procFS) readStat(pid int) (procStat, error) {
	raw, err := os.ReadFile(filepath.Join(p.root, strconv.Itoa(pid), "stat"))
	if err != nil {
		return procStat{}, err
	}
	return parseProcStat(string(raw))
}

func parseProcStat(raw string) (procStat, error) {
	close := strings.LastIndexByte(raw, ')')
	if close < 0 || close+2 >= len(raw) {
		return procStat{}, errors.New("malformed proc stat")
	}
	fields := strings.Fields(raw[close+2:])
	// fields[0] is state (field 3). Field N maps to index N-3.
	const (
		idxPPID       = 4 - 3
		idxUTime      = 14 - 3
		idxSTime      = 15 - 3
		idxStartTicks = 22 - 3
	)
	if len(fields) <= idxStartTicks {
		return procStat{}, errors.New("truncated proc stat")
	}
	ppid, err := strconv.Atoi(fields[idxPPID])
	if err != nil {
		return procStat{}, err
	}
	utime, err := strconv.ParseUint(fields[idxUTime], 10, 64)
	if err != nil {
		return procStat{}, err
	}
	stime, err := strconv.ParseUint(fields[idxSTime], 10, 64)
	if err != nil {
		return procStat{}, err
	}
	start, err := strconv.ParseUint(fields[idxStartTicks], 10, 64)
	if err != nil {
		return procStat{}, err
	}
	return procStat{PPID: ppid, StartTicks: start, CPUTicks: utime + stime}, nil
}

// readExeName returns the basename of the verified executable target.
func (p *procFS) readExeName(pid int) (string, error) {
	reader := p.readlink
	if reader == nil {
		reader = os.Readlink
	}
	target, err := reader(filepath.Join(p.root, strconv.Itoa(pid), "exe"))
	if err != nil {
		return "", err
	}
	// A deleted executable resolves with a " (deleted)" suffix; the identity is
	// still the original basename.
	target = strings.TrimSuffix(target, " (deleted)")
	base := filepath.Base(target)
	if base == "" || base == "." || base == "/" {
		return "", errors.New("unresolvable executable")
	}
	return base, nil
}

// readCmdline returns a bounded argv projection. The caller must never persist
// or expose the returned elements.
func (p *procFS) readCmdline(pid int) ([]string, error) {
	file, err := os.Open(filepath.Join(p.root, strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	buf := make([]byte, maxCmdlineBytes)
	n, readErr := file.Read(buf)
	if readErr != nil && n == 0 {
		return nil, readErr
	}
	raw := strings.TrimRight(string(buf[:n]), "\x00")
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, "\x00")
	if len(parts) > maxCmdlineArgs {
		parts = parts[:maxCmdlineArgs]
	}
	return parts, nil
}

// readStatus returns resident and virtual memory in bytes. Each value carries
// its own presence flag so an absent measurement is never confused with zero.
func (p *procFS) readStatus(pid int) (rssBytes int64, haveRSS bool, vmsBytes int64, haveVMS bool, err error) {
	raw, err := os.ReadFile(filepath.Join(p.root, strconv.Itoa(pid), "status"))
	if err != nil {
		return 0, false, 0, false, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		switch strings.TrimSpace(key) {
		case "VmRSS":
			if kb, ok := parseStatusKB(value); ok {
				rssBytes = kb * 1024
				haveRSS = true
			}
		case "VmSize":
			if kb, ok := parseStatusKB(value); ok {
				vmsBytes = kb * 1024
				haveVMS = true
			}
		}
	}
	if !haveRSS && !haveVMS {
		return 0, false, 0, false, errors.New("no memory fields")
	}
	return rssBytes, haveRSS, vmsBytes, haveVMS, nil
}

func parseStatusKB(value string) (int64, bool) {
	fields := strings.Fields(strings.TrimSpace(value))
	if len(fields) == 0 {
		return 0, false
	}
	kb, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || kb < 0 {
		return 0, false
	}
	return kb, true
}

// readMemTotal returns the host memory total in bytes, when available.
func (p *procFS) readMemTotal() (int64, bool) {
	raw, err := os.ReadFile(filepath.Join(p.root, "meminfo"))
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found || strings.TrimSpace(key) != "MemTotal" {
			continue
		}
		if kb, ok := parseStatusKB(value); ok && kb > 0 {
			return kb * 1024, true
		}
	}
	return 0, false
}

// readBootTime returns the kernel boot time in unix seconds, when available.
func (p *procFS) readBootTime() (int64, bool) {
	raw, err := os.ReadFile(filepath.Join(p.root, "stat"))
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "btime" {
			seconds, convErr := strconv.ParseInt(fields[1], 10, 64)
			if convErr != nil || seconds <= 0 {
				return 0, false
			}
			return seconds, true
		}
	}
	return 0, false
}
