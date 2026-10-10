package nfhealth

// SchemaVersion defines the authoritative schema version for health documents.
const SchemaVersion = 1

// Collector profiles supported by the server-owned collector registry.
const (
	CollectorHTTPMetrics = "http_metrics"
)

// Collection modes.
const (
	CollectionManual    = "manual"
	CollectionScheduled = "scheduled"
)

// Run status values.
const (
	RunStatusSuccess = "success"
	RunStatusPartial = "partial"
	RunStatusFailed  = "failed"
)

// Layer health states. States are deliberately distinct: an unsupported layer
// is never reported as healthy or unhealthy.
const (
	StateHealthy       = "healthy"
	StateDegraded      = "degraded"
	StateUnhealthy     = "unhealthy"
	StateUnknown       = "unknown"
	StateNotConfigured = "not_configured"
	StateStale         = "stale"
)

// Evidence kinds record exactly what was measured.
const (
	EvidenceSystemd = "systemd"
	EvidenceProcess = "process"
	EvidenceHTTP    = "http_metrics"
	EvidenceMetric  = "metric_registry"
	EvidenceNone    = "none"
)

// Process / unit inspection outcomes.
const (
	ProcessActive        = "active"
	ProcessInactive      = "inactive"
	ProcessFailed        = "failed"
	ProcessUnitNotFound  = "unit_not_found"
	ProcessPermission    = "permission_denied"
	ProcessNotConfigured = "not_configured"
	ProcessRunning       = "running"
	ProcessNotRunning    = "not_running"
)

// Interface probe outcomes.
const (
	InterfaceValid     = "valid_response"
	InterfaceRefused   = "connection_refused"
	InterfaceTimeout   = "timeout"
	InterfaceInvalid   = "invalid_response"
	InterfaceHTTP4xx   = "http_4xx"
	InterfaceHTTP5xx   = "http_5xx"
	InterfaceError     = "collection_error"
	InterfaceNotConfig = "not_configured"
)

// Service-layer reasons.
const (
	ReasonNoSupportedKPI = "no_supported_service_kpi"
	ReasonMetricMissing  = "metric_not_exported"
	ReasonMetricInvalid  = "metric_invalid"
	ReasonNotConfigured  = "not_configured"
)

// Canonical vocabularies exposed by GET /api/nf-health/meta.
var (
	CanonicalCollectorProfiles = []string{CollectorHTTPMetrics}
	CanonicalCollectionModes   = []string{CollectionManual, CollectionScheduled}
	CanonicalRunStatuses       = []string{RunStatusSuccess, RunStatusPartial, RunStatusFailed}
	CanonicalLayerStates       = []string{StateHealthy, StateDegraded, StateUnhealthy, StateUnknown, StateNotConfigured, StateStale}
	CanonicalEvidenceKinds     = []string{EvidenceSystemd, EvidenceProcess, EvidenceHTTP, EvidenceMetric, EvidenceNone}
	CanonicalProcessOutcomes   = []string{ProcessActive, ProcessInactive, ProcessFailed, ProcessUnitNotFound, ProcessPermission, ProcessNotConfigured, ProcessRunning, ProcessNotRunning}
	CanonicalInterfaceOutcomes = []string{InterfaceValid, InterfaceRefused, InterfaceTimeout, InterfaceInvalid, InterfaceHTTP4xx, InterfaceHTTP5xx, InterfaceError, InterfaceNotConfig}
)

// Execution bounds for collection.
const (
	MinIntervalSeconds     = 60
	MaxIntervalSeconds     = 3600
	DefaultIntervalSeconds = 120
	MaxGlobalConcurrent    = 2
	MaxPerTargetConcurrent = 1
	RequestTimeoutSeconds  = 5
	TotalDeadlineSeconds   = 15
	MaxResponseBytes       = 1 << 20 // 1 MiB bounded metrics body
	MaxMetricSamples       = 64
	MaxMetricNameLen       = 128
	MaxLabelNameLen        = 64
	MaxLabelValueLen       = 128
)

// Pagination defaults shared with Inventory/Topology/Discovery list contracts.
const (
	DefaultPageLimit = 50
	MaxPageLimit     = 200
)

