package nflogs

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

type stubUnits struct {
	available bool
	note      string
	body      string
	failOpen  error

	opened bool
	unit   string
	lines  int
	follow bool
}

func (s *stubUnits) Available() (bool, string) { return s.available, s.note }

func (s *stubUnits) Open(_ context.Context, unit string, lines int, follow bool) (io.ReadCloser, error) {
	s.opened = true
	s.unit = unit
	s.lines = lines
	s.follow = follow
	if s.failOpen != nil {
		return nil, s.failOpen
	}
	return io.NopCloser(strings.NewReader(s.body)), nil
}

func newUnitHandler(t *testing.T, units UnitReader) *Handler {
	t.Helper()
	registry, err := NewRegistry("", "", "amf=amf.service", "")
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	registry.journal = units
	handler := NewHandler(registry, stubLimiter{}, nil)
	handler.units = units
	return handler
}

func TestJournalEntryRendersLineAndPriority(t *testing.T) {
	entry := journalEntry{
		Message:  "link established",
		Priority: "4",
		Realtime: "1792424581795498",
		Hostname: "node-1",
		Ident:    "amfd",
		PID:      "42",
	}
	line := entry.line()
	for _, part := range []string{"node-1", "amfd[42]", "link established"} {
		if !strings.Contains(line, part) {
			t.Fatalf("line %q must contain %q", line, part)
		}
	}
	if entry.level() != LevelWarn {
		t.Fatalf("syslog priority 4 is a warning, got %q", entry.level())
	}

	if got := (journalEntry{Priority: "3"}).level(); got != LevelError {
		t.Fatalf("priority 3 must be error, got %q", got)
	}
	if got := (journalEntry{Priority: "7"}).level(); got != LevelDebug {
		t.Fatalf("priority 7 must be debug, got %q", got)
	}
	if got := (journalEntry{}).level(); got != "" {
		t.Fatalf("a missing priority must fall back to the text, got %q", got)
	}
}

func TestJournalEntryFoldsMultiLineMessages(t *testing.T) {
	entry := journalEntry{Message: "first line\nsecond line", Priority: "6"}
	line := entry.line()
	if strings.Contains(line, "\n") {
		t.Fatalf("the wire format carries one line per event: %q", line)
	}
	if !strings.Contains(line, "first line second line") {
		t.Fatalf("the folded message must keep both halves: %q", line)
	}
}

func TestJournalValueAcceptsByteArray(t *testing.T) {
	var entry journalEntry
	body := `{"MESSAGE":[104,105],"PRIORITY":"6"}`
	if err := json.Unmarshal([]byte(body), &entry); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(entry.Message) != "hi" {
		t.Fatalf("byte-array messages must decode, got %q", string(entry.Message))
	}
}

func TestReadJournalEntrySkipsMalformedAndOversized(t *testing.T) {
	oversized := `{"MESSAGE":"` + strings.Repeat("x", maxJournalEntryBytes+64) + `"}`
	body := strings.Join([]string{
		`not json at all`,
		`{"MESSAGE":"kept","PRIORITY":"6"}`,
		oversized,
		`{"MESSAGE":"also kept","PRIORITY":"3"}`,
	}, "\n") + "\n"

	reader := bufio.NewReaderSize(strings.NewReader(body), 4096)
	var messages []string
	for {
		entry, err := readJournalEntry(reader)
		if err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("read: %v", err)
		}
		messages = append(messages, string(entry.Message))
	}
	if len(messages) != 2 || messages[0] != "kept" || messages[1] != "also kept" {
		t.Fatalf("an oversized entry must not end the stream: %#v", messages)
	}
}

func TestRegistryDescribesUnitSources(t *testing.T) {
	units := &stubUnits{available: true}
	handler := newUnitHandler(t, units)
	sources := handler.registry.List()
	if len(sources) != 1 {
		t.Fatalf("want one source, got %#v", sources)
	}
	if sources[0].Kind != SourceKindUnit || sources[0].Name != "amf.service" {
		t.Fatalf("unexpected unit source: %#v", sources[0])
	}
	if !sources[0].Readable {
		t.Fatal("a readable journal must mark the source readable")
	}

	unavailable := &stubUnits{available: false, note: "the system journal is not readable by this account; add it to the systemd-journal group"}
	blocked := newUnitHandler(t, unavailable).registry.List()
	if blocked[0].Readable {
		t.Fatal("an unreadable journal must not claim the source is readable")
	}
	if blocked[0].Note == "" {
		t.Fatal("an unreadable unit source must explain itself")
	}
}

func TestRegistryRejectsBadUnitDeclarations(t *testing.T) {
	cases := []string{
		"amf=amf*.service",
		"amf=amf?.service",
		"AMF=amf.service",
		"amf=../../etc/passwd",
		"amf=amf.service,amf=smf.service",
	}
	for _, declaration := range cases {
		if _, err := NewRegistry("", "", declaration, ""); err == nil {
			t.Fatalf("%q must be rejected", declaration)
		}
	}

	path := t.TempDir() + "/amf.log"
	if _, err := NewRegistry("", "amf="+path, "amf=amf.service", ""); err == nil {
		t.Fatal("a unit source may not reuse a file source id")
	}
}

