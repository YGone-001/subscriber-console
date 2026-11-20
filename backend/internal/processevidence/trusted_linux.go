//go:build linux

package processevidence

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func trusted(info os.FileInfo, uid uint32) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uid && info.Mode().Perm()&0o022 == 0 && info.Mode()&os.ModeSymlink == 0
}

func trustedDirectory(path string, uid uint32) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("trusted path must be absolute and clean")
	}
	for {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || !trusted(info, uid) {
			return errors.New("untrusted evidence directory")
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}

func openTrusted(path string, uid uint32) (*os.File, error) {
	if err := trustedDirectory(filepath.Dir(path), uid); err != nil {
		return nil, err
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !trusted(info, uid) || info.Size() > MaxBytes {
		file.Close()
		return nil, errors.New("untrusted evidence file")
	}
	return file, nil
}
