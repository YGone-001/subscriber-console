package runtimeinv

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fixture builds a read-only procfs tree for deterministic tests.
type fixture struct {
	root  string
	links map[string]string
	errs  map[string]error
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "meminfo"), []byte("MemTotal:       1000000 kB\nMemFree: 500000 kB\n"), 0o600); err != nil {
		t.Fatalf("write meminfo: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "stat"), []byte("cpu  1 2 3\nbtime 1700000000\n"), 0o600); err != nil {
		t.Fatalf("write stat: %v", err)
	}
	return &fixture{root: root, links: map[string]string{}, errs: map[string]error{}}
}

func (f *fixture) process(pid int, comm, exe string, startTicks, cpuTicks uint64, rssKB, vmsKB int64, argv []string) {
	dir := filepath.Join(f.root, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		panic(err)
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			panic(err)
		}
	}
	write("comm", comm+"\n")
	write("stat", statLine(pid, comm, 1, cpuTicks, 0, startTicks))
	write("status", "Name:\t"+comm+"\nVmSize:\t"+strconv.FormatInt(vmsKB, 10)+" kB\nVmRSS:\t"+strconv.FormatInt(rssKB, 10)+" kB\n")
	if argv != nil {
		write("cmdline", strings.Join(argv, "\x00")+"\x00")
	}
	f.links[filepath.Join(dir, "exe")] = exe
}

func (f *fixture) processNoStatus(pid int, comm, exe string, startTicks uint64) {
	dir := filepath.Join(f.root, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		panic(err)
	}
	os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "stat"), []byte(statLine(pid, comm, 1, 0, 0, startTicks)), 0o600)
	f.links[filepath.Join(dir, "exe")] = exe
}

func (f *fixture) permissionDenied(pid int, comm string) {
	f.process(pid, comm, "unused", 1, 0, 1, 1, nil)
	f.errs[filepath.Join(f.root, strconv.Itoa(pid), "exe")] = os.ErrPermission
}

func (f *fixture) readlink(path string) (string, error) {
	if err, ok := f.errs[path]; ok {
		return "", err
	}
	if target, ok := f.links[path]; ok {
		return target, nil
	}
	return "", os.ErrNotExist
}

func statLine(pid int, comm string, ppid int, utime, stime, start uint64) string {
	fields := make([]string, 49)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0] = "S"
	fields[1] = strconv.Itoa(ppid)
	fields[11] = strconv.FormatUint(utime, 10)
	fields[12] = strconv.FormatUint(stime, 10)
	fields[19] = strconv.FormatUint(start, 10)
	return strconv.Itoa(pid) + " (" + comm + ") " + strings.Join(fields, " ") + "\n"
}

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time          { return c.now }
func (c *fakeClock) advance(d time.Duration) { c.now = c.now.Add(d) }

func newTestScanner(f *fixture, clock *fakeClock, expected ...string) *Scanner {
	return NewScanner(DefaultRegistry(), ScannerOptions{
		ProcRoot: f.root,
		Clock:    clock.Now,
		Expected: expected,
		Host: &HostIdentity{
			HostID:         "host-test",
			HostName:       "test-host",
			IdentitySource: "test",
			Visibility:     VisibilityHost,
		},
		Readlink: f.readlink,
	})
}

func observationFor(t *testing.T, snapshot *Snapshot, componentID string) Observation {
	t.Helper()
	for _, observation := range snapshot.Components {
		if observation.ComponentID == componentID {
			return observation
		}
	}
	t.Fatalf("component %q missing from snapshot", componentID)
	return Observation{}
}

// ---------------------------------------------------------------- registry

func TestRegistryMatchesCNMSCompatibilityProfile(t *testing.T) {
	registry := DefaultRegistry()
	counts := registry.Counts()
	if counts.CNMSComponents != 24 {
		t.Fatalf("CNMS component definitions must be 24, got %d", counts.CNMSComponents)
	}
	if counts.XCloudOnlyComponents != 2 {
		t.Fatalf("xCloud-only identities must be 2, got %d", counts.XCloudOnlyComponents)
	}
	if counts.EffectiveEntries != 26 {
		t.Fatalf("effective recognition entries must be 26, got %d", counts.EffectiveEntries)
	}
	expectedByCategory := map[string]int{
		Category5GC: 12, CategoryEPC: 7, CategoryIMS: 5, CategoryCharging: 1, CategorySupport: 1,
	}
	for category, want := range expectedByCategory {
		if got := counts.ByCategory[category]; got != want {
			t.Fatalf("category %s must contain %d entries, got %d", category, want, got)
		}
	}
}

