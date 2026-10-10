package nfhealth

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestAuthorizeDialDestinationAcceptsApprovedLoopback(t *testing.T) {
	dest := NewDestinationAllowlist("127.0.0.1:9090")
	u, err := url.Parse("http://127.0.0.1:9090/metrics")
	if err != nil {
		t.Fatal(err)
	}
	host, port, err := AuthorizeDialDestination(context.Background(), u, dest, SystemResolver{})
	if err != nil {
		t.Fatalf("approved loopback metrics target must remain allowed: %v", err)
	}
	if host != "127.0.0.1" || port != "9090" {
		t.Fatalf("unexpected dial target %s:%s", host, port)
	}
}

func TestAuthorizeDialDestinationDeniesNonAllowlisted(t *testing.T) {
	dest := NewDestinationAllowlist("127.0.0.1:9090")
	u, _ := url.Parse("http://127.0.0.12:9090/metrics")
	if _, _, err := AuthorizeDialDestination(context.Background(), u, dest, SystemResolver{}); err == nil {
		t.Fatal("non-allowlisted destination must fail closed")
	}
}

func TestAuthorizeDialDestinationFailsClosedOnDNSRebinding(t *testing.T) {
	// A hostname entry authorizes the name, but resolution returns an
	// unauthorized address. The probe must fail closed rather than dial it.
	dest := NewDestinationAllowlist("metrics.internal:9090")
	resolver := NewStaticResolver()
	resolver.Set("metrics.internal", "203.0.113.10")

	u, _ := url.Parse("http://metrics.internal:9090/metrics")
	if _, _, err := AuthorizeDialDestination(context.Background(), u, dest, resolver); err == nil {
		t.Fatal("hostname resolving to an unauthorized address must fail closed")
	}
}

func TestAuthorizeDialDestinationAcceptsHostnameResolvingToApprovedIP(t *testing.T) {
	dest := NewDestinationAllowlist("metrics.internal:9090,127.0.0.1:9090")
	resolver := NewStaticResolver()
	resolver.Set("metrics.internal", "127.0.0.1")

	u, _ := url.Parse("http://metrics.internal:9090/metrics")
	host, port, err := AuthorizeDialDestination(context.Background(), u, dest, resolver)
	if err != nil {
		t.Fatalf("hostname resolving to an approved loopback address must be allowed: %v", err)
	}
	if host != "127.0.0.1" || port != "9090" {
		t.Fatalf("unexpected pinned dial target %s:%s", host, port)
	}
}

func TestAuthorizeDialDestinationFailsClosedWhenResolutionFails(t *testing.T) {
	dest := NewDestinationAllowlist("metrics.internal:9090")
	resolver := NewStaticResolver()
	u, _ := url.Parse("http://metrics.internal:9090/metrics")
	if _, _, err := AuthorizeDialDestination(context.Background(), u, dest, resolver); err == nil {
		t.Fatal("unresolvable hostname destination must fail closed")
	}
	if _, _, err := AuthorizeDialDestination(context.Background(), u, dest, nil); err == nil {
		t.Fatal("hostname destination without a resolver must fail closed")
	}
}

func TestHTTPProberIgnoresProxyEnvironment(t *testing.T) {
	// A proxy environment must not redirect collection to an unauthorized
	// intermediary. The prober pins its transport proxy to nil.
	t.Setenv("HTTP_PROXY", "http://203.0.113.1:8888")
	t.Setenv("HTTPS_PROXY", "http://203.0.113.1:8888")
	t.Setenv("ALL_PROXY", "http://203.0.113.1:8888")
	t.Setenv("http_proxy", "http://203.0.113.1:8888")
	t.Setenv("https_proxy", "http://203.0.113.1:8888")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("# TYPE amf_session gauge\namf_session 1\n"))
	}))
	defer server.Close()

	hostport := strings.TrimPrefix(server.URL, "http://")
	prober := NewHTTPProber(2 * time.Second)
	dest := NewDestinationAllowlist(hostport)

	res, err := prober.Probe(context.Background(), server.URL+"/metrics", dest)
	if err != nil {
		t.Fatalf("probe error: %v", err)
	}
	if res.Outcome != InterfaceValid {
		t.Fatalf("proxy env must not break an approved direct collection, got %s (%s)", res.Outcome, res.ErrorMessage)
	}
	if strings.Contains(res.ErrorMessage, "8888") {
		t.Fatalf("collection must not traverse the configured proxy: %s", res.ErrorMessage)
	}
}

