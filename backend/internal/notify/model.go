// Package notify implements out-of-band alert notification: channels,
// escalation rules and the delivery ledger.
//
// Boundaries that are not negotiable:
//
//   - The alert evaluation chain never performs network egress. Alert writes
//     only enqueue a delivery intent; a background worker is the single thing
//     that talks to an external webhook.
//   - Channel secrets are write-only: they are stored so the worker can sign
//     requests, but no read endpoint ever returns them.
//   - Every delivery carries an idempotency key and retries with exponential
//     backoff before it dead-letters, so a slow channel can never wedge the
//     alert pipeline.
package notify

import "time"

// Channel kinds. Only webhook is implemented; the token keeps the wire
// contract open for a future capability without a schema change.
const (
	ChannelKindWebhook = "webhook"
)

// Delivery states. A dead delivery is terminal; pending/failed are retryable.
const (
	DeliveryPending = "pending"
	DeliverySending = "sending"
	DeliverySent    = "sent"
	DeliverySkipped = "skipped"
	DeliveryFailed  = "failed"
	DeliveryDead    = "dead"
)

// DeliveryEventEscalate is the worker-scheduled follow-up: the alert stayed
// open past the configured escalation delay.
const DeliveryEventEscalate = "escalate"

// Delivery bounds and timing.
const (
	MaxDeliveryAttempts    = 5
	DeliveryBaseBackoff    = 15 * time.Second
	DeliveryMaxBackoff     = 5 * time.Minute
	WebhookTimeout         = 10 * time.Second
	WorkerPollInterval     = 2 * time.Second
	WorkerBatchSize        = 16
	MaxChannels            = 64
	MaxEscalations         = 64
	MaxDeliveryNameBytes   = 128
	MaxDeliverySecretBytes = 4096
)

// NotificationChannel is one outbound webhook destination.
type NotificationChannel struct {
	ID      string `json:"id" bson:"_id"`
	Name    string `json:"name" bson:"name"`
	Kind    string `json:"kind" bson:"kind"`
	Enabled bool   `json:"enabled" bson:"enabled"`
	URL     string `json:"url" bson:"url"`
	// Secret signs outbound requests and is never serialized to a client.
	Secret    string `json:"-" bson:"secret,omitempty"`
	Revision  int64  `json:"revision" bson:"revision"`
	CreatedAt string `json:"createdAt" bson:"createdAt"`
	UpdatedAt string `json:"updatedAt" bson:"updatedAt"`
}

// CreateChannelRequest is the body for POST /api/nf-notifications/channels.
type CreateChannelRequest struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	URL     string `json:"url"`
	Secret  string `json:"secret"`
	Enabled *bool  `json:"enabled,omitempty"`
}

// UpdateChannelRequest is the body for PUT /api/nf-notifications/channels/{id}.
// An empty secret keeps the stored one; a non-empty secret rotates it.
type UpdateChannelRequest struct {
	ExpectedRevision int64          `json:"expectedRevision"`
	Channel          ChannelMutable `json:"channel"`
}

// ChannelMutable is the operator-mutable projection of a channel.
type ChannelMutable struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Secret  string `json:"secret"`
	Enabled bool   `json:"enabled"`
}

// Escalation maps alert severities (and optionally one or more rules) onto
// channels, with an optional delayed escalation to a second channel set.
type Escalation struct {
	ID                   string   `json:"id" bson:"_id"`
	Name                 string   `json:"name" bson:"name"`
	Enabled              bool     `json:"enabled" bson:"enabled"`
	Severities           []string `json:"severities" bson:"severities"`
	RuleIDs              []string `json:"ruleIds,omitempty" bson:"ruleIds,omitempty"`
	ChannelIDs           []string `json:"channelIds" bson:"channelIds"`
	EscalateAfterSeconds int      `json:"escalateAfterSeconds" bson:"escalateAfterSeconds"`
	EscalateChannelIDs   []string `json:"escalateChannelIds,omitempty" bson:"escalateChannelIds,omitempty"`
	Revision             int64    `json:"revision" bson:"revision"`
	CreatedAt            string   `json:"createdAt" bson:"createdAt"`
	UpdatedAt            string   `json:"updatedAt" bson:"updatedAt"`
}

// CreateEscalationRequest is the body for POST /api/nf-notifications/escalations.
type CreateEscalationRequest struct {
	Name                 string   `json:"name"`
	Enabled              *bool    `json:"enabled,omitempty"`
	Severities           []string `json:"severities"`
	RuleIDs              []string `json:"ruleIds,omitempty"`
	ChannelIDs           []string `json:"channelIds"`
	EscalateAfterSeconds int      `json:"escalateAfterSeconds"`
	EscalateChannelIDs   []string `json:"escalateChannelIds,omitempty"`
}

// UpdateEscalationRequest is the body for PUT /api/nf-notifications/escalations/{id}.
type UpdateEscalationRequest struct {
	ExpectedRevision int64             `json:"expectedRevision"`
	Escalation       EscalationMutable `json:"escalation"`
}

// EscalationMutable is the operator-mutable projection of an escalation rule.
type EscalationMutable struct {
	Name                 string   `json:"name"`
	Enabled              bool     `json:"enabled"`
	Severities           []string `json:"severities"`
	RuleIDs              []string `json:"ruleIds"`
	ChannelIDs           []string `json:"channelIds"`
	EscalateAfterSeconds int      `json:"escalateAfterSeconds"`
	EscalateChannelIDs   []string `json:"escalateChannelIds"`
}

// Delivery is one outbox record: one alert transition, one channel.
type Delivery struct {
	ID            string    `json:"id" bson:"_id"`
	DeliveryKey   string    `json:"deliveryKey" bson:"deliveryKey"`
	Event         string    `json:"event" bson:"event"`
	AlertID       string    `json:"alertId" bson:"alertId"`
	RuleID        string    `json:"ruleId" bson:"ruleId"`
	RuleName      string    `json:"ruleName" bson:"ruleName"`
	TargetID      string    `json:"targetId" bson:"targetId"`
	TargetName    string    `json:"targetName" bson:"targetName"`
	Severity      string    `json:"severity" bson:"severity"`
	TriggerCount  int       `json:"triggerCount" bson:"triggerCount"`
	OccurredAt    string    `json:"occurredAt" bson:"occurredAt"`
	ChannelID     string    `json:"channelId" bson:"channelId"`
	Status        string    `json:"status" bson:"status"`
	Attempts      int       `json:"attempts" bson:"attempts"`
	NotBefore     time.Time `json:"notBefore" bson:"notBefore"`
	NextAttemptAt time.Time `json:"nextAttemptAt" bson:"nextAttemptAt"`
	LastError     string    `json:"lastError,omitempty" bson:"lastError,omitempty"`
	CreatedAt     string    `json:"createdAt" bson:"createdAt"`
	CompletedAt   string    `json:"completedAt,omitempty" bson:"completedAt,omitempty"`
}

// DeliveryListFilter filters the delivery ledger listing.
type DeliveryListFilter struct {
	AlertID string
	Status  string
	Limit   int
	Cursor  string
}

// PageInfo mirrors the shared pagination envelope.
type PageInfo struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}
