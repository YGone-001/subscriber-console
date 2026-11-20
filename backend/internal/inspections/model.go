// Package inspections owns scheduled reports over already-persisted evidence.
package inspections

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"subscriber/internal/operationsview"
)

const (
	Version            = 1
	MaxPlans           = 100
	MaxResources       = 200
	MaxAgents          = 100
	MaxSources         = 128
	MaxItems           = 2000
	MaxRunBytes        = 2 << 20
	StorageBudgetBytes = 1 << 30
	MaxRetainedRuns    = StorageBudgetBytes / MaxRunBytes
	MaxQueued          = 20
	RetentionDays      = 90
)

var ErrNotFound = errors.New("inspection not found")
var ErrConflict = errors.New("inspection revision or request conflict")
var idPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var CheckKinds = []string{"monitoring", "configuration", "drift", "alerts", "agents"}

type Failure struct {
	Status        int
	Code, Message string
}

func (e *Failure) Error() string                  { return e.Message }
func fail(status int, code, message string) error { return &Failure{status, code, message} }
func validID(id string) bool                      { return idPattern.MatchString(id) }
func digest(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func uuidBytes(b []byte) string {
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b[:16])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:32])
}
func newID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic("secure inspection identity unavailable")
	}
	return uuidBytes(b)
}
func stableID(key string) string { b := sha256.Sum256([]byte(key)); return uuidBytes(b[:]) }

type ScopeSelector struct {
	Mode        string                     `json:"mode" bson:"mode"`
	Filter      operationsview.GroupFilter `json:"filter" bson:"filter"`
	ResourceIDs []string                   `json:"resourceIds" bson:"resourceIds"`
}
type Schedule struct {
	Kind            string `json:"kind" bson:"kind"`
	IntervalSeconds int    `json:"intervalSeconds" bson:"intervalSeconds"`
	Timezone        string `json:"timezone" bson:"timezone"`
	Time            string `json:"time" bson:"time"`
	Weekday         int    `json:"weekday" bson:"weekday"`
}
type Definition struct {
	Name                string        `json:"name" bson:"name"`
	Description         string        `json:"description" bson:"description"`
	Scope               ScopeSelector `json:"scope" bson:"scope"`
	Checks              []string      `json:"checks" bson:"checks"`
	ConfigMaxAgeSeconds int           `json:"configMaxAgeSeconds" bson:"configMaxAgeSeconds"`
	Schedule            Schedule      `json:"schedule" bson:"schedule"`
}
type Plan struct {
	ID               string `json:"planId" bson:"_id"`
	Definition       `bson:",inline"`
	Revision         int64      `json:"revision" bson:"revision"`
	ScheduleRevision int64      `json:"scheduleRevision" bson:"scheduleRevision"`
	Enabled          bool       `json:"enabled" bson:"enabled"`
	Archived         bool       `json:"archived" bson:"archived"`
	AuthorizedBy     string     `json:"authorizedBy" bson:"authorizedBy"`
	CreatedAt        time.Time  `json:"createdAt" bson:"createdAt"`
	UpdatedAt        time.Time  `json:"updatedAt" bson:"updatedAt"`
	NextAt           *time.Time `json:"nextAt" bson:"nextAt,omitempty"`
	ActiveRunID      string     `json:"activeRunId" bson:"activeRunId"`
	LastRunID        string     `json:"lastRunId" bson:"lastRunId"`
	ScheduleReason   string     `json:"scheduleReason" bson:"scheduleReason"`
	RequestKey       string     `json:"-" bson:"requestKey"`
	RequestDigest    string     `json:"-" bson:"requestDigest"`
	Pending          *Run       `json:"-" bson:"pending,omitempty"`
}
type CreateRequest struct {
	Definition `bson:",inline"`
	RequestID  string `json:"requestId"`
}
type UpdateRequest struct {
	Definition       `bson:",inline"`
	ExpectedRevision int64 `json:"expectedRevision"`
	Enabled          bool  `json:"enabled"`
	Archived         bool  `json:"archived"`
}
type RunRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	RequestID        string `json:"requestId"`
}
type ResourceFact struct {
	ID     string `json:"resourceId" bson:"resourceId"`
	Name   string `json:"name" bson:"name"`
	Kind   string `json:"kind" bson:"kind"`
	Domain string `json:"domain" bson:"domain"`
}
type Coverage struct {
	State  string    `json:"state" bson:"state"`
	Reason string    `json:"reason" bson:"reason"`
	ReadAt time.Time `json:"readAt" bson:"readAt"`
	Count  int       `json:"count" bson:"count"`
	Limit  int       `json:"limit" bson:"limit"`
}
type ResolvedScope struct {
	Resources        []ResourceFact `json:"resources" bson:"resources"`
	AgentIDs         []string       `json:"agentIds" bson:"agentIds"`
	Agents           []AgentFact    `json:"agents" bson:"agents"`
	Fingerprint      string         `json:"fingerprint" bson:"fingerprint"`
	MembershipDigest string         `json:"membershipDigest" bson:"membershipDigest"`
	Coverage         Coverage       `json:"coverage" bson:"coverage"`
	AgentCoverage    Coverage       `json:"agentCoverage" bson:"agentCoverage"`
}
type AgentFact struct {
	ID       string `json:"agentId" bson:"agentId"`
	Name     string `json:"name" bson:"name"`
	Revision int64  `json:"revision" bson:"revision"`
}
type Item struct {
	Key           string            `json:"key" bson:"key"`
	Kind          string            `json:"kind" bson:"kind"`
	SubjectID     string            `json:"subjectId" bson:"subjectId"`
	ResourceID    string            `json:"resourceId" bson:"resourceId"`
	Name          string            `json:"name" bson:"name"`
	Result        string            `json:"result" bson:"result"`
	Severity      string            `json:"severity" bson:"severity"`
	Reason        string            `json:"reason" bson:"reason"`
	ReadAt        time.Time         `json:"readAt" bson:"readAt"`
	EvidenceAt    *time.Time        `json:"evidenceAt" bson:"evidenceAt,omitempty"`
	AgeSeconds    *int64            `json:"ageSeconds" bson:"ageSeconds,omitempty"`
	MaxAgeSeconds int               `json:"maxAgeSeconds" bson:"maxAgeSeconds"`
	EvidenceID    string            `json:"evidenceId" bson:"evidenceId"`
	Compatibility string            `json:"compatibility" bson:"compatibility"`
	Layers        map[string]string `json:"layers,omitempty" bson:"layers,omitempty"`
	Count         *int              `json:"count" bson:"count,omitempty"`
	Link          string            `json:"link" bson:"link"`
	Change        string            `json:"change,omitempty" bson:"change,omitempty"`
}
type Comparison struct {
	PreviousRunID string        `json:"previousRunId" bson:"previousRunId"`
	State         string        `json:"state" bson:"state"`
	Added         int           `json:"added" bson:"added"`
	Removed       int           `json:"removed" bson:"removed"`
	NewFindings   int           `json:"newFindings" bson:"newFindings"`
	NotRedetected int           `json:"notRedetected" bson:"notRedetected"`
	Incomparable  int           `json:"incomparable" bson:"incomparable"`
	ScopeChanges  *ScopeChanges `json:"scopeChanges,omitempty" bson:"scopeChanges,omitempty"`
}

