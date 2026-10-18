package runtimeinv

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"time"
)

// Scanner bounds and measurement constants.
const (
	// clockTicksPerSecond is the Linux USER_HZ used to convert cumulative
	// process CPU ticks into seconds. A CPU percentage is only derived from a
	// real interval delta, never from the cumulative value itself.
	clockTicksPerSecond = 100.0
	// minCPUInterval is the minimum wall-clock interval between two accepted
	// samples before a CPU percentage is reported.
	minCPUInterval = 200 * time.Millisecond
	// maxWorkersPerComponent bounds the retained worker identities per
	// component. The verified worker count still reports the true number.
	maxWorkersPerComponent = 64
	// maxReportedWorkers bounds how many worker identities are returned.
	maxReportedWorkers = 8
)

// ScannerOptions configures a Scanner. All values have safe defaults.
type ScannerOptions struct {
	ProcRoot string
	Clock    func() time.Time
	// Expected lists component identifiers that are explicitly expected to
	// exist. Only trusted operator configuration or a previous observation may
	// establish an expectation.
	Expected []string
	// Host overrides the resolved host identity. Used by tests.
	Host *HostIdentity
	// Readlink overrides executable target resolution. Used by tests that
	// cannot create real symlinks.
	Readlink func(string) (string, error)
}

type cpuSample struct {
	startTicks uint64
	cpuTicks   uint64
	at         time.Time
}

type candidate struct {
	pid  int
	comm string
	java bool
}

type verifiedProcess struct {
	worker   Worker
	cpuTicks uint64
	rssBytes int64
	haveRSS  bool
	vmsBytes int64
	haveVMS  bool
}

type componentResult struct {
	verified   []verifiedProcess
	total      int
	unverified int
	permission int
	reason     string
	truncated  bool
}

// Scanner performs bounded, read-only local process recognition.
type Scanner struct {
	registry    *Registry
	proc        *procFS
	host        HostIdentity
	clock       func() time.Time
	expected    map[string]struct{}
	java        []Component
	longNames   bool
	bootTime    int64
	hasBootTime bool
	memTotal    int64
	hasMemTotal bool
	prev        map[int]cpuSample
}

// NewScanner builds a scanner over the given registry.
func NewScanner(registry *Registry, opts ScannerOptions) *Scanner {
	if registry == nil {
		registry = DefaultRegistry()
	}
	proc := newProcFS(opts.ProcRoot)
	if opts.Readlink != nil {
		proc.readlink = opts.Readlink
	}
	clock := opts.Clock
	if clock == nil {
		clock = time.Now
	}
	expected := make(map[string]struct{}, len(opts.Expected))
	for _, id := range opts.Expected {
		if component, ok := registry.Lookup(id); ok {
			expected[component.ID] = struct{}{}
		}
	}
	host := HostIdentity{}
	if opts.Host != nil {
		host = *opts.Host
	} else {
		host = newHostResolver(proc.root).resolve()
	}
	longNames := false
	for _, name := range registry.ExactProcessNames() {
		if len(name) > commMaxBytes {
			longNames = true
			break
		}
	}
	bootTime, hasBootTime := proc.readBootTime()
	memTotal, hasMemTotal := proc.readMemTotal()
	return &Scanner{
		registry:    registry,
		proc:        proc,
		host:        host,
		clock:       clock,
		expected:    expected,
		java:        registry.CommandLineComponents(),
		longNames:   longNames,
		bootTime:    bootTime,
		hasBootTime: hasBootTime,
		memTotal:    memTotal,
		hasMemTotal: hasMemTotal,
		prev:        map[int]cpuSample{},
	}
}

// Host returns the resolved server-owned host identity.
func (s *Scanner) Host() HostIdentity { return s.host }

// Registry returns the recognition registry used by this scanner.
func (s *Scanner) Registry() *Registry { return s.registry }

func (s *Scanner) now() time.Time { return s.clock().UTC() }

