package nfhealth

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"testing"
	"time"
)

// Opt-in endpoint/decoder proof only. Canonical Inventory association and the
// production target mutation are separate acceptance gates.
func TestApprovedLiveMetricsReadOnly(t *testing.T) {
	if os.Getenv("NF_HEALTH_LIVE_READONLY") != "1" {
		t.Skip("explicit live read-only gate is closed")
	}
	var endpoints []struct{ Domain, NFType, URL string }
	if err := json.Unmarshal([]byte(os.Getenv("NF_HEALTH_LIVE_ENDPOINTS")), &endpoints); err != nil {
		t.Fatal("invalid explicit endpoint list")
	}
	if len(endpoints) == 0 || len(endpoints) > 8 {
		t.Fatal("expected 1 to 8 approved endpoints")
	}
	for _, endpoint := range endpoints {
		t.Run(endpoint.NFType, func(t *testing.T) {
			parsed, err := url.Parse(endpoint.URL)
			if err != nil || ValidateMetricsEndpoint(endpoint.URL) != nil {
				t.Fatal("invalid approved endpoint")
			}
			dest := NewDestinationAllowlist(parsed.Host)
			units := NewServiceUnitAllowlist("")
			collector := NewCollector(NewHTTPProber(3*time.Second), nil, dest, units)
			target := &HealthTarget{TargetID: newUUID(), CollectorProfile: CollectorHTTPMetrics, MetricsEndpoint: endpoint.URL, ServiceKind: "none", Domain: endpoint.Domain, NFType: endpoint.NFType}
			result, err := collector.Collect(context.Background(), target, "live-readonly-test", false)
			if err != nil || result.Sample == nil {
				t.Fatalf("no accepted evidence: %v", err)
			}
			if result.Sample.Layers.Interface.State != StateHealthy {
				t.Fatalf("interface evidence failed: %+v", result.Sample.Layers.Interface)
			}
			if len(result.Sample.Metrics) == 0 {
				t.Fatal("no registered metrics accepted")
			}
			if result.Sample.Layers.Process.Measured {
				t.Fatal("endpoint test manufactured process evidence")
			}
			t.Logf("accepted_metrics=%d l2=%s l3=%s reason=%s; database_writes=0", len(result.Sample.Metrics), result.Sample.Layers.Interface.State, result.Sample.Layers.Service.State, result.Sample.Layers.Service.Reason)
		})
	}
}
