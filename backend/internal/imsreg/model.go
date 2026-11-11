// Package imsreg provides bounded, read-only IMS registration evidence.
package imsreg

import (
	"context"
	"time"

	"subscriber/internal/operationsview"
)

const (
	MaxSources     = 16
	MaxRows        = 10000
	MaxBindings    = 2000
	MaxBody        = 10 << 20
	AdapterVersion = "scscf-mysql-v1"
)

type Connection struct {
	Address     string `json:"address"`
	Database    string `json:"database"`
	User        string `json:"user"`
	PasswordEnv string `json:"passwordEnv"`
	CAFile      string `json:"caFile,omitempty"`
	ServerName  string `json:"serverName,omitempty"`
}
type Source struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	ResourceID  string      `json:"resourceId"`
	Authority   string      `json:"authority"`
	Persistence string      `json:"persistence"`
	SCSCF       Connection  `json:"scscf"`
	HSS         *Connection `json:"hss,omitempty"`
}
type Catalog struct {
	Version int      `json:"version"`
	Sources []Source `json:"sources"`
}
type Binding struct {
	Key       string     `json:"key"`
	URI       string     `json:"uri,omitempty"`
	ExpiresAt *time.Time `json:"expiresAt"`
	State     string     `json:"state"`
}
type Identity struct {
	Key               string    `json:"key"`
	SourceID          string    `json:"sourceId"`
	ResourceID        string    `json:"resourceId"`
	PublicIdentity    string    `json:"publicIdentity"`
	State             string    `json:"state"`
	Bindings          []Binding `json:"bindings"`
	PrivateIdentities []string  `json:"privateIdentities"`
	MSISDNs           []string  `json:"msisdns"`
	IdentityState     string    `json:"identityState"`
	ReadAt            time.Time `json:"readAt"`
}
type SourceStatus struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	ResourceID         string     `json:"resourceId"`
	Authority          string     `json:"authority"`
	Persistence        string     `json:"persistence"`
	Evidence           string     `json:"evidence"`
	State              string     `json:"state"`
	Reason             string     `json:"reason"`
	Completeness       string     `json:"completeness"`
	Freshness          string     `json:"freshness"`
	ReadAt             *time.Time `json:"readAt"`
	SourceAsOf         *time.Time `json:"sourceAsOf"`
	ObservedIdentities int        `json:"observedIdentities"`
	IdentityState      string     `json:"identityState"`
}
type Counts struct {
	PublicIdentities       *int `json:"publicIdentities"`
	ActivePublicIdentities *int `json:"activePublicIdentities"`
	ActiveBindings         *int `json:"activeBindings"`
}
type ObservedCounts struct {
	PublicIdentities       int `json:"publicIdentities"`
	ActivePublicIdentities int `json:"activePublicIdentities"`
	ActiveBindings         int `json:"activeBindings"`
}
type Pagination struct {
	Limit      int     `json:"limit"`
	Total      *int    `json:"total"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}
type Response struct {
	CatalogSources     []SourceLabel             `json:"catalogSources"`
	GeneratedAt        time.Time                 `json:"generatedAt"`
	ConfigurationState string                    `json:"configurationState"`
	Completeness       string                    `json:"completeness"`
	Scope              operationsview.GroupScope `json:"scope"`
	ScopeMeaning       string                    `json:"scopeMeaning"`
	Consistency        string                    `json:"consistency"`
	Counts             Counts                    `json:"counts"`
	Observed           ObservedCounts            `json:"observed"`
	Sources            []SourceStatus            `json:"sources"`
	Items              []Identity                `json:"items"`
	Pagination         Pagination                `json:"pagination"`
}
type SourceLabel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Query struct {
	Filter   operationsview.GroupFilter
	SourceID string
	Search   string
	State    string
	Cursor   string
	Limit    int
	Summary  bool
}
type Observation struct {
	Reason   string
	Items    []Identity
	ReadAt   time.Time
	Complete bool
}
type Reader interface {
	Read(context.Context, Source, int) (Observation, error)
	Enrich(context.Context, Source, []Identity) (string, error)
}
type GroupResolver interface {
	ResolveGroupScope(context.Context, operationsview.GroupFilter) (operationsview.GroupScope, error)
}
type ReadError struct{ Reason string }

func (e *ReadError) Error() string { return e.Reason }
