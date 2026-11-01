package system

import (
	"context"
	"time"
)

// PlatformProbe is one runtime check registered by the process that owns the
// component. Probes are read-only and must be bounded by the caller context.
type PlatformProbe struct {
	Key   string
	Check func(context.Context) (SubsystemStatus, string)
}

// CheckPlatformHealth runs every registered probe. A probe that was not
// registered is not invented: the report only contains what the process
// actually checked. One unavailable probe degrades the overall platform status
// to critical, because the console must not present a partially blind process
// as healthy.
func CheckPlatformHealth(ctx context.Context, probes []PlatformProbe) PlatformHealthReport {
	checkedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	report := PlatformHealthReport{Status: StatusHealthy, CheckedAt: checkedAt, Probes: []PlatformProbeResult{}}
	for _, probe := range probes {
		if probe.Key == "" || probe.Check == nil {
			continue
		}
		status, detail := probe.Check(ctx)
		switch status {
		case StatusHealthy, StatusDegraded, StatusCritical, StatusUnavailable:
		default:
			status = StatusUnavailable
			detail = "probe returned an unknown status"
		}
		report.Probes = append(report.Probes, PlatformProbeResult{
			Key:       probe.Key,
			Status:    status,
			Detail:    detail,
			CheckedAt: checkedAt,
		})
		if status == StatusUnavailable || status == StatusCritical {
			report.Status = StatusCritical
			continue
		}
		if status == StatusDegraded && report.Status == StatusHealthy {
			report.Status = StatusDegraded
		}
	}
	if len(report.Probes) == 0 {
		report.Status = StatusUnavailable
	}
	return report
}
