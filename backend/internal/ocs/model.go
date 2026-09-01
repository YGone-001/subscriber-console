package ocs

// BalanceListResponse matches GET /api/ocs/balances response shape.
type BalanceListResponse struct {
	OK         bool            `json:"ok"`
	Records    []BalanceRecord `json:"records"`
	Total      int64           `json:"total"`
	Page       int             `json:"page"`
	Limit      int             `json:"limit"`
	TotalPages int             `json:"totalPages"`
	Summary    BalanceSummary  `json:"summary"`
}

// BalanceRecord matches Node OcsBalanceRecord.
type BalanceRecord struct {
	ID               string  `json:"id"`
	IMSI             string  `json:"imsi"`
	PlanID           string  `json:"plan_id"`
	Status           string  `json:"status"`
	DataTotal        int64   `json:"data_total"`
	DataUsed         int64   `json:"data_used"`
	DataReserved     int64   `json:"data_reserved"`
	DataAvailable    int64   `json:"data_available"`
	VoiceTotal       int64   `json:"voice_total"`
	VoiceUsed        int64   `json:"voice_used"`
	VoiceReserved    int64   `json:"voice_reserved"`
	VoiceAvailable   int64   `json:"voice_available"`
	SmsTotal         int64   `json:"sms_total"`
	SmsUsed          int64   `json:"sms_used"`
	SmsAvailable     int64   `json:"sms_available"`
	MoneyBalance     float64 `json:"money_balance"`
	Version          int64   `json:"version"`
	DataInvariantOk  bool    `json:"data_invariant_ok"`
	VoiceInvariantOk bool    `json:"voice_invariant_ok"`
	SmsInvariantOk   bool    `json:"sms_invariant_ok"`
	InvariantOk      bool    `json:"invariant_ok"`
	CreatedAt        string  `json:"created_at,omitempty"`
	UpdatedAt        string  `json:"updated_at,omitempty"`
	CycleStartAt     string  `json:"cycle_start_at,omitempty"`
	CycleResetAt     string  `json:"cycle_reset_at,omitempty"`
}

// BalanceSummary matches Node balance summary.
type BalanceSummary struct {
	TotalSubscribers   int64 `json:"totalSubscribers"`
	TotalDataAllocated int64 `json:"totalDataAllocated"`
	TotalDataUsed      int64 `json:"totalDataUsed"`
	TotalDataReserved  int64 `json:"totalDataReserved"`
	TotalDataAvailable int64 `json:"totalDataAvailable"`
}

// SessionListResponse matches GET /api/ocs/sessions response shape.
type SessionListResponse struct {
	OK         bool            `json:"ok"`
	Records    []SessionRecord `json:"records"`
	Total      int64           `json:"total"`
	Page       int             `json:"page"`
	Limit      int             `json:"limit"`
	TotalPages int             `json:"totalPages"`
	Summary    SessionSummary  `json:"summary"`
}

// SessionRecord matches Node OcsSessionRecord.
type SessionRecord struct {
	ID                string  `json:"id"`
	SessionID         string  `json:"session_id"`
	IMSI              string  `json:"imsi"`
	APN               string  `json:"apn"`
	State             string  `json:"state"`
	InterfaceType     string  `json:"interface_type"`
	CCRequestNumber   int64   `json:"cc_request_number"`
	GrantedTotal      int64   `json:"granted_total"`
	UsedTotal         int64   `json:"used_total"`
	RatingGroup       *int64  `json:"rating_group,omitempty"`
	ServiceIdentifier *int64  `json:"service_identifier,omitempty"`
	TariffRuleID      *string `json:"tariff_rule_id,omitempty"`
	ChargingType      *string `json:"charging_type,omitempty"`
	CallingParty      *string `json:"calling_party,omitempty"`
	CalledParty       *string `json:"called_party,omitempty"`
	ServiceContextID  *string `json:"service_context_id,omitempty"`
	GrantedSeconds    *int64  `json:"granted_seconds,omitempty"`
	UsedSeconds       *int64  `json:"used_seconds,omitempty"`
	CleanupToken      *string `json:"cleanup_token,omitempty"`
	CleanupStage      *string `json:"cleanup_stage,omitempty"`
	CleanupUpdatedAt  *string `json:"cleanup_updated_at,omitempty"`
	CloseReason       *string `json:"close_reason,omitempty"`
	StartedAt         *string `json:"started_at,omitempty"`
	LastUpdateAt      *string `json:"last_update_at,omitempty"`
	ClosedAt          *string `json:"closed_at,omitempty"`
}

// SessionSummary matches Node session summary.
type SessionSummary struct {
	ActiveSessions     int64 `json:"activeSessions"`
	ClosingSessions    int64 `json:"closingSessions"`
	ClosedSessions     int64 `json:"closedSessions"`
	TotalGrantedOctets int64 `json:"totalGrantedOctets"`
	TotalUsedOctets    int64 `json:"totalUsedOctets"`
}

