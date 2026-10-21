package knowledge

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// FileStore owns the on-disk attachment bytes. Files are stored under the
// upload directory keyed by their canonical UUID (never by client-supplied
// names), and deletions move bytes into a sibling trash directory instead of
// removing them, preserving a recovery path.
type FileStore struct {
	dir      string
	trashDir string
}

// NewFileStore creates a file store and ensures both directories exist.
func NewFileStore(dir, trashDir string) (*FileStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create knowledge upload directory: %w", err)
	}
	if err := os.MkdirAll(trashDir, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create knowledge trash directory: %w", err)
	}
	return &FileStore{dir: dir, trashDir: trashDir}, nil
}

// classifyByExtension maps a client-declared filename to an allowed content
// class. Unknown extensions are rejected so no arbitrary type is ever accepted.
func classifyByExtension(name string) (FileKind, string, bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return FileKindImage, "image/png", true
	case ".jpg", ".jpeg":
		return FileKindImage, "image/jpeg", true
	case ".gif":
		return FileKindImage, "image/gif", true
	case ".webp":
		return FileKindImage, "image/webp", true
	case ".pdf":
		return FileKindPDF, "application/pdf", true
	case ".txt", ".log":
		return FileKindText, "text/plain; charset=utf-8", true
	case ".pcap", ".pcapng":
		return FileKindPcap, "application/vnd.tcpdump.pcap", true
	}
	return "", "", false
}

// detectKind classifies bytes by magic signature. Binary signatures are matched
// exactly; a sample with no binary signature and no NUL byte is treated as text.
// Anything else is rejected.
func detectKind(head []byte) (FileKind, string, bool) {
	if len(head) >= 8 && bytes.Equal(head[:8], []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		return FileKindImage, "image/png", true
	}
	if len(head) >= 3 && bytes.Equal(head[:3], []byte{0xFF, 0xD8, 0xFF}) {
		return FileKindImage, "image/jpeg", true
	}
	if len(head) >= 4 && bytes.Equal(head[:4], []byte("GIF8")) {
		return FileKindImage, "image/gif", true
	}
	if len(head) >= 12 && bytes.Equal(head[:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")) {
		return FileKindImage, "image/webp", true
	}
	if len(head) >= 4 && bytes.Equal(head[:4], []byte("%PDF")) {
		return FileKindPDF, "application/pdf", true
	}
	if len(head) >= 4 {
		pcaps := [][]byte{
			{0xD4, 0xC3, 0xB2, 0xA1},
			{0xA1, 0xB2, 0xC3, 0xD4},
			{0x4D, 0x3C, 0x2B, 0x1A},
			{0x1A, 0x2B, 0x3C, 0x4D},
			{0x0A, 0x0D, 0x0D, 0x0A},
		}
		for _, sig := range pcaps {
			if bytes.Equal(head[:4], sig) {
				return FileKindPcap, "application/vnd.tcpdump.pcap", true
			}
		}
	}
	if !bytes.Contains(head, []byte{0}) {
		return FileKindText, "text/plain; charset=utf-8", true
	}
	return "", "", false
}

// SaveAttachment validates and persists one uploaded attachment. The declared
// extension and the detected magic bytes must agree, and the size must stay
// within the per-file budget. The returned values are server-computed metadata.
func (fs *FileStore) SaveAttachment(id, originalName string, src io.Reader) (FileKind, string, int64, string, error) {
	if !IsValidID(id) {
		return "", "", 0, "", ErrFileTypeRejected
	}
	extKind, extCT, ok := classifyByExtension(originalName)
	if !ok {
		return "", "", 0, "", ErrFileTypeRejected
	}

	limited := io.LimitReader(src, MaxFileBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return "", "", 0, "", fmt.Errorf("failed to read attachment: %w", err)
	}
	if int64(len(data)) > MaxFileBytes {
		return "", "", 0, "", ErrFileTooLarge
	}

	detKind, detCT, ok := detectKind(data)
	if !ok {
		return "", "", 0, "", ErrFileTypeRejected
	}
	if detKind != extKind || detCT != extCT {
		return "", "", 0, "", ErrFileTypeRejected
	}

	sum := sha256.Sum256(data)
	if err := fs.writeFile(id, data); err != nil {
		return "", "", 0, "", err
	}
	return detKind, detCT, int64(len(data)), hex.EncodeToString(sum[:]), nil
}

func (fs *FileStore) writeFile(id string, data []byte) error {
	path := filepath.Join(fs.dir, id)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("failed to create knowledge attachment: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return fmt.Errorf("failed to write knowledge attachment: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("failed to finalize knowledge attachment: %w", err)
	}
	return nil
}

// Open returns a read handle for a stored attachment.
func (fs *FileStore) Open(id string) (*os.File, error) {
	if !IsValidID(id) {
		return nil, ErrFileNotFound
	}
	path := filepath.Join(fs.dir, id)
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrFileNotFound
		}
		return nil, fmt.Errorf("failed to open knowledge attachment: %w", err)
	}
	return f, nil
}

// Trash moves a stored attachment into the trash directory. It is best-effort:
// a failed move is reported but never blocks the business response.
func (fs *FileStore) Trash(id string) error {
	if !IsValidID(id) {
		return nil
	}
	src := filepath.Join(fs.dir, id)
	dst := filepath.Join(fs.trashDir, id)
	if err := os.Rename(src, dst); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return nil
}
