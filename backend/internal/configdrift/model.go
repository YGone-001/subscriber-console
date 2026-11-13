// Package configdrift evaluates published configuration evidence against a
// fixed baseline cycle. It never collects or modifies network configuration.
package configdrift

import (
	"context"
	"errors"
	"subscriber/internal/configsnapshots"
	"time"
)

var ErrNotFound = errors.New("configuration drift record not found")
var ErrConflict = errors.New("configuration drift revision conflict")

type Failure struct {
	Status        int
	Code, Message string
}

func (e *Failure) Error() string                  { return e.Message }
func fail(status int, code, message string) error { return &Failure{status, code, message} }

type Evidence struct {
	ObservationID string    `json:"observationId" bson:"observationId"`
	SnapshotID    string    `json:"snapshotId" bson:"snapshotId"`
	Comparison    string    `json:"comparison" bson:"comparison"`
	At            time.Time `json:"at" bson:"at"`
	Sequence      int64     `json:"sequence" bson:"sequence"`
}
type Alert struct {
	ExpiredAt        *time.Time `json:"-" bson:"expiredAt,omitempty"`
	ID               string     `json:"driftAlertId" bson:"_id"`
	SourceID         string     `json:"sourceId" bson:"sourceId"`
	SourceName       string     `json:"sourceName" bson:"sourceName"`
	ResourceID       string     `json:"resourceId" bson:"resourceId"`
	Generation       string     `json:"generation" bson:"generation"`
	Profile          string     `json:"profile" bson:"profile"`
	BaselineID       string     `json:"baselineId" bson:"baselineId"`
	BaselineRevision int64      `json:"baselineRevision" bson:"baselineRevision"`
	PolicyRevision   int64      `json:"policyRevision" bson:"policyRevision"`
	Severity         string     `json:"severity" bson:"severity"`
	State            string     `json:"state" bson:"state"`
	EndReason        string     `json:"endReason" bson:"endReason"`
	Revision         int64      `json:"revision" bson:"revision"`
	TriggerCount     int        `json:"triggerCount" bson:"triggerCount"`
	OpenedAt         time.Time  `json:"openedAt" bson:"openedAt"`
	ResolvedAt       *time.Time `json:"resolvedAt" bson:"resolvedAt"`
	AcknowledgedAt   *time.Time `json:"acknowledgedAt" bson:"acknowledgedAt"`
	AcknowledgedBy   string     `json:"acknowledgedBy" bson:"acknowledgedBy"`
	Trigger          Evidence   `json:"trigger" bson:"trigger"`
	Latest           Evidence   `json:"latest" bson:"latest"`
}
type Event struct {
	ID       string    `json:"eventId" bson:"_id"`
	AlertID  string    `json:"driftAlertId" bson:"alertId"`
	SourceID string    `json:"sourceId" bson:"sourceId"`
	Kind     string    `json:"kind" bson:"kind"`
	Reason   string    `json:"reason" bson:"reason"`
	At       time.Time `json:"at" bson:"at"`
	Actor    string    `json:"actor" bson:"actor"`
	Evidence Evidence  `json:"evidence" bson:"evidence"`
}
type Evaluation struct {
	State             string    `json:"state" bson:"state"`
	Reason            string    `json:"reason" bson:"reason"`
	ProcessedSequence int64     `json:"processedSequence" bson:"processedSequence"`
	EvaluatedAt       time.Time `json:"evaluatedAt" bson:"evaluatedAt"`
	LastVerified      *Evidence `json:"lastVerified" bson:"lastVerified"`
}
type Mutation struct {
	ID     string `bson:"id"`
	Alert  Alert  `bson:"alert"`
	Event  Event  `bson:"event"`
	Notify bool   `bson:"notify"`
}

// State and Pending commit together. Materialized alerts, events and notification
// intents are replayable projections; a failed projection prevents queue removal.
type State struct {
	SourceID   string                     `bson:"_id"`
	Version    int64                      `bson:"version"`
	Sequence   int64                      `bson:"sequence"`
	Input      configsnapshots.DriftInput `bson:"input"`
	Evaluation Evaluation                 `bson:"evaluation"`
	Current    *Alert                     `bson:"current"`
	Pending    *Mutation                  `bson:"pending"`
}
type ListQuery struct {
	State, Severity, SourceID, ResourceID, Cursor string
	Limit                                         int
	ResourceIDs                                   []string
	Scope                                         string
}
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}
type ListView struct {
	Page[Alert]
	Summary      map[string]int `json:"summary"`
	Completeness string         `json:"completeness"`
}
type AckRequest struct {
	ExpectedRevision int64 `json:"expectedRevision"`
}
type Store interface {
	State(context.Context, string) (*State, error)
	Save(context.Context, *State, int64) error
	Materialize(context.Context, *Mutation) error
	Alert(context.Context, string) (*Alert, error)
	List(context.Context, ListQuery) (*ListView, error)
	Events(context.Context, string, string, int) (*Page[Event], error)
}
type NoticeSink interface {
	NotifyConfigDrift(context.Context, Alert, string) error
}
