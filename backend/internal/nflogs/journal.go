package nflogs

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

/*
 * systemd unit sources.
 *
 * The server never opens the journal itself. It runs journalctl as a child
 * process, exactly like an operator would, so the permission model is the one
 * systemd already documents: the account running this server must be able to
 * read the system journal, normally by belonging to the systemd-journal group.
 *
 * The child is bounded in the same way a file read is: one process per stream,
 * stdout read as JSON entries, a hard ceiling per entry, and the process is
 * killed when the client goes away.
 */

// unitNamePattern is the only shape a configured unit may take. Globbing
// characters are rejected on purpose: journalctl treats --unit as a pattern,
// and an explicit source should name one unit rather than a wildcard.
var unitNamePattern = regexp.MustCompile(`^[A-Za-z0-9:_.@-]{1,200}$`)

// maxJournalEntryBytes bounds one JSON entry. A stack trace that exceeds it is
// skipped rather than buffered without limit.
const maxJournalEntryBytes = 256 * 1024

// journalProbeTTL caches the host capability check so listing many unit
// sources does not reopen the journal repeatedly.
const journalProbeTTL = 10 * time.Second

// UnitReader opens a bounded read of one systemd unit's journal.
type UnitReader interface {
	// Available reports whether this process can read the system journal at
	// all, and explains why not when it cannot.
	Available() (bool, string)
	// Open starts a journal read. lines is the tail size and follow keeps the
	// read open for new entries. Closing the reader stops the process.
	Open(ctx context.Context, unit string, lines int, follow bool) (io.ReadCloser, error)
}

// journalctlReader is the production UnitReader.
type journalctlReader struct {
	binary string

	mu        sync.Mutex
	checkedAt time.Time
	ok        bool
	note      string
}

func newJournalctlReader() *journalctlReader {
	binary, _ := exec.LookPath("journalctl")
	return &journalctlReader{binary: binary}
}

// Available checks journalctl and the journal files once per TTL.
func (r *journalctlReader) Available() (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.checkedAt.IsZero() && time.Since(r.checkedAt) < journalProbeTTL {
		return r.ok, r.note
	}
	r.ok, r.note = probeJournal(r.binary)
	r.checkedAt = time.Now()
	return r.ok, r.note
}

// probeJournal answers one question: could this account read system entries?
//
// Exit codes cannot answer it. journalctl exits 0 and prints nothing when the
// caller is not allowed to see other users' messages, so the probe looks at
// the journal files themselves, which is the same permission the library uses.
func probeJournal(binary string) (bool, string) {
	if binary == "" {
		return false, "journalctl is not installed on this host"
	}
	denied := false
	for _, pattern := range []string{
		"/var/log/journal/*/system.journal",
		"/run/log/journal/*/system.journal",
	} {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, path := range matches {
			file, err := os.Open(path)
			if err == nil {
				_ = file.Close()
				return true, ""
			}
			if errors.Is(err, os.ErrPermission) {
				denied = true
			}
		}
	}
	if denied {
		return false, "the system journal is not readable by this account; add it to the systemd-journal group"
	}
	return false, "this host has no system journal to read"
}

// Open runs journalctl for one unit. Tail and follow are one process, so no
// entry can slip through the gap between a separate tail and follow.
func (r *journalctlReader) Open(ctx context.Context, unit string, lines int, follow bool) (io.ReadCloser, error) {
	if r.binary == "" {
		return nil, errors.New("journalctl is not installed on this host")
	}
	if !unitNamePattern.MatchString(unit) {
		return nil, fmt.Errorf("invalid unit name %q", unit)
	}

	args := []string{
		"--unit=" + unit,
		"--no-pager",
		"--quiet",
		"--output=json",
		"--lines=" + strconv.Itoa(lines),
	}
	if follow {
		args = append(args, "--follow")
	}

	read, write, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stderr := &limitedBuffer{limit: 4096}
	command := exec.CommandContext(ctx, r.binary, args...)
	command.Stdout = write
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		_ = read.Close()
		_ = write.Close()
		return nil, err
	}
	// The parent keeps only the read end; deleting our copy of the write end
	// makes the read observe EOF as soon as the child exits.
	_ = write.Close()

	return &unitStream{command: command, reader: read, stderr: stderr}, nil
}

// unitStream is the read end of one journalctl process.
type unitStream struct {
	command *exec.Cmd
	reader  *os.File
	stderr  *limitedBuffer
	once    sync.Once
	err     error
}

func (s *unitStream) Read(p []byte) (int, error) { return s.reader.Read(p) }

// Close kills the child and waits for it. Killing first means a blocked Read
// returns instead of holding the handler open.
func (s *unitStream) Close() error {
	s.once.Do(func() {
		if s.command.Process != nil {
			_ = s.command.Process.Kill()
		}
		_ = s.reader.Close()
		s.err = s.command.Wait()
	})
	return nil
}

