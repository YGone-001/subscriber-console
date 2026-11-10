package configsnapshots

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// noLinks rejects symbolic links in every ancestor, including the root itself.
func noLinks(path string) bool {
	for p := path; ; p = filepath.Dir(p) {
		v, err := os.Lstat(p)
		if err != nil || v.Mode()&os.ModeSymlink != 0 {
			return false
		}
		if parent := filepath.Dir(p); parent == p {
			return true
		}
	}
}

func readSource(ctx context.Context, root string, source Source) ([]byte, string) {
	if ctx.Err() != nil {
		return nil, "cancelled"
	}
	rel, err := filepath.Rel(root, source.Path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || !noLinks(source.Path) {
		return nil, "path_rejected"
	}
	before, err := os.Lstat(source.Path)
	if err != nil || !before.Mode().IsRegular() {
		return nil, "unreadable"
	}
	if before.Size() > MaxFileBytes {
		return nil, "file_too_large"
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, "unreadable"
	}
	defer r.Close()
	f, err := r.OpenFile(rel, os.O_RDONLY|nonblockFlag(), 0)
	if err != nil {
		return nil, "unreadable"
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return nil, "changed_during_read"
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil || ctx.Err() != nil {
		return nil, "unreadable"
	}
	if len(b) > MaxFileBytes {
		return nil, "file_too_large"
	}
	after, err := f.Stat()
	pathAfter, pathErr := os.Lstat(source.Path)
	if err != nil || pathErr != nil || !noLinks(source.Path) || !os.SameFile(opened, pathAfter) || opened.Size() != after.Size() || !opened.ModTime().Equal(after.ModTime()) || int64(len(b)) != after.Size() {
		return nil, "changed_during_read"
	}
	if !utf8.Valid(b) || strings.IndexByte(string(b), 0) >= 0 {
		return nil, "invalid_encoding"
	}
	return b, ""
}
