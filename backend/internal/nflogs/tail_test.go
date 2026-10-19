package nflogs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTempLog(t *testing.T, lines []string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sample.log")
	body := strings.Join(lines, "\n")
	if len(lines) > 0 {
		body += "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write temp log: %v", err)
	}
	return path
}

func TestTailLinesReturnsTheNewestLinesInOrder(t *testing.T) {
	lines := make([]string, 0, 300)
	for i := 0; i < 300; i++ {
		lines = append(lines, "line-"+itoa(i))
	}
	path := writeTempLog(t, lines)

	got, err := TailLines(path, 20, MaxScanBytes)
	if err != nil {
		t.Fatalf("tail: %v", err)
	}
	if len(got) != 20 {
		t.Fatalf("want 20 lines, got %d", len(got))
	}
	if got[0] != "line-280" || got[19] != "line-299" {
		t.Fatalf("unexpected window: %q .. %q", got[0], got[19])
	}
}

func TestTailLinesHandlesShortAndEmptyFiles(t *testing.T) {
	path := writeTempLog(t, []string{"only-one"})
	got, err := TailLines(path, 50, MaxScanBytes)
	if err != nil {
		t.Fatalf("tail: %v", err)
	}
	if len(got) != 1 || got[0] != "only-one" {
		t.Fatalf("unexpected short tail: %#v", got)
	}

	empty := writeTempLog(t, nil)
	got, err = TailLines(empty, 10, MaxScanBytes)
	if err != nil {
		t.Fatalf("tail empty: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("an empty file has no lines: %#v", got)
	}
}

func TestTailFileReportsTheEndOffset(t *testing.T) {
	path := writeTempLog(t, []string{"a", "b", "c"})
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer file.Close()

	lines, offset, err := TailFile(file, 2, MaxScanBytes)
	if err != nil {
		t.Fatalf("tail file: %v", err)
	}
	if len(lines) != 2 || lines[0] != "b" || lines[1] != "c" {
		t.Fatalf("unexpected tail: %#v", lines)
	}
	info, _ := file.Stat()
	if offset != info.Size() {
		t.Fatalf("offset must be the end of the file: got %d want %d", offset, info.Size())
	}
}

func TestTailLinesWithoutTrailingNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "no-newline.log")
	if err := os.WriteFile(path, []byte("first\nsecond"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := TailLines(path, 10, MaxScanBytes)
	if err != nil {
		t.Fatalf("tail: %v", err)
	}
	if len(got) != 2 || got[1] != "second" {
		t.Fatalf("the last unterminated line must be kept: %#v", got)
	}
}

func TestTailLinesZeroReturnsNothing(t *testing.T) {
	path := writeTempLog(t, []string{"a"})
	got, err := TailLines(path, 0, MaxScanBytes)
	if err != nil {
		t.Fatalf("tail: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("zero lines requested: %#v", got)
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