// Scan performs one bounded read-only scan.
//
// It never signals, starts, stops or reconfigures any process. Prior state is
// supplied by the caller so a complete scan can distinguish a service that was
// previously observed from one that was never installed.
func (s *Scanner) Scan(ctx context.Context, trigger string, prior map[string]ComponentState) (*Snapshot, map[string]ComponentState) {
	started := s.now()
	states := make(map[string]ComponentState, len(prior))
	for key, value := range prior {
		states[key] = value
	}

	snapshot := &Snapshot{
		ProfileID:      ProfileCNMSCompat,
		ProfileVersion: ProfileVersion,
		Host:           s.host,
		Registry:       s.registry.Counts(),
		GeneratedAt:    started.Format(time.RFC3339Nano),
		Components:     []Observation{},
	}
	scan := ScanMetadata{
		ScanID:    newScanID(),
		Trigger:   trigger,
		StartedAt: started.Format(time.RFC3339Nano),
		Status:    ScanComplete,
		Complete:  true,
	}

	pids, err := s.proc.listPIDs()
	if err != nil {
		// The process namespace itself is not readable. No absence claim is
		// possible: every component reports permission_denied.
		scan.Status = ScanFailed
		scan.Complete = false
		scan.ErrorSummary = "proc_unreadable"
		scan.CompletedAt = s.now().Format(time.RFC3339Nano)
		snapshot.Scan = scan
		for _, component := range s.registry.Components() {
			observation := baseObservation(component)
			observation.RuntimeStatus = StatusPermissionDenied
			observation.StatusReason = ReasonProcUnreadable
			observation.Expectation = s.expectation(component.ID, states)
			snapshot.Components = append(snapshot.Components, observation)
		}
		snapshot.Counts = countStatuses(snapshot.Components)
		return snapshot, states
	}

	exact, javaCandidates, unreadable := s.collectCandidates(ctx, pids)
	scan.ProcessesScanned = len(pids)
	scan.EntriesUnreadable = unreadable
	if unreadable > 0 {
		// Some entries were unreadable. Positive matches remain valid evidence,
		// but absence is no longer a complete observation.
		scan.Status = ScanIncomplete
		scan.Complete = false
	}

	results := make(map[string]*componentResult, len(exact)+len(s.java))
	for componentID, candidates := range exact {
		component, ok := s.registry.Lookup(componentID)
		if !ok {
			continue
		}
		results[componentID] = s.verifyExact(component, candidates)
	}
	for _, component := range s.java {
		results[component.ID] = s.verifyCommandLine(component, javaCandidates)
	}

	now := s.now()
	nextPrev := make(map[int]cpuSample, len(pids))
	truncated := 0
	for _, component := range s.registry.Components() {
		result := results[component.ID]
		if result == nil {
			result = &componentResult{}
		}
		if result.truncated {
			truncated++
		}
		observation := s.projectObservation(component, result, scan.Complete, states, now)
		if observation.RuntimeStatus == StatusRunning {
			for _, process := range result.verified {
				nextPrev[process.worker.PID] = cpuSample{
					startTicks: process.worker.StartTicks,
					cpuTicks:   process.cpuTicks,
					at:         now,
				}
			}
		}
		snapshot.Components = append(snapshot.Components, observation)
		s.updateState(component, result, states, observation, now)
	}
	scan.WorkersTruncated = truncated
	s.prev = nextPrev

	scan.CompletedAt = s.now().Format(time.RFC3339Nano)
	scan.DurationMs = s.now().Sub(started).Milliseconds()
	snapshot.Scan = scan
	snapshot.Counts = countStatuses(snapshot.Components)
	return snapshot, states
}

// collectCandidates reads the bounded identity projection for every process.
func (s *Scanner) collectCandidates(ctx context.Context, pids []int) (map[string][]candidate, []candidate, int) {
	exact := make(map[string][]candidate)
	javaCandidates := make([]candidate, 0)
	unreadable := 0
	for index, pid := range pids {
		if index%256 == 0 && ctx.Err() != nil {
			// Cancellation ends the scan; the caller sees an incomplete scan
			// because the loop stops before all entries were inspected.
			unreadable++
			break
		}
		comm, err := s.proc.readComm(pid)
		if err != nil {
			unreadable++
			continue
		}
		if component, ok := s.registry.LookupProcess(comm); ok {
			exact[component.ID] = append(exact[component.ID], candidate{pid: pid, comm: comm})
			continue
		}
		// A truncated comm cannot be matched by name. Only when the registry
		// actually contains a name above the kernel limit is the executable
		// consulted, so the common path stays bounded.
		if s.longNames && len(comm) >= commMaxBytes {
			if exeName, exeErr := s.proc.readExeName(pid); exeErr == nil {
				if component, ok := s.registry.LookupProcess(exeName); ok {
					exact[component.ID] = append(exact[component.ID], candidate{pid: pid, comm: comm})
					continue
				}
			}
		}
		if len(s.java) > 0 && comm == "java" {
			javaCandidates = append(javaCandidates, candidate{pid: pid, comm: comm, java: true})
		}
	}
	return exact, javaCandidates, unreadable
}

