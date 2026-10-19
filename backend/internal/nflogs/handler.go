package nflogs

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"subscriber/internal/audit"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

// RateLimiter mirrors the platform's request limiter.
type RateLimiter interface {
	Enforce(w http.ResponseWriter, r *http.Request, identifier string, limit int, windowSeconds int) bool
}

// AuditWriter records denied access attempts.
type AuditWriter interface {
	WriteBestEffort(input audit.WriteAuditInput)
}

// Handler serves the read-only log surface.
type Handler struct {
	registry    *Registry
	limiter     RateLimiter
	auditWriter AuditWriter
	units       UnitReader

	slots *streamSlots

	tick      time.Duration
	heartbeat time.Duration
	now       func() time.Time
}

// NewHandler constructs the log handler.
func NewHandler(registry *Registry, limiter RateLimiter, auditWriter AuditWriter) *Handler {
	return &Handler{
		registry:    registry,
		limiter:     limiter,
		auditWriter: auditWriter,
		units:       newJournalctlReader(),
		slots:       &streamSlots{perUser: map[string]int{}},
		tick:        StreamTickInterval,
		heartbeat:   StreamHeartbeat,
		now:         func() time.Time { return time.Now().UTC() },
	}
}

/* ------------------------------------------------------------------ sources -- */

// ListSources handles GET /api/nf-logs/sources.
func (h *Handler) ListSources(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-logs/sources")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-logs:sources:"+p.Username, 120, 60) {
		return
	}
	query := r.URL.Query()
	for param := range query {
		if param != "resourceId" {
			response.BadRequest(w, "unsupported query parameter: "+param, "UNSUPPORTED_QUERY_PARAMETER")
			return
		}
	}

	sources := h.registry.List()
	if resourceID := strings.TrimSpace(query.Get("resourceId")); resourceID != "" {
		sources = h.registry.SourcesForResource(resourceID)
	}
	if sources == nil {
		sources = []Source{}
	}

	response.JSON(w, http.StatusOK, SourcesResponse{
		GeneratedAt: h.now().Format(time.RFC3339),
		Sources:     sources,
		Capabilities: Capabilities{
			DefaultTailLines:      DefaultTailLines,
			MaxTailLines:          MaxTailLines,
			Levels:                []string{LevelDebug, LevelInfo, LevelWarn, LevelError},
			MaxLineBytes:          MaxLineBytes,
			Follow:                true,
			KeywordIsLiteral:      true,
			ConcurrencyPerSession: MaxStreamsPerUser,
		},
	})
}

/* ------------------------------------------------------------------- stream -- */

type streamOptions struct {
	sourceID  string
	tailLines int
	level     string
	keyword   string
	follow    bool
}

