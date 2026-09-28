package remediation

// HealResponse represents the success payload for POST /api/system/audit/heal.
type HealResponse struct {
	Message string `json:"message"`
}

// BatchHealResponse represents the success payload for POST /api/system/audit/batch-heal.
type BatchHealResponse struct {
	Message      string   `json:"message"`
	SuccessCount int      `json:"successCount"`
	FailedCount  int      `json:"failedCount"`
	Errors       []string `json:"errors"`
}

// AnomalyItem represents an individual anomaly item passed to batch-heal.
type AnomalyItem struct {
	IMSI string `json:"imsi"`
	Type string `json:"type"`
}
