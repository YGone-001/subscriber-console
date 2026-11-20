package nfhealth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var plainWindowLabel = regexp.MustCompile(`^([a-zA-Z_][a-zA-Z0-9_]*)="([^"\\]*)"$`)

// Privacy filtering must not silently join two distinct populations. We accept
// only a fully parsed, unique, unchanged safe label set. Escaped, malformed,
// duplicated or removed labels deliberately leave the scope unverified.
func verifiedWindowScope(name, line string, raw, safe map[string]string) bool {
	if len(raw) != len(safe) {
		return false
	}
	brace := strings.IndexByte(line, '{')
	if brace < 0 {
		fields := strings.Fields(line)
		return len(raw) == 0 && len(fields) > 0 && fields[0] == name
	}
	end := strings.IndexByte(line[brace:], '}')
	if end < 0 {
		return false
	}
	body := line[brace+1 : brace+end]
	if strings.TrimSpace(body) == "" {
		return len(raw) == 0
	}
	seen := map[string]bool{}
	for _, part := range splitLabelPairs(body) {
		match := plainWindowLabel.FindStringSubmatch(strings.TrimSpace(part))
		if match == nil || seen[match[1]] {
			return false
		}
		value, ok := safe[match[1]]
		if !ok || value != match[2] {
			return false
		}
		seen[match[1]] = true
	}
	return len(seen) == len(safe)
}

func windowHash(parts ...string) string {
	raw, _ := json.Marshal(parts)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// Endpoint, resource, domain and collector changes start a new comparison
// population. Cosmetic edits do not discard otherwise valid history.
func windowBinding(target *HealthTarget) string {
	return windowHash(target.TargetID, target.ResourceID, target.Domain, target.NFType,
		target.CollectorProfile, target.MetricsEndpoint, target.ServiceUnit,
		target.ServiceKind, target.CollectionMode, strconv.Itoa(target.IntervalSeconds))
}

func loopbackMetrics(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}

// Local process evidence is checked on both sides of the HTTP probe. PID alone
// is insufficient: a boot ID and start tick distinguish PID reuse and reboot.
func windowProcessToken(root string, target *HealthTarget, process LayerEvidence) string {
	if !loopbackMetrics(target.MetricsEndpoint) || target.ServiceKind != "process" ||
		process.State != StateHealthy || process.MainPID <= 0 {
		return ""
	}
	if root == "" {
		root = "/proc"
	}
	pid := strconv.Itoa(process.MainPID)
	comm, err := os.ReadFile(filepath.Join(root, pid, "comm"))
	if err != nil || strings.TrimSpace(string(comm)) != strings.TrimSuffix(target.ServiceUnit, ".service") {
		return ""
	}
	boot, err := os.ReadFile(filepath.Join(root, "sys/kernel/random/boot_id"))
	if err != nil || len(strings.TrimSpace(string(boot))) != 36 {
		return ""
	}
	stat, err := os.ReadFile(filepath.Join(root, pid, "stat"))
	if err != nil || len(stat) > 32768 {
		return ""
	}
	end := strings.LastIndex(string(stat), ") ")
	if end < 0 {
		return ""
	}
	fields := strings.Fields(string(stat[end+2:]))
	if len(fields) < 20 {
		return ""
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || ticks == 0 {
		return ""
	}
	return windowHash(strings.TrimSpace(string(boot)), pid, fields[19])
}

func windowExporterIdentity(target *HealthTarget, metrics []MetricSample, before, after string) string {
	start := ""
	for _, metric := range metrics {
		if metric.Key != "process_start_time_seconds" {
			continue
		}
		if start != "" || !metric.ScopeVerified || metric.Value <= 0 ||
			math.IsNaN(metric.Value) || math.IsInf(metric.Value, 0) {
			return ""
		}
		// Treat this as an opaque exporter incarnation value, not a wall clock.
		start = strconv.FormatFloat(metric.Value, 'g', -1, 64)
	}
	if start == "" {
		return ""
	}
	if loopbackMetrics(target.MetricsEndpoint) && (before == "" || before != after) {
		return ""
	}
	return windowHash(windowBinding(target), start, before, after)
}