func TestRegistryPreservesXCloudOnlyIdentities(t *testing.T) {
	registry := DefaultRegistry()
	for _, name := range []string{"seppd", "smscd"} {
		component, ok := registry.LookupProcess(name)
		if !ok {
			t.Fatalf("xCloud-only process %q must be preserved", name)
		}
		if component.CNMSCompatible {
			t.Fatalf("process %q must not be reported as CNMS-compatible", name)
		}
	}
	sepp, _ := registry.LookupProcess("seppd")
	if sepp.NFTType != "SEPP" || sepp.Domain != "5gc" {
		t.Fatalf("seppd identity changed: %+v", sepp)
	}
	smsc, _ := registry.LookupProcess("smscd")
	if smsc.NFTType != "SMSC" || smsc.Domain != "ims" {
		t.Fatalf("smscd identity changed: %+v", smsc)
	}
}

func TestRegistryRejectsDuplicateDefinitions(t *testing.T) {
	_, err := NewRegistry([]Component{
		{ID: "a", ProcessName: "amfd"},
		{ID: "b", ProcessName: "amfd"},
	})
	if err == nil {
		t.Fatal("duplicate process name must be rejected")
	}
	_, err = NewRegistry([]Component{
		{ID: "a", ProcessName: "amfd"},
		{ID: "a", ProcessName: "smfd"},
	})
	if err == nil {
		t.Fatal("duplicate component id must be rejected")
	}
}

func TestRegistryTemplateMembership(t *testing.T) {
	registry := DefaultRegistry()
	cases := map[string]int{
		TemplateAuto: 26,
		Template5G:   16, // 11 5GC + 4 IMS + seppd
		Template4G:   13, // 7 EPC + 4 IMS + DRA + smscd
		TemplateIMS:  5,  // 4 IMS + smscd
	}
	for template, want := range cases {
		got := len(registry.FilterTemplate(template))
		if got != want {
			t.Fatalf("template %s must include %d components, got %d", template, want, got)
		}
	}
	// The IMS HSS component is a java process, never a literal executable.
	imsHss, ok := registry.Lookup("imsHss")
	if !ok {
		t.Fatal("imsHss component must exist")
	}
	if imsHss.MatchMethod != MatchJavaCommandLine || imsHss.ProcessName != "java" {
		t.Fatalf("imsHss must use the command-line strategy over java: %+v", imsHss)
	}
	if imsHss.Monitoring != MonitoringNotSupported {
		t.Fatal("imsHss monitoring must stay not_supported")
	}
	dra, _ := registry.Lookup("dra")
	if dra.Monitoring != MonitoringNotSupported || dra.NFTType != "" {
		t.Fatalf("dra must stay a support component without an NF type: %+v", dra)
	}
}

// ----------------------------------------------------------------- scanner

func TestScannerDetectsCNMSProcessesWithoutInventory(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	for index, name := range []string{"amfd", "smfd", "upfd", "mmed"} {
		f.process(100+index, name, "/opt/nf/"+name, uint64(10+index), 0, 1024, 4096, nil)
	}
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	for _, name := range []string{"amfd", "smfd", "upfd", "mmed"} {
		component, _ := scanner.Registry().LookupProcess(name)
		observation := observationFor(t, snapshot, component.ID)
		if observation.RuntimeStatus != StatusRunning {
			t.Fatalf("%s must be running, got %s", name, observation.RuntimeStatus)
		}
		if !observation.Verified || observation.Evidence != EvidenceVerified {
			t.Fatalf("%s must be verified evidence", name)
		}
		if observation.PrimaryPID == 0 {
			t.Fatalf("%s must report a primary pid", name)
		}
	}
	if snapshot.Scan.Status != ScanComplete || !snapshot.Scan.Complete {
		t.Fatalf("scan must be complete, got %+v", snapshot.Scan)
	}
	if snapshot.Counts.Running != 4 {
		t.Fatalf("running count must be 4, got %d", snapshot.Counts.Running)
	}
}