// UsageListResponse matches GET /api/ocs/usage response shape.
type UsageListResponse struct {
	OK         bool          `json:"ok"`
	Records    []UsageRecord `json:"records"`
	Total      int64         `json:"total"`
	Page       int           `json:"page"`
	Limit      int           `json:"limit"`
	TotalPages int           `json:"totalPages"`
	Summary    UsageSummary  `json:"summary"`
}

// UsageRecord matches Node OcsUsageRecord.
type UsageRecord struct {
	ID                string  `json:"id"`
	SessionID         string  `json:"session_id"`
	IMSI              string  `json:"imsi"`
	APN               string  `json:"apn"`
	CCRequestType     string  `json:"cc_request_type"`
	CCRequestNumber   int64   `json:"cc_request_number"`
	InputOctets       int64   `json:"input_octets"`
	OutputOctets      int64   `json:"output_octets"`
	TotalOctets       int64   `json:"total_octets"`
	ChargingType      *string `json:"charging_type,omitempty"`
	InterfaceType     *string `json:"interface_type,omitempty"`
	Charged           bool    `json:"charged"`
	ResultCode        *int64  `json:"result_code,omitempty"`
	GrantedOctets     *int64  `json:"granted_octets,omitempty"`
	GrantedSeconds    *int64  `json:"granted_seconds,omitempty"`
	UsedSeconds       *int64  `json:"used_seconds,omitempty"`
	GrantedEvents     *int64  `json:"granted_events,omitempty"`
	UsedEvents        *int64  `json:"used_events,omitempty"`
	ServiceContextID  *string `json:"service_context_id,omitempty"`
	RatingGroup       *int64  `json:"rating_group,omitempty"`
	ServiceIdentifier *int64  `json:"service_identifier,omitempty"`
	TariffRuleID      *string `json:"tariff_rule_id,omitempty"`
	CreatedAt         *string `json:"created_at,omitempty"`
}

// UsageSummary matches Node usage summary.
type UsageSummary struct {
	TotalRecords        int64 `json:"totalRecords"`
	TotalChargedRecords int64 `json:"totalChargedRecords"`
	TotalInputOctets    int64 `json:"totalInputOctets"`
	TotalOutputOctets   int64 `json:"totalOutputOctets"`
	TotalOctets         int64 `json:"totalOctets"`
}

// ReservationListResponse matches GET /api/ocs/reservations response shape.
type ReservationListResponse struct {
	OK         bool                `json:"ok"`
	Records    []ReservationRecord `json:"records"`
	Total      int64               `json:"total"`
	Page       int                 `json:"page"`
	Limit      int                 `json:"limit"`
	TotalPages int                 `json:"totalPages"`
	Summary    ReservationSummary  `json:"summary"`
}

// ReservationRecord matches Node OcsReservationRecord.
type ReservationRecord struct {
	ID                   string  `json:"id"`
	SessionID            string  `json:"session_id"`
	IMSI                 string  `json:"imsi"`
	APN                  string  `json:"apn"`
	ChargingType         string  `json:"charging_type"`
	InterfaceType        *string `json:"interface_type,omitempty"`
	GrantCCRequestType   string  `json:"grant_cc_request_type"`
	GrantCCRequestNumber int64   `json:"grant_cc_request_number"`
	ReservedOctets       int64   `json:"reserved_octets"`
	UsedOctets           int64   `json:"used_octets"`
	ReleasedOctets       int64   `json:"released_octets"`
	OveruseOctets        int64   `json:"overuse_octets"`
	GrantedOctets        int64   `json:"granted_octets"`
	GrantedSeconds       *int64  `json:"granted_seconds,omitempty"`
	UsedSeconds          *int64  `json:"used_seconds,omitempty"`
	ResultCode           int64   `json:"result_code"`
	State                string  `json:"state"`
	RatingGroup          *int64  `json:"rating_group,omitempty"`
	ServiceIdentifier    *int64  `json:"service_identifier,omitempty"`
	TariffRuleID         *string `json:"tariff_rule_id,omitempty"`
	OrphanReason         *string `json:"orphan_reason,omitempty"`
	CleanupToken         *string `json:"cleanup_token,omitempty"`
	CreatedAt            *string `json:"created_at,omitempty"`
	UpdatedAt            *string `json:"updated_at,omitempty"`
	SettledAt            *string `json:"settled_at,omitempty"`
	ClosedAt             *string `json:"closed_at,omitempty"`
	OrphanedAt           *string `json:"orphaned_at,omitempty"`
}

// ReservationSummary matches Node reservation summary.
type ReservationSummary struct {
	ActiveReservations   int64 `json:"activeReservations"`
	SettledReservations  int64 `json:"settledReservations"`
	OrphanedReservations int64 `json:"orphanedReservations"`
	TotalReservedOctets  int64 `json:"totalReservedOctets"`
	TotalReleasedOctets  int64 `json:"totalReleasedOctets"`
}