// verifyExact verifies executable identity for exact-name candidates.
func (s *Scanner) verifyExact(component Component, candidates []candidate) *componentResult {
	result := &componentResult{}
	for _, item := range candidates {
		stat, err := s.proc.readStat(item.pid)
		if err != nil {
			result.unverified++
			result.reason = ReasonExeUnverified
			continue
		}
		exeName, err := s.proc.readExeName(item.pid)
		if err != nil {
			if errors.Is(err, fs.ErrPermission) {
				result.permission++
				result.reason = ReasonExePermissionDenied
			} else {
				result.unverified++
				result.reason = ReasonExeUnverified
			}
			continue
		}
		if exeName != component.ProcessName {
			// An unrelated executable masquerading under the approved name is
			// never classified as the component.
			result.unverified++
			result.reason = ReasonExeUnverified
			continue
		}
		result.add(verifiedProcess{
			worker: Worker{
				PID:        item.pid,
				StartTicks: stat.StartTicks,
				ExeName:    exeName,
				StartedAt:  s.startedAt(stat.StartTicks),
			},
			cpuTicks: stat.CPUTicks,
		})
	}
	s.fillMemory(result)
	return result
}

// verifyCommandLine verifies the bounded command-line identity for java
// candidates. The raw command line is never retained.
func (s *Scanner) verifyCommandLine(component Component, candidates []candidate) *componentResult {
	result := &componentResult{}
	for _, item := range candidates {
		exeName, err := s.proc.readExeName(item.pid)
		if err != nil {
			if errors.Is(err, fs.ErrPermission) {
				result.permission++
				result.reason = ReasonExePermissionDenied
			} else {
				result.unverified++
				result.reason = ReasonExeUnverified
			}
			continue
		}
		if exeName != component.ProcessName {
			// Not the approved executable: not a candidate for this component.
			continue
		}
		stat, err := s.proc.readStat(item.pid)
		if err != nil {
			result.unverified++
			result.reason = ReasonExeUnverified
			continue
		}
		argv, err := s.proc.readCmdline(item.pid)
		if err != nil || len(argv) == 0 {
			result.unverified++
			result.reason = ReasonCommandUnreadable
			continue
		}
		match := matchJavaLaunchIdentity(argv)
		if !match.Matched {
			// A java process without any approved launch token is simply not
			// this component. It is never reported as an unverified IMS HSS.
			continue
		}
		if !match.Verified {
			result.unverified++
			result.reason = match.Reason
			continue
		}
		result.add(verifiedProcess{
			worker: Worker{
				PID:          item.pid,
				StartTicks:   stat.StartTicks,
				ExeName:      exeName,
				StartedAt:    s.startedAt(stat.StartTicks),
				CommandMatch: match.Token,
			},
			cpuTicks: stat.CPUTicks,
		})
	}
	s.fillMemory(result)
	return result
}

func (r *componentResult) add(process verifiedProcess) {
	r.total++
	if len(r.verified) < maxWorkersPerComponent {
		r.verified = append(r.verified, process)
	} else {
		r.truncated = true
	}
}

// fillMemory reads resident and virtual memory for verified workers.
func (s *Scanner) fillMemory(result *componentResult) {
	for index := range result.verified {
		rss, haveRSS, vms, haveVMS, err := s.proc.readStatus(result.verified[index].worker.PID)
		if err != nil {
			continue
		}
		result.verified[index].rssBytes = rss
		result.verified[index].haveRSS = haveRSS
		result.verified[index].vmsBytes = vms
		result.verified[index].haveVMS = haveVMS
	}
}

func (s *Scanner) startedAt(ticks uint64) string {
	if !s.hasBootTime {
		return ""
	}
	seconds := s.bootTime + int64(ticks/clockTicksPerSecond)
	return time.Unix(seconds, 0).UTC().Format(time.RFC3339)
}

