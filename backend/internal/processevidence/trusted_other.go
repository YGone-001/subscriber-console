//go:build !linux

package processevidence

import (
	"errors"
	"os"
)

func trustedDirectory(string, uint32) error { return errors.New("process evidence requires Linux") }
func openTrusted(string, uint32) (*os.File, error) {
	return nil, errors.New("process evidence requires Linux")
}
