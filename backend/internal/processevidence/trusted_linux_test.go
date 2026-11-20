//go:build linux

package processevidence

import (
	"os"
	"syscall"
	"testing"
)

type metadata struct {
	os.FileInfo
	mode os.FileMode
	uid  uint32
}

func (m metadata) Mode() os.FileMode { return m.mode }
func (m metadata) Sys() any          { return &syscall.Stat_t{Uid: m.uid} }

func TestTrustedEvidenceOwnershipAndPermissions(t *testing.T) {
	for _, test := range []struct {
		name string
		mode os.FileMode
		uid  uint32
		want bool
	}{
		{"root_readonly", 0o644, 0, true}, {"root_private", 0o600, 0, true},
		{"group_writable", 0o664, 0, false}, {"world_writable", 0o646, 0, false},
		{"unprivileged_owner", 0o644, 1001, false}, {"symlink", os.ModeSymlink | 0o644, 0, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if trusted(metadata{mode: test.mode, uid: test.uid}, 0) != test.want {
				t.Fatal("unexpected trust decision")
			}
		})
	}
}
