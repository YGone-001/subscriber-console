package discovery

import "time"

// SchemaVersion defines the authoritative schema version for discovery documents.
const SchemaVersion = 1

// Adapter types supported by the vendor-neutral discovery boundary.
const (
	AdapterNRF = "nrf"
)

// Transport modes supported for NRF SBI access.
const (
	TransportH2C   = "h2c"
	TransportH2TLS = "h2_tls"
)

// Discovery run status values.
const (
	RunStatusRunning = "running"
	RunStatusSuccess = "success"
	RunStatusPartial = "partial"
	RunStatusFailed  = "failed"
)

// Observation state values. Observation state is deliberately distinct from
// NRF registry status and from any future operational health signal.
const (
	ObservationSeen    = "seen"
	ObservationMissing = "missing"
	ObservationStale   = "stale"
)

// Canonical adapter types and transport modes exposed by GET /api/discovery/meta.
var CanonicalAdapterTypes = []string{AdapterNRF}
var CanonicalTransportModes = []string{TransportH2C, TransportH2TLS}
var CanonicalRunStatuses = []string{RunStatusRunning, RunStatusSuccess, RunStatusPartial, RunStatusFailed}
var CanonicalObservationStates = []string{ObservationSeen, ObservationMissing, ObservationStale}

// Execution bounds for operator-triggered discovery scans.
const (
	MinScanIntervalSeconds = 60
	MaxGlobalLiveScans     = 1
	MaxPerSourceLiveScans  = 1
	RequestTimeoutSeconds  = 5
	TotalScanDeadlineSec   = 20
	MaxNFProfiles          = 256
	MaxNFServicesPerInst   = 64
	MaxLinkTraversal       = 256
	MaxResponseBytes       = 2 << 20 // 2 MiB bounded response body
)

// Pagination defaults shared with Inventory/Topology list contracts.
const (
	DefaultPageLimit = 50
	MaxPageLimit     = 200
)

// ObservedEndpoint is a normalized SBI endpoint observed on an NF profile.
type ObservedEndpoint struct {
	ServiceName string `json:"serviceName,omitempty" bson:"serviceName,omitempty"`
	Scheme      string `json:"scheme,omitempty" bson:"scheme,omitempty"`
	AddressType string `json:"addressType,omitempty" bson:"addressType,omitempty"`
	Address     string `json:"address,omitempty" bson:"address,omitempty"`
	Port        int    `json:"port,omitempty" bson:"port,omitempty"`
}

// ObservedService is a normalized NF service entry observed on an NF profile.
type ObservedService struct {
	ServiceName string             `json:"serviceName" bson:"serviceName"`
	Status      string             `json:"status,omitempty" bson:"status,omitempty"`
	APIVersions []string           `json:"apiVersions,omitempty" bson:"apiVersions,omitempty"`
	Endpoints   []ObservedEndpoint `json:"endpoints,omitempty" bson:"endpoints,omitempty"`
}

