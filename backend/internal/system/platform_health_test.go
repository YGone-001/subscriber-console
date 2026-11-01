package system

import (
	"context"
	"testing"
)

func TestPlatformHealthUnavailableIsNeverHealthy(t *testing.T) {
	report := CheckPlatformHealth(context.Background(), []PlatformProbe{
		{Key: "api", Check: func(context.Context) (SubsystemStatus, string) { return StatusHealthy, "ok" }},
		{Key: "worker", Check: func(context.Context) (SubsystemStatus, string) { return StatusUnavailable, "not running" }},
	})
	if report.Status != StatusCritical {
		t.Fatalf("one unavailable probe must make the platform critical, got %s", report.Status)
	}
	if len(report.Probes) != 2 {
		t.Fatalf("expected two probes, got %d", len(report.Probes))
	}
	if report.Probes[1].Status != StatusUnavailable {
		t.Fatalf("unavailable probe must stay unavailable, got %s", report.Probes[1].Status)
	}
}

func TestPlatformHealthWithoutProbesIsUnavailable(t *testing.T) {
	report := CheckPlatformHealth(context.Background(), nil)
	if report.Status != StatusUnavailable {
		t.Fatalf("no probes must report unavailable, got %s", report.Status)
	}
	if len(report.Probes) != 0 {
		t.Fatalf("no probes must not be invented, got %d", len(report.Probes))
	}
}