// Stream handles GET /api/nf-logs/stream as server-sent events.
func (h *Handler) Stream(w http.ResponseWriter, r *http.Request) {
	p := h.requireRead(w, r, "GET", "/api/nf-logs/stream")
	if p == nil {
		return
	}
	if h.limiter != nil && !h.limiter.Enforce(w, r, "nf-logs:stream:"+p.Username, 30, 60) {
		return
	}

	options, err := parseStreamOptions(r)
	if err != nil {
		writeValidation(w, err)
		return
	}
	item, ok := h.registry.Resolve(options.sourceID)
	if !ok {
		response.Error(w, http.StatusNotFound, "log source not found", "NF_LOG_SOURCE_NOT_FOUND")
		return
	}

	if !h.slots.acquire(p.Username) {
		w.Header().Set("Retry-After", "5")
		response.Error(w, http.StatusTooManyRequests,
			fmt.Sprintf("at most %d concurrent log streams per session", MaxStreamsPerUser),
			"NF_LOG_STREAM_LIMIT")
		return
	}
	defer h.slots.release(p.Username)

	// A file source is opened here, so an unreadable file is still an HTTP
	// error. A unit source cannot be checked by opening it; its state is
	// reported before the stream starts and again if the read fails.
	var file *os.File
	if item.Kind == SourceKindUnit {
		if ok, note := h.units.Available(); !ok {
			response.Error(w, http.StatusConflict, note, "NF_LOG_SOURCE_UNREADABLE")
			return
		}
	} else {
		opened, err := os.Open(item.Path)
		if err != nil {
			response.Error(w, http.StatusConflict, "log source is not readable", "NF_LOG_SOURCE_UNREADABLE")
			return
		}
		defer opened.Close()
		file = opened
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		response.Error(w, http.StatusInternalServerError, "streaming is unavailable", "NF_LOG_STREAM_UNAVAILABLE")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// A reconnect is a new tail, not a resume from the last byte.
	fmt.Fprint(w, "retry: 3000\n\n")

	encoder := &streamWriter{w: w, flusher: flusher}
	_ = encoder.event("meta", StreamMeta{
		SourceID:  item.ID,
		Name:      item.Name,
		TailLines: options.tailLines,
		Level:     options.level,
		Keyword:   options.keyword,
		Follow:    options.follow,
		StartedAt: h.now().Format(time.RFC3339),
	})

	seq := int64(0)
	send := func(raw, level string) {
		text := SanitizeLine(raw)
		if level == "" {
			// A file line carries its severity in the text, if at all. A
			// journal entry already knows its syslog priority.
			level = DetectLevel(text)
		}
		if !LevelAllowed(options.level, level) || !MatchesKeyword(options.keyword, text) {
			return
		}
		seq++
		_ = encoder.event("line", StreamLine{Seq: seq, Level: level, Text: text})
	}

	if item.Kind == SourceKindUnit {
		h.streamUnit(r.Context(), encoder, item, options, send)
		return
	}

	lines, endOffset, err := TailFile(file, options.tailLines, MaxScanBytes)
	if err != nil {
		_ = encoder.event("notice", StreamNotice{Reason: "unreadable", Detail: "the tail read failed"})
		return
	}
	for _, line := range lines {
		send(line, "")
	}
	encoder.flush()

	if !options.follow {
		return
	}

	h.follow(r.Context(), encoder, file, item, endOffset, send)
}

// follow reads appended bytes until the client leaves or the source is gone.
func (h *Handler) follow(
	ctx context.Context,
	encoder *streamWriter,
	file *os.File,
	item entry,
	offset int64,
	send func(string, string),
) {
	openInfo, _ := file.Stat()
	ticker := time.NewTicker(h.tick)
	defer ticker.Stop()
	heartbeat := time.NewTicker(h.heartbeat)
	defer heartbeat.Stop()

	pending := make([]byte, 0, 8192)
	dropped := 0
	second := h.now()
	sentThisSecond := 0

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			_ = encoder.event("heartbeat", map[string]string{"at": h.now().Format(time.RFC3339)})
			encoder.flush()
		case <-ticker.C:
			// Rotation or truncation: the open handle no longer describes the
			// file the operator points at, so the stream ends and the client
			// reconnects instead of silently reading a stale inode.
			if pathInfo, err := os.Stat(item.Path); err != nil || (openInfo != nil && !os.SameFile(openInfo, pathInfo)) {
				_ = encoder.event("notice", StreamNotice{Reason: "rotated", Detail: "the source file was replaced"})
				encoder.flush()
				return
			}
			if info, err := file.Stat(); err == nil && info.Size() < offset {
				_ = encoder.event("notice", StreamNotice{Reason: "truncated", Detail: "the source file shrank"})
				encoder.flush()
				return
			}

			chunk := make([]byte, 64*1024)
			n, readErr := file.ReadAt(chunk, offset)
			if n > 0 {
				offset += int64(n)
				pending = append(pending, chunk[:n]...)
			}
			if readErr != nil && !errors.Is(readErr, io.EOF) {
				_ = encoder.event("notice", StreamNotice{Reason: "unreadable", Detail: "the follow read failed"})
				encoder.flush()
				return
			}

			for {
				index := indexByte(pending, '\n')
				if index < 0 {
					// A single line has a hard ceiling; the remainder is
					// emitted truncated rather than buffered forever.
					if len(pending) > MaxLineBytes*2 {
						h.emit(&send, string(pending), "", &dropped, &sentThisSecond, &second)
						pending = pending[:0]
						encoder.flush()
					}
					break
				}
				line := string(pending[:index])
				pending = pending[index+1:]
				h.emit(&send, line, "", &dropped, &sentThisSecond, &second)
			}
			if dropped > 0 {
				_ = encoder.event("dropped", StreamDropped{Count: dropped})
				dropped = 0
			}
			encoder.flush()
		}
	}
}

