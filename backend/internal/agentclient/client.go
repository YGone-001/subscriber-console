// Package agentclient implements the outbound-only collector transport.
// It never receives shell commands, database credentials or business mutations.
package agentclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"subscriber/internal/agents"
	"subscriber/internal/runtimeinv"
)

type Config struct {
	ServerURL string `json:"serverUrl"`
	AgentID   string `json:"agentId"`
	TokenFile string `json:"tokenFile"`
	CAFile    string `json:"caFile,omitempty"`
}
type Client struct {
	base, id, token string
	http            *http.Client
}
type APIError struct {
	Status int
	Code   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("collector request rejected (%d, %s)", e.Status, e.Code)
}

var hexID = regexp.MustCompile(`^[0-9a-f]{32}$`)

func ValidateServerURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("serverUrl must be an origin without credentials, path, query or fragment")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || ip == nil || !ip.IsLoopback() {
			return "", errors.New("serverUrl requires HTTPS; HTTP is only allowed for a literal loopback address")
		}
	}
	return strings.TrimRight(u.String(), "/"), nil
}
func New(cfg Config, token string) (*Client, error) {
	base, err := ValidateServerURL(cfg.ServerURL)
	if err != nil {
		return nil, err
	}
	if !hexID.MatchString(cfg.AgentID) || len(token) != 64 || !hexID.MatchString(token[:32]) || !hexID.MatchString(token[32:]) {
		return nil, errors.New("invalid agent identifier or credential")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CAFile != "" {
		data, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, errors.New("cannot read collector CA file")
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(data) {
			return nil, errors.New("collector CA file contains no certificates")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return &Client{base: base, id: cfg.AgentID, token: token, http: &http.Client{
		Timeout: 10 * time.Second, Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}
func (c *Client) post(ctx context.Context, path string, body, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	if len(data) > agents.MaxBodyBytes {
		return errors.New("collector report exceeds protocol limit")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Agent "+c.token)
	res, err := c.http.Do(req)
	if err != nil {
		return errors.New("collector controller is unreachable")
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(res.Body, agents.MaxBodyBytes+1))
	if err != nil || len(payload) > agents.MaxBodyBytes {
		return errors.New("invalid bounded controller response")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var failure struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(payload, &failure)
		// Never include server bodies, credentials or URLs in diagnostics.
		return &APIError{Status: res.StatusCode, Code: failure.Code}
	}
	if out != nil {
		return json.Unmarshal(payload, out)
	}
	return nil
}
func (c *Client) Session(ctx context.Context) (*agents.SessionResponse, error) {
	var out agents.SessionResponse
	err := c.post(ctx, "/api/agent-sessions/"+c.id, agents.SessionRequest{ProtocolVersion: agents.ProtocolVersion}, &out)
	if err != nil {
		return nil, err
	}
	if out.ProtocolVersion != agents.ProtocolVersion || out.IntervalSeconds < 5 || out.IntervalSeconds > 300 || len(out.SessionID) != 64 || !out.ExpiresAt.After(time.Now()) {
		return nil, errors.New("controller returned an invalid collector session")
	}
	return &out, nil
}
func (c *Client) Send(ctx context.Context, req agents.ReportRequest) error {
	return c.post(ctx, "/api/agent-reports/"+c.id, req, nil)
}
func LoadConfig(path string) (Config, string, error) {
	var cfg Config
	f, err := os.Open(path)
	if err != nil {
		return cfg, "", errors.New("cannot open collector config")
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 16*1024))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&cfg); err != nil {
		return cfg, "", errors.New("invalid collector config")
	}
	var trailing any
	if !errors.Is(decoder.Decode(&trailing), io.EOF) {
		return cfg, "", errors.New("collector config has trailing content")
	}
	info, err := os.Stat(cfg.TokenFile)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 128 || info.Mode().Perm()&0077 != 0 {
		return cfg, "", errors.New("tokenFile must be a private regular file with mode 0600")
	}
	data, err := os.ReadFile(cfg.TokenFile)
	if err != nil {
		return cfg, "", errors.New("cannot read collector credential")
	}
	return cfg, strings.TrimSpace(string(data)), nil
}
func wait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func (c *Client) Run(ctx context.Context, logger *slog.Logger, version string) error {
	scanner := runtimeinv.NewScanner(runtimeinv.DefaultRegistry(), runtimeinv.ScannerOptions{})
	sampler := agents.NewHostSampler()
	prior := map[string]runtimeinv.ComponentState{}
	var session *agents.SessionResponse
	var seq int64
	delay := time.Second
	for ctx.Err() == nil {
		if session == nil || time.Now().Add(30*time.Second).After(session.ExpiresAt) {
			next, err := c.Session(ctx)
			if err != nil {
				logger.Warn("collector connection unavailable", "error", err)
				if !wait(ctx, delay) {
					break
				}
				delay = min(delay*2, 60*time.Second)
				continue
			}
			session = next
			seq = 0
			delay = time.Second
		}
		snapshot, next := scanner.Scan(ctx, runtimeinv.TriggerScheduled, prior)
		prior = next
		observation := agents.ObservationFromRuntime(snapshot, sampler.Sample(), version)
		seq++
		err := c.Send(ctx, agents.ReportRequest{ProtocolVersion: agents.ProtocolVersion, SessionID: session.SessionID, Sequence: seq, Observation: observation})
		if err != nil {
			logger.Warn("collector publication failed", "error", err)
			var api *APIError
			if errors.As(err, &api) && (api.Status == 401 || api.Code == "AGENT_SESSION_INVALID") {
				session = nil
			}
			if !wait(ctx, delay) {
				break
			}
			delay = min(delay*2, 60*time.Second)
			continue
		}
		delay = time.Second
		if !wait(ctx, time.Duration(session.IntervalSeconds)*time.Second) {
			break
		}
	}
	return ctx.Err()
}