func TestHTTPProberDoesNotFollowRedirects(t *testing.T) {
	var redirectHits int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			w.Header().Set("Location", "http://203.0.113.50/steal")
			w.WriteHeader(http.StatusFound)
			return
		}
		redirectHits++
		_, _ = w.Write([]byte("should-not-be-reached"))
	}))
	defer server.Close()

	hostport := strings.TrimPrefix(server.URL, "http://")
	prober := NewHTTPProber(2 * time.Second)
	dest := NewDestinationAllowlist(hostport)

	res, err := prober.Probe(context.Background(), server.URL+"/metrics", dest)
	if err != nil {
		t.Fatalf("probe error: %v", err)
	}
	if res.HTTPStatus != http.StatusFound {
		t.Fatalf("redirect must not be followed, got status %d", res.HTTPStatus)
	}
	if redirectHits != 0 {
		t.Fatal("redirect target must never be contacted")
	}
}

func TestHTTPProberRejectsURLsLearnedFromResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("# TYPE amf_session gauge\namf_session 1\nhttp://203.0.113.60:9999/metrics\n"))
	}))
	defer server.Close()

	hostport := strings.TrimPrefix(server.URL, "http://")
	prober := NewHTTPProber(2 * time.Second)
	dest := NewDestinationAllowlist(hostport)

	if _, err := prober.Probe(context.Background(), "http://203.0.113.60:9999/metrics", dest); err == nil {
		t.Fatal("addresses discovered inside a response body must not become probe destinations")
	}
}

func TestHTTPProberPreservesTLSVerification(t *testing.T) {
	prober := NewHTTPProber(2 * time.Second)
	transport, ok := prober.client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("prober must use a dedicated transport")
	}
	if transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS certificate verification must remain enabled")
	}
	if transport.Proxy != nil {
		t.Fatal("transport proxy must be disabled so proxy env cannot bypass the allowlist")
	}
}

func TestHTTPProberBoundsResponseSize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		chunk := strings.Repeat("a", 4096)
		for i := 0; i < 512; i++ {
			_, _ = w.Write([]byte(chunk))
		}
	}))
	defer server.Close()

	hostport := strings.TrimPrefix(server.URL, "http://")
	prober := NewHTTPProber(3 * time.Second)
	dest := NewDestinationAllowlist(hostport)

	res, err := prober.Probe(context.Background(), server.URL+"/metrics", dest)
	if err != nil {
		t.Fatalf("probe error: %v", err)
	}
	if res.Outcome != InterfaceInvalid {
		t.Fatalf("oversized body must be rejected, got %s", res.Outcome)
	}
}

func TestStaticResolverDrivesMockDialer(t *testing.T) {
	// Controlled resolver + mock dial destination: a hostname is authorized
	// only when its resolved address is itself approved.
	dest := NewDestinationAllowlist("exporter.local:9090,127.0.0.1:9090")
	resolver := NewStaticResolver()
	resolver.Set("exporter.local", "127.0.0.1")

	u, _ := url.Parse("http://exporter.local:9090/metrics")
	host, _, err := AuthorizeDialDestination(context.Background(), u, dest, resolver)
	if err != nil {
		t.Fatalf("authorized hostname must resolve to a pinned dial target: %v", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		t.Fatalf("pinned dial target must be the authorized loopback address, got %s", host)
	}
}

func TestMain(m *testing.M) {
	// Ensure no ambient proxy variables leak into default test runs.
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		_ = os.Unsetenv(key)
	}
	os.Exit(m.Run())
}
