package runtimeinv

// Runtime status vocabulary.
//
// The distinction between these outcomes is the core safety property of this
// package: a process-inspection failure never establishes a stopped state, and a
// component that was never installed is never reported as stopped.
const (
	// StatusRunning: a compatible executable was positively verified in a
	// successful scan.
	StatusRunning = "running"
	// StatusStopped: a previously observed or explicitly expected local service
	// was absent from a complete, successful scan.
	StatusStopped = "stopped"
	// StatusUnverified: a name or command-line candidate was found but its
	// identity could not be positively verified.
	StatusUnverified = "unverified"
	// StatusPermissionDenied: inspection failed because of permissions.
	StatusPermissionDenied = "permission_denied"
	// StatusUnknown: the platform lacks sufficient evidence.
	StatusUnknown = "unknown"
	// StatusStale: the last accepted observation exceeded the freshness policy.
	StatusStale = "stale"
	// StatusNotDetected: a recognized component was never observed and is not
	// explicitly expected.
	StatusNotDetected = "not_detected"
	// StatusNotConfigured: the component is not part of the active expectation
	// profile. This is a configuration statement, never a runtime claim.
	StatusNotConfigured = "not_configured"
	// StatusNotApplicable: the component cannot be evaluated in this
	// environment (for example a command-line matched component when the
	// command line is not readable at all).
	StatusNotApplicable = "not_applicable"
)

// CanonicalStatuses is the status vocabulary exposed by the meta endpoint.
var CanonicalStatuses = []string{
	StatusRunning, StatusStopped, StatusUnverified, StatusPermissionDenied,
	StatusUnknown, StatusStale, StatusNotDetected, StatusNotConfigured,
	StatusNotApplicable,
}

// Evidence verification states.
const (
	EvidenceVerified   = "verified"
	EvidenceUnverified = "unverified"
	EvidenceNone       = "none"
)

// Scan outcomes.
const (
	ScanComplete   = "complete"
	ScanIncomplete = "incomplete"
	ScanFailed     = "failed"
)

// Scan triggers.
const (
	TriggerStartup   = "startup"
	TriggerScheduled = "scheduled"
	TriggerManual    = "manual"
)

// Visibility describes the process namespace the scanner can actually see.
const (
	VisibilityHost           = "host"
	VisibilityContainerLimit = "container_limited"
	VisibilityUnavailable    = "unavailable"
)

// Status reasons. Stable machine-readable tokens; the UI localizes them.
const (
	ReasonVerifiedRunning        = "verified_process_running"
	ReasonAbsentAfterObservation = "previously_observed_absent"
	ReasonExpectedButAbsent      = "expected_service_absent"
	ReasonNeverObserved          = "never_observed"
	ReasonExeUnverified          = "executable_identity_unverified"
	ReasonExePermissionDenied    = "executable_permission_denied"
	ReasonLaunchIdentityAbsent   = "approved_launch_identity_absent"
	ReasonCommandUnreadable      = "command_line_unreadable"
	ReasonTokenNotLaunchIdentity = "command_token_not_launch_identity"
	ReasonScanIncomplete         = "scan_incomplete"
	ReasonProcUnreadable         = "proc_inspection_permission_denied"
	ReasonScannerDisabled        = "scanner_disabled"
	ReasonObservationExpired     = "observation_expired"
	ReasonWorkerLimitReached     = "worker_limit_reached"
)

// Monitoring association states reported alongside a component.
const (
	AssociationAssociated = "associated"
	AssociationAbsent     = "absent"
	AssociationUnresolved = "unresolved"
)

// CPU measurement bases.
const (
	// CPUBasisIntervalDelta is a real percentage derived from the delta of
	// cumulative process CPU time across a measured wall-clock interval.
	CPUBasisIntervalDelta = "interval_delta_verified_group"
	// CPUBasisUnavailable means no valid interval measurement exists. The value
	// is never synthesized as zero.
	CPUBasisUnavailable = "unavailable"
)

// Memory measurement bases.
const (
	MemoryBasisGroupAggregate = "verified_group_aggregate"
	MemoryBasisUnavailable    = "unavailable"
)

// Worker is one verified process identity behind a component.
type Worker struct {
	PID        int    `json:"pid"`
	StartTicks uint64 `json:"-"`
	ExeName    string `json:"exeName"`
	// StartedAt is derived from the boot time and the process start ticks. It
	// is present only when both values are known.
	StartedAt string `json:"startedAt,omitempty"`
	// CommandMatch is the approved launch token for command-line matched
	// components. The raw command line is never retained or returned.
	CommandMatch string `json:"commandMatch,omitempty"`
}

// MonitoringProjection states whether NF Health adoption is possible.
type MonitoringProjection struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

// AssociationProjection links an observation to canonical identities.
type AssociationProjection struct {
	State string `json:"state"`
	ID    string `json:"id,omitempty"`
}