// Failure is the child's own explanation for an early exit, if it left one.
func (s *unitStream) Failure() string {
	message := strings.TrimSpace(s.stderr.String())
	if message == "" {
		return "journalctl stopped reading this unit"
	}
	return firstLine(message)
}

func streamFailure(stream io.ReadCloser) string {
	if reporter, ok := stream.(interface{ Failure() string }); ok {
		return reporter.Failure()
	}
	return "the journal read ended"
}

// limitedBuffer keeps the first bytes of a chatty stderr and drops the rest.
type limitedBuffer struct {
	mu     sync.Mutex
	limit  int
	buffer bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.limit - b.buffer.Len(); room > 0 {
		if len(p) > room {
			b.buffer.Write(p[:room])
		} else {
			b.buffer.Write(p)
		}
	}
	// Always report a full write: the writer must not block on our ceiling.
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		text = text[:index]
	}
	return strings.TrimSpace(text)
}

/* ------------------------------------------------------------------- decode -- */

// journalValue accepts the two shapes journald uses for a text field: a JSON
// string, or an array of bytes when the value is not valid UTF-8.
type journalValue string

func (v *journalValue) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*v = ""
		return nil
	}
	if data[0] == '"' {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		*v = journalValue(text)
		return nil
	}
	var raw []byte
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*v = journalValue(raw)
	return nil
}

// journalEntry is the subset of a journald JSON object this surface renders.
type journalEntry struct {
	Message  journalValue `json:"MESSAGE"`
	Priority string       `json:"PRIORITY"`
	Realtime string       `json:"__REALTIME_TIMESTAMP"`
	Hostname string       `json:"_HOSTNAME"`
	Ident    string       `json:"SYSLOG_IDENTIFIER"`
	Comm     string       `json:"_COMM"`
	PID      string       `json:"_PID"`
}

// line renders the entry in a shape an operator reads like a log file.
func (e journalEntry) line() string {
	parts := make([]string, 0, 4)
	if stamp := e.timestamp(); stamp != "" {
		parts = append(parts, stamp)
	}
	if host := strings.TrimSpace(e.Hostname); host != "" {
		parts = append(parts, host)
	}
	ident := strings.TrimSpace(e.Ident)
	if ident == "" {
		ident = strings.TrimSpace(e.Comm)
	}
	if ident == "" {
		ident = "journal"
	}
	if pid := strings.TrimSpace(e.PID); pid != "" {
		ident += "[" + pid + "]"
	}
	// Multi-line messages are folded into one line: the wire format carries
	// one line per event and the control stripper would otherwise glue the
	// halves together.
	message := strings.ReplaceAll(string(e.Message), "\n", " ")
	return strings.Join(parts, " ") + " " + ident + ": " + message
}

func (e journalEntry) timestamp() string {
	micros, err := strconv.ParseInt(strings.TrimSpace(e.Realtime), 10, 64)
	if err != nil {
		return ""
	}
	return time.UnixMicro(micros).Local().Format("2006-01-02T15:04:05Z07:00")
}

// level maps the syslog priority onto the workspace vocabulary. An entry
// without a priority is classified by its own text, like a file line.
func (e journalEntry) level() string {
	switch strings.TrimSpace(e.Priority) {
	case "0", "1", "2", "3":
		return LevelError
	case "4":
		return LevelWarn
	case "5", "6":
		return LevelInfo
	case "7":
		return LevelDebug
	default:
		return ""
	}
}

// readJournalEntry reads one JSON object. Malformed or oversized entries are
// skipped instead of ending the stream: one huge stack trace must not blind
// the operator to everything written after it.
func readJournalEntry(reader *bufio.Reader) (journalEntry, error) {
	for {
		line, complete, err := readBoundedLine(reader, maxJournalEntryBytes)
		if err != nil {
			return journalEntry{}, err
		}
		if !complete {
			continue
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var entry journalEntry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		if entry.Message == "" && entry.Priority == "" {
			continue
		}
		return entry, nil
	}
}

// readBoundedLine reads up to and including a newline, keeping at most limit
// bytes. When the line is longer, complete is false and the remainder is
// drained so the next entry still starts at a record boundary.
func readBoundedLine(reader *bufio.Reader, limit int) ([]byte, bool, error) {
	line := make([]byte, 0, 512)
	complete := true
	for {
		chunk, err := reader.ReadSlice('\n')
		if err == nil {
			if len(line)+len(chunk) > limit {
				if room := limit - len(line); room > 0 {
					line = append(line, chunk[:room]...)
				}
				complete = false
			} else {
				line = append(line, chunk...)
			}
			return line, complete, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			room := limit - len(line)
			if room > 0 {
				if len(chunk) > room {
					chunk = chunk[:room]
				}
				line = append(line, chunk...)
			}
			if len(line) >= limit {
				complete = false
			}
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(line) == 0 {
				return nil, complete, io.EOF
			}
			return line, complete, nil
		}
		return nil, complete, err
	}
}
