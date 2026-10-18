package runtimeinv

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// hostIdentitySources are the server-side files that can carry a stable machine
// identifier. They are read, hashed and never returned verbatim.
var hostIdentitySources = []string{
	"/etc/machine-id",
	"/var/lib/dbus/machine-id",
}

// containerMarkers identify a process namespace that cannot see the host.
var containerMarkers = []string{
	"/.dockerenv",
	"/run/.containerenv",
}

// hostResolver derives the local host identity. All inputs are overridable so
// tests never depend on the machine running the suite.
type hostResolver struct {
	procRoot     string
	machineFiles []string
	markerFiles  []string
	hostname     func() (string, error)
}

func newHostResolver(procRoot string) *hostResolver {
	if strings.TrimSpace(procRoot) == "" {
		procRoot = "/proc"
	}
	return &hostResolver{
		procRoot:     procRoot,
		machineFiles: hostIdentitySources,
		markerFiles:  containerMarkers,
		hostname:     os.Hostname,
	}
}

// resolve returns the server-owned host identity.
//
// The identifier is a truncated SHA-256 digest of the machine identifier, so the
// raw value never leaves the process. A browser-provided hostname, an arbitrary
// IP claim or a process display name is never accepted as an identity.
func (h *hostResolver) resolve() HostIdentity {
	identity := HostIdentity{
		HostName:       "localhost",
		IdentitySource: "unavailable",
		Visibility:     VisibilityUnavailable,
	}
	if name, err := h.hostname(); err == nil {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			identity.HostName = trimmed
		}
	}

	seed := ""
	for _, file := range h.machineFiles {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		value := strings.TrimSpace(string(raw))
		if value == "" {
			continue
		}
		seed = value
		identity.IdentitySource = filepath.Base(file)
		break
	}
	if seed == "" {
		// No machine identifier is available. The hostname is a weak but
		// server-owned fallback; it is never trusted as a uniqueness proof for
		// cross-host identity, only as a stable local key.
		seed = identity.HostName
		identity.IdentitySource = "hostname"
	}
	sum := sha256.Sum256([]byte("xcloud-runtime-host|" + seed))
	identity.HostID = "host-" + hex.EncodeToString(sum[:])[:16]

	identity.Visibility, identity.VisibilityReason = h.visibility()
	return identity
}

// visibility reports whether the scanner can see host processes.
//
// A container that cannot see host processes must never have unseen host
// processes reported as stopped; the limitation is reported explicitly instead.
func (h *hostResolver) visibility() (string, string) {
	for _, marker := range h.markerFiles {
		if _, err := os.Stat(marker); err == nil {
			return VisibilityContainerLimit, "container_marker_present"
		}
	}
	raw, err := os.ReadFile(filepath.Join(h.procRoot, "1", "cgroup"))
	if err == nil {
		text := strings.ToLower(string(raw))
		for _, token := range []string{"docker", "kubepods", "containerd", "lxc", "podman"} {
			if strings.Contains(text, token) {
				return VisibilityContainerLimit, "container_cgroup_detected"
			}
		}
	}
	if _, err := os.ReadDir(h.procRoot); err != nil {
		return VisibilityUnavailable, "proc_unreadable"
	}
	return VisibilityHost, ""
}
