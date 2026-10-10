package nfhealth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ProbeResult is the bounded outcome of one HTTP metrics endpoint probe.
type ProbeResult struct {
	Endpoint     string
	HTTPStatus   int
	ResponseMs   int64
	ContentType  string
	Body         []byte
	Outcome      string
	ErrorMessage string
}

// HostResolver resolves hostnames for egress authorization. It is injectable so
// tests can drive DNS-rebinding scenarios without live resolution.
type HostResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// SystemResolver uses the machine resolver.
type SystemResolver struct{}

// LookupIPAddr resolves a hostname through the system resolver.
func (SystemResolver) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

// StaticResolver is a controlled test resolver.
type StaticResolver struct {
	mu    sync.Mutex
	hosts map[string][]net.IPAddr
	Err   error
}

// NewStaticResolver constructs an empty controlled resolver.
func NewStaticResolver() *StaticResolver {
	return &StaticResolver{hosts: map[string][]net.IPAddr{}}
}

// Set installs the addresses a hostname resolves to.
func (r *StaticResolver) Set(host string, ips ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	addrs := make([]net.IPAddr, 0, len(ips))
	for _, raw := range ips {
		ip := net.ParseIP(raw)
		if ip != nil {
			addrs = append(addrs, net.IPAddr{IP: ip})
		}
	}
	r.hosts[strings.ToLower(host)] = addrs
}

// LookupIPAddr returns the configured addresses for a hostname.
func (r *StaticResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Err != nil {
		return nil, r.Err
	}
	addrs, ok := r.hosts[strings.ToLower(host)]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	if len(addrs) == 0 {
		return nil, &net.DNSError{Err: "no addresses", Name: host, IsNotFound: true}
	}
	out := make([]net.IPAddr, len(addrs))
	copy(out, addrs)
	return out, nil
}

// HTTPProber performs a single bounded, non-redirecting GET.
//
// Egress safety:
//   - proxy environment variables are ignored (Transport.Proxy is nil)
//   - redirects are disabled
//   - TLS certificate verification is preserved
//   - the actual dialed destination is authorized after name resolution
//   - resolved addresses are pinned so a DNS rebind cannot redirect the socket
//   - timeouts and response-size bounds remain enforced
type HTTPProber struct {
	client   *http.Client
	timeout  time.Duration
	resolver HostResolver
}

// NewHTTPProber constructs a prober with a fixed timeout, no redirect following
// and no transparent proxying.
func NewHTTPProber(timeout time.Duration) *HTTPProber {
	return NewHTTPProberWithResolver(timeout, SystemResolver{})
}

