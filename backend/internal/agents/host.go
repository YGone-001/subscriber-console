package agents

import (
	"context"
	"runtime"
	"sync"
	"time"

	"subscriber/internal/runtimeinv"
)

type hostCounters struct {
	Metrics           Metrics
	TotalCPU, IdleCPU uint64
	CPUValid          bool
}

// HostSampler caches measured host values. CPU requires two actual intervals.
type HostSampler struct {
	mu           sync.Mutex
	previous     hostCounters
	havePrevious bool
	metrics      Metrics
	at           time.Time
	read         func() hostCounters
}

func NewHostSampler() *HostSampler { return &HostSampler{read: readHostCounters} }
func (s *HostSampler) Sample() Metrics {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.read()
	if s.havePrevious && next.CPUValid && s.previous.CPUValid && next.TotalCPU > s.previous.TotalCPU && next.IdleCPU >= s.previous.IdleCPU {
		total := next.TotalCPU - s.previous.TotalCPU
		idle := next.IdleCPU - s.previous.IdleCPU
		if idle <= total {
			value := 100 * float64(total-idle) / float64(total)
			next.Metrics.CPUPercent = &value
		}
	}
	s.previous = next
	s.havePrevious = true
	s.metrics = next.Metrics
	s.at = time.Now().UTC()
	return s.metrics
}
func (s *HostSampler) Cached() (Metrics, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.metrics, s.at
}
func (s *HostSampler) Run(ctx context.Context) {
	s.Sample()
	ticker := time.NewTicker(ReportIntervalSeconds * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Sample()
		}
	}
}

func ObservationFromRuntime(snapshot *runtimeinv.Snapshot, metrics Metrics, version string) Observation {
	out := Observation{
		CollectedAt: time.Now().UTC().Format(time.RFC3339Nano), Platform: runtime.GOOS,
		Version: version, Visibility: runtimeinv.VisibilityUnavailable, Metrics: metrics, Components: []Component{},
	}
	if snapshot == nil {
		return out
	}
	out.HostName = snapshot.Host.HostName
	out.Visibility = snapshot.Host.Visibility
	out.ScanComplete = snapshot.Scan.Complete
	if snapshot.Scan.CompletedAt != "" {
		out.CollectedAt = snapshot.Scan.CompletedAt
	}
	for _, c := range snapshot.Components {
		v := Component{ComponentID: c.ComponentID, RuntimeStatus: c.RuntimeStatus, Verified: c.Verified, PrimaryPID: c.PrimaryPID, WorkerCount: c.WorkerCount}
		if c.RuntimeStatus == runtimeinv.StatusRunning && c.Verified {
			v.CPUPercent = c.CPUPercent
			v.MemoryRSSBytes = c.MemoryRSSBytes
		}
		out.Components = append(out.Components, v)
	}
	return out
}

type LocalCollector struct {
	runtime *runtimeinv.Service
	sampler *HostSampler
}

func NewLocalCollector(service *runtimeinv.Service, sampler *HostSampler) *LocalCollector {
	return &LocalCollector{service, sampler}
}
func (s *LocalCollector) View() LocalView {
	snapshot := s.runtime.Snapshot()
	metrics, _ := s.sampler.Cached()
	o := ObservationFromRuntime(snapshot, metrics, "builtin")
	view := LocalView{Role: "controller", Transport: "in_process", HostName: snapshot.Host.HostName, HostID: snapshot.Host.HostID, Observation: &o, EvidenceFreshness: "unavailable"}
	if s.runtime.Enabled() && snapshot.Scan.CompletedAt != "" {
		view.EvidenceFreshness = "stale"
		at, err := time.Parse(time.RFC3339Nano, snapshot.Scan.CompletedAt)
		if err == nil && time.Since(at) <= time.Duration(s.runtime.FreshnessSeconds())*time.Second {
			view.EvidenceFreshness = "fresh"
		}
	}
	return view
}