// emit applies the per-stream line rate. Lines above the ceiling are dropped
// and reported in a single frame, so a noisy source cannot flood the browser.
func (h *Handler) emit(send *func(string, string), text, level string, dropped, sent *int, second *time.Time) {
	now := h.now()
	if now.Sub(*second) >= time.Second {
		*second = now
		*sent = 0
	}
	if *sent >= MaxLinesPerSecond {
		*dropped++
		return
	}
	*sent++
	(*send)(text, level)
}

func indexByte(data []byte, target byte) int {
	for i, value := range data {
		if value == target {
			return i
		}
	}
	return -1
}

// streamUnit reads one systemd unit's journal.
//
// journalctl is the only reader: this process never opens the journal itself,
// so the account running the server needs the same access a human running
// journalctl needs. Tail and follow are one child process, which is why no
// entry can be lost between the two.
func (h *Handler) streamUnit(
	ctx context.Context,
	encoder *streamWriter,
	item entry,
	options streamOptions,
	send func(string, string),
) {
	stream, err := h.units.Open(ctx, item.Unit, options.tailLines, options.follow)
	if err != nil {
		_ = encoder.event("notice", StreamNotice{Reason: "unreadable", Detail: err.Error()})
		encoder.flush()
		return
	}
	defer stream.Close()

	type journalLine struct {
		text  string
		level string
	}
	lines := make(chan journalLine, 64)
	failures := make(chan error, 1)
	go func() {
		defer close(lines)
		reader := bufio.NewReaderSize(stream, 64*1024)
		for {
			entry, err := readJournalEntry(reader)
			if err != nil {
				if !errors.Is(err, io.EOF) {
					select {
					case failures <- err:
					default:
					}
				}
				return
			}
			select {
			case lines <- journalLine{text: entry.line(), level: entry.level()}:
			case <-ctx.Done():
				return
			}
		}
	}()

	heartbeat := time.NewTicker(h.heartbeat)
	defer heartbeat.Stop()

	dropped := 0
	sent := 0
	second := h.now()
	lastDropReport := h.now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			_ = encoder.event("heartbeat", map[string]string{"at": h.now().Format(time.RFC3339)})
			encoder.flush()
		case err := <-failures:
			_ = encoder.event("notice", StreamNotice{Reason: "unreadable", Detail: err.Error()})
			encoder.flush()
			return
		case line, ok := <-lines:
			if !ok {
				if !options.follow {
					return
				}
				// The child stopped following. Say so instead of leaving a
				// stream that looks live but shows nothing.
				_ = encoder.event("notice", StreamNotice{Reason: "ended", Detail: streamFailure(stream)})
				encoder.flush()
				return
			}
			h.emit(&send, line.text, line.level, &dropped, &sent, &second)
			// A journal read is event driven, so flush each line: waiting for
			// the heartbeat would make a live stream look frozen.
			encoder.flush()
			if dropped > 0 && h.now().Sub(lastDropReport) >= time.Second {
				_ = encoder.event("dropped", StreamDropped{Count: dropped})
				dropped = 0
				lastDropReport = h.now()
				encoder.flush()
			}
		}
	}
}

/* ------------------------------------------------------------------ plumbing -- */

type streamWriter struct {
	w       io.Writer
	flusher http.Flusher
}

func (s *streamWriter) event(name string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", name, body); err != nil {
		return err
	}
	return nil
}