func TestScannerRejectsSubstringCollisions(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Now().UTC()}
	f.process(201, "amfd-helper", "/opt/nf/amfd-helper", 1, 0, 10, 10, nil)
	f.process(202, "amfd2", "/opt/nf/amfd2", 2, 0, 10, 10, nil)
	f.process(203, "mmed-helper", "/opt/nf/mmed-helper", 3, 0, 10, 10, nil)
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	amf := observationFor(t, snapshot, "amf")
	if amf.RuntimeStatus != StatusNotDetected {
		t.Fatalf("amf must not be detected from a substring collision, got %s", amf.RuntimeStatus)
	}
	mme := observationFor(t, snapshot, "mme")
	if mme.RuntimeStatus != StatusNotDetected {
		t.Fatalf("mme must not be detected from a substring collision, got %s", mme.RuntimeStatus)
	}
}

func TestScannerRejectsMasqueradingExecutable(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Now().UTC()}
	// comm matches the approved name, but the executable behind it is unrelated.
	f.process(301, "amfd", "/usr/bin/unrelated", 1, 0, 10, 10, nil)
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	amf := observationFor(t, snapshot, "amf")
	if amf.RuntimeStatus != StatusUnverified {
		t.Fatalf("masquerading executable must stay unverified, got %s", amf.RuntimeStatus)
	}
	if amf.StatusReason != ReasonExeUnverified {
		t.Fatalf("expected executable identity reason, got %s", amf.StatusReason)
	}
}

func TestScannerRejectsSharedExecutableUnderRoleTitle(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Now().UTC()}
	// A SIP stack that ships one shared binary and rewrites its process title per
	// role must not be recognized: comm says "pcscfd" while the executable behind
	// it is "kamailio". Invisibility is the intended signal that the installed
	// image does not match the declared per-role process names.
	f.process(311, "pcscfd", "/usr/local/sbin/kamailio", 1, 0, 10, 10, nil)
	// The same role launched from its own per-role executable does verify.
	f.process(312, "scscfd", "/usr/local/sbin/scscfd", 2, 0, 10, 10, nil)
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	pcscf := observationFor(t, snapshot, "pcscf")
	if pcscf.RuntimeStatus != StatusUnverified || pcscf.StatusReason != ReasonExeUnverified {
		t.Fatalf("a shared binary must stay unverified with the executable identity reason, got %s/%s", pcscf.RuntimeStatus, pcscf.StatusReason)
	}
	scscf := observationFor(t, snapshot, "scscf")
	if scscf.RuntimeStatus != StatusRunning || !scscf.Verified {
		t.Fatalf("the per-role executable must verify by exact name, got %s verified=%v", scscf.RuntimeStatus, scscf.Verified)
	}
}

func TestScannerReportsPermissionDeniedExecutable(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Now().UTC()}
	f.permissionDenied(401, "amfd")
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	amf := observationFor(t, snapshot, "amf")
	if amf.RuntimeStatus != StatusPermissionDenied {
		t.Fatalf("permission failure must be explicit, got %s", amf.RuntimeStatus)
	}
}

func TestScannerHandlesCommTruncation(t *testing.T) {
	longName := "xcloudgatewayprocessd" // 22 bytes, above the 15-byte comm limit
	registry, err := NewRegistry([]Component{{
		ID: "long", DisplayName: "LONG", ProcessName: longName, Category: Category5GC,
		Domain: "5gc", Role: "amf", NFTType: "AMF", Monitoring: MonitoringSupported,
		Templates: []string{TemplateAuto},
	}})
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	f := newFixture(t)
	clock := &fakeClock{now: time.Now().UTC()}
	// The kernel truncates comm to 15 bytes, so only the executable can prove
	// the identity.
	f.process(501, longName[:15], "/opt/nf/"+longName, 1, 0, 10, 10, nil)
	scanner := NewScanner(registry, ScannerOptions{
		ProcRoot: f.root, Clock: clock.Now, Readlink: f.readlink,
		Host: &HostIdentity{HostID: "host-test", Visibility: VisibilityHost},
	})
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)
	observation := observationFor(t, snapshot, "long")
	if observation.RuntimeStatus != StatusRunning {
		t.Fatalf("truncated comm must resolve through the executable, got %s", observation.RuntimeStatus)
	}
}

