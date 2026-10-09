package discovery

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
)

// DestinationAllowlist is the server-owned set of permitted NRF destinations.
// Default deny: an empty allowlist authorizes nothing.
type DestinationAllowlist struct {
	mu      sync.RWMutex
	allowed map[string]struct{} // "host:port"
}

// NewDestinationAllowlist parses a comma-separated host:port list.
func NewDestinationAllowlist(raw string) *DestinationAllowlist {
	d := &DestinationAllowlist{allowed: map[string]struct{}{}}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		d.allowed[strings.ToLower(part)] = struct{}{}
	}
	return d
}

// Allows reports whether host:port is authorized.
func (d *DestinationAllowlist) Allows(hostport string) bool {
	if d == nil {
		return false
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	_, ok := d.allowed[strings.ToLower(hostport)]
	return ok
}

// Size returns the number of authorized destinations.
func (d *DestinationAllowlist) Size() int {
	if d == nil {
		return 0
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	return len(d.allowed)
}

// ErrDestinationNotAllowed is returned when an outbound target is not authorized.
var ErrDestinationNotAllowed = errors.New("discovery target not allowlisted")

// ErrResponseTooLarge is returned when a remote body exceeds the bounded limit.
var ErrResponseTooLarge = errors.New("discovery response limit exceeded")

// ErrProtocol is returned when the remote endpoint misbehaves at the HTTP layer.
var ErrProtocol = errors.New("discovery protocol error")

// NRFClient performs bounded, read-only HTTP/2 requests against an authorized NRF.
type NRFClient struct {
	allowlist *DestinationAllowlist
	httpC     map[string]*http.Client
	mu        sync.Mutex
	tlsRoots  *x509.CertPool
}

// NewNRFClient builds a client that only talks to allowlisted destinations.
// TLS uses system trust roots or an explicitly configured CA file. InsecureSkipVerify
// is never set.
func NewNRFClient(allowlist *DestinationAllowlist, caFile string) (*NRFClient, error) {
	c := &NRFClient{
		allowlist: allowlist,
		httpC:     map[string]*http.Client{},
	}
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("failed to read discovery CA file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("discovery CA file contains no certificates")
		}
		c.tlsRoots = pool
	}
	return c, nil
}

// TransportModeFor returns the transport mode string for a URL scheme pairing.
func TransportModeFor(mode string) string {
	if mode == TransportH2TLS {
		return TransportH2TLS
	}
	return TransportH2C
}

func (c *NRFClient) clientFor(mode string) *http.Client {
	key := TransportModeFor(mode)
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.httpC[key]; ok {
		return existing
	}

	var transport http.RoundTripper
	switch key {
	case TransportH2TLS:
		tlsCfg := &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    c.tlsRoots,
		}
		transport = &http2.Transport{
			TLSClientConfig:    tlsCfg,
			AllowHTTP:          false,
			DisableCompression: false,
		}
	default: // h2c prior knowledge
		transport = &http2.Transport{
			AllowHTTP: true,
			DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
				d := net.Dialer{Timeout: RequestTimeoutSeconds * time.Second}
				return d.DialContext(ctx, network, addr)
			},
		}
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   RequestTimeoutSeconds * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Redirects are never followed.
			return errors.New("discovery redirects are not allowed")
		},
	}
	c.httpC[key] = client
	return client
}

// ValidateTarget ensures a base URL is a well-formed, allowlisted NRF origin.
func ValidateTarget(rawBase string, allowlist *DestinationAllowlist) (*url.URL, error) {
	rawBase = strings.TrimSpace(rawBase)
	if rawBase == "" {
		return nil, fmt.Errorf("%w: empty target", ErrDestinationNotAllowed)
	}
	u, err := url.Parse(rawBase)
	if err != nil {
		return nil, fmt.Errorf("malformed discovery url")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported url scheme")
	}
	if u.User != nil {
		return nil, errors.New("discovery url must not embed credentials")
	}
	if u.Fragment != "" {
		return nil, errors.New("discovery url must not contain a fragment")
	}
	host := u.Hostname()
	if host == "" {
		return nil, errors.New("discovery url must contain a host")
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	hostport := net.JoinHostPort(strings.ToLower(host), port)
	if !allowlist.Allows(hostport) {
		return nil, fmt.Errorf("%w: %s", ErrDestinationNotAllowed, hostport)
	}
	return u, nil
}

// ValidateLink ensures a discovered link stays inside the authorized source origin
// and approved path boundary before any request is issued.
func ValidateLink(link string, sourceBase *url.URL, allowlist *DestinationAllowlist) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil {
		return nil, errors.New("malformed profile link")
	}
	if u.User != nil || u.Fragment != "" {
		return nil, errors.New("profile link rejected")
	}
	// Only same-origin relative or absolute links to the configured source.
	if u.IsAbs() {
		if !strings.EqualFold(u.Scheme, sourceBase.Scheme) || !strings.EqualFold(u.Host, sourceBase.Host) {
			return nil, errors.New("cross-origin profile link rejected")
		}
	}
	resolved := sourceBase.ResolveReference(u)
	if _, err := ValidateTarget(resolved.String(), allowlist); err != nil {
		return nil, err
	}
	path := resolved.EscapedPath()
	if !strings.HasPrefix(path, "/nnrf-nfm/") && !strings.HasPrefix(path, "/nnrf-disc/") {
		return nil, errors.New("profile link outside approved path boundary")
	}
	return resolved, nil
}

// GetJSON issues a bounded GET and returns the response body with its content type.
func (c *NRFClient) GetJSON(ctx context.Context, rawURL string, mode string, allowlist *DestinationAllowlist) (body []byte, contentType string, status int, err error) {
	u, err := ValidateTarget(rawURL, allowlist)
	if err != nil {
		return nil, "", 0, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", 0, err
	}
	req.Header.Set("Accept", "application/3gppHal+json, application/json")

	client := c.clientFor(mode)
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", 0, fmt.Errorf("discovery transport error: %w", err)
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, MaxResponseBytes+1)
	data, readErr := io.ReadAll(limited)
	if readErr != nil {
		return nil, "", resp.StatusCode, fmt.Errorf("discovery transport error: %w", readErr)
	}
	if int64(len(data)) > MaxResponseBytes {
		return nil, "", resp.StatusCode, ErrResponseTooLarge
	}
	return data, resp.Header.Get("Content-Type"), resp.StatusCode, nil
}