// NewHTTPProberWithResolver constructs a prober with an injectable resolver.
func NewHTTPProberWithResolver(timeout time.Duration, resolver HostResolver) *HTTPProber {
	if timeout <= 0 {
		timeout = RequestTimeoutSeconds * time.Second
	}
	if resolver == nil {
		resolver = SystemResolver{}
	}
	transport := &http.Transport{
		// Explicitly disable proxy discovery so HTTP_PROXY / HTTPS_PROXY /
		// ALL_PROXY cannot silently redirect outbound collection.
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   timeout,
			KeepAlive: 0,
		}).DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          0,
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   timeout,
		ExpectContinueTimeout: 0,
		// TLS verification stays enabled: InsecureSkipVerify is intentionally
		// left at its zero value (false).
	}
	return &HTTPProber{
		timeout:  timeout,
		resolver: resolver,
		client: &http.Client{
			Transport: transport,
			Timeout:   timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Probe fetches the approved metrics endpoint once. It never follows redirects
// and never requests URLs discovered inside response bodies.
func (p *HTTPProber) Probe(ctx context.Context, rawURL string, dest *DestinationAllowlist) (*ProbeResult, error) {
	if err := ValidateMetricsEndpoint(rawURL); err != nil {
		return nil, err
	}
	if err := MustAllowlistEndpoint(rawURL, dest); err != nil {
		return nil, err
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}

	// Resolve and authorize the concrete dial destination before any socket is
	// opened. Unverifiable hostname destinations fail closed.
	dialHost, dialPort, err := AuthorizeDialDestination(ctx, u, dest, p.resolver)
	if err != nil {
		return nil, err
	}

	reqCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/plain")
	req.Header.Set("User-Agent", "xcloud-nf-health/1.0")

	// Pin the request URL to the authorized dial target so a DNS rebind between
	// authorization and connection cannot change the destination. The original
	// hostname is preserved in the Host header for virtual-hosted exporters.
	req.Host = u.Host
	req.URL.Host = net.JoinHostPort(dialHost, dialPort)

	started := time.Now()
	res, err := p.client.Do(req)
	elapsed := time.Since(started).Milliseconds()
	if err != nil {
		outcome := InterfaceError
		msg := err.Error()
		switch {
		case errors.Is(err, context.DeadlineExceeded) || strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline"):
			outcome = InterfaceTimeout
		case strings.Contains(msg, "connection refused") || strings.Contains(msg, "connect: "):
			outcome = InterfaceRefused
		}
		return &ProbeResult{
			Endpoint:     rawURL,
			Outcome:      outcome,
			ResponseMs:   elapsed,
			ErrorMessage: msg,
		}, nil
	}
	defer func() { _ = res.Body.Close() }()

	limited := io.LimitReader(res.Body, MaxResponseBytes+1)
	body, readErr := io.ReadAll(limited)
	if readErr != nil {
		return &ProbeResult{
			Endpoint:     rawURL,
			HTTPStatus:   res.StatusCode,
			ResponseMs:   elapsed,
			ContentType:  res.Header.Get("Content-Type"),
			Outcome:      InterfaceError,
			ErrorMessage: readErr.Error(),
		}, nil
	}
	if len(body) > MaxResponseBytes {
		return &ProbeResult{
			Endpoint:     rawURL,
			HTTPStatus:   res.StatusCode,
			ResponseMs:   elapsed,
			ContentType:  res.Header.Get("Content-Type"),
			Outcome:      InterfaceInvalid,
			ErrorMessage: "response body exceeds maximum size",
		}, nil
	}

	result := &ProbeResult{
		Endpoint:    rawURL,
		HTTPStatus:  res.StatusCode,
		ResponseMs:  elapsed,
		ContentType: res.Header.Get("Content-Type"),
		Body:        body,
	}

	switch {
	case res.StatusCode >= 500:
		result.Outcome = InterfaceHTTP5xx
		result.ErrorMessage = fmt.Sprintf("metrics endpoint returned HTTP %d", res.StatusCode)
	case res.StatusCode >= 400:
		result.Outcome = InterfaceHTTP4xx
		result.ErrorMessage = fmt.Sprintf("metrics endpoint returned HTTP %d", res.StatusCode)
	case res.StatusCode != http.StatusOK:
		result.Outcome = InterfaceInvalid
		result.ErrorMessage = fmt.Sprintf("metrics endpoint returned HTTP %d", res.StatusCode)
	default:
		result.Outcome = InterfaceValid
	}
	return result, nil
}

// AuthorizeDialDestination resolves the endpoint host and returns the concrete
// host:port the socket must dial. Every resolved address must match the
// allowlist, otherwise the probe fails closed.
//
// Documented limitation: hostname destinations are only accepted when every
// resolved address is itself an approved ip:port entry (or the original
// host:port entry authorizes the concrete address). This prevents DNS rebinding
// from redirecting a collection to an unauthorized address.
func AuthorizeDialDestination(ctx context.Context, u *url.URL, dest *DestinationAllowlist, resolver HostResolver) (string, string, error) {
	if u == nil {
		return "", "", validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "metricsEndpoint destination is not allowlisted")
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if dest == nil || !dest.Allows(net.JoinHostPort(host, port)) {
		return "", "", validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "metricsEndpoint destination is not allowlisted")
	}

	// IP-literal destinations need no resolution and are authorized as-is.
	if ip := net.ParseIP(host); ip != nil {
		return host, port, nil
	}

	if resolver == nil {
		return "", "", validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "hostname destination cannot be verified without a resolver")
	}
	addrs, err := resolver.LookupIPAddr(ctx, host)
	if err != nil || len(addrs) == 0 {
		return "", "", validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "hostname destination could not be resolved for egress authorization")
	}

	// Every resolved address must be individually authorized. A single
	// unauthorized address fails the whole destination closed.
	approved := ""
	for _, addr := range addrs {
		ip := addr.IP
		if ip == nil {
			return "", "", validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "hostname destination resolved to an unauthorized address")
		}
		ipPort := net.JoinHostPort(ip.String(), port)
		// Authorize the concrete ip:port, or the original hostname:port when
		// every resolved address is loopback and the host entry is approved.
		if dest.Allows(ipPort) {
			if approved == "" {
				approved = ip.String()
			}
			continue
		}
		if dest.Allows(net.JoinHostPort(host, port)) && ip.IsLoopback() {
			if approved == "" {
				approved = ip.String()
			}
			continue
		}
		return "", "", validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "hostname destination resolved to an unauthorized address")
	}
	if approved == "" {
		return "", "", validationError("NF_HEALTH_DESTINATION_NOT_ALLOWED", "hostname destination cannot be verified safely")
	}
	return approved, port, nil
}

// classifyDialError maps low-level network failures without inventing success.
func classifyDialError(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return InterfaceTimeout
	}
	if strings.Contains(err.Error(), "connection refused") {
		return InterfaceRefused
	}
	return InterfaceError
}
