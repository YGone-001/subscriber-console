// Package agents owns collector identities and bounded, read-only node reports.
// Inventory remains the resource authority. Network keys are grouping metadata,
// not tenant boundaries, PLMN identities or roaming relationships.
package agents

import (
	"context"
	"errors"
	"time"
)

const (
	ProtocolVersion       = 1
	ReportIntervalSeconds = 15
	StaleAfterSeconds     = 45
	OfflineAfterSeconds   = 120
	MaxBodyBytes          = 128 * 1024
	MaxPageSize           = 100
)

var (
	ErrNotFound     = errors.New("agent not found")
	ErrConflict     = errors.New("agent revision conflict")
	ErrUnauthorized = errors.New("agent credential is invalid")
	ErrSession      = errors.New("agent session is invalid")
	ErrSequence     = errors.New("agent report sequence conflict")
)

type Scope struct {
	NetworkKey     string   `json:"networkKey" bson:"networkKey"`
	OperatorName   string   `json:"operatorName" bson:"operatorName"`
	SiteResourceID string   `json:"siteResourceId" bson:"siteResourceId"`
	HostResourceID string   `json:"hostResourceId" bson:"hostResourceId"`
	PLMNs          []string `json:"plmns" bson:"plmns"`
}

type Metadata struct {
	Name  string `json:"name" bson:"name"`
	Scope Scope  `json:"scope" bson:"scope"`
}

type Metrics struct {
	CPUPercent           *float64 `json:"cpuPercent" bson:"cpuPercent"`
	MemoryTotalBytes     *int64   `json:"memoryTotalBytes" bson:"memoryTotalBytes"`
	MemoryAvailableBytes *int64   `json:"memoryAvailableBytes" bson:"memoryAvailableBytes"`
	DiskTotalBytes       *int64   `json:"diskTotalBytes" bson:"diskTotalBytes"`
	DiskAvailableBytes   *int64   `json:"diskAvailableBytes" bson:"diskAvailableBytes"`
	UptimeSeconds        *float64 `json:"uptimeSeconds" bson:"uptimeSeconds"`
}

type Component struct {
	ComponentID    string   `json:"componentId" bson:"componentId"`
	RuntimeStatus  string   `json:"runtimeStatus" bson:"runtimeStatus"`
	Verified       bool     `json:"verified" bson:"verified"`
	PrimaryPID     int      `json:"primaryPid" bson:"primaryPid"`
	WorkerCount    int      `json:"workerCount" bson:"workerCount"`
	CPUPercent     *float64 `json:"cpuPercent" bson:"cpuPercent"`
	MemoryRSSBytes *int64   `json:"memoryRssBytes" bson:"memoryRssBytes"`
}

type Observation struct {
	CollectedAt  string      `json:"collectedAt" bson:"collectedAt"`
	HostName     string      `json:"hostName" bson:"hostName"`
	Platform     string      `json:"platform" bson:"platform"`
	Version      string      `json:"version" bson:"version"`
	Visibility   string      `json:"visibility" bson:"visibility"`
	ScanComplete bool        `json:"scanComplete" bson:"scanComplete"`
	Metrics      Metrics     `json:"metrics" bson:"metrics"`
	Components   []Component `json:"components" bson:"components"`
}

type Record struct {
	AgentID          string `json:"agentId" bson:"_id"`
	Metadata         `bson:",inline"`
	Enabled          bool         `json:"enabled" bson:"enabled"`
	Revision         int64        `json:"revision" bson:"revision"`
	CreatedAt        time.Time    `json:"createdAt" bson:"createdAt"`
	UpdatedAt        time.Time    `json:"updatedAt" bson:"updatedAt"`
	CreatedBy        string       `json:"createdBy" bson:"createdBy"`
	LastReceivedAt   *time.Time   `json:"lastReceivedAt" bson:"lastReceivedAt"`
	Observation      *Observation `json:"observation" bson:"observation"`
	KeyHash          string       `json:"-" bson:"keyHash"`
	SessionHash      string       `json:"-" bson:"sessionHash"`
	SessionExpiresAt time.Time    `json:"-" bson:"sessionExpiresAt"`
	Sequence         int64        `json:"-" bson:"sequence"`
	ReportHash       string       `json:"-" bson:"reportHash"`
}

type View struct {
	AgentID string `json:"agentId"`
	Metadata
	Enabled           bool         `json:"enabled"`
	Revision          int64        `json:"revision"`
	CreatedAt         time.Time    `json:"createdAt"`
	UpdatedAt         time.Time    `json:"updatedAt"`
	LastReceivedAt    *time.Time   `json:"lastReceivedAt"`
	ConnectionState   string       `json:"connectionState"`
	EvidenceFreshness string       `json:"evidenceFreshness"`
	Observation       *Observation `json:"observation"`
}

type CreateRequest struct{ Metadata }
type UpdateRequest struct {
	Metadata
	ExpectedRevision int64 `json:"expectedRevision"`
	Enabled          *bool `json:"enabled"`
}
type CredentialRequest struct {
	ExpectedRevision int64 `json:"expectedRevision"`
}
type CredentialResponse struct {
	Agent View   `json:"agent"`
	Token string `json:"token"`
}
type SessionRequest struct {
	ProtocolVersion int `json:"protocolVersion"`
}
type SessionResponse struct {
	SessionID       string    `json:"sessionId"`
	ExpiresAt       time.Time `json:"expiresAt"`
	IntervalSeconds int       `json:"intervalSeconds"`
	ProtocolVersion int       `json:"protocolVersion"`
}
type ReportRequest struct {
	ProtocolVersion int         `json:"protocolVersion"`
	SessionID       string      `json:"sessionId"`
	Sequence        int64       `json:"sequence"`
	Observation     Observation `json:"observation"`
}
type Summary struct {
	Total    int64 `json:"total"`
	Online   int64 `json:"online"`
	Stale    int64 `json:"stale"`
	Offline  int64 `json:"offline"`
	Pending  int64 `json:"pending"`
	Disabled int64 `json:"disabled"`
}
type Page struct {
	Records    []Record
	Summary    Summary
	NextCursor *string
	HasMore    bool
}
type ListQuery struct {
	Q, Cursor string
	Limit     int
}
type ListResponse struct {
	Controller          LocalView `json:"controller"`
	Agents              []View    `json:"agents"`
	Summary             *Summary  `json:"summary"`
	Completeness        string    `json:"completeness"`
	NextCursor          *string   `json:"nextCursor"`
	HasMore             bool      `json:"hasMore"`
	ProtocolVersion     int       `json:"protocolVersion"`
	StaleAfterSeconds   int       `json:"staleAfterSeconds"`
	OfflineAfterSeconds int       `json:"offlineAfterSeconds"`
}
type LocalView struct {
	Role              string       `json:"role"`
	Transport         string       `json:"transport"`
	HostName          string       `json:"hostName"`
	HostID            string       `json:"hostId"`
	Observation       *Observation `json:"observation"`
	EvidenceFreshness string       `json:"evidenceFreshness"`
}

type Repository interface {
	Create(context.Context, *Record) error
	Get(context.Context, string) (*Record, error)
	List(context.Context, ListQuery, time.Time) (*Page, error)
	Update(context.Context, string, UpdateRequest, time.Time) (*Record, error)
	Rotate(context.Context, string, int64, string, time.Time) (*Record, error)
	StartSession(context.Context, string, string, string, time.Time, time.Time) error
	Accept(context.Context, string, string, string, int64, string, *Observation, time.Time) (bool, error)
}
