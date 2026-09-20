package balance

// BalanceRecord represents a subscriber balance account in xcloud.ocs_balances.
type BalanceRecord struct {
	ID               string  `json:"id"`
	IMSI             string  `json:"imsi"`
	PlanID           string  `json:"plan_id,omitempty"`
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
	MoneyBalance     float64 `json:"money_balance,omitempty"`
	Version          int64   `json:"version"`
	DataInvariantOk  bool    `json:"data_invariant_ok"`
	VoiceInvariantOk bool    `json:"voice_invariant_ok"`
	SmsInvariantOk   bool    `json:"sms_invariant_ok"`
	InvariantOk      bool    `json:"invariant_ok"`
	CreatedAt        string  `json:"created_at,omitempty"`
	UpdatedAt        string  `json:"updated_at,omitempty"`
}

// BalanceSummary contains aggregate statistics for balance management.
type BalanceSummary struct {
	TotalSubscribers   int64 `json:"totalSubscribers"`
	ActiveAccounts     int64 `json:"activeAccounts"`
	PendingAdjustments int64 `json:"pendingAdjustments"`
}

// BalanceQueryOptions contains filtering and pagination options for balance listing.
type BalanceQueryOptions struct {
	Page            int
	Limit           int
	IMSI            string
	PlanID          string
	Status          string
	InvariantStatus string
	SortField       string
	SortOrder       string
}

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

// BalanceDetailResponse matches GET /api/ocs/balances/{imsi} response shape.
type BalanceDetailResponse struct {
	OK      bool          `json:"ok"`
	Balance BalanceRecord `json:"balance"`
}

// AdjustBalanceRequest is the payload for POST /api/ocs/balances/{imsi}/adjust.
type AdjustBalanceRequest struct {
	Operation string `json:"operation"`         // "credit" | "debit"
	Bucket    string `json:"bucket"`            // "data" | "voice" | "sms"
	Amount    int64  `json:"amount"`            // positive integer
	Reason    string `json:"reason"`            // required, 1-200 chars
	TicketID  string `json:"ticketId"`          // optional, max 100 chars
	Version   *int64 `json:"version,omitempty"` // optional CAS version precondition
}

// BalanceFingerprint encapsulates balance state for CAS comparison.
type BalanceFingerprint struct {
	IMSI         string `json:"imsi"`
	DataBalance  int64  `json:"data_balance"`
	VoiceBalance int64  `json:"voice_balance"`
	SmsBalance   int64  `json:"sms_balance"`
	Version      int64  `json:"version"`
}

// BucketAmounts captures available balances across buckets.
type BucketAmounts struct {
	Data  int64 `json:"data"`
	Voice int64 `json:"voice"`
	Sms   int64 `json:"sms"`
}

// FrozenBalanceAdjustmentPayload is the frozen approval payload schema balance-adjustment-v1.
type FrozenBalanceAdjustmentPayload struct {
	Schema    string        `json:"schema"` // "balance-adjustment-v1"
	IMSI      string        `json:"imsi"`
	Before    BucketAmounts `json:"before"`
	After     BucketAmounts `json:"after"`
	Operation string        `json:"operation"`
	Bucket    string        `json:"bucket"`
	Amount    int64         `json:"amount"`
	Reason    string        `json:"reason"`
	TicketID  string        `json:"ticketId,omitempty"`
}

// CheckInvariants computes the invariant status for a balance record.
func (r *BalanceRecord) CheckInvariants() {
	r.DataInvariantOk = r.DataTotal == (r.DataUsed + r.DataReserved + r.DataAvailable)
	r.VoiceInvariantOk = r.VoiceTotal == (r.VoiceUsed + r.VoiceReserved + r.VoiceAvailable)
	r.SmsInvariantOk = r.SmsTotal == (r.SmsUsed + r.SmsAvailable)
	r.InvariantOk = r.DataInvariantOk && r.VoiceInvariantOk && r.SmsInvariantOk
}

// Fingerprint returns the CAS fingerprint of the record.
func (r *BalanceRecord) Fingerprint() BalanceFingerprint {
	return BalanceFingerprint{
		IMSI:         r.IMSI,
		DataBalance:  r.DataAvailable,
		VoiceBalance: r.VoiceAvailable,
		SmsBalance:   r.SmsAvailable,
		Version:      r.Version,
	}
}
