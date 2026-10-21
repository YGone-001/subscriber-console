package knowledge

import (
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestValidateCreateRequest(t *testing.T) {
	t.Run("rejects empty title", func(t *testing.T) {
		_, _, err := ValidateCreateRequest(&CreateEntryRequest{Title: "   "})
		if err == nil || !strings.Contains(err.Error(), "title") {
			t.Fatalf("expected title error, got %v", err)
		}
	})

	t.Run("normalizes empty protocol to General", func(t *testing.T) {
		protocol, _, err := ValidateCreateRequest(&CreateEntryRequest{Title: "hello"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if protocol != "General" {
			t.Fatalf("expected General, got %q", protocol)
		}
	})

	t.Run("rejects non-canonical protocol", func(t *testing.T) {
		_, _, err := ValidateCreateRequest(&CreateEntryRequest{Title: "hello", Protocol: "FTP"})
		if err == nil {
			t.Fatalf("expected protocol error")
		}
	})

	t.Run("trims and dedupes tags", func(t *testing.T) {
		_, tags, err := ValidateCreateRequest(&CreateEntryRequest{
			Title: "hello",
			Tags:  []string{" sip ", "sip", "", "diameter"},
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(tags) != 2 || tags[0] != "sip" || tags[1] != "diameter" {
			t.Fatalf("unexpected tags: %v", tags)
		}
	})

	t.Run("rejects too many tags", func(t *testing.T) {
		tags := make([]string, MaxTags+1)
		for i := range tags {
			tags[i] = "t"
		}
		_, _, err := ValidateCreateRequest(&CreateEntryRequest{Title: "hello", Tags: tags})
		if err == nil {
			t.Fatalf("expected tag count error")
		}
	})

	t.Run("rejects too many attachments", func(t *testing.T) {
		ids := make([]string, MaxAttachments+1)
		for i := range ids {
			ids[i] = "00000000-0000-4000-8000-000000000000"
		}
		_, _, err := ValidateCreateRequest(&CreateEntryRequest{Title: "hello", AttachmentFileIDs: ids})
		if err == nil {
			t.Fatalf("expected attachment count error")
		}
	})

	t.Run("rejects malformed attachment id", func(t *testing.T) {
		_, _, err := ValidateCreateRequest(&CreateEntryRequest{Title: "hello", AttachmentFileIDs: []string{"nope"}})
		if err == nil {
			t.Fatalf("expected attachment id error")
		}
	})
}

func TestValidateUpdateRequest(t *testing.T) {
	if _, _, err := ValidateUpdateRequest(&UpdateEntryRequest{Title: "x"}); err == nil {
		t.Fatalf("expected missing expectedRevision error")
	}
	if _, _, err := ValidateUpdateRequest(&UpdateEntryRequest{Title: "x", ExpectedRevision: 3}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDetectKind(t *testing.T) {
	cases := []struct {
		name string
		head []byte
		kind FileKind
	}{
		{"png", []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00}, FileKindImage},
		{"jpeg", []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00}, FileKindImage},
		{"gif", []byte("GIF89a"), FileKindImage},
		{"webp", []byte("RIFF....WEBPVP8"), FileKindImage},
		{"pdf", []byte("%PDF-1.7\n"), FileKindPDF},
		{"pcap", []byte{0xD4, 0xC3, 0xB2, 0xA1, 0x00}, FileKindPcap},
		{"pcapng", []byte{0x0A, 0x0D, 0x0D, 0x0A, 0x00}, FileKindPcap},
		{"text", []byte("hello world\n"), FileKindText},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, _, ok := detectKind(tc.head)
			if !ok {
				t.Fatalf("expected detection to succeed")
			}
			if kind != tc.kind {
				t.Fatalf("expected kind %q, got %q", tc.kind, kind)
			}
		})
	}

	t.Run("rejects null-byte binary", func(t *testing.T) {
		_, _, ok := detectKind([]byte{0x7F, 0x45, 0x4C, 0x46, 0x00, 0x00})
		if ok {
			t.Fatalf("expected binary blob to be rejected")
		}
	})
}

func TestSaveAttachmentValidation(t *testing.T) {
	t.Run("rejects disallowed extension", func(t *testing.T) {
		store, err := NewFileStore(t.TempDir(), t.TempDir())
		if err != nil {
			t.Fatalf("failed to create store: %v", err)
		}
		_, _, _, _, err = store.SaveAttachment(
			"00000000-0000-4000-8000-000000000000",
			"payload.svg",
			strings.NewReader("<svg></svg>"),
		)
		if err != ErrFileTypeRejected {
			t.Fatalf("expected ErrFileTypeRejected, got %v", err)
		}
	})

	t.Run("rejects extension and magic mismatch", func(t *testing.T) {
		store, err := NewFileStore(t.TempDir(), t.TempDir())
		if err != nil {
			t.Fatalf("failed to create store: %v", err)
		}
		_, _, _, _, err = store.SaveAttachment(
			"00000000-0000-4000-8000-000000000000",
			"fake.png",
			strings.NewReader("plain text"),
		)
		if err != ErrFileTypeRejected {
			t.Fatalf("expected ErrFileTypeRejected, got %v", err)
		}
	})

	t.Run("accepts text file", func(t *testing.T) {
		store, err := NewFileStore(t.TempDir(), t.TempDir())
		if err != nil {
			t.Fatalf("failed to create store: %v", err)
		}
		kind, ct, size, _, err := store.SaveAttachment(
			"00000000-0000-4000-8000-000000000000",
			"notes.txt",
			strings.NewReader("some notes"),
		)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if kind != FileKindText || ct != "text/plain; charset=utf-8" || size != int64(len("some notes")) {
			t.Fatalf("unexpected result: kind=%q ct=%q size=%d", kind, ct, size)
		}
	})
}

func TestClassifyByExtension(t *testing.T) {
	if _, _, ok := classifyByExtension("x.svg"); ok {
		t.Fatalf("expected svg to be rejected")
	}
	if _, _, ok := classifyByExtension("x.exe"); ok {
		t.Fatalf("expected exe to be rejected")
	}
	if kind, _, ok := classifyByExtension("trace.pcap"); !ok || kind != FileKindPcap {
		t.Fatalf("expected pcap to be accepted")
	}
	if kind, _, ok := classifyByExtension("notes.log"); !ok || kind != FileKindText {
		t.Fatalf("expected log to be accepted")
	}
}

func TestBuildListFilterEscapesRegex(t *testing.T) {
	filter, err := buildListFilter(ListFilter{Query: ".*"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	or, ok := filter["$or"].([]bson.M)
	if !ok {
		t.Fatalf("expected $or filter, got %#v", filter)
	}
	titleClause := or[0]["title"].(bson.M)
	pattern := titleClause["$regex"].(string)
	if pattern != `\.\*` {
		t.Fatalf("expected escaped pattern, got %q", pattern)
	}
}

func TestBuildListFilterRejectsLongQuery(t *testing.T) {
	_, err := buildListFilter(ListFilter{Query: strings.Repeat("a", MaxSearchQueryLength+1)})
	if err == nil {
		t.Fatalf("expected over-length query to be rejected")
	}
}
