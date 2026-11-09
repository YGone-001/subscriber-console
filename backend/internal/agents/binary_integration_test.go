//go:build linux

package agents

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// This test runs two actual collector binaries against a test-owned TLS
// controller. It proves protocol integration, not deployment on two hosts.
func TestTwoCollectorBinariesPublishThroughTLS(t *testing.T) {
	if testing.Short() {
		t.Skip("collector binary integration")
	}
	repo := newMemoryRepo()
	service := NewService(repo, actors{}, nil, nil, nil)
	a := create(t, service, "binary-a", "home")
	b := create(t, service, "binary-b", "partner")
	handler := NewHandler(service, nil, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/agent-sessions/{agentId}", handler.Session)
	mux.HandleFunc("POST /api/agent-reports/{agentId}", handler.Report)
	server := httptest.NewTLSServer(mux)
	defer server.Close()

	dir := t.TempDir()
	binary := filepath.Join(dir, "xcloud-agent")
	compiler := filepath.Join(os.Getenv("GOROOT"), "bin", "go")
	if os.Getenv("GOROOT") == "" {
		var err error
		compiler, err = exec.LookPath("go")
		if err != nil {
			t.Fatal(err)
		}
	}
	build := exec.Command(compiler, "build", "-o", binary, "../../cmd/agent")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build collector: %v: %s", err, output)
	}
	ca := filepath.Join(dir, "controller-ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, credential := range []*CredentialResponse{a, b} {
		nodeDir := filepath.Join(dir, credential.Agent.AgentID)
		if err := os.Mkdir(nodeDir, 0700); err != nil {
			t.Fatal(err)
		}
		token := filepath.Join(nodeDir, "token")
		if err := os.WriteFile(token, []byte(credential.Token), 0600); err != nil {
			t.Fatal(err)
		}
		config := filepath.Join(nodeDir, "config.json")
		data, _ := json.Marshal(map[string]string{"serverUrl": server.URL, "agentId": credential.Agent.AgentID, "tokenFile": token, "caFile": ca})
		if err := os.WriteFile(config, data, 0600); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		command := exec.CommandContext(ctx, binary, "-config", config)
		command.Stderr = os.Stderr
		command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
		command.WaitDelay = 5 * time.Second
		if err := command.Start(); err != nil {
			cancel()
			t.Fatal(err)
		}
		t.Cleanup(func() { cancel(); _ = command.Wait() })
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		va, errA := service.Get(context.Background(), a.Agent.AgentID)
		vb, errB := service.Get(context.Background(), b.Agent.AgentID)
		if errA == nil && errB == nil && va.LastReceivedAt != nil && vb.LastReceivedAt != nil {
			if va.ConnectionState != "online" || vb.ConnectionState != "online" || va.Scope.NetworkKey != "home" || vb.Scope.NetworkKey != "partner" {
				t.Fatal("node assignment or connectivity was lost")
			}
			if va.Observation.Platform != "linux" || vb.Observation.Platform != "linux" || va.Observation.HostName == "" || vb.Observation.HostName == "" {
				t.Fatal("real node observation missing")
			}
			if va.AgentID == vb.AgentID {
				t.Fatal("collector identities collapsed")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("two collector binaries did not publish accepted reports before the deadline")
}
