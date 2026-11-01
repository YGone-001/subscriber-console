package system

// DatabaseNames stores names of xcloud and ops databases.
type DatabaseNames struct {
	XCloud string `json:"xcloud"`
	App    string `json:"app"`
}

// CollectionHealth details health information for a single collection.
type CollectionHealth struct {
	Database       string   `json:"database"`
	Name           string   `json:"name"`
	Exists         bool     `json:"exists"`
	DocumentCount  *int64   `json:"documentCount"`
	MissingIndexes []string `json:"missingIndexes"`
}

// MissingIndexRef identifies a missing index by collection and index name.
type MissingIndexRef struct {
	Collection string `json:"collection"`
	Index      string `json:"index"`
}

// MongoHealthReport represents the payload for GET /api/system/mongo/health.
type MongoHealthReport struct {
	OK                 bool               `json:"ok"`
	Database           *string            `json:"database"`
	Databases          *DatabaseNames     `json:"databases"`
	CheckedAt          string             `json:"checkedAt"`
	LatencyMs          *int64             `json:"latencyMs"`
	Collections        []CollectionHealth `json:"collections"`
	MissingCollections []string           `json:"missingCollections"`
	MissingIndexes     []MissingIndexRef  `json:"missingIndexes"`
	Error              *string            `json:"error,omitempty"`
}

// SubsystemStatus is healthy, degraded, or critical.
type SubsystemStatus string

const (
	StatusHealthy     SubsystemStatus = "healthy"
	StatusDegraded    SubsystemStatus = "degraded"
	StatusCritical    SubsystemStatus = "critical"
	StatusUnavailable SubsystemStatus = "unavailable"
)

// ComprehensiveSystemHealth represents the response for GET /api/system/health.
//
// Platform and DataConsistency are the two presentation sections the console
// renders. Platform reports the runtime services and stores that must be alive
// for the console to work; DataConsistency reports business-document anomalies.
// The legacy Status/Score/Subsystems fields stay for backward compatibility.
type ComprehensiveSystemHealth struct {
	Status          SubsystemStatus        `json:"status"`
	Score           int                    `json:"score"`
	CheckedAt       string                 `json:"checkedAt"`
	Subsystems      SystemSubsystems       `json:"subsystems"`
	Summary         HealthSummary          `json:"summary"`
	Platform        *PlatformHealthReport  `json:"platform,omitempty"`
	DataConsistency *DataConsistencyReport `json:"dataConsistency,omitempty"`
}

// PlatformProbeResult is one runtime probe. Status is healthy, degraded or
// unavailable; an unavailable probe is never rendered as healthy.
type PlatformProbeResult struct {
	Key       string          `json:"key"`
	Status    SubsystemStatus `json:"status"`
	Detail    string          `json:"detail,omitempty"`
	CheckedAt string          `json:"checkedAt"`
}

// PlatformHealthReport summarizes runtime probes.
type PlatformHealthReport struct {
	Status    SubsystemStatus       `json:"status"`
	CheckedAt string                `json:"checkedAt"`
	Probes    []PlatformProbeResult `json:"probes"`
}

// DataConsistencyReport summarizes the business-document anomaly evaluation.
// Sampled is false when the counts cover the whole collection. SampleSize is 0
// for full evaluations.
type DataConsistencyReport struct {
	Status     SubsystemStatus `json:"status"`
	Sampled    bool            `json:"sampled"`
	SampleSize int             `json:"sampleSize"`
	CheckedAt  string          `json:"checkedAt"`
}

// SystemSubsystems bundles health for database, ocs, hss, and security subsystems.
type SystemSubsystems struct {
	Database  DatabaseSubsystemHealth `json:"database"`
	OCSEngine OcsSubsystemHealth      `json:"ocsEngine"`
	HSSCore   HssSubsystemHealth      `json:"hssCore"`
	Security  SecuritySubsystemHealth `json:"security"`
}

