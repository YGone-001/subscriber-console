// Package configsnapshots owns bounded, read-only configuration observations.
package configsnapshots

import (
	"context"
	"errors"
	"time"
)

const (
	MaxSources         = 128
	MaxRoots           = 16
	MaxFileBytes       = 1 << 20
	MaxProjectionBytes = 256 << 10
	PolicyVersion      = "network-endpoints-v1"
	RetentionDays      = 90
	MaxVersions        = 100
)

var (
	ErrNotFound = errors.New("configuration record not found")
	ErrConflict = errors.New("configuration revision conflict")
	ErrBusy     = errors.New("configuration source is busy")
)

type Failure struct {
	Status        int
	Code, Message string
}

func (e *Failure) Error() string                  { return e.Message }
func fail(status int, code, message string) error { return &Failure{status, code, message} }

type Source struct {
	SourceID        string `json:"sourceId" bson:"_id"`
	Name            string `json:"name" bson:"name"`
	CollectorID     string `json:"collectorId" bson:"collectorId"`
	ResourceID      string `json:"resourceId" bson:"resourceId"`
	Format          string `json:"format" bson:"format"`
	Profile         string `json:"profile" bson:"profile"`
	Generation      string `json:"generation" bson:"generation"`
	IntervalSeconds int    `json:"intervalSeconds" bson:"intervalSeconds"`
	Path            string `json:"-" bson:"-"`
	Root            string `json:"-" bson:"-"`
}

type Manifest struct {
	CollectorID string              `json:"collectorId"`
	Root        string              `json:"root"`
	Roots       []string            `json:"roots,omitempty"`
	Sources     []SourceDeclaration `json:"sources"`
}
type SourceDeclaration struct {
	SourceID        string `json:"sourceId"`
	Name            string `json:"name"`
	ResourceID      string `json:"resourceId,omitempty"`
	Path            string `json:"path"`
	Format          string `json:"format"`
	Profile         string `json:"profile"`
	IntervalSeconds int    `json:"intervalSeconds,omitempty"`
}
type Catalog struct {
	Sources []Source
	Root    string
	State   string
}

type Snapshot struct {
	SnapshotID     string    `json:"snapshotId" bson:"_id"`
	SourceID       string    `json:"sourceId" bson:"sourceId"`
	Generation     string    `json:"generation" bson:"generation"`
	CollectorID    string    `json:"collectorId" bson:"collectorId"`
	ResourceID     string    `json:"resourceId" bson:"resourceId"`
	CollectedAt    time.Time `json:"collectedAt" bson:"collectedAt"`
	Actor          string    `json:"actor" bson:"actor"`
	Mode           string    `json:"mode" bson:"mode"`
	Reason         string    `json:"reason" bson:"reason"`
	Policy         string    `json:"policy" bson:"policy"`
	KeyVersion     string    `json:"-" bson:"keyVersion"`
	Fingerprint    string    `json:"-" bson:"fingerprint"`
	ProjectionHash string    `json:"projectionHash" bson:"projectionHash"`
	Projection     string    `json:"projection" bson:"projection"`
	Size           int64     `json:"size" bson:"size"`
	Published      bool      `json:"-" bson:"published"`
}
type Observation struct {
	ObservationID string    `json:"observationId" bson:"_id"`
	SourceID      string    `json:"sourceId" bson:"sourceId"`
	Generation    string    `json:"generation" bson:"generation"`
	ResourceID    string    `json:"resourceId" bson:"resourceId"`
	CollectedAt   time.Time `json:"collectedAt" bson:"collectedAt"`
	Actor         string    `json:"actor" bson:"actor"`
	Status        string    `json:"status" bson:"status"`
	Reason        string    `json:"reason" bson:"reason"`
	SnapshotID    string    `json:"snapshotId" bson:"snapshotId"`
	Changed       *bool     `json:"changed" bson:"changed"`
	Published     bool      `json:"-" bson:"published"`
}

// Pending is a durable publication journal. Reads never repair or write it.
type Pending struct {
	Observation Observation `bson:"observation"`
	SnapshotID  string      `bson:"snapshotId"`
	NewSnapshot bool        `bson:"newSnapshot"`
}
type State struct {
	Source           Source       `bson:"source"`
	SourceID         string       `bson:"_id"`
	Revision         int64        `bson:"revision"`
	Version          int64        `bson:"version"`
	LatestSnapshotID string       `bson:"latestSnapshotId"`
	LatestEvidence   *Snapshot    `bson:"latestEvidence"`
	BaselineEvidence *Snapshot    `bson:"baselineEvidence"`
	Latest           *Observation `bson:"latest"`
	BaselineID       string       `bson:"baselineId"`
	BaselineBy       string       `bson:"baselineBy"`
	BaselineAt       *time.Time   `bson:"baselineAt"`
	Pending          *Pending     `bson:"pending,omitempty"`
	LeaseToken       string       `bson:"leaseToken"`
	LeaseUntil       time.Time    `bson:"leaseUntil"`
}
type SourceView struct {
	Source
	Registered        bool         `json:"registered"`
	Revision          int64        `json:"revision"`
	CollectionState   string       `json:"collectionState"`
	ResourceState     string       `json:"resourceState"`
	Latest            *Observation `json:"latest"`
	LatestSnapshot    *Snapshot    `json:"latestSnapshot"`
	BaselineID        string       `json:"baselineId"`
	BaselineBy        string       `json:"baselineBy"`
	BaselineAt        *time.Time   `json:"baselineAt"`
	Comparison        string       `json:"comparison"`
	Pending           bool         `json:"pending"`
	NextCollectionAt  *time.Time   `json:"nextCollectionAt"`
	ScheduleState     string       `json:"scheduleState"`
	ScheduleLastError string       `json:"scheduleLastError"`
}
type ListQuery struct {
	Q, Cursor, ResourceID, Status string
	Limit                         int
}
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}
type SourceList struct {
	Page[SourceView]
	Summary      *map[string]int `json:"summary"`
	Completeness string          `json:"completeness"`
	CatalogState string          `json:"catalogState"`
}
type CaptureRequest struct {
	RequestID string `json:"requestId"`
}
type BaselineRequest struct {
	ExpectedRevision int64   `json:"expectedRevision"`
	SnapshotID       *string `json:"snapshotId"`
}
type DiffLine struct {
	Kind  string `json:"kind"`
	Left  *int   `json:"left"`
	Right *int   `json:"right"`
	Text  string `json:"text"`
}
type Diff struct {
	Left       *Snapshot  `json:"left"`
	Right      *Snapshot  `json:"right"`
	Comparison string     `json:"comparison"`
	Complete   bool       `json:"complete"`
	Reason     string     `json:"reason"`
	Lines      []DiffLine `json:"lines"`
}

type Repository interface {
	States(context.Context) ([]State, error)
	GetState(context.Context, string) (*State, error)
	Acquire(context.Context, Source, string, time.Time) (*State, error)
	Save(context.Context, *State) error
	Release(context.Context, string, string) error
	InsertSnapshot(context.Context, *Snapshot) error
	InsertObservation(context.Context, *Observation) error
	Publish(context.Context, *Pending) error
	Snapshot(context.Context, string, string) (*Snapshot, error)
	Observation(context.Context, string, string) (*Observation, error)
	Snapshots(context.Context, string, string, int) ([]Snapshot, error)
	Observations(context.Context, string, string, int) ([]Observation, error)
	Prune(context.Context, *State, time.Time) error
	Usage(context.Context) (int64, int64, error)
}