func (s *streamWriter) flush() {
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

// streamSlots bounds concurrent streams per session and per process.
type streamSlots struct {
	mu      sync.Mutex
	perUser map[string]int
	total   int
}

func (s *streamSlots) acquire(user string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.perUser[user] >= MaxStreamsPerUser || s.total >= MaxStreamsTotal {
		return false
	}
	s.perUser[user]++
	s.total++
	return true
}

func (s *streamSlots) release(user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.perUser[user] > 0 {
		s.perUser[user]--
		if s.perUser[user] == 0 {
			delete(s.perUser, user)
		}
	}
	if s.total > 0 {
		s.total--
	}
}

func (h *Handler) requireRead(w http.ResponseWriter, r *http.Request, method, path string) *auth.Principal {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return nil
	}
	if !auth.HasPermission(p, "core.read") {
		h.recordDenial(p, method, path)
		response.Forbidden(w, "Forbidden")
		return nil
	}
	return p
}

func (h *Handler) recordDenial(p *auth.Principal, method, path string) {
	if h.auditWriter == nil {
		return
	}
	h.auditWriter.WriteBestEffort(audit.WriteAuditInput{
		Action: "nf_logs.denied",
		Module: "nf_logs",
		Actor: audit.ActorInput{
			Type:     "user",
			Username: p.Username,
			Role:     p.Role,
		},
		Request:   &audit.RequestInput{Method: method, Path: path},
		Result:    "denied",
		RiskLevel: "low",
	})
}

/* ---------------------------------------------------------------- validation -- */

type validationError struct {
	code    string
	message string
}

func (e *validationError) Error() string { return e.message }

func invalid(code, message string) error { return &validationError{code: code, message: message} }

func writeValidation(w http.ResponseWriter, err error) {
	var invalidErr *validationError
	if errors.As(err, &invalidErr) {
		response.BadRequest(w, invalidErr.message, invalidErr.code)
		return
	}
	response.BadRequest(w, err.Error(), "INVALID_QUERY_PARAMETER")
}

func parseStreamOptions(r *http.Request) (streamOptions, error) {
	query := r.URL.Query()
	for param := range query {
		switch param {
		case "sourceId", "tailLines", "level", "keyword", "follow":
		default:
			return streamOptions{}, invalid("UNSUPPORTED_QUERY_PARAMETER", "unsupported query parameter: "+param)
		}
	}

	sourceID := strings.TrimSpace(query.Get("sourceId"))
	if sourceID == "" {
		return streamOptions{}, invalid("INVALID_SOURCE_ID", "sourceId is required")
	}
	if !sourceIDPattern.MatchString(sourceID) {
		return streamOptions{}, invalid("INVALID_SOURCE_ID", "sourceId must match the registered id shape")
	}

	tailLines := DefaultTailLines
	if raw := strings.TrimSpace(query.Get("tailLines")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > MaxTailLines {
			return streamOptions{}, invalid("INVALID_TAIL_LINES",
				fmt.Sprintf("tailLines must be an integer between 0 and %d", MaxTailLines))
		}
		tailLines = parsed
	}

	level := strings.ToLower(strings.TrimSpace(query.Get("level")))
	switch level {
	case "", LevelDebug, LevelInfo, LevelWarn, LevelError:
	default:
		return streamOptions{}, invalid("INVALID_LEVEL", "level must be debug, info, warn or error")
	}

	keyword := strings.TrimSpace(query.Get("keyword"))
	if len(keyword) > MaxKeywordBytes || !utf8.ValidString(keyword) || hasControl(keyword) {
		return streamOptions{}, invalid("INVALID_KEYWORD",
			fmt.Sprintf("keyword must be valid text of at most %d bytes", MaxKeywordBytes))
	}

	follow := true
	if raw := strings.TrimSpace(query.Get("follow")); raw != "" {
		switch raw {
		case "true":
			follow = true
		case "false":
			follow = false
		default:
			return streamOptions{}, invalid("INVALID_FOLLOW", "follow must be true or false")
		}
	}

	return streamOptions{
		sourceID:  sourceID,
		tailLines: tailLines,
		level:     level,
		keyword:   keyword,
		follow:    follow,
	}, nil
}

func hasControl(value string) bool {
	for _, character := range value {
		if (character < 0x20 && character != '\t') || character == 0x7f {
			return true
		}
	}
	return false
}