// Default and maximum sample retention, in days.
const (
	DefaultRetentionDays = 7
	MaxRetentionDays     = 30
)

// LayerEvidence records one health layer with explicit provenance.
type LayerEvidence struct {
	State        string `json:"state" bson:"state"`
	EvidenceKind string `json:"evidenceKind" bson:"evidenceKind"`
	Reason       string `json:"reason,omitempty" bson:"reason,omitempty"`
	// HTTP probe fields, present only for interface evidence.
	HTTPStatus *int   `json:"httpStatus,omitempty" bson:"httpStatus,omitempty"`
	ResponseMs *int64 `json:"responseMs,omitempty" bson:"responseMs,omitempty"`
	// Process fields, present only for process evidence.
	ProcessOutcome string `json:"processOutcome,omitempty" bson:"processOutcome,omitempty"`
	MainPID        int    `json:"mainPid,omitempty" bson:"mainPid,omitempty"`
	// Coverage marks the layer as explicitly measured versus unsupported.
	Measured bool `json:"measured" bson:"measured"`
}

// MetricSample is one typed, bounded measurement with provenance.
type MetricSample struct {
	Key            string            `json:"key" bson:"key"`
	Value          float64           `json:"value" bson:"value"`
	Unit           string            `json:"unit" bson:"unit"`
	Type           string            `json:"type" bson:"type"` // counter | gauge
	Source         string            `json:"source" bson:"source"`
	CollectedAt    string            `json:"collectedAt" bson:"collectedAt"`
	Interpretation string            `json:"interpretation,omitempty" bson:"interpretation,omitempty"`
	Labels         map[string]string `json:"labels,omitempty" bson:"labels,omitempty"`
}

// LayerSet is the three-layer observation carried by every sample.
type LayerSet struct {
	Process   LayerEvidence `json:"process" bson:"process"`
	Interface LayerEvidence `json:"interface" bson:"interface"`
	Service   LayerEvidence `json:"service" bson:"service"`
}

// HealthTarget is an operator-authored monitoring configuration. It references
// an existing Discovery candidate and never creates its own NF identity.
type HealthTarget struct {
	TargetID         string `json:"targetId" bson:"_id"`
	SchemaVersion    int    `json:"schemaVersion" bson:"schemaVersion"`
	CandidateID      string `json:"candidateId" bson:"candidateId"`
	Name             string `json:"name" bson:"name"`
	CollectorProfile string `json:"collectorProfile" bson:"collectorProfile"`
	MetricsEndpoint  string `json:"metricsEndpoint,omitempty" bson:"metricsEndpoint,omitempty"`
	ServiceUnit      string `json:"serviceUnit,omitempty" bson:"serviceUnit,omitempty"`
	ServiceKind      string `json:"serviceKind" bson:"serviceKind"`
	CollectionMode   string `json:"collectionMode" bson:"collectionMode"`
	IntervalSeconds  int    `json:"intervalSeconds" bson:"intervalSeconds"`
	Enabled          bool   `json:"enabled" bson:"enabled"`
	Revision         int64  `json:"revision" bson:"revision"`
	CreatedAt        string `json:"createdAt" bson:"createdAt"`
	CreatedBy        string `json:"createdBy" bson:"createdBy"`
	UpdatedAt        string `json:"updatedAt" bson:"updatedAt"`
	UpdatedBy        string `json:"updatedBy" bson:"updatedBy"`
	// Freshness fields. Failed collection must not overwrite lastMeasuredAt.
	LastAttemptAt  string `json:"lastAttemptAt,omitempty" bson:"lastAttemptAt,omitempty"`
	LastSuccessAt  string `json:"lastSuccessAt,omitempty" bson:"lastSuccessAt,omitempty"`
	LastMeasuredAt string `json:"lastMeasuredAt,omitempty" bson:"lastMeasuredAt,omitempty"`
	LastError      string `json:"lastError,omitempty" bson:"lastError,omitempty"`
}