// projectObservation builds the read projection for one component.
func (s *Scanner) projectObservation(component Component, result *componentResult, scanComplete bool, states map[string]ComponentState, now time.Time) Observation {
	observation := baseObservation(component)
	observation.LastScannedAt = now.Format(time.RFC3339Nano)
	observation.Expectation = s.expectation(component.ID, states)

	state := states[StateID(s.host.HostID, component.ID)]
	observation.FirstSeenAt = state.FirstSeenAt
	observation.LastSeenAt = state.LastSeenAt

	observation.WorkerCount = result.total
	observation.UnverifiedWorkers = result.unverified + result.permission
	observation.WorkersTruncated = result.truncated
	observation.Workers = projectWorkers(result.verified)

	if result.total > 0 {
		observation.Verified = true
		observation.Evidence = EvidenceVerified
		observation.PrimaryPID = primaryPID(result.verified)
		observation.RuntimeStatus = StatusRunning
		observation.StatusReason = ReasonVerifiedRunning
		observation.CPUPercent, observation.CPUBasis = s.cpuPercent(result.verified, now)
		observation.CPUAvailable = observation.CPUPercent != nil
		observation.MemoryRSSBytes, observation.MemoryVMSBytes, observation.MemoryPercent, observation.MemoryBasis = s.memory(result.verified)
		observation.MemoryAvailable = observation.MemoryRSSBytes != nil
		return observation
	}

	// No verified worker. The evidence state is explicit about why.
	switch {
	case result.permission > 0 && result.unverified == 0:
		observation.Evidence = EvidenceUnverified
		observation.RuntimeStatus = StatusPermissionDenied
		observation.StatusReason = ReasonExePermissionDenied
	case result.unverified > 0 || result.permission > 0:
		observation.Evidence = EvidenceUnverified
		observation.RuntimeStatus = StatusUnverified
		observation.StatusReason = firstNonEmpty(result.reason, ReasonExeUnverified)
	case !scanComplete:
		// Absence from an incomplete scan never establishes stopped state.
		observation.Evidence = EvidenceNone
		observation.RuntimeStatus = StatusUnknown
		observation.StatusReason = ReasonScanIncomplete
	case state.Presence:
		observation.Evidence = EvidenceNone
		observation.RuntimeStatus = StatusStopped
		observation.StatusReason = ReasonAbsentAfterObservation
	case observation.Expectation == "expected":
		observation.Evidence = EvidenceNone
		observation.RuntimeStatus = StatusStopped
		observation.StatusReason = ReasonExpectedButAbsent
	default:
		observation.Evidence = EvidenceNone
		observation.RuntimeStatus = StatusNotDetected
		observation.StatusReason = ReasonNeverObserved
	}
	observation.CPUBasis = CPUBasisUnavailable
	observation.MemoryBasis = MemoryBasisUnavailable
	return observation
}

func (s *Scanner) expectation(componentID string, states map[string]ComponentState) string {
	if _, ok := s.expected[componentID]; ok {
		return "expected"
	}
	state := states[StateID(s.host.HostID, componentID)]
	if state.Presence || state.FirstSeenAt != "" {
		return "expected"
	}
	return "not_expected"
}

func (s *Scanner) updateState(component Component, result *componentResult, states map[string]ComponentState, observation Observation, now time.Time) {
	key := StateID(s.host.HostID, component.ID)
	state := states[key]
	state.StateID = key
	state.HostID = s.host.HostID
	state.ComponentID = component.ID
	state.UpdatedAt = now.Format(time.RFC3339Nano)
	if result.total > 0 {
		if state.FirstSeenAt == "" {
			state.FirstSeenAt = now.Format(time.RFC3339Nano)
		}
		state.LastSeenAt = now.Format(time.RFC3339Nano)
		state.Presence = true
		state.LastPrimaryPID = observation.PrimaryPID
		state.LastProcessName = component.ProcessName
	} else if observation.RuntimeStatus == StatusStopped || observation.RuntimeStatus == StatusNotDetected {
		state.Presence = false
	}
	states[key] = state
}

