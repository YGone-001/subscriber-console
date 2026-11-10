//go:build linux

package configsnapshots

import "syscall"

func nonblockFlag() int { return syscall.O_NONBLOCK }