// DiscoverySource is a server-authorized discovery endpoint configuration.
type DiscoverySource struct {
	SourceID      string `json:"sourceId" bson:"_id"`
	SchemaVersion int    `json:"schemaVersion" bson:"schemaVersion"`
	Name          string `json:"name" bson:"name"`
	AdapterType   string `json:"adapterType" bson:"adapterType"`
	BaseURL       string `json:"baseUrl" bson:"baseUrl"`
	Enabled       bool   `json:"enabled" bson:"enabled"`
	TransportMode string `json:"transportMode" bson:"transportMode"`
	Revision      int64  `json:"revision" bson:"revision"`
	CreatedAt     string `json:"createdAt" bson:"createdAt"`
	CreatedBy     string `json:"createdBy" bson:"createdBy"`
	UpdatedAt     string `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy     string `json:"updatedBy" bson:"updatedBy"`
	LastSuccessAt string `json:"lastSuccessAt,omitempty" bson:"lastSuccessAt,omitempty"`
	LastScanAt    string `json:"lastScanAt,omitempty" bson:"lastScanAt,omitempty"`
	LastError     string `json:"lastError,omitempty" bson:"lastError,omitempty"`
}

// CreateSourceRequest defines the body for POST /api/discovery/sources.
type CreateSourceRequest struct {
	Name          string `json:"name"`
	AdapterType   string `json:"adapterType"`
	BaseURL       string `json:"baseUrl"`
	TransportMode string `json:"transportMode"`
	Enabled       *bool  `json:"enabled,omitempty"`
}

// UpdateSourceRequest defines the body for PUT /api/discovery/sources/{sourceId}.
type UpdateSourceRequest struct {
	ExpectedRevision int64         `json:"expectedRevision"`
	Source           MutableSource `json:"source"`
}

// MutableSource is the operator-mutable projection of a discovery source.
type MutableSource struct {
	Name          string `json:"name"`
	BaseURL       string `json:"baseUrl"`
	TransportMode string `json:"transportMode"`
	Enabled       bool   `json:"enabled"`
}

// DiscoveryRun records one bounded operator-triggered discovery execution.
type DiscoveryRun struct {
	RunID           string `json:"runId" bson:"_id"`
	SchemaVersion   int    `json:"schemaVersion" bson:"schemaVersion"`
	SourceID        string `json:"sourceId" bson:"sourceId"`
	StartedAt       string `json:"startedAt" bson:"startedAt"`
	CompletedAt     string `json:"completedAt,omitempty" bson:"completedAt,omitempty"`
	Status          string `json:"status" bson:"status"`
	DiscoveredCount int    `json:"discoveredCount" bson:"discoveredCount"`
	CreatedCount    int    `json:"createdCount" bson:"createdCount"`
	UpdatedCount    int    `json:"updatedCount" bson:"updatedCount"`
	UnchangedCount  int    `json:"unchangedCount" bson:"unchangedCount"`
	MissingCount    int    `json:"missingCount" bson:"missingCount"`
	ErrorCode       string `json:"errorCode,omitempty" bson:"errorCode,omitempty"`
	ErrorSummary    string `json:"errorSummary,omitempty" bson:"errorSummary,omitempty"`
	InitiatedBy     string `json:"initiatedBy" bson:"initiatedBy"`
}

// NFObservation is a normalized observed NF candidate. It is not an
// authoritative Inventory resource and never carries operational health.
type NFObservation struct {
	CandidateID          string             `json:"candidateId" bson:"_id"`
	SchemaVersion        int                `json:"schemaVersion" bson:"schemaVersion"`
	SourceID             string             `json:"sourceId" bson:"sourceId"`
	AdapterType          string             `json:"adapterType" bson:"adapterType"`
	ExternalNfInstanceID string             `json:"externalNfInstanceId" bson:"externalNfInstanceId"`
	NfType               string             `json:"nfType" bson:"nfType"`
	NfStatus             string             `json:"nfStatus" bson:"nfStatus"`
	Fqdn                 string             `json:"fqdn,omitempty" bson:"fqdn,omitempty"`
	IPv4Addresses        []string           `json:"ipv4Addresses,omitempty" bson:"ipv4Addresses,omitempty"`
	IPv6Addresses        []string           `json:"ipv6Addresses,omitempty" bson:"ipv6Addresses,omitempty"`
	ObservedEndpoints    []ObservedEndpoint `json:"observedEndpoints" bson:"observedEndpoints"`
	ObservedServices     []ObservedService  `json:"observedServices" bson:"observedServices"`
	HeartBeatTimer       int                `json:"heartBeatTimer,omitempty" bson:"heartBeatTimer,omitempty"`
	PlmnList             []PlmnID           `json:"plmnList,omitempty" bson:"plmnList,omitempty"`
	SNssaiList           []SNssai           `json:"sNssaiList,omitempty" bson:"sNssaiList,omitempty"`
	FirstSeenAt          string             `json:"firstSeenAt" bson:"firstSeenAt"`
	LastSeenAt           string             `json:"lastSeenAt" bson:"lastSeenAt"`
	ObservationState     string             `json:"observationState" bson:"observationState"`
	LinkedResourceID     *string            `json:"linkedResourceId" bson:"linkedResourceId"`
	Revision             int64              `json:"revision" bson:"revision"`
}

// PlmnID is a normalized PLMN identifier.
type PlmnID struct {
	MCC string `json:"mcc" bson:"mcc"`
	MNC string `json:"mnc" bson:"mnc"`
}

// SNssai is a normalized S-NSSAI value.
type SNssai struct {
	SST int    `json:"sst" bson:"sst"`
	SD  string `json:"sd,omitempty" bson:"sd,omitempty"`
}

// LinkCandidateRequest defines the body for POST .../candidates/{candidateId}/link.
type LinkCandidateRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	ResourceID       string `json:"resourceId"`
}

// UnlinkCandidateRequest defines the body for POST .../candidates/{candidateId}/unlink.
type UnlinkCandidateRequest struct {
	ExpectedRevision int64 `json:"expectedRevision"`
}

// PageInfo mirrors the Inventory/Topology pagination envelope.
type PageInfo struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}

// MetaResponse is the payload for GET /api/discovery/meta.
type MetaResponse struct {
	SchemaVersion            int      `json:"schemaVersion"`
	AdapterTypes             []string `json:"adapterTypes"`
	TransportModes           []string `json:"transportModes"`
	RunStatuses              []string `json:"runStatuses"`
	ObservedStates           []string `json:"observationStates"`
	MinScanIntervalSeconds   int      `json:"minScanIntervalSeconds"`
	RequestTimeoutSeconds    int      `json:"requestTimeoutSeconds"`
	TotalScanDeadlineSeconds int      `json:"totalScanDeadlineSeconds"`
	MaxNFProfiles            int      `json:"maxNfProfiles"`
}

// ListSourcesResponse is the payload for GET /api/discovery/sources.
type ListSourcesResponse struct {
	Sources []DiscoverySource `json:"sources"`
	Page    PageInfo          `json:"page"`
}

// ListRunsResponse is the payload for GET /api/discovery/runs.
type ListRunsResponse struct {
	Runs []DiscoveryRun `json:"runs"`
	Page PageInfo       `json:"page"`
}

// ListCandidatesResponse is the payload for GET /api/discovery/candidates.
type ListCandidatesResponse struct {
	Candidates []NFObservation `json:"candidates"`
	Page       PageInfo        `json:"page"`
}

// ScanResult is returned by POST /api/discovery/sources/{sourceId}/scan.
type ScanResult struct {
	Run DiscoveryRun `json:"run"`
}

// CurrentTimestamp returns an RFC3339 formatted UTC timestamp.
func CurrentTimestamp() string {
	return time.Now().UTC().Format(time.RFC3339)
}