// ScopeChanges preserves membership differences using captured report identities.
// Omission on older reports means unavailable, rather than an empty difference.
type ScopeChanges struct {
	AddedResources   []ResourceFact `json:"addedResources" bson:"addedResources"`
	RemovedResources []ResourceFact `json:"removedResources" bson:"removedResources"`
	AddedAgents      []AgentFact    `json:"addedAgents" bson:"addedAgents"`
	RemovedAgents    []AgentFact    `json:"removedAgents" bson:"removedAgents"`
}
type Run struct {
	ID            string              `json:"runId" bson:"_id"`
	PlanID        string              `json:"planId" bson:"planId"`
	PlanRevision  int64               `json:"planRevision" bson:"planRevision"`
	Definition    Definition          `json:"definition" bson:"definition"`
	Version       int                 `json:"version" bson:"version"`
	Mode          string              `json:"mode" bson:"mode"`
	Actor         string              `json:"actor" bson:"actor"`
	State         string              `json:"state" bson:"state"`
	Reason        string              `json:"reason" bson:"reason"`
	Conclusion    string              `json:"conclusion" bson:"conclusion"`
	QueuedAt      time.Time           `json:"queuedAt" bson:"queuedAt"`
	ScheduledFor  *time.Time          `json:"scheduledFor" bson:"scheduledFor,omitempty"`
	MissedUntil   *time.Time          `json:"missedUntil" bson:"missedUntil,omitempty"`
	MissedCount   int                 `json:"missedCount" bson:"missedCount"`
	StartedAt     *time.Time          `json:"startedAt" bson:"startedAt,omitempty"`
	FinishedAt    *time.Time          `json:"finishedAt" bson:"finishedAt,omitempty"`
	Scope         ResolvedScope       `json:"scope" bson:"scope"`
	Coverage      map[string]Coverage `json:"coverage" bson:"coverage"`
	Counts        map[string]int      `json:"counts" bson:"counts"`
	Items         []Item              `json:"items,omitempty" bson:"items"`
	Comparison    Comparison          `json:"comparison" bson:"comparison"`
	OccurrenceKey string              `json:"-" bson:"occurrenceKey,omitempty"`
	RequestKey    string              `json:"-" bson:"requestKey,omitempty"`
	RequestDigest string              `json:"-" bson:"requestDigest,omitempty"`
	LeaseToken    string              `json:"-" bson:"leaseToken"`
	LeaseUntil    time.Time           `json:"-" bson:"leaseUntil"`
	ExpiresAt     *time.Time          `json:"-" bson:"expiresAt,omitempty"`
}
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}
type Query struct {
	Q, PlanID, State, Conclusion, Kind, Result, Cursor string
	Limit                                              int
	Archived                                           bool
	Scope                                              operationsview.GroupFilter
	AfterAt                                            time.Time
}
type Preview struct {
	Definition  Definition    `json:"definition"`
	Scope       ResolvedScope `json:"scope"`
	Next        []time.Time   `json:"next"`
	GeneratedAt time.Time     `json:"generatedAt"`
}
type Evidence interface {
	Resolve(context.Context, ScopeSelector) (ResolvedScope, error)
	Evaluate(context.Context, Definition, ResolvedScope) ([]Item, map[string]Coverage)
}
type Store interface {
	Plans(context.Context) ([]Plan, error)
	ListPlans(context.Context, Query) ([]Plan, bool, error)
	Plan(context.Context, string) (*Plan, error)
	Create(context.Context, *Plan) (*Plan, error)
	Update(context.Context, *Plan, int64) error
	Admit(context.Context, *Plan, *Run, *time.Time) error
	Reconcile(context.Context, *Plan) error
	Run(context.Context, string) (*Run, error)
	Runs(context.Context, Query) ([]Run, bool, error)
	Claim(context.Context, string, time.Time) (*Run, error)
	Finish(context.Context, *Run, string, time.Time) error
	Release(context.Context, *Plan, string) error
	Recover(context.Context, time.Time) error
	Capacity(context.Context) (int, int, error)
	Previous(context.Context, *Run) (*Run, error)
	Record(context.Context, *Run) error
	ScheduleNext(context.Context, *Plan, *time.Time, string) error
}
