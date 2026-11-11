package agents

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"subscriber/internal/runtimeinv"
)

var (
	idPattern      = regexp.MustCompile(`^[0-9a-f]{32}$`)
	uuidPattern    = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	networkPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	plmnPattern    = regexp.MustCompile(`^[0-9]{5,6}$`)
)

func textValid(value string, limit int) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= limit &&
		strings.IndexFunc(value, unicode.IsControl) < 0
}

func validateMetadata(m *Metadata) error {
	m.Name = strings.TrimSpace(m.Name)
	m.Scope.OperatorName = strings.TrimSpace(m.Scope.OperatorName)
	if m.Name == "" || !textValid(m.Name, 128) {
		return fmt.Errorf("name must contain 1 to 128 characters")
	}
	if !networkPattern.MatchString(m.Scope.NetworkKey) {
		return fmt.Errorf("networkKey must be a stable lowercase grouping key")
	}
	if !textValid(m.Scope.OperatorName, 128) {
		return fmt.Errorf("operatorName is too long or contains control characters")
	}
	for _, id := range []string{m.Scope.SiteResourceID, m.Scope.HostResourceID} {
		if id != "" && !uuidPattern.MatchString(id) {
			return fmt.Errorf("resource references must be canonical UUIDs")
		}
	}
	if len(m.Scope.PLMNs) > 16 {
		return fmt.Errorf("at most 16 PLMNs may be assigned")
	}
	seen := map[string]bool{}
	normalized := []string{}
	for _, value := range m.Scope.PLMNs {
		if !plmnPattern.MatchString(value) || seen[value] {
			return fmt.Errorf("PLMNs must be unique five or six digit strings")
		}
		seen[value] = true
		normalized = append(normalized, value)
	}
	m.Scope.PLMNs = normalized
	return nil
}

func validNumber(v *float64, max float64) bool {
	return v == nil || (!math.IsNaN(*v) && !math.IsInf(*v, 0) && *v >= 0 && *v <= max)
}
func validBytes(v *int64) bool { return v == nil || (*v >= 0 && *v <= 9007199254740991) }
func pairedBytes(total, available *int64) bool {
	return validBytes(total) && validBytes(available) && (available == nil || total != nil && *available <= *total)
}

func validateObservation(o *Observation, now time.Time) error {
	at, err := time.Parse(time.RFC3339Nano, o.CollectedAt)
	if err != nil || at.After(now.Add(time.Minute)) || at.Before(now.Add(-5*time.Minute)) {
		return fmt.Errorf("collectedAt must be within the accepted clock window")
	}
	o.CollectedAt = at.UTC().Format(time.RFC3339Nano)
	if !textValid(o.HostName, 128) || !textValid(o.Version, 64) || o.Platform != "linux" {
		return fmt.Errorf("invalid collector metadata")
	}
	if o.Visibility != runtimeinv.VisibilityHost && o.Visibility != runtimeinv.VisibilityContainerLimit && o.Visibility != runtimeinv.VisibilityUnavailable {
		return fmt.Errorf("invalid process visibility")
	}
	m := o.Metrics
	if !validNumber(m.CPUPercent, 100) || !validNumber(m.UptimeSeconds, 1e12) ||
		!pairedBytes(m.MemoryTotalBytes, m.MemoryAvailableBytes) || !pairedBytes(m.DiskTotalBytes, m.DiskAvailableBytes) {
		return fmt.Errorf("invalid host measurements")
	}
	registry := runtimeinv.DefaultRegistry()
	if len(o.Components) > len(registry.Components()) {
		return fmt.Errorf("too many component observations")
	}
	seen := map[string]bool{}
	for _, c := range o.Components {
		if _, ok := registry.Lookup(c.ComponentID); !ok || seen[c.ComponentID] {
			return fmt.Errorf("unknown or duplicate component")
		}
		seen[c.ComponentID] = true
		validStatus := false
		for _, status := range runtimeinv.CanonicalStatuses {
			if c.RuntimeStatus == status {
				validStatus = true
			}
		}
		if !validStatus || c.PrimaryPID < 0 || c.WorkerCount < 0 || c.WorkerCount > 8192 ||
			!validNumber(c.CPUPercent, 1e6) || !validBytes(c.MemoryRSSBytes) {
			return fmt.Errorf("invalid component measurements")
		}
		if c.RuntimeStatus == runtimeinv.StatusRunning && (!c.Verified || c.PrimaryPID == 0 || c.WorkerCount == 0) {
			return fmt.Errorf("running requires positively verified process evidence")
		}
		if c.RuntimeStatus != runtimeinv.StatusRunning && (c.CPUPercent != nil || c.MemoryRSSBytes != nil) {
			return fmt.Errorf("unverified components cannot carry process measurements")
		}
		if !o.ScanComplete && c.RuntimeStatus == runtimeinv.StatusStopped {
			return fmt.Errorf("an incomplete scan cannot establish stopped state")
		}
	}
	return nil
}

func ConnectionState(r *Record, now time.Time) string {
	if !r.Enabled {
		return "disabled"
	}
	if r.LastReceivedAt == nil {
		return "pending"
	}
	age := now.Sub(*r.LastReceivedAt)
	if age > OfflineAfterSeconds*time.Second {
		return "offline"
	}
	if age > StaleAfterSeconds*time.Second {
		return "stale"
	}
	return "online"
}
func project(r *Record, now time.Time, detail bool) View {
	v := View{
		AgentID: r.AgentID, Metadata: r.Metadata, Enabled: r.Enabled, Revision: r.Revision,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, LastReceivedAt: r.LastReceivedAt,
		ConnectionState: ConnectionState(r, now), EvidenceFreshness: "unavailable",
	}
	if r.Observation != nil {
		v.EvidenceFreshness = "stale"
		at, err := time.Parse(time.RFC3339Nano, r.Observation.CollectedAt)
		if err == nil && r.Enabled && now.Sub(at) <= StaleAfterSeconds*time.Second && v.ConnectionState == "online" {
			v.EvidenceFreshness = "fresh"
		}
		// The bounded latest observation is also used by list metric cells.
		o := *r.Observation
		if !detail {
			o.Components = []Component{}
		}
		v.Observation = &o
	}
	return v
}

// ListView reuses the collector authority's freshness and safe list projection.
func ListView(r *Record, now time.Time) View { return project(r, now, false) }
