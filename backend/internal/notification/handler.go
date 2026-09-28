// Package notification provides the shadow SSE notification stream handler.
package notification

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"subscriber/internal/alert"
	"subscriber/internal/auth"
	"subscriber/internal/response"
)

const (
	pollInterval      = 4 * time.Second
	heartbeatInterval = 12 * time.Second
)

// AlertReader is the read-only alert dependency used by a notification stream.
type AlertReader interface {
	ListAlerts(ctx context.Context, limit int64) (*alert.ListAlertsResponse, error)
}

// SessionRevalidator verifies that an already-connected session is still valid.
type SessionRevalidator interface {
	ValidateSession(ctx context.Context, claims *auth.Claims) (*auth.Principal, error)
}

// Handler serves GET /api/notifications/stream.
type Handler struct {
	alerts      AlertReader
	sessions    SessionRevalidator
	pollEvery   time.Duration
	heartbeatAt time.Duration
	now         func() time.Time
}

// NewHandler constructs a handler with the frozen production timing contract.
func NewHandler(alerts AlertReader, sessions SessionRevalidator) *Handler {
	return &Handler{
		alerts:      alerts,
		sessions:    sessions,
		pollEvery:   pollInterval,
		heartbeatAt: heartbeatInterval,
		now:         time.Now,
	}
}

// ServeHTTP streams read-only SSE frames for an authenticated session.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := auth.PrincipalFromContext(r.Context())
	if p == nil {
		response.Error(w, http.StatusUnauthorized, "Unauthorized", "AUTH_INVALID_TOKEN")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	// This request is intentionally long lived. Keep the normal server-wide
	// WriteTimeout for every other route and clear only this response deadline.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	writeEvent := func(name string, payload any) bool {
		frame, err := eventFrame(name, payload)
		if err != nil {
			return false
		}
		if _, err := w.Write(frame); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	writeComment := func(comment string) bool {
		if _, err := w.Write(commentFrame(comment)); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	initial, err := h.alerts.ListAlerts(r.Context(), 15)
	if err != nil {
		// The Node route catches ordinary initial repository failures and emits
		// an empty init payload rather than an init_error comment.
		initial = emptyAlerts()
	}
	if initial == nil {
		initial = emptyAlerts()
	}

	lastAlertsCount := initial.ActiveCount
	if !writeEvent("init", initPayload{
		Timestamp: isoMillis(h.now()),
		User:      p.Username,
		Role:      p.Role,
		Alerts: alertPayload{
			ActiveCriticalCount: initial.ActiveCriticalCount,
			ActiveWarningCount:  initial.ActiveWarningCount,
			ActiveCount:         initial.ActiveCount,
			Recent:              firstAlerts(initial.Alerts),
		},
	}) {
		return
	}

	lastHeartbeat := h.now()
	ticker := time.NewTicker(h.pollEvery)
	defer ticker.Stop()

	claims := &auth.Claims{Username: p.Username, Role: p.Role, SV: p.SessionVersion}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}

		if _, err := h.sessions.ValidateSession(r.Context(), claims); err != nil {
			// The reason is intentionally not exposed to the SSE client.
			_ = writeEvent("session_expired", struct{}{})
			return
		}

		alerts, err := h.alerts.ListAlerts(r.Context(), 10)
		hasUpdate := false
		if err == nil && alerts != nil && alerts.ActiveCount != lastAlertsCount {
			lastAlertsCount = alerts.ActiveCount
			hasUpdate = true
			if !writeEvent("alerts_update", updatePayload{
				Timestamp:           isoMillis(h.now()),
				ActiveCriticalCount: alerts.ActiveCriticalCount,
				ActiveWarningCount:  alerts.ActiveWarningCount,
				ActiveCount:         alerts.ActiveCount,
				LatestAlerts:        firstAlerts(alerts.Alerts),
			}) {
				return
			}
		}

		// A failed periodic listAlerts call is null in Node. It neither emits an
		// alerts_update nor a transient_retry frame, but it can still heartbeat.
		now := h.now()
		if !hasUpdate && now.Sub(lastHeartbeat) >= h.heartbeatAt {
			lastHeartbeat = now
			if !writeComment("ping") {
				return
			}
		}
	}
}

type alertPayload struct {
	ActiveCriticalCount int64                 `json:"activeCriticalCount"`
	ActiveWarningCount  int64                 `json:"activeWarningCount"`
	ActiveCount         int64                 `json:"activeCount"`
	Recent              []alert.AlertDocument `json:"recent"`
}

type initPayload struct {
	Timestamp string       `json:"timestamp"`
	User      string       `json:"user"`
	Role      string       `json:"role"`
	Alerts    alertPayload `json:"alerts"`
}

type updatePayload struct {
	Timestamp           string                `json:"timestamp"`
	ActiveCriticalCount int64                 `json:"activeCriticalCount"`
	ActiveWarningCount  int64                 `json:"activeWarningCount"`
	ActiveCount         int64                 `json:"activeCount"`
	LatestAlerts        []alert.AlertDocument `json:"latestAlerts"`
}

func emptyAlerts() *alert.ListAlertsResponse {
	return &alert.ListAlertsResponse{Alerts: []alert.AlertDocument{}}
}

func firstAlerts(alerts []alert.AlertDocument) []alert.AlertDocument {
	if len(alerts) == 0 {
		return []alert.AlertDocument{}
	}
	if len(alerts) > 5 {
		return alerts[:5]
	}
	return alerts
}

func eventFrame(name string, payload any) ([]byte, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return []byte("event: " + name + "\ndata: " + string(data) + "\n\n"), nil
}

func commentFrame(comment string) []byte {
	return []byte(":" + comment + "\n\n")
}

func isoMillis(now time.Time) string {
	return now.UTC().Format("2006-01-02T15:04:05.000Z")
}