func TestScannerMultiWorkerAndPrimaryPID(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Now().UTC()}
	f.process(610, "upfd", "/opt/nf/upfd", 500, 10, 100, 200, nil)
	f.process(611, "upfd", "/opt/nf/upfd", 300, 10, 100, 200, nil)
	f.process(612, "upfd", "/opt/nf/upfd", 400, 10, 100, 200, nil)
	scanner := newTestScanner(f, clock)
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)

	upf := observationFor(t, snapshot, "upf")
	if upf.WorkerCount != 3 {
		t.Fatalf("worker count must be 3, got %d", upf.WorkerCount)
	}
	if upf.PrimaryPID != 611 {
		t.Fatalf("primary pid must be the earliest started worker (611), got %d", upf.PrimaryPID)
	}
	if upf.MemoryRSSBytes == nil || *upf.MemoryRSSBytes != 300*1024 {
		t.Fatalf("memory must be the verified group aggregate, got %v", upf.MemoryRSSBytes)
	}
	if upf.MemoryBasis != MemoryBasisGroupAggregate {
		t.Fatalf("memory basis must be documented, got %s", upf.MemoryBasis)
	}
}

func TestScannerCPURequiresIntervalDelta(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	f.process(701, "smfd", "/opt/nf/smfd", 1, 100, 10, 10, nil)
	scanner := newTestScanner(f, clock)

	first, _ := scanner.Scan(t.Context(), TriggerManual, nil)
	if got := observationFor(t, first, "smf"); got.CPUAvailable || got.CPUPercent != nil {
		t.Fatalf("first observation must not report a CPU percentage, got %v", got.CPUPercent)
	}

	// Advance the wall clock by one second and 50 CPU ticks (0.5 CPU seconds).
	clock.advance(time.Second)
	f.process(701, "smfd", "/opt/nf/smfd", 1, 150, 10, 10, nil)
	second, _ := scanner.Scan(t.Context(), TriggerScheduled, nil)
	got := observationFor(t, second, "smf")
	if !got.CPUAvailable || got.CPUPercent == nil {
		t.Fatal("second observation must report a CPU percentage")
	}
	if *got.CPUPercent < 49 || *got.CPUPercent > 51 {
		t.Fatalf("expected about 50 percent, got %v", *got.CPUPercent)
	}
	if got.CPUBasis != CPUBasisIntervalDelta {
		t.Fatalf("cpu basis must document the interval delta, got %s", got.CPUBasis)
	}
}

func TestScannerPIDReuseInvalidatesCPU(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	f.process(801, "smfd", "/opt/nf/smfd", 10, 100, 10, 10, nil)
	scanner := newTestScanner(f, clock)
	scanner.Scan(t.Context(), TriggerManual, nil)

	// Same PID, different start time: the kernel reused the identifier.
	clock.advance(time.Second)
	f.process(801, "smfd", "/opt/nf/smfd", 99, 5, 10, 10, nil)
	second, _ := scanner.Scan(t.Context(), TriggerScheduled, nil)
	got := observationFor(t, second, "smf")
	if got.CPUAvailable || got.CPUPercent != nil {
		t.Fatalf("a reused pid must not produce a CPU delta, got %v", got.CPUPercent)
	}
}

func TestScannerStatusSemantics(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	f.process(901, "amfd", "/opt/nf/amfd", 1, 0, 10, 10, nil)
	scanner := newTestScanner(f, clock, "mme")

	first, states := scanner.Scan(t.Context(), TriggerManual, nil)
	if got := observationFor(t, first, "amf"); got.RuntimeStatus != StatusRunning {
		t.Fatalf("amf must be running, got %s", got.RuntimeStatus)
	}
	if got := observationFor(t, first, "mme"); got.RuntimeStatus != StatusStopped {
		t.Fatalf("an explicitly expected but absent service must be stopped, got %s", got.RuntimeStatus)
	}
	if got := observationFor(t, first, "smf"); got.RuntimeStatus != StatusNotDetected {
		t.Fatalf("a never observed component must be not_detected, got %s", got.RuntimeStatus)
	}

	// The process disappears: a complete scan establishes stopped.
	os.RemoveAll(filepath.Join(f.root, "901"))
	second, _ := scanner.Scan(t.Context(), TriggerScheduled, states)
	if got := observationFor(t, second, "amf"); got.RuntimeStatus != StatusStopped {
		t.Fatalf("a previously observed component must become stopped, got %s", got.RuntimeStatus)
	} else if got.StatusReason != ReasonAbsentAfterObservation {
		t.Fatalf("expected the previous-observation reason, got %s", got.StatusReason)
	}
}