// DatabaseSubsystemHealth details database status and reports.
type DatabaseSubsystemHealth struct {
	Status                  SubsystemStatus   `json:"status"`
	LatencyMs               int64             `json:"latencyMs"`
	XCloudDB                string            `json:"xcloudDb"`
	AppDB                   string            `json:"appDb"`
	Ready                   bool              `json:"ready"`
	TotalCollections        int               `json:"totalCollections"`
	ExistingCollections     int               `json:"existingCollections"`
	MissingCollectionsCount int               `json:"missingCollectionsCount"`
	MissingIndexesCount     int               `json:"missingIndexesCount"`
	Report                  MongoHealthReport `json:"report"`
}

// OcsSubsystemHealth details OCS billing and session status.
type OcsSubsystemHealth struct {
	Status                SubsystemStatus `json:"status"`
	TotalSubscribers      int64           `json:"totalSubscribers"`
	TotalAllocatedOctets  int64           `json:"totalAllocatedOctets"`
	TotalUsedOctets       int64           `json:"totalUsedOctets"`
	TotalReservedOctets   int64           `json:"totalReservedOctets"`
	TotalAvailableOctets  int64           `json:"totalAvailableOctets"`
	UtilizationRate       float64         `json:"utilizationRate"`
	InvariantsOk          bool            `json:"invariantsOk"`
	BrokenInvariantsCount int             `json:"brokenInvariantsCount"`
	ActiveSessions        int64           `json:"activeSessions"`
	ClosingSessions       int64           `json:"closingSessions"`
	ActiveReservations    int64           `json:"activeReservations"`
	OrphanedReservations  int64           `json:"orphanedReservations"`
	ActiveTariffPlans     int64           `json:"activeTariffPlans"`
}

// HssSubsystemHealth details HSS core subscribers and slice configs.
type HssSubsystemHealth struct {
	Status                  SubsystemStatus `json:"status"`
	TotalSubscribers        int64           `json:"totalSubscribers"`
	ValidCredentialsCount   int64           `json:"validCredentialsCount"`
	MissingCredentialsCount int64           `json:"missingCredentialsCount"`
	ValidSlicesCount        int64           `json:"validSlicesCount"`
	MissingSlicesCount      int64           `json:"missingSlicesCount"`
	ActiveProfilesCount     int64           `json:"activeProfilesCount"`
	DanglingProfilesCount   int64           `json:"danglingProfilesCount"`
}

// SecuritySubsystemHealth details auth, alerts, and audit status.
type SecuritySubsystemHealth struct {
	Status                    SubsystemStatus `json:"status"`
	RootUserConfigured        bool            `json:"rootUserConfigured"`
	ActiveUsersCount          int64           `json:"activeUsersCount"`
	UnacknowledgedAlertsCount int64           `json:"unacknowledgedAlertsCount"`
	CriticalAlertsCount       int64           `json:"criticalAlertsCount"`
	WarningAlertsCount        int64           `json:"warningAlertsCount"`
	RecentAuditLogsCount      int64           `json:"recentAuditLogsCount"`
}

// HealthSummary summarizes anomalies, actionable items, and recommendations.
type HealthSummary struct {
	TotalAnomaliesDetected int      `json:"totalAnomaliesDetected"`
	ActionableItemsCount   int      `json:"actionableItemsCount"`
	Recommendations        []string `json:"recommendations"`
}

// SystemAnomaly represents an inconsistency discovered during audit scan.
type SystemAnomaly struct {
	IMSI     string `json:"imsi"`
	Type     string `json:"type"`
	Details  string `json:"details"`
	Severity string `json:"severity"`
	Category string `json:"category"`
}

// AuditScanResponse represents the response for POST /api/system/audit/scan.
type AuditScanResponse struct {
	NextCursor   string          `json:"nextCursor"`
	ScannedCount int             `json:"scannedCount"`
	Anomalies    []SystemAnomaly `json:"anomalies"`
}

// AuditScanRequest represents the JSON request payload for POST /api/system/audit/scan.
type AuditScanRequest struct {
	Cursor *string `json:"cursor"`
	Phase  *string `json:"phase"`
}