// cpuPercent derives a real interval-based CPU percentage for the verified
// process group. It returns nil when no valid interval measurement exists.
func (s *Scanner) cpuPercent(processes []verifiedProcess, now time.Time) (*float64, string) {
	if len(processes) == 0 {
		return nil, CPUBasisUnavailable
	}
	var total float64
	var elapsed float64
	for index, process := range processes {
		previous, ok := s.prev[process.worker.PID]
		if !ok {
			return nil, CPUBasisUnavailable
		}
		if previous.startTicks != process.worker.StartTicks {
			// The PID was reused by a different process: no delta is valid.
			return nil, CPUBasisUnavailable
		}
		interval := now.Sub(previous.at)
		if interval < minCPUInterval {
			return nil, CPUBasisUnavailable
		}
		if process.cpuTicks < previous.cpuTicks {
			return nil, CPUBasisUnavailable
		}
		delta := float64(process.cpuTicks - previous.cpuTicks)
		if index == 0 {
			elapsed = interval.Seconds()
		} else if diff := interval.Seconds() - elapsed; diff > 0.001 || diff < -0.001 {
			// Incompatible sampling intervals must never be summed.
			return nil, CPUBasisUnavailable
		}
		total += delta
	}
	if elapsed <= 0 {
		return nil, CPUBasisUnavailable
	}
	percent := total / clockTicksPerSecond / elapsed * 100
	if percent < 0 {
		return nil, CPUBasisUnavailable
	}
	return &percent, CPUBasisIntervalDelta
}

// memory aggregates the verified process group. A missing measurement in any
// worker makes the aggregate unavailable rather than silently partial.
func (s *Scanner) memory(processes []verifiedProcess) (*int64, *int64, *float64, string) {
	if len(processes) == 0 {
		return nil, nil, nil, MemoryBasisUnavailable
	}
	var rss int64
	var vms int64
	for _, process := range processes {
		if !process.haveRSS || !process.haveVMS {
			return nil, nil, nil, MemoryBasisUnavailable
		}
		rss += process.rssBytes
		vms += process.vmsBytes
	}
	var percent *float64
	if s.hasMemTotal && s.memTotal > 0 {
		value := float64(rss) / float64(s.memTotal) * 100
		percent = &value
	}
	return &rss, &vms, percent, MemoryBasisGroupAggregate
}

func primaryPID(processes []verifiedProcess) int {
	if len(processes) == 0 {
		return 0
	}
	primary := processes[0]
	for _, process := range processes[1:] {
		if process.worker.StartTicks < primary.worker.StartTicks {
			primary = process
			continue
		}
		if process.worker.StartTicks == primary.worker.StartTicks && process.worker.PID < primary.worker.PID {
			primary = process
		}
	}
	return primary.worker.PID
}

func projectWorkers(processes []verifiedProcess) []Worker {
	out := make([]Worker, 0, maxReportedWorkers)
	for index, process := range processes {
		if index >= maxReportedWorkers {
			break
		}
		out = append(out, process.worker)
	}
	return out
}

func baseObservation(component Component) Observation {
	return Observation{
		ComponentID:    component.ID,
		DisplayName:    component.DisplayName,
		ProcessName:    component.ProcessName,
		MatchMethod:    component.MatchMethod,
		Category:       component.Category,
		Domain:         component.Domain,
		Role:           component.Role,
		NFTType:        component.NFTType,
		CNMSCompatible: component.CNMSCompatible,
		Templates:      append([]string{}, component.Templates...),
		Evidence:       EvidenceNone,
		Workers:        []Worker{},
		CPUBasis:       CPUBasisUnavailable,
		MemoryBasis:    MemoryBasisUnavailable,
		Monitoring: MonitoringProjection{
			State:  component.Monitoring,
			Reason: component.MonitoringReason,
		},
		InventoryAssociation: AssociationProjection{State: AssociationAbsent},
		NFHealthAssociation:  AssociationProjection{State: AssociationAbsent},
	}
}

func countStatuses(observations []Observation) SnapshotCounts {
	counts := SnapshotCounts{Total: len(observations)}
	for _, observation := range observations {
		switch observation.RuntimeStatus {
		case StatusRunning:
			counts.Running++
		case StatusStopped:
			counts.Stopped++
		case StatusUnverified:
			counts.Unverified++
		case StatusPermissionDenied:
			counts.PermissionDenied++
		case StatusStale:
			counts.Stale++
		case StatusNotDetected:
			counts.NotDetected++
		default:
			counts.Unknown++
		}
		if observation.Expectation == "expected" {
			counts.Expected++
		}
	}
	return counts
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func newScanID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "scan-0000000000000000"
	}
	return "scan-" + hex.EncodeToString(buf[:])
}
