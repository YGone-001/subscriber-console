package agentclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"subscriber/internal/agents"
)

func TestCollectorTransportHTTPSAndCredentialDestination(t *testing.T) {
	for _, u := range []string{"http://10.0.0.1", "http://localhost", "https://user:secret@example.test", "https://example.test/path", "https://example.test?token=x"} {
		if _, err := ValidateServerURL(u); err == nil {
			t.Fatalf("unsafe origin accepted: %s", u)
		}
	}
	for _, u := range []string{"http://127.0.0.1:18888", "http://[::1]:18888", "https://controller.example.test"} {
		if _, err := ValidateServerURL(u); err != nil {
			t.Fatal(err)
		}
	}
}
func TestActualHTTPCollectorSessionAndReportUseDedicatedIdentity(t *testing.T) {
	id := strings.Repeat("a", 32)
	key := strings.Repeat("b", 64)
	session := strings.Repeat("c", 64)
	reports := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Agent "+key || r.Header.Get("Cookie") != "" {
			t.Error("machine identity was not isolated")
		}
		switch r.URL.Path {
		case "/api/agent-sessions/" + id:
			_ = json.NewEncoder(w).Encode(agents.SessionResponse{SessionID: session, ExpiresAt: time.Now().Add(time.Hour), IntervalSeconds: 15, ProtocolVersion: 1})
		case "/api/agent-reports/" + id:
			var req agents.ReportRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Error(err)
			}
			if req.SessionID != session || req.Sequence != 1 {
				t.Error("session envelope lost")
			}
			reports++
			w.WriteHeader(200)
		default:
			t.Error("unexpected endpoint")
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	c, err := New(Config{ServerURL: server.URL, AgentID: id}, key)
	if err != nil {
		t.Fatal(err)
	}
	c.http.Transport = server.Client().Transport
	s, err := c.Session(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Send(context.Background(), agents.ReportRequest{ProtocolVersion: 1, SessionID: s.SessionID, Sequence: 1}); err != nil {
		t.Fatal(err)
	}
	if reports != 1 {
		t.Fatal("report was not received")
	}
}
func TestRedirectNeverForwardsCredential(t *testing.T) {
	received := false
	destination := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { received = true }))
	defer destination.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	c, err := New(Config{ServerURL: source.URL, AgentID: strings.Repeat("a", 32)}, strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	c.http.Transport = source.Client().Transport
	_, err = c.Session(context.Background())
	if err == nil || received {
		t.Fatal("credential followed a redirect")
	}
	if c.http.Transport.(*http.Transport).TLSClientConfig == nil {
		t.Fatal("TLS client missing")
	}
}
