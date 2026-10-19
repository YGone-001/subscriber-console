/*
 * Package nflogs serves the read-only log workspace.
 *
 * Boundaries that are not negotiable:
 *
 *   - A request never names a file. It names a source id that the server built
 *     from operator configuration at startup; the mapping id -> absolute path
 *     lives only in this process.
 *   - Sources are files ("kind":"file") or systemd units ("kind":"unit"). A
 *     unit is read through journalctl, so the host account needs the usual
 *     systemd-journal read access; an unreadable journal says so instead of
 *     pretending the unit is silent.
 *   - Every line leaves through one sanitizer. IMSI, IMPI, MSISDN, IPv4
 *     addresses and credential-looking pairs are masked before serialization.
 *   - Reads are bounded: line length, tail size, line rate and concurrent
 *     streams all have hard ceilings.
 */
package nflogs

import "time"

// Source kinds. A file source is read from the path an operator declared; a
// unit source is read from the systemd journal by the account this process
// runs as.
const (
	SourceKindFile = "file"
	SourceKindUnit = "unit"
)

// Bounds. They are part of the contract: the UI reads them from /sources.
const (
	DefaultTailLines = 100
	MaxTailLines     = 500
	MaxSources       = 64
	MaxLineBytes     = 4096
	// MaxScanBytes bounds how far back a tail read walks. A larger file is
	// still served, just from the most recent window.
	MaxScanBytes = 1 << 20
)

// Stream rate and lifecycle bounds.
const (
	StreamTickInterval = 250 * time.Millisecond
	StreamHeartbeat    = 15 * time.Second
	MaxLinesPerSecond  = 200
	MaxStreamsPerUser  = 2
	MaxStreamsTotal    = 8
	// MaxKeywordBytes bounds the plain substring filter. The filter is a
	// literal match, not a pattern, so it cannot backtrack.
	MaxKeywordBytes = 128
)

// Levels in ascending severity.
const (
	LevelDebug = "debug"
	LevelInfo  = "info"
	LevelWarn  = "warn"
	LevelError = "error"
)

// Source is one readable log stream offered to the UI.
//
// ResourceIDs is the explicit operator mapping from a source to Inventory
// resources. It is never inferred from a file name or a process name.
type Source struct {
	SourceID    string   `json:"sourceId"`
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	SizeBytes   int64    `json:"sizeBytes"`
	UpdatedAt   string   `json:"updatedAt,omitempty"`
	Readable    bool     `json:"readable"`
	Note        string   `json:"note,omitempty"`
	ResourceIDs []string `json:"resourceIds,omitempty"`
}

// Capabilities is the server-declared vocabulary of the log workspace.
type Capabilities struct {
	DefaultTailLines      int      `json:"defaultTailLines"`
	MaxTailLines          int      `json:"maxTailLines"`
	Levels                []string `json:"levels"`
	MaxLineBytes          int      `json:"maxLineBytes"`
	Follow                bool     `json:"follow"`
	KeywordIsLiteral      bool     `json:"keywordIsLiteral"`
	ConcurrencyPerSession int      `json:"concurrencyPerSession"`
}

// SourcesResponse is the GET /api/nf-logs/sources payload.
type SourcesResponse struct {
	GeneratedAt  string       `json:"generatedAt"`
	Sources      []Source     `json:"sources"`
	Capabilities Capabilities `json:"capabilities"`
}

// StreamLine is one sanitized log line sent over SSE.
type StreamLine struct {
	Seq   int64  `json:"seq"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

// StreamMeta is the first SSE frame: exactly what this stream is reading and
// which filters the server applied.
type StreamMeta struct {
	SourceID  string `json:"sourceId"`
	Name      string `json:"name"`
	TailLines int    `json:"tailLines"`
	Level     string `json:"level,omitempty"`
	Keyword   string `json:"keyword,omitempty"`
	Follow    bool   `json:"follow"`
	StartedAt string `json:"startedAt"`
}

// StreamNotice reports a lifecycle event the operator must see: rotation,
// truncation, an unreadable file or a dropped connection.
type StreamNotice struct {
	Reason string `json:"reason"`
	Detail string `json:"detail,omitempty"`
}

// StreamDropped reports lines the server discarded to protect the connection.
type StreamDropped struct {
	Count int `json:"count"`
}
