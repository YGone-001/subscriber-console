package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// WebhookPayload is the JSON body delivered to a webhook channel.
type WebhookPayload struct {
	DeliveryID   string `json:"deliveryId"`
	Event        string `json:"event"`
	AlertID      string `json:"alertId"`
	RuleID       string `json:"ruleId"`
	RuleName     string `json:"ruleName"`
	TargetID     string `json:"targetId"`
	TargetName   string `json:"targetName"`
	Severity     string `json:"severity"`
	TriggerCount int    `json:"triggerCount"`
	OccurredAt   string `json:"occurredAt"`
}

// Sender delivers one delivery to a channel.
type Sender interface {
	Send(ctx context.Context, channel *NotificationChannel, delivery *Delivery) error
}

// WebhookSender posts signed JSON to a webhook channel.
type WebhookSender struct {
	client *http.Client
	now    func() time.Time
}

// NewWebhookSender constructs the HTTP sender.
func NewWebhookSender(client *http.Client) *WebhookSender {
	if client == nil {
		client = http.DefaultClient
	}
	return &WebhookSender{client: client, now: func() time.Time { return time.Now().UTC() }}
}

// Send performs one bounded POST. A 2xx is success; anything else is a
// delivery error the worker will retry with backoff.
func (s *WebhookSender) Send(ctx context.Context, channel *NotificationChannel, delivery *Delivery) error {
	payload := WebhookPayload{
		DeliveryID:   delivery.ID,
		Event:        delivery.Event,
		AlertID:      delivery.AlertID,
		RuleID:       delivery.RuleID,
		RuleName:     delivery.RuleName,
		TargetID:     delivery.TargetID,
		TargetName:   delivery.TargetName,
		Severity:     delivery.Severity,
		TriggerCount: delivery.TriggerCount,
		OccurredAt:   delivery.OccurredAt,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	requestCtx, cancel := context.WithTimeout(ctx, WebhookTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, channel.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "xcloud-nf-notify/1.0")
	request.Header.Set("Idempotency-Key", delivery.DeliveryKey)
	if channel.Secret != "" {
		request.Header.Set("X-Notification-Signature", "sha256="+signBody(channel.Secret, body))
	}

	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	// Drain a bounded amount so the connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))

	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	return fmt.Errorf("webhook returned HTTP %d", response.StatusCode)
}

func signBody(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