func TestStreamUnitSanitizesAndFilters(t *testing.T) {
	units := &stubUnits{
		available: true,
		body: strings.Join([]string{
			`{"MESSAGE":"started amf 460001234567890","PRIORITY":"6","__REALTIME_TIMESTAMP":"1792424581795498","_HOSTNAME":"node-1","SYSLOG_IDENTIFIER":"amfd","_PID":"42"}`,
			`{"MESSAGE":"peer error password=hunter2","PRIORITY":"3","__REALTIME_TIMESTAMP":"1792424582795498","_HOSTNAME":"node-1","SYSLOG_IDENTIFIER":"amfd","_PID":"42"}`,
		}, "\n") + "\n",
	}
	handler := newUnitHandler(t, units)

	recorder := request(handler, "/api/nf-logs/stream?sourceId=amf&tailLines=25&follow=false", "viewer")
	if recorder.Code != 200 {
		t.Fatalf("stream must start, got %d (%s)", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !units.opened || units.unit != "amf.service" || units.lines != 25 || units.follow {
		t.Fatalf("unexpected journal read: %#v", units)
	}
	if !strings.Contains(body, "event: line") || !strings.Contains(body, "event: meta") {
		t.Fatalf("the stream must announce itself and carry lines: %s", body)
	}
	if strings.Contains(body, "460001234567890") || !strings.Contains(body, "[imsi]") {
		t.Fatalf("a journal line must pass the same sanitizer as a file line: %s", body)
	}
	if strings.Contains(body, "hunter2") || !strings.Contains(body, "password=[redacted]") {
		t.Fatalf("credentials must be masked: %s", body)
	}
	if !strings.Contains(body, `"level":"error"`) {
		t.Fatalf("the syslog priority must drive the level: %s", body)
	}
}

func TestStreamUnitAppliesLevelAndKeyword(t *testing.T) {
	units := &stubUnits{
		available: true,
		body: strings.Join([]string{
			`{"MESSAGE":"started amf","PRIORITY":"6"}`,
			`{"MESSAGE":"peer error","PRIORITY":"3"}`,
		}, "\n") + "\n",
	}
	handler := newUnitHandler(t, units)

	recorder := request(handler, "/api/nf-logs/stream?sourceId=amf&level=error&follow=false", "viewer")
	body := recorder.Body.String()
	if strings.Contains(body, "started amf") {
		t.Fatalf("the level filter must drop info lines: %s", body)
	}
	if !strings.Contains(body, "peer error") {
		t.Fatalf("the level filter must keep error lines: %s", body)
	}

	units.body = strings.Join([]string{
		`{"MESSAGE":"started amf","PRIORITY":"6"}`,
		`{"MESSAGE":"peer error","PRIORITY":"3"}`,
	}, "\n") + "\n"
	recorder = request(handler, "/api/nf-logs/stream?sourceId=amf&keyword=started&follow=false", "viewer")
	body = recorder.Body.String()
	if !strings.Contains(body, "started amf") || strings.Contains(body, "peer error") {
		t.Fatalf("the keyword filter must be literal and exact: %s", body)
	}
}

func TestStreamUnitReportsUnavailableJournal(t *testing.T) {
	units := &stubUnits{available: false, note: "the system journal is not readable by this account; add it to the systemd-journal group"}
	handler := newUnitHandler(t, units)

	recorder := request(handler, "/api/nf-logs/stream?sourceId=amf&follow=false", "viewer")
	if recorder.Code != 409 {
		t.Fatalf("an unreadable journal must fail before the stream starts, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "systemd-journal") {
		t.Fatalf("the refusal must explain the permission: %s", recorder.Body.String())
	}
	if units.opened {
		t.Fatal("no child process may be started when the journal is unreadable")
	}
}

// TestJournalctlReadsARealUnit is the deployment probe. It runs only when an
// operator names a unit, because the answer depends on the host: the account
// running the server must be able to read the system journal.
//
//	NF_LOGS_JOURNAL_UNIT=cron.service go test ./internal/nflogs/ -run RealUnit -v
func TestJournalctlReadsARealUnit(t *testing.T) {
	unit := strings.TrimSpace(os.Getenv("NF_LOGS_JOURNAL_UNIT"))
	if unit == "" {
		t.Skip("set NF_LOGS_JOURNAL_UNIT to read a real unit journal")
	}

	reader := newJournalctlReader()
	if ok, note := reader.Available(); !ok {
		t.Fatalf("the journal is not readable by this account: %s", note)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	stream, err := reader.Open(ctx, unit, 5, false)
	if err != nil {
		t.Fatalf("open %s: %v", unit, err)
	}
	defer stream.Close()

	lines := 0
	buffered := bufio.NewReaderSize(stream, 64*1024)
	for {
		entry, err := readJournalEntry(buffered)
		if err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("read %s: %v", unit, err)
		}
		if entry.line() == "" {
			t.Fatalf("an entry must render a line: %#v", entry)
		}
		lines++
	}
	if lines == 0 {
		t.Fatalf("%s produced no journal entries; either the unit is silent or the read is still unprivileged", unit)
	}
	t.Logf("read %d entries from %s", lines, unit)
}
