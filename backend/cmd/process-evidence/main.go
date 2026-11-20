// process-evidence is a local, one-shot procfs reader. It has no server,
// network client, shell, process-control or application credential capability.
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"subscriber/internal/processevidence"
)

func main() {
	policyPath := flag.String("policy", "/etc/xcloud-process-evidence.json", "root-owned process-name policy")
	output := flag.String("output", "/run/xcloud-process-evidence/latest.json", "root-owned snapshot output")
	flag.Parse()
	if os.Geteuid() != 0 || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "requires root and explicit policy/output flags only")
		os.Exit(1)
	}
	policy, err := processevidence.LoadPolicy(*policyPath)
	if err == nil {
		var snapshot processevidence.Snapshot
		snapshot, err = processevidence.Collect("/proc", policy, time.Now())
		if err == nil {
			err = processevidence.Write(*output, snapshot)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "process evidence publication failed:", err)
		os.Exit(1)
	}
}
