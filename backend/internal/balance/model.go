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
	TotalSubscribers int64 `json:"totalSubscribers"`
	ActiveAccounts   int64 `json:"activeAccounts"`
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

// BalanceSnapshot captures a single bucket snapshot for CAS validation.
type BalanceSnapshot struct {
	IMSI           string `json:"imsi"`
	Bucket         string `json:"bucket"`
	Total          int64  `json:"total"`
	Used           int64  `json:"used"`
	Reserved       int64  `json:"reserved"`
	Available      int64  `json:"available"`
	Version        int64  `json:"version"`
	VersionPresent bool   `json:"versionPresent"`
}

// ExpectedAfterSnapshot captures expected bucket balances after adjustment.
type ExpectedAfterSnapshot struct {
	IMSI      string `json:"imsi"`
	Bucket    string `json:"bucket"`
	Total     int64  `json:"total"`
	Used      int64  `json:"used"`
	Reserved  int64  `json:"reserved"`
	Available int64  `json:"available"`
}

// BalanceAdjustmentIntent captures the adjustment operation intent.
type BalanceAdjustmentIntent struct {
	Bucket    string `json:"bucket"`
	Operation string `json:"operation"`
	Amount    int64  `json:"amount"`
	Reason    string `json:"reason"`
	TicketID  string `json:"ticketId,omitempty"`
}

// OcsBalanceAdjustmentV1Payload matches canonical ocs-balance-adjustment-v1 schema.
type OcsBalanceAdjustmentV1Payload struct {
	Schema        string                  `json:"schema"` // "ocs-balance-adjustment-v1"
	AdjustmentID  string                  `json:"adjustmentId"`
	IMSI          string                  `json:"imsi"`
	Intent        BalanceAdjustmentIntent `json:"intent"`
	Before        BalanceSnapshot         `json:"before"`
	ExpectedAfter ExpectedAfterSnapshot   `json:"expectedAfter"`
}

// FrozenBalanceAdjustmentPayload is kept as alias for canonical payload.
type FrozenBalanceAdjustmentPayload = OcsBalanceAdjustmentV1Payload

// SnapshotForBucket extracts the balance snapshot for a specific bucket.
func (r *BalanceRecord) SnapshotForBucket(bucket string) BalanceSnapshot {
	snap := BalanceSnapshot{
		IMSI:           r.IMSI,
		Bucket:         bucket,
		Version:        r.Version,
		VersionPresent: true,
	}
	switch bucket {
	case "data":
		snap.Total = r.DataTotal
		snap.Used = r.DataUsed
		snap.Reserved = r.DataReserved
		snap.Available = r.DataAvailable
	case "voice":
		snap.Total = r.VoiceTotal
		snap.Used = r.VoiceUsed
		snap.Reserved = r.VoiceReserved
		snap.Available = r.VoiceAvailable
	case "sms":
		snap.Total = r.SmsTotal
		snap.Used = r.SmsUsed
		snap.Reserved = 0
		snap.Available = r.SmsAvailable
	}
	return snap
}

// ExpectedAfterForSnapshot computes the expected after snapshot from a before snapshot and operation.
func ExpectedAfterForSnapshot(before BalanceSnapshot, op string, amount int64) ExpectedAfterSnapshot {
	delta := amount
	if op == "debit" {
		delta = -amount
	}
	expectedTotal := before.Total + delta
	expectedAvailable := expectedTotal - before.Used - before.Reserved
	return ExpectedAfterSnapshot{
		IMSI:      before.IMSI,
		Bucket:    before.Bucket,
		Total:     expectedTotal,
		Used:      before.Used,
		Reserved:  before.Reserved,
		Available: expectedAvailable,
	}
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
