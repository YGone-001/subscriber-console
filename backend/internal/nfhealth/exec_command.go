package nfhealth

import (
	"context"
	"os/exec"
)

// execCommandContext builds a fixed-argv command with a deadline. There is no
// shell interpolation and no generic command-execution abstraction exposed to
// any HTTP request.
func execCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}
