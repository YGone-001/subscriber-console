// Package analytics provides read-only analytics API handlers.
package analytics

// AnalyticsMetrics is the business-analysis read projection.
//
// TotalTraffic and Top5 are retained for compatibility with the legacy
// cockpit. They describe remaining data balances, not consumption; new
// consumers must use OcsBalances and the explicit usage fields below.
type AnalyticsMetrics struct {
	TotalTraffic    int                   `json:"totalTraffic"`
	PlmnDist        []NameValue           `json:"plmnDist"`
	RatesDist       []NameValue           `json:"ratesDist"`
	Top5            []Top5Entry           `json:"top5"`
	Timestamp       int64                 `json:"timestamp"`
	OcsBalances     OcsBalanceMetrics     `json:"ocsBalances"`
	OcsSessions     OcsSessionMetrics     `json:"ocsSessions"`
	OcsReservations OcsReservationMetrics `json:"ocsReservations"`
	TariffPlanDist  []TariffPlanDistItem  `json:"tariffPlanDist"`
	OcsUsage        OcsUsageMetrics       `json:"ocsUsage"`

	UsageWindowHours       int               `json:"usageWindowHours"`
	UsageWindowRecords     int               `json:"usageWindowRecords"`
	UsageWindowTotalOctets int64             `json:"usageWindowTotalOctets"`
	UsageTrend             []UsageTrendPoint `json:"usageTrend"`
	TopUsage               []TopUsageEntry   `json:"topUsage"`
	LatestUsageAt          string            `json:"latestUsageAt"`
}

// UsageTrendPoint is one hourly bucket of accepted OCS usage records.
type UsageTrendPoint struct {
	Hour   string `json:"hour"`
	Octets int64  `json:"octets"`
}

// TopUsageEntry is one subscriber's usage inside the analysis window.
type TopUsageEntry struct {
	IMSI       string  `json:"imsi"`
	UsedOctets int64   `json:"usedOctets"`
	Share      float64 `json:"share"`
}

type NameValue struct {
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

type Top5Entry struct {
	Imsi         string `json:"imsi"`
	Balance      int64  `json:"balance"`
	VoiceBalance int64  `json:"voiceBalance"`
	SmsBalance   int64  `json:"smsBalance"`
}

type OcsBalanceMetrics struct {
	TotalSubscribers     int     `json:"totalSubscribers"`
	TotalDataAllocated   int64   `json:"totalDataAllocated"`
	TotalDataUsed        int64   `json:"totalDataUsed"`
	TotalDataReserved    int64   `json:"totalDataReserved"`
	TotalDataAvailable   int64   `json:"totalDataAvailable"`
	DataUtilizationRate  float64 `json:"dataUtilizationRate"`
	TotalVoiceAllocated  int64   `json:"totalVoiceAllocated"`
	TotalVoiceUsed       int64   `json:"totalVoiceUsed"`
	TotalVoiceReserved   int64   `json:"totalVoiceReserved"`
	TotalVoiceAvailable  int64   `json:"totalVoiceAvailable"`
	TotalSmsAllocated    int64   `json:"totalSmsAllocated"`
	TotalSmsUsed         int64   `json:"totalSmsUsed"`
	TotalSmsAvailable    int64   `json:"totalSmsAvailable"`
	ValidInvariantCount  int     `json:"validInvariantCount"`
	BrokenInvariantCount int     `json:"brokenInvariantCount"`
	AllInvariantsOk      bool    `json:"allInvariantsOk"`

	// InvariantChecked is the number of balance documents actually evaluated.
	// InvariantSampleLimit documents the bounded scan; a result is never a
	// platform-wide claim when checked is below the target population.
	InvariantChecked         int    `json:"invariantChecked"`
	InvariantSampleLimit     int    `json:"invariantSampleLimit"`
	InvariantScope           string `json:"invariantScope"`
	VoiceAllocationDefaulted int    `json:"voiceAllocationDefaulted"`
	SmsAllocationDefaulted   int    `json:"smsAllocationDefaulted"`
}

type OcsSessionMetrics struct {
	TotalSessions      int        `json:"totalSessions"`
	ActiveSessions     int        `json:"activeSessions"`
	ClosingSessions    int        `json:"closingSessions"`
	ClosedSessions     int        `json:"closedSessions"`
	TotalGrantedOctets int64      `json:"totalGrantedOctets"`
	TotalUsedOctets    int64      `json:"totalUsedOctets"`
	InterfaceGyCount   int        `json:"interfaceGyCount"`
	InterfaceRoCount   int        `json:"interfaceRoCount"`
	ApnDistribution    []ApnCount `json:"apnDistribution"`

	// ActiveUsedOctets and ActiveUsageTop describe the live session authority.
	// They are a current-session fallback when the charging plane does not write
	// per-request usage records into ocs_usage_records. They are never labelled
	// as a 24-hour window.
	ActiveUsedOctets int64           `json:"activeUsedOctets"`
	ActiveUsageTop   []TopUsageEntry `json:"activeUsageTop"`
}

type ApnCount struct {
	Apn   string `json:"apn"`
	Count int    `json:"count"`
}

type OcsReservationMetrics struct {
	TotalReservations    int   `json:"totalReservations"`
	ActiveReservations   int   `json:"activeReservations"`
	SettledReservations  int   `json:"settledReservations"`
	ReleasedReservations int   `json:"releasedReservations"`
	OrphanedReservations int   `json:"orphanedReservations"`
	TotalReservedOctets  int64 `json:"totalReservedOctets"`
	TotalReleasedOctets  int64 `json:"totalReleasedOctets"`
	TotalUsedOctets      int64 `json:"totalUsedOctets"`
}

type TariffPlanDistItem struct {
	PlanID          string  `json:"planId"`
	Name            string  `json:"name"`
	SubscriberCount int     `json:"subscriberCount"`
	Percentage      float64 `json:"percentage"`
	Status          string  `json:"status"`
}

type OcsUsageMetrics struct {
	TotalRecords      int   `json:"totalRecords"`
	ChargedRecords    int   `json:"chargedRecords"`
	TotalInputOctets  int64 `json:"totalInputOctets"`
	TotalOutputOctets int64 `json:"totalOutputOctets"`
	TotalOctets       int64 `json:"totalOctets"`
}

// SparklineResponse matches the existing API response shape.
type SparklineResponse struct {
	Subscribers     []int64 `json:"subscribers"`
	Traffic         []int64 `json:"traffic"`
	CurrentSubCount int     `json:"currentSubCount"`
	CurrentTraffic  int64   `json:"currentTraffic"`
}