// Observation is the runtime state of one recognized component.
type Observation struct {
	ComponentID    string   `json:"componentId"`
	DisplayName    string   `json:"displayName"`
	ProcessName    string   `json:"processName"`
	MatchMethod    string   `json:"matchMethod"`
	Category       string   `json:"category"`
	Domain         string   `json:"domain"`
	Role           string   `json:"role"`
	NFTType        string   `json:"nfType,omitempty"`
	CNMSCompatible bool     `json:"cnmsCompatible"`
	Templates      []string `json:"templates"`

	RuntimeStatus string `json:"runtimeStatus"`
	StatusReason  string `json:"statusReason"`
	// PreviousStatus retains the last accepted status when the observation
	// expired. Empty while the observation is current.
	PreviousStatus string `json:"previousStatus,omitempty"`
	Evidence       string `json:"evidence"`
	Verified       bool   `json:"verified"`

	PrimaryPID        int      `json:"primaryPid"`
	WorkerCount       int      `json:"workerCount"`
	Workers           []Worker `json:"workers"`
	WorkersTruncated  bool     `json:"workersTruncated"`
	UnverifiedWorkers int      `json:"unverifiedWorkers"`

	CPUPercent   *float64 `json:"cpuPercent"`
	CPUAvailable bool     `json:"cpuAvailable"`
	CPUBasis     string   `json:"cpuBasis"`

	MemoryRSSBytes  *int64   `json:"memoryRssBytes"`
	MemoryVMSBytes  *int64   `json:"memoryVmsBytes"`
	MemoryPercent   *float64 `json:"memoryPercent"`
	MemoryAvailable bool     `json:"memoryAvailable"`
	MemoryBasis     string   `json:"memoryBasis"`

	LastScannedAt string `json:"lastScannedAt"`
	FirstSeenAt   string `json:"firstSeenAt,omitempty"`
	LastSeenAt    string `json:"lastSeenAt,omitempty"`
	// Expectation is "expected" only when an operator expectation profile or a
	// previous observation established that the service should exist.
	Expectation string `json:"expectation"`

	Monitoring MonitoringProjection `json:"monitoring"`

	// Association fields are filled by the read projection, never by the
	// scanner: a runtime observation alone never proves an Inventory or
	// NF Health association.
	InventoryAssociation AssociationProjection `json:"inventoryAssociation"`
	NFHealthAssociation  AssociationProjection `json:"nfHealthAssociation"`
}

// HostIdentity is the server-owned local host identity. It is derived from the
// host itself and never from a browser claim.
type HostIdentity struct {
	HostID string `json:"hostId"`
	// HostName is a display label only; it is never used as an identity key.
	HostName string `json:"hostName"`
	// IdentitySource names the server-side source of the identifier.
	IdentitySource string `json:"identitySource"`
	// Visibility reports the actual process-namespace visibility boundary.
	Visibility string `json:"visibility"`
	// VisibilityReason explains a limited or unavailable visibility.
	VisibilityReason string `json:"visibilityReason,omitempty"`
}

// ScanMetadata describes one bounded scan execution.
type ScanMetadata struct {
	ScanID            string `json:"scanId"`
	Trigger           string `json:"trigger"`
	StartedAt         string `json:"startedAt"`
	CompletedAt       string `json:"completedAt"`
	DurationMs        int64  `json:"durationMs"`
	Status            string `json:"status"`
	Complete          bool   `json:"complete"`
	ProcessesScanned  int    `json:"processesScanned"`
	EntriesUnreadable int    `json:"entriesUnreadable"`
	WorkersTruncated  int    `json:"workersTruncated"`
	IntervalSeconds   int    `json:"intervalSeconds"`
	ErrorSummary      string `json:"errorSummary,omitempty"`
}

// SnapshotCounts summarizes the current-state distribution.
type SnapshotCounts struct {
	Total            int `json:"total"`
	Running          int `json:"running"`
	Stopped          int `json:"stopped"`
	Unverified       int `json:"unverified"`
	PermissionDenied int `json:"permissionDenied"`
	Unknown          int `json:"unknown"`
	Stale            int `json:"stale"`
	NotDetected      int `json:"notDetected"`
	Expected         int `json:"expected"`
}

// Snapshot is the bounded current-state publication of one scan.
type Snapshot struct {
	ProfileID      string         `json:"profileId"`
	ProfileVersion int            `json:"profileVersion"`
	Host           HostIdentity   `json:"host"`
	Scan           ScanMetadata   `json:"scan"`
	Components     []Observation  `json:"components"`
	Counts         SnapshotCounts `json:"counts"`
	Registry       Counts         `json:"registry"`
	GeneratedAt    string         `json:"generatedAt"`
}

// ComponentState is the persisted cross-restart memory of what was previously
// observed. It lets a later complete scan distinguish "previously observed but
// no longer running" from "never installed".
type ComponentState struct {
	StateID         string `json:"stateId" bson:"_id"`
	HostID          string `json:"hostId" bson:"hostId"`
	ComponentID     string `json:"componentId" bson:"componentId"`
	FirstSeenAt     string `json:"firstSeenAt,omitempty" bson:"firstSeenAt,omitempty"`
	LastSeenAt      string `json:"lastSeenAt,omitempty" bson:"lastSeenAt,omitempty"`
	Presence        bool   `json:"presence" bson:"presence"`
	LastPrimaryPID  int    `json:"lastPrimaryPid" bson:"lastPrimaryPid"`
	LastProcessName string `json:"lastProcessName,omitempty" bson:"lastProcessName,omitempty"`
	UpdatedAt       string `json:"updatedAt" bson:"updatedAt"`
}

// StateID builds the stable state document key.
func StateID(hostID, componentID string) string {
	return hostID + "|" + componentID
}
