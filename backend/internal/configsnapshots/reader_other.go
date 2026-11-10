//go:build !linux

package configsnapshots

func nonblockFlag() int { return 0 }