// HealthRun records one bounded collection execution.
type HealthRun struct {
	RunID          string `json:"runId" bson:"_id"`
	SchemaVersion  int    `json:"schemaVersion" bson:"schemaVersion"`
	TargetID       string `json:"targetId" bson:"targetId"`
	CandidateID    string `json:"candidateId,omitempty" bson:"candidateId,omitempty"`
	StartedAt      string `json:"startedAt" bson:"startedAt"`
	CompletedAt    string `json:"completedAt,omitempty" bson:"completedAt,omitempty"`
	Status         string `json:"status" bson:"status"`
	SampleID       string `json:"sampleId,omitempty" bson:"sampleId,omitempty"`
	LayersMeasured int    `json:"layersMeasured" bson:"layersMeasured"`
	ErrorCode      string `json:"errorCode,omitempty" bson:"errorCode,omitempty"`
	ErrorSummary   string `json:"errorSummary,omitempty" bson:"errorSummary,omitempty"`
	InitiatedBy    string `json:"initiatedBy" bson:"initiatedBy"`
}

// HealthSample is bounded time-series measurement evidence.
type HealthSample struct {
	SampleID      string         `json:"sampleId" bson:"_id"`
	SchemaVersion int            `json:"schemaVersion" bson:"schemaVersion"`
	TargetID      string         `json:"targetId" bson:"targetId"`
	RunID         string         `json:"runId" bson:"runId"`
	CandidateID   string         `json:"candidateId,omitempty" bson:"candidateId,omitempty"`
	CollectedAt   string         `json:"collectedAt" bson:"collectedAt"`
	ExpiresAt     string         `json:"expiresAt,omitempty" bson:"expiresAt,omitempty"`
	Layers        LayerSet       `json:"layers" bson:"layers"`
	Metrics       []MetricSample `json:"metrics" bson:"metrics"`
}

// CreateTargetRequest is the body for POST /api/nf-health/targets.
type CreateTargetRequest struct {
	CandidateID      string `json:"candidateId"`
	Name             string `json:"name"`
	CollectorProfile string `json:"collectorProfile"`
	MetricsEndpoint  string `json:"metricsEndpoint,omitempty"`
	ServiceUnit      string `json:"serviceUnit,omitempty"`
	ServiceKind      string `json:"serviceKind"`
	CollectionMode   string `json:"collectionMode"`
	IntervalSeconds  int    `json:"intervalSeconds"`
	Enabled          *bool  `json:"enabled,omitempty"`
}

// UpdateTargetRequest is the body for PUT /api/nf-health/targets/{targetId}.
type UpdateTargetRequest struct {
	ExpectedRevision int64         `json:"expectedRevision"`
	Target           MutableTarget `json:"target"`
}

// MutableTarget is the operator-mutable projection of a monitoring target.
type MutableTarget struct {
	Name            string `json:"name"`
	MetricsEndpoint string `json:"metricsEndpoint,omitempty"`
	ServiceUnit     string `json:"serviceUnit,omitempty"`
	ServiceKind     string `json:"serviceKind"`
	CollectionMode  string `json:"collectionMode"`
	IntervalSeconds int    `json:"intervalSeconds"`
	Enabled         bool   `json:"enabled"`
}

// TargetListFilter filters monitoring target listings.
type TargetListFilter struct {
	Query   string
	Enabled string // "", "true", "false"
	Limit   int
	Cursor  string
}

// RunListFilter filters collection run listings.
type RunListFilter struct {
	TargetID string
	Status   string
	Limit    int
	Cursor   string
}

// SampleListFilter filters telemetry sample listings.
type SampleListFilter struct {
	TargetID string
	From     string
	To       string
	Limit    int
	Cursor   string
}

// HealthTargetSummary is the read projection with coverage counters.
type HealthTargetSummary struct {
	HealthTarget
	Coverage CoverageSummary `json:"coverage" bson:"coverage"`
}

// CoverageSummary exposes which layers are currently measured.
type CoverageSummary struct {
	L1Measured  bool `json:"l1Measured" bson:"l1Measured"`
	L2Measured  bool `json:"l2Measured" bson:"l2Measured"`
	L3Measured  bool `json:"l3Measured" bson:"l3Measured"`
	L3Available bool `json:"l3Available" bson:"l3Available"`
}

// PageInfo mirrors the Inventory/Topology/Discovery pagination envelope.
type PageInfo struct {
	Limit      int     `json:"limit"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasMore"`
}