func TestScannerIncompleteScanNeverEstablishesStopped(t *testing.T) {
	f := newFixture(t)
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	f.process(1001, "amfd", "/opt/nf/amfd", 1, 0, 10, 10, nil)
	scanner := newTestScanner(f, clock)
	_, states := scanner.Scan(t.Context(), TriggerManual, nil)

	// Remove the process and make one entry unreadable: absence is no longer a
	// complete observation. An entry whose comm cannot be read models a process
	// that exited mid-scan or a namespace the scanner cannot fully inspect.
	os.RemoveAll(filepath.Join(f.root, "1001"))
	dir := filepath.Join(f.root, "1002")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(statLine(1002, "otherd", 1, 0, 0, 5)), 0o600); err != nil {
		t.Fatalf("stat: %v", err)
	}

	snapshot, _ := scanner.Scan(t.Context(), TriggerScheduled, states)
	if snapshot.Scan.Status != ScanIncomplete {
		t.Fatalf("scan must be reported incomplete, got %s", snapshot.Scan.Status)
	}
	got := observationFor(t, snapshot, "amf")
	if got.RuntimeStatus != StatusUnknown {
		t.Fatalf("incomplete evidence must never establish stopped, got %s", got.RuntimeStatus)
	}
	if got.StatusReason != ReasonScanIncomplete {
		t.Fatalf("expected the incomplete reason, got %s", got.StatusReason)
	}
}

func TestScannerUnreadableProcNamespace(t *testing.T) {
	clock := &fakeClock{now: time.Now().UTC()}
	scanner := NewScanner(DefaultRegistry(), ScannerOptions{
		ProcRoot: filepath.Join(t.TempDir(), "missing"),
		Clock:    clock.Now,
		Host:     &HostIdentity{HostID: "host-test", Visibility: VisibilityHost},
	})
	snapshot, _ := scanner.Scan(t.Context(), TriggerManual, nil)
	if snapshot.Scan.Status != ScanFailed {
		t.Fatalf("an unreadable namespace must fail the scan, got %s", snapshot.Scan.Status)
	}
	for _, observation := range snapshot.Components {
		if observation.RuntimeStatus != StatusPermissionDenied {
			t.Fatalf("%s must report permission_denied, got %s", observation.ComponentID, observation.RuntimeStatus)
		}
	}
	if snapshot.Counts.Stopped != 0 {
		t.Fatal("an inspection failure must never report stopped components")
	}
}

func TestHostResolverReportsContainerVisibility(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, ".dockerenv")
	if err := os.WriteFile(marker, []byte(""), 0o600); err != nil {
		t.Fatalf("marker: %v", err)
	}
	machine := filepath.Join(root, "machine-id")
	if err := os.WriteFile(machine, []byte("0123456789abcdef0123456789abcdef\n"), 0o600); err != nil {
		t.Fatalf("machine id: %v", err)
	}
	resolver := &hostResolver{
		procRoot:     root,
		machineFiles: []string{machine},
		markerFiles:  []string{marker},
		hostname:     func() (string, error) { return "test-host", nil },
	}
	identity := resolver.resolve()
	if identity.Visibility != VisibilityContainerLimit {
		t.Fatalf("container marker must limit visibility, got %s", identity.Visibility)
	}
	if strings.Contains(identity.HostID, "0123456789abcdef") {
		t.Fatal("the raw machine identifier must never be exposed")
	}
	if !strings.HasPrefix(identity.HostID, "host-") {
		t.Fatalf("host id must be namespaced, got %s", identity.HostID)
	}
}

// removeFixtureProcess deletes one fixture process directory.
func removeFixtureProcess(t *testing.T, f *fixture, pid int) {
	t.Helper()
	if err := os.RemoveAll(filepath.Join(f.root, strconv.Itoa(pid))); err != nil {
		t.Fatalf("remove fixture process: %v", err)
	}
}
