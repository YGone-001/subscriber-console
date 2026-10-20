package ueinfo

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

const (
	upstreamTimeout = 4 * time.Second
	maxBodyBytes    = 4 << 20
)

// FetchError carries a safe reason token for a failed upstream call.
type FetchError struct {
	Reason string
}

func (e *FetchError) Error() string { return e.Reason }

// Fetcher reads the approved UE endpoints. It is an interface so tests can inject
// deterministic upstream responses without network access.
type Fetcher interface {
	FetchUEInfo(ctx context.Context, host string) ([]upstreamUE, error)
	FetchPDUInfo(ctx context.Context, host string) ([]upstreamUE, error)
	FetchUESActive(ctx context.Context, host string) ([]byte, error)
}

// HTTPFetcher is the production implementation. It only issues GET requests to
// fixed paths on allowlisted host:port targets and never follows redirects.
type HTTPFetcher struct {
	client *http.Client
}

func NewHTTPFetcher() *HTTPFetcher {
	return &HTTPFetcher{
		client: &http.Client{
			Timeout: upstreamTimeout,
			Transport: &http.Transport{
				Proxy:                 nil,
				DialContext:           (&net.Dialer{Timeout: upstreamTimeout}).DialContext,
				MaxIdleConns:          16,
				MaxIdleConnsPerHost:   4,
				IdleConnTimeout:       30 * time.Second,
				ResponseHeaderTimeout: upstreamTimeout,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (f *HTTPFetcher) FetchUEInfo(ctx context.Context, host string) ([]upstreamUE, error) {
	return f.fetchItems(ctx, host, "/ue-info", url.Values{"page": []string{"-1"}})
}

func (f *HTTPFetcher) FetchPDUInfo(ctx context.Context, host string) ([]upstreamUE, error) {
	return f.fetchItems(ctx, host, "/pdu-info", url.Values{"page": []string{"-1"}})
}

func (f *HTTPFetcher) FetchUESActive(ctx context.Context, host string) ([]byte, error) {
	return f.fetchText(ctx, host, "/metrics", nil)
}

func (f *HTTPFetcher) fetchItems(ctx context.Context, host, path string, query url.Values) ([]upstreamUE, error) {
	body, err := f.fetchText(ctx, host, path, query)
	if err != nil {
		return nil, err
	}
	var payload upstreamResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, &FetchError{Reason: ReasonInvalidResponse}
	}
	if payload.Items == nil {
		return []upstreamUE{}, nil
	}
	if len(payload.Items) > MaxUpstreamItems {
		return nil, &FetchError{Reason: ReasonTruncated}
	}
	return payload.Items, nil
}

func (f *HTTPFetcher) fetchText(ctx context.Context, host, path string, query url.Values) ([]byte, error) {
	u := url.URL{Scheme: "http", Host: host, Path: path}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, &FetchError{Reason: ReasonNetworkError}
	}
	req.Header.Set("Accept", "application/json, text/plain")
	resp, err := f.client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return nil, &FetchError{Reason: ReasonTimeout}
		}
		return nil, &FetchError{Reason: ReasonNetworkError}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, &FetchError{Reason: ReasonHTTPError}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil {
		return nil, &FetchError{Reason: ReasonNetworkError}
	}
	if len(body) > maxBodyBytes {
		return nil, &FetchError{Reason: ReasonInvalidResponse}
	}
	return body, nil
}

func sourceReason(err error) string {
	var fetchErr *FetchError
	if errors.As(err, &fetchErr) {
		return fetchErr.Reason
	}
	return ReasonNetworkError
}
