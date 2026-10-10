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

// HTTPProber performs a single bounded, non-redirecting GET.
type HTTPProber struct {
	client  *http.Client
	timeout time.Duration
}

// NewHTTPProber constructs a prober with a fixed timeout and no redirect following.
func NewHTTPProber(timeout time.Duration) *HTTPProber {
	if timeout <= 0 {
		timeout = RequestTimeoutSeconds * time.Second
	}
	return &HTTPProber{
		timeout: timeout,
		client: &http.Client{
			Timeout: timeout,
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

	reqCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/plain")
	req.Header.Set("User-Agent", "xcloud-nf-health/1.0")

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
