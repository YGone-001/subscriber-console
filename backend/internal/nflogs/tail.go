package nflogs

import (
	"bytes"
	"io"
	"os"
)

const tailBlockBytes = 64 * 1024

// TailLines returns at most maxLines complete lines from the end of a file.
//
// The read walks backwards in fixed blocks and stops at maxLines or at the scan
// ceiling, so tailing a multi-gigabyte file costs a bounded amount of I/O. When
// the walk stops before the beginning of the file the first partial line is
// discarded rather than emitted as a fragment.
func TailLines(path string, maxLines int, maxScanBytes int64) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	lines, _, err := TailFile(file, maxLines, maxScanBytes)
	return lines, err
}

// TailFile tails an already-open handle and reports the offset just past the
// last byte it considered. The caller keeps reading from that offset, so a line
// written between the tail and the follow cannot be lost or repeated.
func TailFile(file *os.File, maxLines int, maxScanBytes int64) ([]string, int64, error) {
	if maxLines <= 0 {
		return []string{}, 0, nil
	}
	info, err := file.Stat()
	if err != nil {
		return nil, 0, err
	}
	size := info.Size()
	if size == 0 {
		return []string{}, 0, nil
	}

	blocks := make([][]byte, 0, 8)
	offset := size
	scanned := int64(0)
	newlines := 0
	for offset > 0 && newlines <= maxLines && scanned < maxScanBytes {
		readSize := int64(tailBlockBytes)
		if readSize > offset {
			readSize = offset
		}
		offset -= readSize
		block := make([]byte, readSize)
		if _, err := file.ReadAt(block, offset); err != nil && err != io.EOF {
			return nil, 0, err
		}
		blocks = append(blocks, block)
		newlines += bytes.Count(block, []byte{'\n'})
		scanned += readSize
	}

	var buffer bytes.Buffer
	for i := len(blocks) - 1; i >= 0; i-- {
		buffer.Write(blocks[i])
	}
	data := buffer.Bytes()
	if offset > 0 {
		// The window starts mid-line; drop that fragment.
		if index := bytes.IndexByte(data, '\n'); index >= 0 {
			data = data[index+1:]
		} else {
			return []string{}, size, nil
		}
	}
	return lastLines(data, maxLines), size, nil
}

// lastLines splits a payload into lines, keeping the newest maxLines.
func lastLines(data []byte, maxLines int) []string {
	if len(data) == 0 {
		return []string{}
	}
	text := string(data)
	if text[len(text)-1] == '\n' {
		text = text[:len(text)-1]
	}
	if text == "" {
		return []string{}
	}
	lines := splitLines(text)
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines
}

func splitLines(text string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			lines = append(lines, text[start:i])
			start = i + 1
		}
	}
	if start < len(text) {
		lines = append(lines, text[start:])
	}
	return lines
}
